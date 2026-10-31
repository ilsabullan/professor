import type Anthropic from '@anthropic-ai/sdk'
import type { InkBus } from '../shared/bus'
import type { InkEvent } from '../shared/ink'
import { type AiOptions, describeError, type ModelId, prewarm, proxyStatus, sceneCall, streamSteps, type ThinkingMode } from './ai/client'
import { parseProgress } from './ai/parse'
import { buildUserPrompt } from './ai/prompt'
import { Board } from './board'
import { Engine, Player, type PlayStep } from './engine'
import type { ReqRecord } from './metrics'
import { type Op, sanitizeOp } from './ops'
import { quickFromBoard, quickFromSpeech } from './quick'
import { alignDirection, describeGrounding, type GateMode, groundSpeech, keepGrounded, mentionedValues, planNumericSort, planNumericSwap, planRestore, rejectUngrounded, type Grounding } from './grounding'
import { SceneParser } from './scene'
import { snapshotB64 } from './snapshot'
import { type MicState, SpeechInput, type SttProvider } from './speech'

export interface Settings {
  model: ModelId
  thinking: ThinkingMode
  /** 필기 이미지도 보낼지: off 안 보냄, auto 손글씨가 있을 때만, on 항상 (보내면 조금 느려지지만 손글씨를 읽음) */
  image: 'off' | 'auto' | 'on'
  /** 말이 끝나기 전에 미리 AI를 부름 */
  early: boolean
  /** 즉시 반응 규칙 사용 */
  quick: boolean
  /** 이 확신보다 낮으면 재생하지 않음 */
  thr: number
  /** 펜을 뗀 뒤 쉬면 장면 해석(LLM)으로 객체의 의미를 정함 */
  scene: boolean
  /** 받아쓰기: 브라우저 내장 / OpenAI / Gemini 실시간 */
  stt: SttProvider
  /** AI 동작을 막는 규칙의 강도 (실측 비교용) */
  gate: GateMode
}

export type AiStatus = 'checking' | 'ready' | 'nokey' | 'locked' | 'error'

interface Trigger {
  kind: string
  desc: string
  t: number
  quickMs?: number
  grounding?: Grounding
}

interface Inflight {
  rec: ReqRecord
  ctrl: AbortController
  /** 확정 발화 요청. 뒤이은 필기·미완성 발화가 취소하지 않는다 */
  final: boolean
}

/** 계기별로 AI를 부르기 전 기다리는 시간(ms). 짧을수록 빠르고, 연달아 오는 입력은 하나로 묶는다 */
const DELAY: Record<string, number> = {
  // 그냥 획은 펜이 멈추면 한 번만 (획마다 부르면 숫자 한 글자에 세 번씩 불렀다)
  획: 1200,
  글자: 0,
  화살표: 0,
  덧그리기: 0,
  '다시 쓰기': 0,
  지우기: 250,
  가리키기: 0,
  말: 0,
  '말 중': 0,
  접속어: 0,
}

/** 같은 쌍을 다시 바꾸면 되풀이로 보는 시간. 실측에서 받아쓰기가 한 문장을 쪼개 "바꿔요"가 두 번 들어왔다 */
const SWAP_REPEAT_MS = 10000

/** 단계가 가리키는 객체 id. 대상 없는 restore는 전부 되돌리므로 모두를 가리킨다 */
function opRefs(ops: Op[], board: Board): string[] {
  return ops.flatMap((op) => {
    if (op.v === 'restore' && !op.id) return board.objs.map((o) => o.id)
    const o = op as { id?: unknown; along?: unknown; to?: unknown; from?: unknown; about?: unknown }
    return [o.id, o.along, o.to, o.from, o.about].filter((x): x is string => typeof x === 'string')
  })
}
/** "안 바뀐다"고 한 쌍을 숫자를 다시 말하지 않고는 바꾸지 않는 시간 */
const HELD_MS = 30000

/** 두 객체의 맞교환이면 그 쌍의 키 */
export function swapKey(ops: Op[]): string | null {
  const moves = ops.filter((op): op is Extract<Op, { v: 'move' }> => op.v === 'move')
  if (moves.length !== 2) return null
  const [a, b] = moves
  return a.to === b.id && b.to === a.id ? [a.id, b.id].sort().join('|') : null
}

/** 여러 입력을 묶을 때 계기 이름은 더 강한 신호로 */
export const shortModel = (m: ModelId) => (m === 'claude-haiku-5-5' ? 'Haiku 5.5' : 'Sonnet 5.5')

/** 받아쓰기 글자가 이만큼 그대로면 문장이 끝난 것으로 본다. 실측 받아쓰기는 문장 중간에도 0.65초씩 멈춰서 0.9초 */
export const PAUSE_MS = 900

