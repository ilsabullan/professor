import { type Board, KIND_KO, type SceneObj, type SceneResult, type SceneRole } from './board'

/**
 * 장면 해석: 펜을 뗀 뒤 잠깐 쉬면 칠판 이미지와 객체 목록을 LLM에 보내
 * 각 객체가 무엇인지(값·도형·화살표·칸·그림…)와 읽은 글자, 묶기·나누기를 받는다.
 * 애니메이션 요청(1초 예산)과 따로 돈다. 그사이 칠판이 바뀌면 결과를 버린다.
 */

export const SCENE_PROMPT = `너는 칠판 필기 장면 해석기다. 교수자가 강의 자료 위에 손으로 그린 필기를 이미지(빨간 글씨 = 객체 id)와 객체 목록으로 받는다. 객체 목록은 획 모양만 보고 자동으로 나눈 추정이라 틀릴 수 있다. 각 객체가 무엇인지 판단해 JSON 객체 하나만 출력한다. 코드블록·설명 금지.

출력: {"objs":{"o1":{"role":"box","label":"송신자"},"o4":{"role":"arrow","head":"end","from":"o1","to":"o2"},"o7":{"role":"value","read":"5"}},"merge":[["o12","o13"]],"split":{"o11":[["s50"],["s51"]]}}

role (하나만):
- value: 손으로 쓴 글자·숫자·단어·기호(read에 쓴 그대로. 한 글자씩이 아니라 객체 전체. 못 읽으면 read 생략)
- box: 닫힌 도형·노드(상자·원·말풍선). 안이나 옆에 쓴 이름이 있으면 label
- arrow: 화살표. head는 머리가 있는 쪽(획 목록의 시작점=start, 끝점=end). from/to는 꼬리·머리가 가리키는 객체(있을 때만)
- connector: 머리 없이 두 객체를 잇는 경로선. from/to
- frame: 표·배열 칸의 테두리·구분선, 축
- underline: 글자 아래 강조선. to에 꾸미는 객체
- drawing: 그림의 일부(심장 윤곽, 혈관, 세포막처럼 무엇을 그린 선). label에 무엇인지
- noise: 실수로 찍은 점, 의미 없는 짧은 획
label: 강의 맥락에서 그 객체가 나타내는 것(10자 이내). 확실할 때만.

묶기·나누기:
- merge: 한 글자·단어·도형인데 여러 객체로 쪼개졌으면 묶을 id들(앞 id로 합쳐짐). 확실할 때만.
- split: 한 객체에 서로 다른 것이 섞였으면 획 id(s…)를 나눈 묶음. 그 객체의 모든 획을 빠짐없이 한 번씩.
- merge/split 뒤의 결과 객체 기준으로 objs를 쓰지 않는다. objs는 지금 id 기준.

규칙: 목록의 id만 쓴다. 판단이 바뀌지 않은 객체도 모두 objs에 쓴다. 강의 자료 글자는 맥락일 뿐 그려진 것으로 치지 않는다.`

const ROLES: SceneRole[] = ['value', 'box', 'arrow', 'connector', 'frame', 'underline', 'drawing', 'noise']
const r = Math.round

/** 모델에 보내는 객체 목록 (획 id까지) */
export function describeScene(board: Board): string {
  const page = board.page
  const lines = board.objs.map((o) => {
    const b = o.bbox
    const geo = o.kind === 'line' && o.pts
      ? `시작(${r(o.pts[0].x)},${r(o.pts[0].y)}) 끝(${r(o.pts[o.pts.length - 1].x)},${r(o.pts[o.pts.length - 1].y)})${o.arrowEnd ? ` 머리추정:${o.arrowEnd}` : ''}`
      : ''
    const strokes = o.strokes.length > 1
      ? ' 획 ' + o.strokes.map((st) => {
          const xs = st.pts.map((p) => p.x)
          const ys = st.pts.map((p) => p.y)
          return `${st.id}[${r(Math.min(...xs))},${r(Math.min(...ys))},${r(Math.max(...xs) - Math.min(...xs))}x${r(Math.max(...ys) - Math.min(...ys))}]`
        }).join(' ')
      : ` 획 ${o.strokes[0]?.id ?? '-'}`
    const text = o.text ? ` "${o.text}"` : ''
    const prev = o.role ? ` 이전판단:${o.role}${o.read ? '=' + o.read : ''}${o.label ? '(' + o.label + ')' : ''}` : o.read ? ` 이전판독:${o.read}` : ''
    return `${o.id} ${KIND_KO[o.kind]}${text} x${r(b.x)} y${r(b.y)} w${r(b.w)} h${r(b.h)} ${geo}${strokes}${prev}`
  })
  return [
    `페이지 ${r(page.width)}×${r(page.height)}`,
    page.text ? `강의 자료 글자:\n${page.text.slice(0, 500)}` : '',
    `객체(그린 순서):\n${lines.join('\n')}`,
  ].filter(Boolean).join('\n')
}

const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() && !/^[?？]+$/.test(v.trim()) ? v.trim().slice(0, max) : undefined)
const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

