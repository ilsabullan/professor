import type Anthropic from '@anthropic-ai/sdk'
import type { InkBus } from '../shared/bus'
import type { InkEvent } from '../shared/ink'
import { type AiOptions, describeError, type ModelId, prewarm, proxyStatus, streamSteps, type ThinkingMode } from './ai/client'
import { parseProgress } from './ai/parse'
import { buildUserPrompt } from './ai/prompt'
import { Board } from './board'
import { Engine, Player, type PlayStep } from './engine'
import type { ReqRecord } from './metrics'
import { type Op, sanitizeOp } from './ops'
import { CONNECTIVES, quickFromBoard, quickFromSpeech } from './quick'
import { snapshotB64 } from './snapshot'
import { type MicState, SpeechInput } from './speech'

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
}

export type AiStatus = 'checking' | 'ready' | 'nokey' | 'locked' | 'error'

interface Trigger {
  kind: string
  desc: string
  t: number
  quickMs?: number
}

interface Inflight {
  rec: ReqRecord
  ctrl: AbortController
  interimText: string
}

/** 계기별로 AI를 부르기 전 기다리는 시간(ms). 짧을수록 빠르고, 연달아 오는 입력은 하나로 묶는다 */
const DELAY: Record<string, number> = {
  획: 80,
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

/** 여러 입력을 묶을 때 계기 이름은 더 강한 신호로 */
const PRECEDENCE = ['획', '글자', '말 중', '말', '지우기', '가리키기', '덧그리기', '화살표', '다시 쓰기', '접속어']

const norm = (s: string) => s.replace(/[\s.,!?~…]/g, '')

/** 미리 보낸(말하는 중) 내용과 확정된 말이 사실상 같은지 */
function sameSpeech(interim: string, final: string) {
  const a = norm(interim)
  const b = norm(final)
  if (!a) return false
  return b.startsWith(a) ? b.length - a.length <= 4 : a === b
}

export const shortModel = (m: ModelId) => (m === 'claude-haiku-5-5' ? 'Haiku 5.5' : 'Sonnet 5.5')

export class Pipeline {
  readonly board = new Board()
  readonly engine: Engine
  readonly player: Player
  readonly speech: SpeechInput

  settings: Settings = { model: 'claude-haiku-5-5', thinking: 'off', image: 'auto', early: true, quick: true, thr: 0.3 }
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

  private inflight: Inflight | null = null
  private lastSpec: { text: string; rec: ReqRecord; doneAt: number } | null = null
  private pending: Trigger | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private seq = 0
  private firedRules = new Set<string>()
  private connCount = 0
  private lastEarlyLen = 0
  private interimDirty = false
  private lastCallAt = 0
  private listeners = new Set<() => void>()
  private version = 0
  private notifyQueued = false

  constructor(bus: InkBus) {
    this.engine = new Engine(this.board, (strokeIds, hidden) => bus.request({ type: 'hideStrokes', strokeIds, hidden }))
    this.player = new Player(this.engine, {
      onFirstOp: (step, now) => {
        const r = this.reqs.find((x) => x.id === step.reqId)
        if (r && r.tFirstOp == null) r.tFirstOp = now
        this.notifySoon()
      },
      onCaption: (step) => {
        this.caption = step.cap
        this.shown.push(step.cap)
        if (this.shown.length > 20) this.shown.shift()
        this.notifySoon()
      },
    })
    this.speech = new SpeechInput({
      onInterim: (text, t) => this.onInterim(text, t),
      onFinal: (text, t) => this.onFinal(text, t),
      onState: (state, note) => {
        this.mic = state
        this.micNote = note ?? ''
        this.notify()
      },
    })
    bus.onInk((e) => this.handleInk(e))
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
    return `${shortModel(s.model)}/${s.thinking === 'off' ? '생각끔' : '생각켬'}/${{ off: '좌표', auto: '이미지자동', on: '이미지' }[s.image]}/${s.early ? '미리' : '끝나고'}`
  }

  update(patch: Partial<Settings>) {
    const rewarm = (patch.model && patch.model !== this.settings.model) || (patch.thinking && patch.thinking !== this.settings.thinking)
    this.settings = { ...this.settings, ...patch }
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
    const before = this.board.objs.map((o) => o.id)
    const ev = this.board.apply(e)
    if (e.type === 'page' || e.type === 'clear') {
      this.resetAnimation()
      return
    }
    if (e.type === 'erase') this.engine.forget(before.filter((id) => !this.board.get(id)))
    if (!ev) {
      this.notify()
      return
    }
    const quickMs = this.quick(quickFromBoard(ev, this.board), ev.t, ev.kind)
    this.schedule({ kind: ev.kind, desc: ev.desc, t: ev.t, quickMs })
  }

  /** 즉시 반응 실행. 실행했으면 행동부터 걸린 ms */
  private quick(ops: Op[], t0: number, label: string): number | undefined {
    if (!this.settings.quick || !ops.length) return undefined
    const now = performance.now()
    for (const op of ops) this.engine.applyOp(op, now)
    const ms = now - t0
    this.quickLog.unshift(`${label} → ${ops.map((o) => o.v).join(', ')} (${Math.round(ms)}ms)`)
    this.quickLog.length = Math.min(this.quickLog.length, 6)
    this.notifySoon()
    return ms
  }

  onInterim(text: string, t: number) {
    this.interim = text.trim()
    const quickMs = this.quick(quickFromSpeech(this.interim, this.board, this.engine, this.firedRules), t, '말')
    const conn = this.interim.match(CONNECTIVES) ?? []
    if (conn.length > this.connCount) {
      this.connCount = conn.length
      this.schedule({ kind: '접속어', desc: `시간 접속어 "${conn[conn.length - 1]}" (다음 단계로 넘어감): "${this.interim}"`, t, quickMs })
    } else if (this.settings.early && this.interim.length - this.lastEarlyLen >= 4) {
      this.lastEarlyLen = this.interim.length
      this.schedule({ kind: '말 중', desc: `말하는 중: "${this.interim}"`, t, quickMs })
    }
    this.notifySoon()
  }

  onFinal(text: string, tEnd: number) {
    const final = text.trim()
    this.interim = ''
    this.lastEarlyLen = 0
    this.connCount = 0
    if (!final) {
      this.firedRules.clear()
      return
    }
    const quickMs = this.quick(quickFromSpeech(final, this.board, this.engine, this.firedRules), tEnd, '말')
    this.firedRules.clear()
    this.utter.push({ text: final, t: tEnd })
    if (this.utter.length > 30) this.utter.shift()
    // 말하는 중에 미리 보낸 요청이 같은 내용이면 그 결과를 그대로 쓴다
    const inf = this.inflight
    if (inf && inf.rec.kind === '말 중' && sameSpeech(inf.interimText, final)) {
      inf.rec.kind = '말(미리)'
      inf.rec.tSpeechEnd = tEnd
      this.notify()
      return
    }
    const spec = this.lastSpec
    if (spec && performance.now() - spec.doneAt < 3000 && sameSpeech(spec.text, final)) {
      spec.rec.kind = '말(미리)'
      spec.rec.tSpeechEnd = tEnd
      this.lastSpec = null
      this.notify()
      return
    }
    this.schedule({ kind: '말', desc: `발화: "${final}"`, t: tEnd, quickMs })
  }

  /** 받아쓰기 칸 등에서 문장을 직접 넣을 때 */
  say(text: string) {
    const t = performance.now()
    this.onFinal(text, t)
  }

  private schedule(trig: Trigger) {
    // 말하는 중 미리 부르기는 한 번에 하나만. 진행 중이면 끝난 뒤 최신 내용으로 다시 부른다
    if (trig.kind === '말 중' && this.inflight && !this.pending) {
      this.interimDirty = true
      return
    }
    const p = this.pending
    if (p) {
      p.desc = `${p.desc} / ${trig.desc}`
      if (PRECEDENCE.indexOf(trig.kind) > PRECEDENCE.indexOf(p.kind)) p.kind = trig.kind
      p.t = Math.max(p.t, trig.t)
      p.quickMs ??= trig.quickMs
    } else this.pending = { ...trig }
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
    inf.ctrl.abort()
    this.player.drop(inf.rec.id)
  }

  private async run(trig: Trigger) {
    if (this.aiStatus !== 'ready') return
    if (!this.board.objs.length && !this.utter.length && !this.interim) return
    this.abortInflight('중단(새 입력)')
    const rec: ReqRecord = {
      id: ++this.seq,
      kind: trig.kind,
      desc: trig.desc,
      t0: trig.t,
      quickMs: trig.quickMs,
      status: '진행 중',
      cap: '',
      cfg: this.cfgKey(),
    }
    this.reqs.push(rec)
    if (this.reqs.length > 300) this.reqs.shift()
    const ctrl = new AbortController()
    const inf: Inflight = { rec, ctrl, interimText: this.interim }
    this.inflight = inf
    this.lastCallAt = performance.now()

    const content: Anthropic.ContentBlockParam[] = []
    rec.image = this.settings.image === 'on' || (this.settings.image === 'auto' && this.board.objs.some((o) => o.kind === 'mark'))
    if (rec.image) {
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: snapshotB64(this.board, this.engine) } })
    }
    content.push({
      type: 'text',
      text: buildUserPrompt({
        board: this.board,
        engine: this.engine,
        utter: this.utter,
        interim: this.interim,
        shown: this.shown,
        trigger: trig.desc,
        now: performance.now(),
      }),
    })
    rec.tSend = performance.now()
    this.notify()

    const consumer = this.consume(rec)
    try {
      const res = await streamSteps(this.aiOptions, content, ctrl.signal, consumer.onText)
      rec.tDone = performance.now()
      rec.cacheRead = res.cacheRead
      rec.inputTokens = res.inputTokens
      rec.outputTokens = res.outputTokens
      rec.status = consumer.finish()
    } catch (err) {
      consumer.finish()
      const d = describeError(err)
      if (!d.aborted && !ctrl.signal.aborted) {
        rec.status = `오류: ${d.text}`
        if (d.noKey) {
          this.aiStatus = 'nokey'
          this.aiNote = d.text
        }
      }
    }
    if (this.inflight === inf) {
      this.inflight = null
      if (rec.kind === '말 중') this.lastSpec = { text: inf.interimText, rec, doneAt: performance.now() }
      if (this.interimDirty) {
        this.interimDirty = false
        if (this.interim && this.settings.early) this.schedule({ kind: '말 중', desc: `말하는 중: "${this.interim}"`, t: performance.now() })
      }
    }
    this.notify()
  }

  /** 스트리밍으로 쌓이는 응답 글자를 단계·동작으로 바꿔 바로 재생에 넘긴다 */
  private consume(rec: ReqRecord) {
    const made: PlayStep[] = []
    const rawSeen: number[] = []
    let gated = false
    let none = false
    const onText = (full: string) => {
      if (rec.tFirst == null) rec.tFirst = performance.now()
      this.aiRaw = full
      const parsed = parseProgress(full)
      none = parsed.none
      parsed.steps.forEach((ps, i) => {
        if (i === 0 && ps.conf != null) {
          rec.conf = ps.conf
          if (ps.conf < this.settings.thr) gated = true
        }
        if (gated) return
        let st = made[i]
        if (!st) {
          st = { reqId: rec.id, ops: [], applied: 0, cap: '', capShown: false, open: true, startedAt: null, maxDur: 0 }
          made[i] = st
          rawSeen[i] = 0
          this.player.push(st)
        }
        for (const raw of ps.ops.slice(rawSeen[i])) {
          const op = sanitizeOp(raw)
          if (op) st.ops.push(op)
        }
        rawSeen[i] = ps.ops.length
        if (ps.cap) st.cap = ps.cap
        if (i === 0 && ps.cap) rec.cap = ps.cap
        if (ps.closed) st.open = false
      })
      // 다음 화면 갱신(최대 16ms)을 기다리지 않고 도착한 동작을 바로 실행
      this.player.tick(performance.now())
      this.notifySoon()
    }
    const finish = () => {
      made.forEach((st) => (st.open = false))
      if (gated) return `확신 낮음(${rec.conf?.toFixed(2)})`
      if (made.some((s) => s.ops.length)) return '재생'
      return none ? '새 움직임 없음' : '형식 오류'
    }
    return { onText, finish }
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
    this.abortInflight('중단(초기화)')
    this.engine.reset()
    this.player.clear()
    this.shown = []
    this.caption = ''
    this.notify()
  }

  clearRecords() {
    this.reqs = []
    this.notify()
  }
}