/** 이 말로 끝나면 멈춤을 기다리지 않고 바로 확정 (동작을 마무리하는 말) */
export const ACTION_END =
  /(바꿔요|바꿉니다|바꿀게요|바꾸죠|바뀌어요|바뀝니다|바뀌죠|바뀔 거예요|옮겨요|옮깁니다|옮길게요|옮기죠|교환해요|교환합니다|교환하죠|이동해요|이동합니다|흘러가요|흘러가죠|흘러요|보내요|보냅니다|넣어요|넣습니다|빼요|꺼내요|밀려요|밀려나요|올라가요|내려가요|떨어져요|멈춰요|끊겨요)[.!?\s]*$/

export class Pipeline {
  readonly board = new Board()
  readonly engine: Engine
  readonly player: Player
  readonly speech: SpeechInput
  readonly scene: SceneParser

  settings: Settings = { model: 'claude-haiku-5-5', thinking: 'off', image: 'auto', early: true, quick: true, thr: 0.3, scene: true, stt: 'browser', gate: 'strict' }
  aiStatus: AiStatus = 'checking'
  aiNote = ''
  mic: MicState = 'off'
  micNote = ''
  reqs: ReqRecord[] = []
  utter: { text: string; t: number }[] = []
  interim = ''
  caption = ''
  aiRaw = ''
  shown: string[] = []
  quickLog: string[] = []
  /** 테스트 기록 훅 (개발용). 기본은 아무것도 안 함 */
  private logger: (type: string, data: Record<string, unknown>) => void = () => {}
  get log() { return this.logger }
  set log(logger: (type: string, data: Record<string, unknown>) => void) {
    this.logger = logger
    this.log('settings', { settings: { ...this.settings }, initial: true })
  }

  private logRequestUpdate(rec: ReqRecord, reason: string) {
    this.log('request-update', { rec: { ...rec }, reason })
  }

  private inflight: Inflight | null = null
  private pending: Trigger | null = null
  /** 확정 발화 요청이 끝난 뒤 부를 필기·미완성 발화 계기 */
  private deferred: Trigger | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private seq = 0
  private firedRules = new Set<string>()
  private actionSeq = 0
  private epoch = 0
  private focus: { ids: string[]; t: number } = { ids: [], t: 0 }
  /** 마지막으로 실행한 두 값 교환. 같은 말을 되풀이해 원래대로 되돌리는 것을 막는다 */
  private lastSwap: { key: string; t: number } | null = null
  /** "안 바뀌겠죠"라고 한 두 값 (실측: 바로 뒤의 "빨리 바뀐다"에 그 둘을 교환함) */
  private heldPair: { key: string; t: number } | null = null
  /** 멈춤 확정: 받아쓰기가 이 시간 동안 그대로면 우리가 문장을 확정한다 */
  private commitTimer: ReturnType<typeof setTimeout> | undefined
  /** 지금 받아쓰기 덩어리에서 이미 확정한 앞부분 (브라우저가 같은 덩어리를 계속 늘려 보낸다) */
  private committedRaw = ''
  private interimAt = 0
  private lastCallAt = 0
  private listeners = new Set<() => void>()
  private version = 0
  private notifyQueued = false

  /** 마지막으로 화면에 재생된 AI 요청 (✓/✗ 피드백 대상) */
  lastPlayed: ReqRecord | null = null
  submitted = 0