/** 모델 응답을 안전한 장면 결과로. 형식이 깨졌으면 null */
export function parseScene(text: string): SceneResult | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let j: Record<string, unknown>
  try {
    j = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
  const objs: Record<string, SceneObj> = {}
  if (j.objs && typeof j.objs === 'object') {
    for (const [id, raw] of Object.entries(j.objs as Record<string, unknown>)) {
      if (!/^o\d+$/.test(id) || !raw || typeof raw !== 'object') continue
      const o = raw as Record<string, unknown>
      const role = ROLES.includes(o.role as SceneRole) ? (o.role as SceneRole) : undefined
      objs[id] = {
        role,
        read: role === 'value' ? str(o.read, 12) : undefined,
        label: str(o.label, 12),
        head: o.head === 'start' || o.head === 'end' ? o.head : undefined,
        from: str(o.from, 8),
        to: str(o.to, 8),
      }
    }
  }
  const merge = Array.isArray(j.merge) ? j.merge.map(ids).filter((g) => g.length >= 2) : []
  const split: Record<string, string[][]> = {}
  if (j.split && typeof j.split === 'object') {
    for (const [id, g] of Object.entries(j.split as Record<string, unknown>)) {
      if (Array.isArray(g)) split[id] = g.map(ids)
    }
  }
  return { objs, merge, split }
}

export interface SceneStatus {
  state: 'idle' | 'waiting' | 'running'
  /** 마지막 해석: 걸린 시간, 반영한 객체 수, 버림 여부 */
  last?: { ms: number; objs: number; merged: number; split: number; discarded?: string }
}

export interface SceneDeps {
  board: Board
  /** 모델 호출 (이미지 base64, 글자) → 응답 글자 */
  call: (imageB64: string | undefined, text: string, signal: AbortSignal) => Promise<{ text: string; model?: string }>
  snapshot: () => string | undefined
  keep: (id: string) => boolean
  log: (type: string, data: Record<string, unknown>) => void
  onApplied: (r: { removed: string[]; added: string[] }) => void
  onStatus: () => void
  idleMs?: number
}

export class SceneParser {
  status: SceneStatus = { state: 'idle' }
  private timer: ReturnType<typeof setTimeout> | undefined
  private ctrl: AbortController | null = null
  private seq = 0

  constructor(private d: SceneDeps) {}

  /** 필기가 바뀔 때마다 부른다. 잠깐 조용해지면 해석을 시작한다 */
  schedule() {
    clearTimeout(this.timer)
    this.abort()
    this.status.state = 'waiting'
    this.timer = setTimeout(() => void this.run(), this.d.idleMs ?? 600)
    this.d.onStatus()
  }

  reset() {
    clearTimeout(this.timer)
    this.abort()
    this.status = { state: 'idle' }
    this.d.onStatus()
  }

  private abort() {
    this.ctrl?.abort()
    this.ctrl = null
  }

  async run() {
    const { board } = this.d
    if (!board.objs.some((o) => o.kind !== 'text')) {
      this.status.state = 'idle'
      return
    }
    const id = ++this.seq
    const version = board.version
    const ctrl = new AbortController()
    this.ctrl = ctrl
    this.status.state = 'running'
    this.d.onStatus()
    const t0 = performance.now()
    const text = describeScene(board)
    const imageB64 = this.d.snapshot()
    this.d.log('scene-request', { id, version, prompt: text, imageB64 })
    let raw = ''
    let model: string | undefined
    try {
      const res = await this.d.call(imageB64, text, ctrl.signal)
      raw = res.text
      model = res.model
    } catch (err) {
      if (ctrl.signal.aborted) return
      this.finish({ ms: performance.now() - t0, objs: 0, merged: 0, split: 0, discarded: `오류: ${err instanceof Error ? err.message : String(err)}` })
      this.d.log('scene', { id, version, error: String(err) })
      return
    }
    if (ctrl.signal.aborted) return
    this.ctrl = null
    const ms = Math.round(performance.now() - t0)
    const parsed = parseScene(raw)
    const discarded = !parsed ? '형식 오류' : board.version !== version ? '해석 중 칠판이 바뀜' : undefined
    if (!parsed || discarded) {
      this.d.log('scene', { id, version, ms, model, raw, discarded })
      this.finish({ ms, objs: 0, merged: 0, split: 0, discarded })
      return
    }
    const applied = board.applyScene(parsed, this.d.keep)
    this.d.log('scene', {
      id, version, ms, model, raw, removed: applied.removed, added: applied.added,
      objs: board.objs.map((o) => ({ id: o.id, kind: o.kind, role: o.role, read: o.read, label: o.label, from: o.from, to: o.to, arrowEnd: o.arrowEnd, strokes: o.strokes.map((st) => st.id) })),
    })
    this.d.onApplied(applied)
    this.finish({ ms, objs: Object.keys(parsed.objs).length, merged: applied.removed.length, split: applied.added.length })
  }

  private finish(last: NonNullable<SceneStatus['last']>) {
    this.status = { state: 'idle', last: { ...last, ms: Math.round(last.ms) } }
    this.d.onStatus()
  }
}