  /** headless: 브라우저 없이(채점 등) 돌릴 때. 프록시 확인·캐시 데우기·이미지 없이 바로 준비 상태 */
  constructor(bus: InkBus, opts: { headless?: boolean } = {}) {
    this.engine = new Engine(this.board, (strokeIds, hidden) => bus.request({ type: 'hideStrokes', strokeIds, hidden }))
    this.player = new Player(this.engine, {
      onFirstOp: (step, now) => {
        const r = this.reqs.find((x) => x.id === step.reqId)
        if (r && r.tFirstOp == null) r.tFirstOp = now
        if (r && r.tFirstMove == null && step.ops.some((op) => op.v === 'move')) r.tFirstMove = now
        if (r) this.logRequestUpdate(r, 'first-op')
        this.log('applied', { reqId: step.reqId, actionId: step.commitKey, ops: step.ops })
        this.notifySoon()
      },
      onCaption: (step) => {
        this.lastPlayed = this.reqs.find((r) => r.id === step.reqId) ?? this.lastPlayed
        this.caption = step.cap
        this.shown.push(step.cap)
        if (this.shown.length > 20) this.shown.shift()
        this.notifySoon()
      },
      onRejected: (step, reason) => {
        const r = this.reqs.find((x) => x.id === step.reqId)
        if (r) { r.rejected = (r.rejected ?? 0) + 1; r.status = `보류: ${reason}` }
        if (r) this.logRequestUpdate(r, 'rejected')
        this.log('rejected', { reqId: step.reqId, reason, ops: step.ops, ...this.stateForLog() })
        this.player.drop(step.reqId)
        this.notifySoon()
      },
    })
    this.scene = new SceneParser({
      board: this.board,
      // 장면 해석은 정확도가 중요하고 1초 예산 밖이라 항상 Haiku·생각 끔·큰 이미지
      call: (imageB64, text, signal) => sceneCall({ model: 'claude-haiku-5-5', thinking: 'off' }, imageB64, text, signal),
      snapshot: () => snapshotB64(this.board, this.engine, 960, true),
      keep: (id) => this.engine.isTakenOver(id),
      speech: () => this.utter.slice(-6).map((u) => u.text),
      log: (type, data) => this.log(type, data),
      onApplied: ({ removed }) => {
        if (removed.length) this.engine.forget(removed)
        this.notifySoon()
      },
      onStatus: () => this.notifySoon(),
    })
    this.speech = new SpeechInput({
      onInterim: (text, t) => this.onInterim(text, t),
      onFinal: (text, t) => this.onFinal(text, t),
      onState: (state, note) => {
        this.mic = state
        this.micNote = note ?? ''
        this.log('mic', { state, note })
        this.notify()
      },
      onDiagnostic: (event, detail) => this.log('speech', { event, ...detail }),
    })
    bus.onInk((e) => this.handleInk(e))
    if (opts.headless) {
      this.aiStatus = 'ready'
      this.settings.image = 'off'
      this.settings.scene = false
      return
    }
    void this.checkProxy()
    // 5분 캐시가 식기 전에 다시 데움 (한동안 요청이 없을 때만)
    setInterval(() => {
      if (this.aiStatus === 'ready' && performance.now() - this.lastCallAt > 4 * 60 * 1000) void this.warm()
    }, 30 * 1000)
  }

  // ---------- 화면 갱신 구독 (React useSyncExternalStore) ----------
  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }
  getVersion = () => this.version
  private notify() {
    this.version++
    this.listeners.forEach((f) => f())
  }
  private notifySoon() {
    if (this.notifyQueued) return
    this.notifyQueued = true
    requestAnimationFrame(() => {
      this.notifyQueued = false
      this.notify()
    })
  }

  // ---------- 설정 ----------
  get aiOptions(): AiOptions {
    return { model: this.settings.model, thinking: this.settings.thinking }
  }

  cfgKey() {
    const s = this.settings
    return `${shortModel(s.model)}/${s.thinking === 'off' ? '생각끔' : '생각켬'}/${{ off: '좌표', auto: '이미지자동', on: '이미지' }[s.image]}/${s.early ? '멈춤확정' : '브라우저확정'}/${s.quick ? '즉시켬' : '즉시끔'}/확신${s.thr}${s.scene ? '/장면' : ''}/듣기:${s.stt}/규칙:${s.gate}`
  }

  update(patch: Partial<Settings>) {
    const rewarm = (patch.model && patch.model !== this.settings.model) || (patch.thinking && patch.thinking !== this.settings.thinking)
    this.settings = { ...this.settings, ...patch }
    if (patch.stt) this.speech.setProvider(patch.stt)
    this.log('settings', { settings: { ...this.settings } })
    if (rewarm) void this.warm()
    this.notify()
  }

  private async checkProxy() {
    try {
      const s = await proxyStatus()
      if (s.locked) {
        this.aiStatus = 'locked'
        this.aiNote = '접속 코드가 없어 AI를 쓸 수 없어요. 서버 터미널에 나온 주소(?k=…)로 다시 여세요.'
      } else if (!s.anthropic) {
        this.aiStatus = 'nokey'
        this.aiNote = '.env에 ANTHROPIC_API_KEY가 없어요. 즉시 반응만 동작해요.'
      } else {
        this.aiStatus = 'ready'
        void this.warm()
      }
    } catch {
      this.aiStatus = 'error'
      this.aiNote = '개발 서버 프록시에 연결하지 못했어요 (npm run dev로 실행했는지 확인)'
    }
    this.notify()
  }

  private async warm() {
    this.lastCallAt = performance.now()
    try {
      await prewarm(this.aiOptions)
      this.aiNote = `캐시 데움 · ${shortModel(this.settings.model)}`
    } catch (err) {
      const d = describeError(err)
      if (d.noKey) this.aiStatus = 'nokey'
      this.aiNote = `미리 데우기 실패: ${d.text}`
    }
    this.notify()
  }

  // ---------- 입력 ----------
  private handleInk(e: InkEvent) {
    const reset = e.type === 'page' || e.type === 'clear'
    if (e.type === 'page') this.speech.setPageText(e.info.text)
    if (reset) {
      this.scene.reset()
      this.resetAnimation()
      this.utter = []
      this.focus = { ids: [], t: 0 }
    }
    const before = this.board.objs.map((o) => o.id)
    this.log('ink', { event: e })
    const ev = this.board.apply(e)
    this.log('board', { event: ev, ...this.stateForLog() })
    if (reset) return
    if (e.type === 'erase') this.engine.forget(before.filter((id) => !this.board.get(id)))
    if (e.type !== 'point' && this.settings.scene && this.aiStatus === 'ready') this.scene.schedule()
    if (!ev) {
      this.notify()
      return
    }
    const quickMs = this.quick(quickFromBoard(ev, this.board), ev.t, ev.kind)
    this.schedule({ kind: ev.kind, desc: ev.desc, t: ev.t, quickMs, grounding: {
      id: `${this.epoch}:ink:${++this.actionSeq}`, phase: 'ink', text: ev.desc,
      targets: ev.objId ? [ev.objId] : [], move: ev.kind === '가리키기',
      flow: ev.kind === '화살표' || ev.kind === '덧그리기', stop: false, sort: false, restore: false, negated: false,
    } })
  }

  /** 즉시 반응 실행. 실행했으면 행동부터 걸린 ms */
  private quick(ops: Op[], t0: number, label: string): number | undefined {
    if (!this.settings.quick || !ops.length) return undefined
    const now = performance.now()
    const reason = this.engine.validateStep(ops)
    if (reason) { this.log('rejected', { kind: 'quick', reason, ops }); return undefined }
    this.engine.beginStep()
    for (const op of ops) this.engine.applyOp(op, now)
    const ms = now - t0
    this.log('quick', { label, ops, ms: Math.round(ms) })
    this.quickLog.unshift(`${label} → ${ops.map((o) => o.v).join(', ')} (${Math.round(ms)}ms)`)
    this.quickLog.length = Math.min(this.quickLog.length, 6)
    this.notifySoon()
    return ms
  }

  /**
   * 받아쓰기 중간 결과. AI는 부르지 않고(요청 폭주 방지), 문장이 끝났는지만 본다.
   * - 동작 말("바꿔요/옮겨요/흘러가요"…)로 끝나면 바로 확정
   * - 아니면 PAUSE_MS 동안 글자가 그대로일 때 확정 (브라우저가 확정을 미뤄도 넘어가게)
   */
  onInterim(text: string, t: number) {
    const raw = text.trim()
    const rest = this.afterCommitted(raw)
    this.interim = rest
    this.interimAt = t
    this.log('interim', { text: rest, raw })
    clearTimeout(this.commitTimer)
    if (rest && this.settings.early) {
      if (ACTION_END.test(rest)) this.commitInterim(raw, 'action')
      else this.commitTimer = setTimeout(() => this.commitInterim(raw, 'pause'), PAUSE_MS)
    }
    this.notifySoon()
  }

  /** 브라우저가 보낸 확정. 이미 멈춤 확정한 앞부분은 잘라낸다 */
  onFinal(text: string, tEnd: number) {
    clearTimeout(this.commitTimer)
    const rest = this.afterCommitted(text.trim())
    this.committedRaw = ''
    if (!rest) {
      this.log('final-dup', { text: text.trim() })
      this.interim = ''
      this.notifySoon()
      return
    }
    this.finalize(rest, tEnd, 'browser')
  }

  private commitInterim(raw: string, why: 'pause' | 'action') {
    const rest = this.afterCommitted(raw)
    if (!rest) return
    this.committedRaw = raw
    this.finalize(rest, this.interimAt || performance.now(), why)
  }

  /** raw 가 이미 확정한 덩어리로 시작하면 그 뒤만. 새 덩어리면 확정 기록을 비우고 전체 */
  private afterCommitted(raw: string) {
    if (!this.committedRaw) return raw
    const key = (s: string) => s.replace(/[\s.,!?~…]/g, '')
    const done = key(this.committedRaw)
    const now = key(raw)
    if (!now.startsWith(done)) {
      // 받아쓰기가 앞부분을 고쳐 쓴 경우("을"→"의")는 같은 덩어리로 본다: 같은 자리 글자가 70% 이상 같으면 확정한 길이만큼 자른다
      let same = 0
      for (let k = 0; k < done.length && k < now.length; k++) if (done[k] === now[k]) same++
      if (same < 0.7 * done.length || now.length < done.length) {
        this.committedRaw = ''
        return raw
      }
    }
    let seen = 0
    let i = 0
    while (i < raw.length && seen < done.length) {
      if (!/[\s.,!?~…]/.test(raw[i])) seen++
      i++
    }
    // 남은 게 문장부호뿐이면(브라우저 확정 끝의 ".") 새 말이 아니다
    return raw.slice(i).replace(/^[\s.,!?~…]+/, '').trim()
  }

  private finalize(text: string, tEnd: number, why: 'pause' | 'action' | 'browser') {
    const final = text.trim()
    this.log('final', { text: final, why })
    this.interim = ''
    if (!final) {
      this.firedRules.clear()
      return
    }
    // 어미만 따로 확정된 조각은 앞 문장의 끝이다. 새 실행 단위로 앞 요청을 취소하지 않는다
    // (실측 083151: "위에 C가 쌓여" 뒤의 "요"가 스택 요청을 취소함)
    const last = this.utter.at(-1)
    if (last && tEnd - last.t < 4000 && /^(?:요|죠|네요|어요|에요|예요|다)[.?!]*$/.test(final)) {
      last.text += final
      this.firedRules.clear()
      return
    }
    // 미완성 발화는 강조만 했다. 확정 발화는 한 개의 새로운 실행 단위다.
    clearTimeout(this.timer)
    this.pending = null
    this.deferred = null
    this.abortInflight('중단(확정 발화)')
    this.player.cancelPending()
    const grounding = this.speechGrounding(final, tEnd, 'final')
    if (grounding.negated && grounding.targets.length === 2) this.heldPair = { key: [...grounding.targets].sort().join('|'), t: tEnd }
    if (/(비교|비유|더\s*크|더\s*작)/.test(final) || grounding.targets.length === 2) {
      const next = final.split(/그\s*다음(?:에)?/).at(-1)!
      const nextGrounding = next !== final ? this.speechGrounding(next, tEnd, 'preview') : grounding
      this.focus = { ids: nextGrounding.targets, t: tEnd }
    }
    const quickMs = this.quick(quickFromSpeech(final, this.board, this.engine, this.firedRules), tEnd, '말')
    this.firedRules.clear()
    this.utter.push({ text: final, t: tEnd })
    if (this.utter.length > 30) this.utter.shift()
    this.schedule({ kind: '말', desc: `발화: "${final}"`, t: tEnd, quickMs, grounding })
  }

  private speechGrounding(text: string, t: number, phase: 'preview' | 'final') {
    return groundSpeech(this.board, text, t - this.focus.t < 30000 ? this.focus.ids : [],
      `${this.epoch}:speech:${phase === 'final' ? ++this.actionSeq : this.actionSeq + 1}`, phase, this.engine)
  }

  /** 받아쓰기 칸 등에서 문장을 직접 넣을 때 */
  say(text: string) {
    const t = performance.now()
    clearTimeout(this.commitTimer)
    this.committedRaw = ''
    this.finalize(text, t, 'browser')
  }

  private schedule(trig: Trigger) {
    const finalPlaying = [this.player.current, ...this.player.queue].some((s) => s && this.reqs.find((r) => r.id === s.reqId)?.kind === '말')
    if (trig.grounding?.phase === 'preview' && (this.pending?.grounding?.phase === 'final' || this.inflight?.rec.kind === '말' || finalPlaying)) return
    // 말하는 중 미리 부르기는 한 번에 하나만. 진행 중이면 끝난 뒤 최신 내용으로 다시 부른다
    if (trig.kind === '말 중' && this.inflight && !this.pending) {
      return
    }
    if (this.pending?.grounding?.phase === 'final' && trig.grounding?.phase !== 'final') return
    this.pending = { ...trig }
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      const next = this.pending
      this.pending = null
      if (next) void this.run(next)
    }, DELAY[trig.kind] ?? 0)
  }

  private abortInflight(status: string) {
    const inf = this.inflight
    if (!inf) return
    this.inflight = null
    inf.rec.status = status
    inf.rec.tEnd = performance.now()
    this.logRequestUpdate(inf.rec, 'abort')
    inf.ctrl.abort()
    this.player.drop(inf.rec.id)
  }

  private async run(trig: Trigger) {
    if (this.aiStatus !== 'ready') return
    if (!this.board.objs.length && !this.utter.length && !this.interim) return
    // 말한 직후 필기하면 확정 발화 요청이 취소되고, 이동 권한이 없는 필기 요청만 남아 아무것도 움직이지 않았다 (실측 043036, 050404)
    if (this.inflight?.final && trig.grounding?.phase !== 'final') {
      this.deferred = trig
      return
    }
    this.abortInflight('중단(새 입력)')
    const settings = { ...this.settings }
    const rec: ReqRecord = {
      settings,
      id: ++this.seq,
      kind: trig.kind,
      desc: trig.desc,
      t0: trig.t,
      quickMs: trig.quickMs,
      status: '진행 중',
      cap: '',
      cfg: this.cfgKey(),
      actionId: trig.grounding?.id,
    }
    this.reqs.push(rec)
    if (this.reqs.length > 300) this.reqs.shift()
    const ctrl = new AbortController()
    const inf: Inflight = { rec, ctrl, final: trig.grounding?.phase === 'final' }
    this.inflight = inf
    this.lastCallAt = performance.now()

    // 시작부터 기록해 준비 중 실패하거나 페이지를 닫아도 시도한 요청이 남는다.
    this.log('request-start', { rec: { ...rec } })
    let prompt = ''
    let imageB64: string | undefined
    const consumer = this.consume(rec, trig.grounding, ctrl.signal, settings.thr)
    try {
      const g = trig.grounding
      const restore = g?.phase === 'final' ? planRestore(this.engine, g) : null
      const plan = restore ?? (g?.phase === 'final' ? g.sort ? planNumericSort(this.board, this.engine, g.text) : planNumericSwap(this.board, this.engine, g) : null)
      if (plan) {
        rec.model = restore ? 'local-restore' : g?.sort ? 'local-numeric-sort' : 'local-numeric-swap'
        rec.cfg += '/로컬이동'
        consumer.onText(JSON.stringify({ conf: 1, ...plan }) + '\n')
        rec.tDone = rec.tEnd = performance.now()
        rec.status = consumer.finish()
      } else {
      const content: Anthropic.ContentBlockParam[] = []
      // 자동: 아직 값을 안 읽은 손글씨가 있을 때만 이미지 (다 읽었으면 글자로 충분하고 더 빠르다)
      rec.image = settings.image === 'on' || (settings.image === 'auto' && this.board.values().some((o) => o.kind === 'mark' && !o.read))
      imageB64 = rec.image ? snapshotB64(this.board, this.engine) : undefined
      if (imageB64) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageB64 } })
      prompt = buildUserPrompt({
        board: this.board,
        engine: this.engine,
        utter: this.utter,
        interim: this.interim,
        shown: this.shown,
        trigger: trig.desc,
        now: performance.now(),
      }) + (trig.grounding ? '\n' + describeGrounding(trig.grounding, settings.gate) : '')
      content.push({ type: 'text', text: prompt })
      rec.tSend = performance.now()
      this.log('request-update', { rec: { ...rec }, reason: 'send', prompt, imageB64 })
      this.notify()

      const res = await streamSteps({ model: settings.model, thinking: settings.thinking }, content, ctrl.signal, consumer.onText)
      // 취소 직전에 끝난 응답이 뒤늦게 도착해도 중단 기록을 덮어쓰지 않는다.
      if (!ctrl.signal.aborted) {
        rec.tDone = performance.now()
        rec.tEnd = rec.tDone
        rec.model = res.model
        rec.cacheRead = res.cacheRead
        rec.inputTokens = res.inputTokens
        rec.outputTokens = res.outputTokens
        rec.status = consumer.finish()
      }
      }
    } catch (err) {
      consumer.finish(false)
      const d = describeError(err)
      if (!ctrl.signal.aborted) {
        rec.tEnd = performance.now()
        rec.status = d.aborted ? '중단' : `오류: ${d.text}`
        if (d.noKey) {
          this.aiStatus = 'nokey'
          this.aiNote = d.text
        }
      }
    }
    if (this.inflight === inf) {
      this.inflight = null
    }
    this.log('request', { rec: { ...rec }, prompt, raw: consumer.raw(), imageB64 })
    this.notify()
    const next = this.deferred
    this.deferred = null
    if (next && !this.inflight && !this.pending) void this.run(next)
  }

  /** AI가 읽은 손글씨 값을 기억 (이미 읽은 건 덮어쓰지 않음) */
  private applyRead(read: Record<string, string>) {
    for (const [id, v] of Object.entries(read)) {
      const o = this.board.get(id)
      // 값은 손글씨에만 기억한다 (선에 값을 붙이면 밑줄을 숫자로 착각함)
      // '?'·빈 값은 못 읽은 것이므로 기억하지 않는다
      if (o && o.kind === 'mark' && !this.board.underlineOf(id) && !o.read && v.trim() && !/^[?？]+$/.test(v.trim())) o.read = v.trim()
    }
  }

  /** 진행 중인 AI 요청·대기·재생이 있는지 (채점에서 반응이 끝날 때까지 기다릴 때) */
  busy() {
    return !!this.inflight || !!this.pending || !!this.deferred || !!this.player.current || this.player.queue.length > 0
  }

  /** 마지막 AI 반응에 대한 ✓/✗ */
  feedback(ok: boolean, note = '') {
    const r = this.lastPlayed
    if (!r) return
    r.feedback = ok ? 'ok' : 'bad'
    this.logRequestUpdate(r, 'feedback')
    this.log('feedback', { reqId: r.id, ok, note, cap: r.cap, kind: r.kind, desc: r.desc, utter: this.utter.slice(-3).map((u) => u.text), ...this.stateForLog() })
    this.notify()
  }

  /** 실측 하나를 끝내고 검토 대상으로 보냄 */
  submit(note = '') {
    this.submitted++
    this.log('submit', { note, ...this.stateForLog() })
    this.notify()
  }

  /** 기록용 현재 상태 요약 */
  stateForLog() {
    const r = Math.round
    return {
      objs: this.board.objs.map((o) => ({
        id: o.id,
        kind: o.kind,
        bbox: [r(o.bbox.x), r(o.bbox.y), r(o.bbox.w), r(o.bbox.h)],
        position: this.engine.settled(o.id),
        annotationOf: this.board.underlineOf(o.id),
        strokes: o.strokes.map((s) => s.id),
        ...(o.text ? { text: o.text } : {}),
        ...(o.arrowEnd ? { arrowEnd: o.arrowEnd } : {}),
        ...(o.read ? { read: o.read } : {}),
        ...(o.role ? { role: o.role } : {}),
        ...(o.label ? { label: o.label } : {}),
      })),
      overlaps: this.engine.overlaps(),
      flows: this.engine.flows.map((f) => f.along),
    }
  }

  /** 테스트 중 "의도와 다름"을 표시: 메모와 그 순간의 화면·상태를 기록 */
  markIssue(note: string) {
    this.log('issue', {
      note,
      caption: this.caption,
      shown: this.shown.slice(-6),
      utter: this.utter.slice(-5).map((u) => u.text),
      lastRaw: this.aiRaw,
      ...this.stateForLog(),
      imageB64: snapshotB64(this.board, this.engine, 1280),
    })
  }

  /** 스트리밍으로 쌓이는 응답 글자를 단계·동작으로 바꿔 바로 재생에 넘긴다 */
  private consume(rec: ReqRecord, grounding?: Grounding, signal?: AbortSignal, threshold = this.settings.thr) {
    // 요청을 시작할 때의 규칙으로 끝까지 판단한다
    const gate = this.settings.gate
    const seen = new Set<number>()
    const epoch = this.epoch
    let expectedLayout = this.engine.layoutSnapshot()
    const readVersions = new Map(this.board.objs.map((o) => [o.id, o.t]))
    let made = 0
    let gated = false
    let none = false
    let last = ''
    const onText = (full: string) => {
      if (signal?.aborted || epoch !== this.epoch) return
      last = full
      if (rec.tFirst == null) {
        rec.tFirst = performance.now()
        this.logRequestUpdate(rec, 'first-token')
      }
      this.aiRaw = full
      const parsed = parseProgress(full)
      none = parsed.none
      this.applyRead(Object.fromEntries(Object.entries(parsed.read).filter(([id]) => this.board.get(id)?.t === readVersions.get(id))))
      parsed.steps.forEach((ps, i) => {
        if (i === 0 && ps.conf != null) {
          rec.conf = ps.conf
          if (ps.conf < threshold) gated = true
        }
        if (gated || rec.rejected || !ps.closed || seen.has(i)) return
        seen.add(i)
        const sanitized = ps.ops.map(sanitizeOp)
        // 말한 방향과 반대로 민 이동은 부호를 바로잡는다
        const ops = grounding?.phase === 'final' && sanitized.every(Boolean) ? alignDirection(sanitized as Op[], grounding.text) : sanitized
        if (ops.some((op, k) => op !== sanitized[k])) this.log('aligned', { reqId: rec.id, from: sanitized, to: ops })
        const reject = (reason: string) => {
          rec.rejected = (rec.rejected ?? 0) + 1
          this.logRequestUpdate(rec, 'rejected')
          this.log('rejected', { reqId: rec.id, reason, ops, ...this.stateForLog() })
        }
        if (!ps.valid || ops.some((op) => !op)) { reject('완성된 유효한 동작 묶음이 아님'); return }
        if (!ops.length) return
        const swap = swapKey(ops as Op[])
        const now = performance.now()
        const text = grounding?.text ?? ''
        // 같은 쌍을 연달아 바꾸면 그 사이에 다른 이동이 없었다는 뜻이다. "다시"라고 하지 않았으면 되풀이한 말로 본다
        // (실측: 교환이 막히자 "5와 3이 바뀝니다"를 20초 동안 세 번 말함)
        const repeat = swap && this.lastSwap?.key === swap && (now - this.lastSwap.t < SWAP_REPEAT_MS || !/다시|또|한\s*번\s*더/.test(text)) ? '방금 바꾼 두 값을 다시 바꿈(되풀이한 말)'
          : swap && this.heldPair?.key === swap && now - this.heldPair.t < HELD_MS && !mentionedValues(text).length ? '안 바뀐다고 한 두 값' : null
        if (repeat) { reject(repeat); return }
        // 근거 없는 동작만 빼고 나머지는 실행한다
        const kept = grounding ? keepGrounded(ops as Op[], grounding, this.board, gate) : { ops: ops as Op[], dropped: [], reason: null }
        if (!kept.ops.length) { reject(kept.reason!); return }
        if (kept.dropped.length) this.log('rejected', { reqId: rec.id, reason: kept.reason, ops: kept.dropped, partial: true, ...this.stateForLog() })
        const validOps = kept.ops
        const mutations = validOps.filter((op) => op.v === 'move').map((op) => [op.id, op.to, op.along]).sort()
        const st: PlayStep = {
          reqId: rec.id, ops: validOps, applied: 0, cap: ps.cap, capShown: false, open: false, startedAt: null, maxDur: 0,
          commitKey: `${grounding?.id ?? rec.id}:${mutations.length ? JSON.stringify(mutations) : i}`,
          validate: () => signal?.aborted || epoch !== this.epoch ? '취소되거나 이전 페이지의 요청'
            : this.engine.layoutChanged(expectedLayout, opRefs(validOps, this.board)) ? '요청 이후 칠판 배치가 바뀜'
            : grounding ? rejectUngrounded(validOps, grounding, this.board, gate) : null,
          onApplied: () => {
            expectedLayout = this.engine.layoutSnapshot()
            // 다른 이동이 끼면 되풀이가 아니라 새 교환이므로 기록을 바꾼다
            if (validOps.some((op) => op.v === 'move')) this.lastSwap = swap ? { key: swap, t: performance.now() } : null
            // 되돌린 뒤 같은 교환을 다시 보여주는 것은 되풀이가 아니다
            if (validOps.some((op) => op.v === 'restore')) this.lastSwap = null
            this.log('state', { reqId: rec.id, ...this.stateForLog() }) },
        }
        made++
        if (!rec.cap) rec.cap = ps.cap
        this.player.push(st)
      })
      // 다음 화면 갱신(최대 16ms)을 기다리지 않고 도착한 동작을 바로 실행
      this.player.tick(performance.now())
      this.notifySoon()
    }
    const finish = (success = true) => {
      // 중단/오류에서 부분 JSON을 닫아 실행하지 않는다.
      if (success && last) {
        const raw = last
        onText(raw + '\n')
        last = raw
      }
      if (gated) return `확신 낮음(${rec.conf?.toFixed(2)})`
      if (rec.rejected) return `보류(${rec.rejected})`
      if (made) return '재생'
      return none ? '새 움직임 없음' : '형식 오류'
    }
    return { onText, finish, raw: () => last }
  }

  /**
   * 개발용: 모델 대신 미리 쓴 응답을 조각조각 흘려보내 재생 경로를 시험한다 (API 키 없이).
   * 브라우저 콘솔에서 window.__pipeline.simulate('{"conf":0.9,"ops":[...],"cap":"..."}\n')
   */
  async simulate(text: string, chunk = 12, gapMs = 30) {
    const rec: ReqRecord = { id: ++this.seq, kind: '시뮬레이션', desc: '개발용 가짜 응답', t0: performance.now(), status: '진행 중', cap: '', cfg: '시뮬레이션' }
    this.reqs.push(rec)
    rec.tSend = rec.t0
    const consumer = this.consume(rec)
    for (let i = chunk; i < text.length + chunk; i += chunk) {
      await new Promise((r) => setTimeout(r, gapMs))
      consumer.onText(text.slice(0, i))
    }
    rec.tDone = performance.now()
    rec.status = consumer.finish()
    this.notify()
    return rec
  }

  // ---------- 화면 ----------
  tick(now: number, dt: number) {
    this.player.tick(now)
    this.engine.tick(now, dt)
  }

  resetAnimation() {
    this.epoch++
    this.lastSwap = null
    this.heldPair = null
    clearTimeout(this.timer)
    this.pending = null
    this.deferred = null
    this.interim = ''
    clearTimeout(this.commitTimer)
    this.committedRaw = ''
    this.firedRules.clear()
    this.abortInflight('중단(초기화)')
    this.engine.reset()
    this.player.clear()
    this.shown = []
    this.caption = ''
    this.lastPlayed = null
    this.notify()
  }

  clearRecords() {
    this.reqs = []
    this.notify()
  }
}
