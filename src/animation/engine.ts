import type { Board, BoardObj } from './board'
import { type Pt, boxCenter, clamp, dist, pathLen, pointOnPath } from './geometry'
import type { Op } from './ops'

interface PathAnim {
  pts: Pt[]
  t0: number
  dur: number
  base: Pt
  /** 반복: 닫힌 경로는 계속 돌고(wrap), 열린 경로는 왕복(bounce). stop으로 멈춘다 */
  loop?: 'wrap' | 'bounce'
  /** 따라가는 선 id (stop along으로 멈출 때) */
  along?: string
}

/** 끝점이 서로 가까우면 닫힌 경로(궤도·순환) */
export function isClosedPath(pts: Pt[]) {
  if (pts.length < 3) return false
  return dist(pts[0], pts[pts.length - 1]) < Math.max(30, pathLen(pts) * 0.15)
}

/**
 * 선을 따라 이동할 실제 경로. 물체가 선 위(근처)에 있으면 선을 타고 가고, 떨어져 있으면 선의 모양대로
 * 제자리에서 같은 만큼 옮긴다 (그래프를 x축 "방향으로" 옮기라는데 그래프가 축 위로 뛰어가던 문제).
 * 사전 검사와 실행이 같은 도착지를 보도록 둘 다 이것을 쓴다.
 */
export function alongPath(line: Pt[], from: Pt): Pt[] {
  const onLine = line.some((q) => dist(q, from) < 40)
  return onLine ? line : line.map((q) => ({ x: q.x - line[0].x + from.x, y: q.y - line[0].y + from.y }))
}

interface AnimState {
  dx: number
  dy: number
  sc: number
  alpha: number
  color: string | null
  pulse: number
  labelText?: string
  path?: PathAnim | null
  /** 이동이 끝나면 도착할 오프셋 (애니메이션 중에도 계획은 이 값 기준) */
  gx?: number
  gy?: number
  /** 이 시각이 되면 사라짐 (그 전 300ms 동안 흐려짐) */
  removeAt?: number
  /** 회전 각도(라디안, 시계 방향 +)와 회전축(페이지 좌표). 없으면 자기 중심 */
  rot?: number
  pivot?: Pt
  /** 반복 회전: swing은 ±amp 왕복(진자), spin은 계속 회전(자전). stop id로 멈춘다. tilt는 그려진 자리가 수직에서 기운 각도(rad) */
  spin?: { mode: 'swing' | 'spin'; t0: number; period: number; amp: number; tilt?: number }
}

/** 즉시 반응이 만든 효과(q…)는 AI에게 알리지 않는다. AI가 대상 객체로 착각하지 않게 */
export const isEffectId = (id: string) => id.startsWith('q')

interface Spawned {
  shape: 'dot' | 'circle' | 'box' | 'label' | 'arrow'
  /** arrow: 페이지 좌표의 시작→끝 */
  pts?: Pt[]
  x: number
  y: number
  r: number
  w: number
  h: number
  text: string
  color: string
  /** 이동이 끝나면 도착할 자리 */
  gx?: number
  gy?: number
}

interface Flow {
  along: string
  n: number
  speed: number
  color: string
  rev: boolean
  phase: number
}

/** 한 번 보내는 패킷 묶음 (send) */
interface Burst {
  along: string
  n: number
  drop: number
  /** 버려지는 자리 (경로 위 비율 0~1) */
  dropAt: number
  color: string
  rev: boolean
  ack: boolean
  t0: number
  /** 패킷 하나가 경로를 지나는 시간 */
  travel: number
  /** 패킷 사이 간격 */
  gap: number
}

const DROP_FALL = 900

/** 경로 위에서 점 p와 가장 가까운 곳의 비율 (0=시작, 1=끝) */
function fractionOn(line: Pt[], p: Pt) {
  const total = pathLen(line) || 1
  let best = Infinity
  let at = 0
  let acc = 0
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i]
    const L = dist(a, b)
    const k = L ? clamp(((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (L * L), 0, 1) : 0
    const d = dist(p, { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k })
    if (d < best) { best = d; at = (acc + L * k) / total }
    acc += L
  }
  return at
}

interface Tween {
  set: (v: number) => void
  from: number
  to: number
  t0: number
  dur: number
  owner?: string
}

const INK = '#eef0e6'
const FONT = "'Nanum Pen Script', cursive"

/** 흰 종이(PDF) 위에서도 보이도록 칠판용 밝은 색을 같은 계열의 진한 색으로 바꾼다 */
const PAPER: Record<string, string> = {
  '#eef0e6': '#1f1f1f',
  '#cdf0ff': '#1e88e5',
  '#ffc65a': '#d98200',
  '#5ec8e6': '#0288d1',
  '#7be596': '#2e9d4f',
  '#93a39b': '#6b7280',
  '#6ea8ff': '#1e5eff',
  '#ff5a46': '#e53935',
}

/**
 * 진자 왕복 각도 (그려진 자리 기준 회전량). k는 경과 주기 수.
 * tilt가 없으면 그려진 자리를 가운데로 ±amp. 있으면 수직 아래를 가운데로 흔들어, 비스듬히 그린 진자가
 * 한쪽 끝에서 가운데까지만 오가지 않고 반대편 끝까지 간다. 진폭은 기운 각도 이상이라 시작할 때 튀지 않는다.
 */
export function swingAngle(amp: number, tilt: number | undefined, k: number): number {
  if (!tilt) return amp * Math.sin(2 * Math.PI * k)
  const A = Math.max(Math.abs(amp), Math.abs(tilt))
  const r = clamp(tilt / A, -1, 1)
  // 처음엔 수직 쪽으로 내려가게 위상을 고른다
  const phase = tilt >= 0 ? Math.acos(r) : -Math.acos(r)
  return A * Math.cos(2 * Math.PI * k + phase) - tilt
}

/**
 * 칠판 위 애니메이션 상태와 그리기.
 * 그린 객체(o…)를 움직이거나 색을 바꾸면 편집기에 원래 필기를 숨겨 달라고 요청하고, 여기서 대신 그린다.
 */
export class Engine {
  anim: Record<string, AnimState> = {}
  spawned: Record<string, Spawned> = {}
  flows: Flow[] = []
  /** 흰 종이 위에 그릴 때 true (PDF 편집기). 어두운 칠판이면 false */
  paper = false
  bursts: Burst[] = []
  /** 보낸 패킷 수 기록 (AI가 두 배·절반을 이어서 계산하게) */
  sent: { along: string; n: number; drop: number; ack: boolean; rev: boolean }[] = []
  private tweens: Tween[] = []
  private takenOver = new Set<string>()
  /** 지금 단계가 시작될 때의 위치 (한 단계 안의 move는 모두 이 기준으로 동시에 움직인다) */
  private frozen = new Map<string, Pt>()

  constructor(
    private board: Board,
    private hideStrokes: (strokeIds: string[], hidden: boolean) => void,
  ) {}

  private strokeIdsOf(o: BoardObj) {
    return o.kind === 'text' ? (o.srcId ? [o.srcId] : []) : o.strokes.map((s) => s.id)
  }

  reset() {
    for (const id of this.takenOver) {
      const o = this.board.get(id)
      if (o) this.hideStrokes(this.strokeIdsOf(o), false)
    }
    this.takenOver.clear()
    this.anim = {}
    this.spawned = {}
    this.flows = []
    this.bursts = []
    this.sent = []
    this.tweens = []
    this.frozen.clear()
  }

  /**
   * 지우개가 p 근처(반경 r)를 지남. 새로 생긴 것·이름표·흐름은 바로 지우고,
   * 대신 그리던(움직인) 필기에 닿으면 그 획 id를 돌려준다 (편집기가 실제 필기를 지운다)
   */
  eraseAt(p: Pt, r: number): { strokeIds: string[]; erased: string[] } {
    const erased: string[] = []
    const near = (cx: number, cy: number, hw: number, hh: number) =>
      Math.abs(p.x - cx) <= hw + r && Math.abs(p.y - cy) <= hh + r

    for (const [id, s] of Object.entries(this.spawned)) {
      const sc = this.anim[id]?.sc ?? 1
      const [hw, hh] =
        s.shape === 'dot'
          ? [s.r, s.r]
          : s.shape === 'circle'
            ? [s.r * 2, s.r * 2]
            : s.shape === 'box'
              ? [s.w / 2, s.h / 2]
              : [Math.max(10, s.text.length * 14), 16]
      const label = this.anim[id]?.labelText
      const onLabel = !!label && near(s.x, s.y - s.r - 20, label.length * 11, 14)
      if (near(s.x, s.y, hw * sc, hh * sc) || onLabel) {
        delete this.spawned[id]
        delete this.anim[id]
        erased.push(id)
      }
    }

    const strokeIds: string[] = []
    for (const o of this.board.objs) {
      const a = this.anim[o.id]
      if (!a) continue
      // 그린 객체 위 이름표
      if (a.labelText && near(o.bbox.x + o.bbox.w / 2 + a.dx, o.bbox.y + a.dy - 18, a.labelText.length * 11, 14)) {
        delete a.labelText
        erased.push(o.id + ':label')
      }
      if (!this.takenOver.has(o.id) || a.alpha <= 0.05) continue
      // 그린 자리 기준으로 되돌려서 원래 획과 비교 (drawObj의 회전 → 중심 기준 확대·이동을 거꾸로)
      const c = boxCenter(o.bbox)
      let x = p.x
      let y = p.y
      if (a.rot) {
        const pv = a.pivot ?? c
        const px = pv.x + a.dx
        const py = pv.y + a.dy
        const cos = Math.cos(-a.rot)
        const sin = Math.sin(-a.rot)
        ;[x, y] = [px + (x - px) * cos - (y - py) * sin, py + (x - px) * sin + (y - py) * cos]
      }
      const q = { x: (x - c.x - a.dx) / a.sc + c.x, y: (y - c.y - a.dy) / a.sc + c.y }
      const rr = r / a.sc + 4
      if (o.strokes.some((st) => st.pts.some((pt) => Math.hypot(pt.x - q.x, pt.y - q.y) <= rr))) {
        strokeIds.push(...this.strokeIdsOf(o))
        erased.push(o.id)
      }
    }

    const before = this.flows.length
    this.flows = this.flows.filter((f) => {
      const pts = this.linePts(f.along)
      return !pts?.some((pt) => Math.hypot(pt.x - p.x, pt.y - p.y) <= r + 6)
    })
    if (this.flows.length !== before) erased.push('flow')
    return { strokeIds, erased }
  }

  /** 지워진 객체의 애니메이션 정리 */
  forget(ids: string[]) {
    for (const id of ids) {
      delete this.anim[id]
      this.takenOver.delete(id)
      this.flows = this.flows.filter((f) => f.along !== id)
      this.bursts = this.bursts.filter((f) => f.along !== id)
    }
  }

  private A(id: string): AnimState {
    return (this.anim[id] ??= { dx: 0, dy: 0, sc: 1, alpha: 1, color: null, pulse: 0 })
  }

  private takeOver(id: string) {
    const o = this.board.get(id)
    if (!o || this.takenOver.has(id)) return
    this.takenOver.add(id)
    this.hideStrokes(this.strokeIdsOf(o), true)
  }

  private tween(set: (v: number) => void, from: number, to: number, dur: number, now: number, owner?: string) {
    this.tweens.push({ set, from, to, t0: now, dur: Math.max(1, dur), owner })
  }

  /** 애니메이션이 대신 그리고 있는 객체인지 (원래 필기는 숨겨짐) */
  isTakenOver(id: string) {
    return this.takenOver.has(id)
  }

  /** 새 단계 시작: 단계 시작 위치 기록을 비운다 */
  beginStep() {
    this.frozen.clear()
    for (const id of [...this.board.objs.map((o) => o.id), ...Object.keys(this.spawned)]) {
      const p = this.settled(id)
      if (p) this.frozen.set(id, p)
    }
  }

  /** 보간 중인 픽셀이 아닌 확정 도착점과 필기 버전으로 오래된 응답을 판별한다. */
  layoutKey() {
    return JSON.stringify([
      this.board.objs.map((o) => [o.id, o.t, o.strokes.length, o.bbox, this.settled(o.id)]),
      Object.keys(this.spawned).sort().map((id) => [id, this.settled(id)]),
    ])
  }

  /** 객체별 배치 기록. layoutChanged로 단계가 전제한 배치가 그대로인지 본다. */
  layoutSnapshot(): Map<string, { pos: string; ink: string }> {
    const out = new Map<string, { pos: string; ink: string }>()
    for (const o of this.board.objs) out.set(o.id, { pos: JSON.stringify(this.settled(o.id)), ink: JSON.stringify([o.t, o.strokes.length, o.bbox]) })
    for (const id of Object.keys(this.spawned)) out.set(id, { pos: JSON.stringify(this.settled(id)), ink: '' })
    return out
  }

  /**
   * 요청 이후 배치가 바뀌었는지. 기존 객체가 옮겨졌거나, 단계가 가리키는 객체의 필기가 바뀌거나 지워졌을 때만 바뀐 것으로 본다.
   * 새로 그은 획·무관한 획의 덧그리기는 무시한다 (실측 043036, 050404: 말한 직후 그은 획 때문에 교환이 통째로 버려졌다).
   */
  layoutChanged(snap: Map<string, { pos: string; ink: string }>, refs: Iterable<string>): boolean {
    const now = this.layoutSnapshot()
    const ref = new Set(refs)
    for (const [id, was] of snap) {
      const cur = now.get(id)
      if (!cur) { if (ref.has(id)) return true; continue }
      if (cur.pos !== was.pos) return true
      if (ref.has(id) && cur.ink !== was.ink) return true
    }
    return false
  }

  /** 한 단계 전체를 미리 검사한다. 실패하면 어떤 동작/자막도 적용하지 않는다. */
  validateStep(ops: Op[]): string | null {
    const positions = new Map<string, Pt>()
    for (const id of [...this.board.objs.map((o) => o.id), ...Object.keys(this.spawned)]) {
      const p = this.settled(id)
      if (p) positions.set(id, p)
    }
    // 같은 단계에서 만든 화살표도 흐름 경로로 쓸 수 있다
    const newPaths = new Set<string>()
    for (const op of ops) if (op.v === 'spawn') {
      if (positions.has(op.id)) return `이미 있는 객체 생성: ${op.id}`
      if (op.shape === 'arrow') {
        const ends = [op.from, op.to].map((e) => typeof e === 'string' ? positions.get(e) : e ? { x: e[0], y: e[1] } : undefined)
        if (ends.some((e) => !e)) return '화살표 끝 객체가 없음'
        positions.set(op.id, { x: (ends[0]!.x + ends[1]!.x) / 2, y: (ends[0]!.y + ends[1]!.y) / 2 })
        newPaths.add(op.id)
        continue
      }
      const at = op.at ? { x: op.at[0], y: op.at[1] } : op.on ? positions.get(op.on) : { x: this.board.page.width / 2, y: this.board.page.height / 2 }
      if (!at) return '생성 위치가 없음'
      positions.set(op.id, at)
    }
    const goals = new Map(positions)
    const moved = new Set<string>()
    for (const op of ops) {
      if ('id' in op && op.id && !positions.has(op.id)) return `없는 객체: ${op.id}`
      if ((op.v === 'flow' || op.v === 'send') && !this.isPath(op.along) && !newPaths.has(op.along)) return '연결 경로가 아닌 선'
      if (op.v === 'rotate' && typeof op.about === 'string' && !positions.has(op.about)) return `없는 객체: ${op.about}`
      if (op.v !== 'move') continue
      if (moved.has(op.id)) return `한 단계에 같은 객체를 두 번 이동: ${op.id}`
      moved.add(op.id)
      // 수식 단위(2만큼)를 픽셀로 착각한 이동은 화면에서 보이지 않는다 (실측 재현에서 by:[2,0])
      if (op.by && Math.hypot(op.by[0], op.by[1]) < 10) return `이동량이 너무 작음: ${op.id}`
      // 자기 선을 따라 자기를 옮기는 것은 의미가 없다 (실측: 포물선 평행이동을 이렇게 써서 엉뚱하게 움직임)
      if (op.along === op.id) return `자기 자신을 따라 이동: ${op.id}`
      const at = positions.get(op.id)!
      const line = op.along ? this.linePts(op.along) : null
      const path = line ? alongPath(line, at) : null
      if (op.loop && !path) return '유효한 도착지가 없음'
      // 반복 이동은 결국 제자리로 돌아오므로 겹침 판단은 지금 자리 기준
      const to = op.loop ? at : op.along ? path?.at(-1) : op.by ? { x: at.x + op.by[0], y: at.y + op.by[1] } : typeof op.to === 'string' ? positions.get(op.to) : op.to ? { x: op.to[0], y: op.to[1] } : null
      if (!to || to.x < 0 || to.y < 0 || to.x > this.board.page.width || to.y > this.board.page.height) return '유효한 도착지가 없음'
      goals.set(op.id, to)
    }
    const values = this.board.values()
    type V = (typeof values)[number]
    const overlap = (a: V, b: V, pa: Pt, pb: Pt) => {
      const iw = Math.min(pa.x + a.bbox.w / 2, pb.x + b.bbox.w / 2) - Math.max(pa.x - a.bbox.w / 2, pb.x - b.bbox.w / 2)
      const ih = Math.min(pa.y + a.bbox.h / 2, pb.y + b.bbox.h / 2) - Math.max(pa.y - a.bbox.h / 2, pb.y - b.bbox.h / 2)
      return iw > 0 && ih > 0 && iw * ih > 0.4 * Math.min(a.bbox.w * a.bbox.h, b.bbox.w * b.bbox.h)
    }
    // 이동 전부터 이미 다른 값과 겹쳐 있던 객체(덧쓴 숫자 등)는 겹침 판정에서 뺀다.
    // 실측: 3을 한 번 더 써서 생긴 o13 때문에 맞는 5↔3 교환이 네 번 연속 막혔다
    const cluttered = new Set<string>()
    for (let i = 0; i < values.length; i++) for (let j = i + 1; j < values.length; j++) {
      const a = values[i], b = values[j]
      const pa = positions.get(a.id), pb = positions.get(b.id)
      if (pa && pb && overlap(a, b, pa, pb)) cluttered.add(a.id).add(b.id)
    }
    for (let i = 0; i < values.length; i++) for (let j = i + 1; j < values.length; j++) {
      const a = values[i], b = values[j]
      if (!moved.has(a.id) && !moved.has(b.id)) continue
      if ((cluttered.has(a.id) && !moved.has(a.id)) || (cluttered.has(b.id) && !moved.has(b.id))) continue
      if (overlap(a, b, goals.get(a.id)!, goals.get(b.id)!)) return `이동 후 겹침: ${a.id}, ${b.id}`
    }
    return null
  }

  /** 원래 자리·각도에서 벗어났거나 계속 움직이는 그린 객체 */
  changed(): string[] {
    return Object.entries(this.anim).filter(([id, a]) => this.board.get(id)
      && (Math.abs(this.offset(id).x) > 1 || Math.abs(this.offset(id).y) > 1 || a.spin || a.path || Math.abs(a.rot ?? 0) > 0.01)).map(([id]) => id)
  }

  /** 움직임이 끝났을 때 놓일 중심 (진행 중인 애니메이션의 도착지) */
  settled(id: string): Pt | null {
    const o = this.board.get(id)
    if (o) {
      const c = boxCenter(o.bbox)
      const off = this.offset(id)
      return { x: c.x + off.x, y: c.y + off.y }
    }
    const s = this.spawned[id]
    return s ? { x: s.gx ?? s.x, y: s.gy ?? s.y } : null
  }

  /** 그린 객체가 원래 자리에서 옮겨질(옮겨진) 양 */
  offset(id: string): Pt {
    const a = this.anim[id]
    return { x: a?.gx ?? a?.dx ?? 0, y: a?.gy ?? a?.dy ?? 0 }
  }

  private startPos(id: string): Pt | null {
    if (!this.frozen.has(id)) {
      const p = this.settled(id)
      if (!p) return null
      this.frozen.set(id, p)
    }
    return this.frozen.get(id)!
  }

  /** 손글씨·글자끼리 크게 겹친 쌍 (AI에게 알려 스스로 바로잡게) */
  /** 움직인 값이 다른 값과 겹친 쌍. 교수자가 처음부터 겹쳐 그린 것은 바로잡을 대상이 아니다 */
  overlaps(): [string, string][] {
    const items = this.board.values()
    const moved = (id: string) => { const off = this.offset(id); return Math.abs(off.x) > 1 || Math.abs(off.y) > 1 }
    const boxes = items.map((o) => {
      const off = this.offset(o.id)
      return { id: o.id, x: o.bbox.x + off.x, y: o.bbox.y + off.y, w: o.bbox.w, h: o.bbox.h }
    })
    const out: [string, string][] = []
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]
        const b = boxes[j]
        if (!moved(a.id) && !moved(b.id)) continue
        const iw = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
        const ih = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
        if (iw > 0 && ih > 0 && iw * ih > 0.4 * Math.min(a.w * a.h, b.w * b.h)) out.push([a.id, b.id])
      }
    return out
  }

  exists(id: string) {
    return !!(this.board.get(id) || this.spawned[id])
  }

  center(id: string): Pt | null {
    const o = this.board.get(id)
    if (o) {
      const a = this.anim[id]
      const c = boxCenter(o.bbox)
      return { x: c.x + (a?.dx ?? 0), y: c.y + (a?.dy ?? 0) }
    }
    const s = this.spawned[id]
    return s ? { x: s.x, y: s.y } : null
  }

  /** 흐름·이동 경로로 쓸 수 있는 선 (칠판의 연결선·화살표·궤적, 또는 AI가 만든 화살표) */
  isPath(id: string) {
    return this.board.isFlowPath(id) || this.spawned[id]?.shape === 'arrow'
  }

  linePts(id: string): Pt[] | null {
    const sp = this.spawned[id]
    if (sp?.pts) return sp.pts
    const tr = this.board.traces.find((x) => x.id === id)
    if (tr) return tr.pts
    const o = this.board.get(id)
    if (!o) return null
    const a = this.anim[id]
    const raw = o.pts ?? o.strokes[0]?.pts
    if (!raw) return null
    return raw.map((p) => ({ x: p.x + (a?.dx ?? 0), y: p.y + (a?.dy ?? 0) }))
  }

  /** 동작 하나 실행. 걸리는 시간(ms)을 돌려준다 */
  applyOp(op: Op, now: number): number {
    const W = this.board.page.width
    const H = this.board.page.height
    switch (op.v) {
      case 'flow': {
        if (!this.linePts(op.along)) return 0
        this.flows = this.flows.filter((f) => f.along !== op.along)
        this.flows.push({ along: op.along, n: op.n, speed: op.speed, color: op.color, rev: op.rev, phase: 0 })
        return 600
      }
      case 'send': {
        const line = this.linePts(op.along)
        if (!line) return 0
        // 개수가 보이게 같은 경로의 계속 흐르는 입자는 멈춘다
        this.flows = this.flows.filter((f) => f.along !== op.along)
        const L = pathLen(line)
        const travel = clamp(L / 0.32, 900, 2200)
        const gap = clamp(travel / Math.max(3, op.n + 1), 140, 320)
        const c = op.at ? this.center(op.at) : null
        let dropAt = c ? fractionOn(line, c) : 0.6
        if (op.rev) dropAt = 1 - dropAt
        // 넘치는 곳은 중간 라우터다. 송신자 바로 앞에서 버리지 않는다
        dropAt = clamp(dropAt, 0.35, 0.95)
        this.bursts.push({ along: op.along, n: op.n, drop: op.drop, dropAt, color: op.color, rev: op.rev, ack: !!op.ack, t0: now, travel, gap })
        this.sent.push({ along: op.along, n: op.n, drop: op.drop, ack: !!op.ack, rev: op.rev })
        if (this.sent.length > 8) this.sent.shift()
        return travel + gap * (op.n - 1) + (op.drop ? DROP_FALL * 0.5 : 0)
      }
      case 'stop':
        if (op.along) this.bursts = this.bursts.filter((f) => f.along !== op.along)
        if (op.along) this.flows = this.flows.filter((f) => f.along !== op.along)
        // 반복 회전을 멈춤: 지금 각도에서 멈춘다
        if (op.id && this.anim[op.id]?.spin) this.anim[op.id].spin = undefined
        // 반복 이동을 멈춤: 지금 있는 자리에 그대로 둔다
        for (const [id, a] of Object.entries(this.anim)) {
          if (!a.path?.loop) continue
          if (id !== op.id && !(op.along && a.path.along === op.along)) continue
          a.path = null
          a.gx = a.dx
          a.gy = a.dy
          const sp = this.spawned[id]
          if (sp) { sp.gx = sp.x; sp.gy = sp.y }
        }
        return 300
      case 'spawn': {
        let p: Pt = { x: W / 2, y: H / 2 }
        let pts: Pt[] | undefined
        if (op.shape === 'arrow') {
          const end = (e: string | [number, number] | undefined) => typeof e === 'string' ? this.center(e) : e ? { x: e[0], y: e[1] } : null
          const a0 = end(op.from), b0 = end(op.to)
          if (!a0 || !b0) return 0
          // 두 객체 중심을 잇되 양 끝을 조금 줄여 글자·상자를 덮지 않게
          const L = dist(a0, b0) || 1
          const cut = Math.min(40, L * 0.2) / L
          pts = [{ x: a0.x + (b0.x - a0.x) * cut, y: a0.y + (b0.y - a0.y) * cut }, { x: b0.x - (b0.x - a0.x) * cut, y: b0.y - (b0.y - a0.y) * cut }]
          p = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 }
        } else if (op.at) p = { x: op.at[0], y: op.at[1] }
        else if (op.on) p = this.center(op.on) ?? p
        this.spawned[op.id] = {
          ...(pts ? { pts } : {}),
          shape: op.shape,
          x: clamp(p.x, 0, W),
          y: clamp(p.y, 0, H),
          r: op.r,
          w: op.w,
          h: op.h,
          text: op.text,
          color: op.color,
        }
        const a = this.A(op.id)
        a.alpha = 0
        this.tween((v) => (a.alpha = v), 0, 1, 400, now)
        if (op.life) a.removeAt = now + op.life
        return 400
      }
      case 'move': {
        // 출발점과 도착점 모두 '이 단계가 시작될 때의 위치' 기준. 같은 단계의 move들은 동시에 움직이므로
        // o7→o8, o8→o7 을 같이 쓰면 교환이 된다. 도착지에 무엇이 있든 엔진이 따로 손대지 않는다
        const from = this.startPos(op.id)
        if (!from) return 0
        const sp = this.spawned[op.id]
        if (!sp) this.takeOver(op.id)
        const a = this.A(op.id)
        // 새 이동이 시작된 뒤 이전 tween/path가 화면 좌표를 다시 덮어쓰지 않게 한다.
        this.tweens = this.tweens.filter((w) => w.owner !== op.id)
        a.path = null
        if (op.along) {
          const line = this.linePts(op.along)
          if (!line) return 0
          const pts = alongPath(line, from)
          const end = pts[pts.length - 1]
          const base = sp ? { x: 0, y: 0 } : { x: from.x - this.offset(op.id).x, y: from.y - this.offset(op.id).y }
          // 반복은 경로에서 지금 자리와 가장 가까운 곳부터 시작한다 (시작점으로 순간이동하지 않게)
          let t0 = now
          if (op.loop) {
            let bi = 0
            pts.forEach((q, i) => { if (dist(q, from) < dist(pts[bi], from)) bi = i })
            t0 = now - (pathLen(pts.slice(0, bi + 1)) / Math.max(1, pathLen(pts))) * op.dur
          }
          a.path = { pts, t0, dur: op.dur, base, along: op.along, ...(op.loop ? { loop: isClosedPath(pts) ? 'wrap' as const : 'bounce' as const } : {}) }
          if (op.loop) {
            // 반복 중에는 도착지가 지금 자리(계획·겹침 판단 기준)
            if (sp) { sp.gx = sp.x; sp.gy = sp.y } else { a.gx = a.dx; a.gy = a.dy }
            return op.dur
          }
          if (sp) {
            sp.gx = end.x
            sp.gy = end.y
          } else {
            a.gx = end.x - base.x
            a.gy = end.y - base.y
          }
          return op.dur
        }
        const to = op.by ? { x: from.x + op.by[0], y: from.y + op.by[1] }
          : typeof op.to === 'string' ? this.startPos(op.to) : op.to ? { x: op.to[0], y: op.to[1] } : null
        if (!to) return 0
        if (sp) {
          sp.gx = to.x
          sp.gy = to.y
          this.tween((v) => (sp.x = v), sp.x, to.x, op.dur, now, op.id)
          this.tween((v) => (sp.y = v), sp.y, to.y, op.dur, now, op.id)
        } else {
          const gx = this.offset(op.id).x + to.x - from.x
          const gy = this.offset(op.id).y + to.y - from.y
          a.gx = gx
          a.gy = gy
          this.tween((v) => (a.dx = v), a.dx, gx, op.dur, now, op.id)
          this.tween((v) => (a.dy = v), a.dy, gy, op.dur, now, op.id)
        }
        return op.dur
      }
      case 'rotate': {
        if (!this.exists(op.id)) return 0
        if (!this.spawned[op.id]) this.takeOver(op.id)
        const a = this.A(op.id)
        const pivot = typeof op.about === 'string' ? this.center(op.about) : op.about ? { x: op.about[0], y: op.about[1] } : null
        // 회전축은 객체 원래 자리 기준으로 저장한다 (그리기에서 이동량을 따로 더하지 않게 지금 이동량을 뺀다)
        a.pivot = pivot ? { x: pivot.x - (this.spawned[op.id] ? 0 : a.dx), y: pivot.y - (this.spawned[op.id] ? 0 : a.dy) } : undefined
        const rad = (op.deg * Math.PI) / 180
        this.tweens = this.tweens.filter((w) => w.owner !== `${op.id}:rot`)
        if (op.loop) {
          const spin = Math.abs(op.deg) >= 360
          const tilt = !spin && op.tilt ? (op.tilt * Math.PI) / 180 : undefined
          a.spin = { mode: spin ? 'spin' : 'swing', t0: now, period: op.dur, amp: spin ? Math.sign(rad) * 2 * Math.PI : rad, ...(tilt ? { tilt } : {}) }
          a.rot = 0
          return Math.min(op.dur, 1200)
        }
        a.spin = undefined
        const from = a.rot ?? 0
        this.tween((v) => (a.rot = v), from, from + rad, op.dur, now, `${op.id}:rot`)
        return op.dur
      }
      case 'restore': {
        // 그린 객체는 원래 자리·각도로 돌아오고 반복 움직임을 멈춘다. 흐름도 같이 멈춘다
        const ids = op.id ? [op.id] : Object.keys(this.anim).filter((id) => this.board.get(id))
        for (const id of ids) {
          const a = this.anim[id]
          if (!a || !this.board.get(id)) continue
          this.tweens = this.tweens.filter((w) => w.owner !== id && w.owner !== `${id}:rot`)
          a.path = null
          a.spin = undefined
          a.gx = 0
          a.gy = 0
          this.tween((v) => (a.dx = v), a.dx, 0, op.dur, now, id)
          this.tween((v) => (a.dy = v), a.dy, 0, op.dur, now, id)
          // 가장 가까운 '똑바른' 각도로 (자전하던 것을 거꾸로 몇 바퀴 되감지 않게)
          if (a.rot) this.tween((v) => (a.rot = v), a.rot, Math.round(a.rot / (2 * Math.PI)) * 2 * Math.PI, op.dur, now, `${id}:rot`)
          if (a.sc !== 1) this.tween((v) => (a.sc = v), a.sc, 1, op.dur, now)
        }
        if (!op.id) { this.flows = []; this.bursts = [] }
        else this.flows = this.flows.filter((f) => f.along !== op.id)
        return op.dur
      }
      case 'color': {
        if (!this.exists(op.id)) return 0
        this.A(op.id).color = op.color
        const sp = this.spawned[op.id]
        if (sp) sp.color = op.color
        else this.takeOver(op.id)
        return 300
      }
      case 'scale': {
        if (!this.exists(op.id)) return 0
        if (!this.spawned[op.id]) this.takeOver(op.id)
        const a = this.A(op.id)
        this.tween((v) => (a.sc = v), a.sc, op.k, op.dur, now)
        return op.dur
      }
      case 'pulse': {
        if (!this.exists(op.id)) return 0
        if (!this.spawned[op.id]) this.takeOver(op.id)
        this.A(op.id).pulse = 1
        return 700
      }
      case 'fade': {
        if (!this.exists(op.id)) return 0
        if (!this.spawned[op.id]) this.takeOver(op.id)
        const a = this.A(op.id)
        this.tween((v) => (a.alpha = v), a.alpha, op.to, op.dur, now)
        return op.dur
      }
      case 'label': {
        if (!this.exists(op.id)) return 0
        this.A(op.id).labelText = op.text
        return 300
      }
    }
  }

  tick(now: number, dt: number) {
    for (let i = this.tweens.length - 1; i >= 0; i--) {
      const w = this.tweens[i]
      const k = clamp((now - w.t0) / w.dur, 0, 1)
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2
      w.set(w.from + (w.to - w.from) * e)
      if (k >= 1) this.tweens.splice(i, 1)
    }
    for (const [id, a] of Object.entries(this.anim)) {
      if (a.removeAt != null) {
        const left = a.removeAt - now
        if (left <= 0) {
          delete this.anim[id]
          delete this.spawned[id]
          continue
        }
        if (left < 300) a.alpha = Math.min(a.alpha, left / 300)
      }
      if (a.pulse > 0) a.pulse = Math.max(0, a.pulse - dt * 1.2)
      if (a.spin) {
        const k = (now - a.spin.t0) / a.spin.period
        a.rot = a.spin.mode === 'spin' ? a.spin.amp * (k % 1) : swingAngle(a.spin.amp, a.spin.tilt, k)
      }
      if (a.path) {
        const raw = (now - a.path.t0) / a.path.dur
        const k = a.path.loop === 'wrap' ? raw % 1 : a.path.loop === 'bounce' ? 1 - Math.abs((raw % 2) - 1) : clamp(raw, 0, 1)
        const q = pointOnPath(a.path.pts, k)
        const sp = this.spawned[id]
        if (sp) {
          sp.x = q.x
          sp.y = q.y
        } else {
          a.dx = q.x - a.path.base.x
          a.dy = q.y - a.path.base.y
        }
        if (!a.path.loop && k >= 1) a.path = null
      }
    }
    for (const f of this.flows) {
      const p = this.linePts(f.along)
      const L = p ? pathLen(p) : 300
      f.phase += (dt * f.speed * 120) / Math.max(80, L)
    }
    this.bursts = this.bursts.filter((b) => now - b.t0 < b.travel + b.gap * (b.n - 1) + DROP_FALL + 100)
    this.clock = now
  }

  private clock = 0

  /** 묶음 안 패킷 k의 지금 모습. 아직 출발 전이거나 사라졌으면 null */
  private packet(b: Burst, k: number, line: Pt[], now: number) {
    const start = b.t0 + k * b.gap
    if (now < start) return null
    // 앞에서부터 보내고, 버퍼에 늦게 닿는 뒤쪽 패킷이 넘쳐 버려진다
    const dropped = k >= b.n - b.drop
    const end = dropped ? b.dropAt : 1
    const f = (now - start) / b.travel
    if (f <= end) {
      const q = pointOnPath(line, b.rev ? 1 - f : f)
      return { ...q, color: b.color, alpha: 1 }
    }
    if (!dropped) return null
    // 버려짐: 그 자리에서 빨갛게 변해 아래로 떨어지며 사라진다
    const fall = (now - start - end * b.travel) / DROP_FALL
    if (fall >= 1) return null
    const q = pointOnPath(line, b.rev ? 1 - end : end)
    return { x: q.x + fall * 10, y: q.y + fall * fall * 70, color: '#ff5a46', alpha: 1 - fall * fall }
  }

  private col(color: string) {
    return this.paper ? (PAPER[color.toLowerCase()] ?? color) : color
  }

  /** 페이지 좌표로 그린다 (ctx에 scale이 이미 적용돼 있어야 함) */
  render(c: CanvasRenderingContext2D) {
    for (const id of this.takenOver) {
      const o = this.board.get(id)
      if (o) this.drawObj(c, o)
    }
    // 그린 객체 위 이름표
    for (const [id, a] of Object.entries(this.anim)) {
      if (!a.labelText || this.spawned[id]) continue
      const o = this.board.get(id)
      if (!o) continue
      c.fillStyle = this.col('#ffc65a')
      c.font = `22px ${FONT}`
      c.textAlign = 'center'
      c.fillText(a.labelText, o.bbox.x + o.bbox.w / 2 + a.dx, o.bbox.y + a.dy - 10)
      c.textAlign = 'left'
    }
    for (const f of this.flows) {
      const p = this.linePts(f.along)
      if (!p) continue
      for (let k = 0; k < f.n; k++) {
        let fr = (((f.phase + k / f.n) % 1) + 1) % 1
        if (f.rev) fr = 1 - fr
        const q = pointOnPath(p, fr)
        c.fillStyle = this.col(f.color)
        c.beginPath()
        c.arc(q.x, q.y, 5, 0, Math.PI * 2)
        c.fill()
      }
    }
    for (const b of this.bursts) {
      const line = this.linePts(b.along)
      if (!line) continue
      for (let k = 0; k < b.n; k++) {
        const q = this.packet(b, k, line, this.clock)
        if (!q) continue
        c.save()
        c.globalAlpha = clamp(q.alpha, 0, 1)
        c.fillStyle = this.col(q.color)
        c.strokeStyle = '#0d1512'
        c.lineWidth = 1.5
        c.beginPath()
        // 데이터 패킷은 작은 사각형, 응답은 작은 점
        if (b.ack) c.arc(q.x, q.y, 4.5, 0, Math.PI * 2)
        else c.rect(q.x - 8, q.y - 6, 16, 12)
        c.fill()
        c.stroke()
        c.restore()
      }
    }
    for (const [id, s] of Object.entries(this.spawned)) {
      const a = this.anim[id]
      c.save()
      c.globalAlpha = clamp(a?.alpha ?? 1, 0, 1)
      if (a?.rot) {
        const p = a.pivot ?? { x: s.x, y: s.y }
        c.translate(p.x, p.y)
        c.rotate(a.rot)
        c.translate(-p.x, -p.y)
      }
      c.translate(s.x, s.y)
      c.scale(a?.sc ?? 1, a?.sc ?? 1)
      if (a && a.pulse > 0) {
        c.shadowColor = this.col(s.color)
        c.shadowBlur = 24 * a.pulse
      }
      c.fillStyle = this.col(s.color)
      c.strokeStyle = this.col(s.color)
      c.lineWidth = 3
      if (s.shape === 'dot') {
        c.beginPath()
        c.arc(0, 0, s.r, 0, Math.PI * 2)
        c.fill()
      } else if (s.shape === 'circle') {
        c.beginPath()
        c.arc(0, 0, s.r * 2, 0, Math.PI * 2)
        c.stroke()
      } else if (s.shape === 'box') {
        c.strokeRect(-s.w / 2, -s.h / 2, s.w, s.h)
      } else if (s.shape === 'arrow' && s.pts) {
        const [p0, p1] = s.pts.map((q) => ({ x: q.x - s.x, y: q.y - s.y }))
        const ang = Math.atan2(p1.y - p0.y, p1.x - p0.x)
        c.beginPath()
        c.moveTo(p0.x, p0.y)
        c.lineTo(p1.x, p1.y)
        c.moveTo(p1.x - 16 * Math.cos(ang - 0.45), p1.y - 16 * Math.sin(ang - 0.45))
        c.lineTo(p1.x, p1.y)
        c.lineTo(p1.x - 16 * Math.cos(ang + 0.45), p1.y - 16 * Math.sin(ang + 0.45))
        c.stroke()
        if (s.text) {
          c.font = `22px ${FONT}`
          c.textAlign = 'center'
          c.fillText(s.text, (p0.x + p1.x) / 2, (p0.y + p1.y) / 2 - 12)
        }
      } else {
        c.font = `28px ${FONT}`
        c.textAlign = 'center'
        c.textBaseline = 'middle'
        c.fillText(s.text, 0, 0)
      }
      c.restore()
      if (a?.labelText) {
        c.fillStyle = this.col('#ffc65a')
        c.font = `22px ${FONT}`
        c.textAlign = 'center'
        c.fillText(a.labelText, s.x, s.y - s.r - 14)
        c.textAlign = 'left'
      }
    }
  }

  private drawObj(c: CanvasRenderingContext2D, o: BoardObj) {
    const a = this.anim[o.id] ?? { dx: 0, dy: 0, sc: 1, alpha: 1, color: null, pulse: 0 }
    const cc = boxCenter(o.bbox)
    c.save()
    c.globalAlpha = clamp(a.alpha, 0, 1)
    if (a.rot) {
      // 회전축은 원래 자리 기준이므로 이동량과 함께 옮긴다
      const p = a.pivot ?? cc
      c.translate(p.x + a.dx, p.y + a.dy)
      c.rotate(a.rot)
      c.translate(-p.x - a.dx, -p.y - a.dy)
    }
    c.translate(cc.x + a.dx, cc.y + a.dy)
    c.scale(a.sc, a.sc)
    c.translate(-cc.x, -cc.y)
    if (a.pulse > 0) {
      c.shadowColor = this.col(a.color ?? '#5ec8e6')
      c.shadowBlur = 26 * a.pulse
    }
    c.lineCap = 'round'
    c.lineJoin = 'round'
    // AI가 색을 바꾸지 않았으면 쓴 사람의 펜 색·굵기 그대로 그린다
    for (const s of o.strokes) {
      const ink = a.color ? this.col(a.color) : s.color ?? this.col(INK)
      c.strokeStyle = ink
      c.fillStyle = ink
      drawStrokes(c, [s.pts], s.width)
    }
    if (o.kind === 'text' && o.text) {
      c.font = `30px ${FONT}`
      c.textBaseline = 'middle'
      c.fillText(o.text, o.bbox.x, cc.y)
    }
    c.restore()
  }

  /** AI에게 알려줄 지금 화면 상태 */
  describe(): string {
    const r = Math.round
    const out: string[] = []
    if (this.flows.length)
      out.push('흐르는 중: ' + this.flows.map((f) => `${f.along}(입자 ${f.n}, 빠르기 ${f.speed}${f.rev ? ', 반대 방향' : ''})`).join(', '))
    if (this.sent.length) {
      const last = this.sent.filter((x) => !x.ack).at(-1)
      out.push(`보낸 패킷(오래된→최근): ${this.sent.map((x) => `${x.along} ${x.ack ? '응답 ' : ''}${x.n}개${x.drop ? `(${x.drop}개 버려짐)` : ''}`).join(' → ')}${last ? `. 직전에 보낸 데이터 패킷 수: ${last.n}` : ''}`)
    }
    const moved = Object.entries(this.anim)
      .filter(([id, a]) => !this.spawned[id] && (Math.abs(a.dx) > 1 || Math.abs(a.dy) > 1 || a.sc !== 1 || a.color || a.alpha < 1))
      .map(([id, a]) => {
        const parts: string[] = []
        if (Math.abs(a.dx) > 1 || Math.abs(a.dy) > 1) parts.push(`이동 ${r(a.dx)},${r(a.dy)}`)
        if (a.sc !== 1) parts.push(`크기 ×${a.sc.toFixed(2)}`)
        if (a.color) parts.push(`색 ${a.color}`)
        if (a.alpha < 1) parts.push(`투명도 ${a.alpha.toFixed(2)}`)
        return `${id}(${parts.join(', ')})`
      })
    if (moved.length) out.push('바뀐 객체: ' + moved.join(', '))
    const loops = Object.entries(this.anim).filter(([id, a]) => a.path?.loop && !isEffectId(id))
    if (loops.length) out.push('계속 도는 중(stop id로 멈춤): ' + loops.map(([id]) => id).join(', '))
    const spins = Object.entries(this.anim).filter(([id, a]) => a.spin && !isEffectId(id))
    if (spins.length) out.push('회전·왕복 중(stop id로 멈춤): ' + spins.map(([id, a]) => `${id}(${a.spin!.mode === 'spin' ? '회전' : '왕복'})`).join(', '))
    const turned = Object.entries(this.anim).filter(([id, a]) => !a.spin && a.rot && Math.abs(a.rot) > 0.01 && !isEffectId(id))
    if (turned.length) out.push('돌려 놓은 객체: ' + turned.map(([id, a]) => `${id}(${r((a.rot! * 180) / Math.PI)}°)`).join(', '))
    const sp = Object.entries(this.spawned).filter(([id]) => !isEffectId(id))
    if (sp.length) out.push('네가 만든 객체: ' + sp.map(([id, s]) => `${id} ${s.shape}${s.text ? ' "' + s.text + '"' : ''} ${s.pts ? `(${r(s.pts[0].x)},${r(s.pts[0].y)})→(${r(s.pts[1].x)},${r(s.pts[1].y)}) 경로로 쓸 수 있음` : `(${r(s.x)},${r(s.y)})`}`).join(', '))
    return out.join('\n') || '(움직이는 것 없음)'
  }
}

/** width가 있으면 그 굵기로, 없으면 필압에 따라 그린다 */
export function drawStrokes(c: CanvasRenderingContext2D, strokes: { x: number; y: number; p: number }[][], width?: number) {
  for (const s of strokes) {
    if (s.length === 1) {
      c.beginPath()
      c.arc(s[0].x, s[0].y, width ? width / 2 : 2.5, 0, Math.PI * 2)
      c.fill()
      continue
    }
    for (let i = 1; i < s.length; i++) {
      c.lineWidth = width ?? 1.8 + (s[i].p ?? 0.5) * 3.6
      c.beginPath()
      c.moveTo(s[i - 1].x, s[i - 1].y)
      c.lineTo(s[i].x, s[i].y)
      c.stroke()
    }
  }
}

/** AI가 만든 단계 하나. ops는 스트리밍 중에 계속 늘어날 수 있다 */
export interface PlayStep {
  reqId: number
  ops: Op[]
  applied: number
  cap: string
  capShown: boolean
  /** 아직 이 단계의 줄이 다 도착하지 않음 */
  open: boolean
  startedAt: number | null
  maxDur: number
  commitKey?: string
  validate?: () => string | null
  onApplied?: () => void
}

/** 단계를 순서대로 재생한다. 도착한 동작은 단계 안에서 즉시 실행 */
export class Player {
  queue: PlayStep[] = []
  current: PlayStep | null = null
  private committed = new Set<string>()

  constructor(
    private engine: Engine,
    private hooks: {
      onFirstOp: (step: PlayStep, now: number) => void
      onCaption: (step: PlayStep) => void
      onRejected?: (step: PlayStep, reason: string) => void
    },
  ) {}

  /** 새 요청의 단계가 오면 이전 요청의 남은 단계는 버린다 */
  push(step: PlayStep) {
    this.queue = this.queue.filter((s) => s.reqId === step.reqId)
    if (this.current && this.current.reqId !== step.reqId) this.current = null
    this.queue.push(step)
  }

  /** 중단된 요청의 남은 단계를 버린다. 이미 재생 중인 단계는 마저 끝낸다 */
  drop(reqId: number) {
    this.queue = this.queue.filter((s) => s.reqId !== reqId)
    if (this.current?.reqId === reqId && this.current.applied === 0) this.current = null
  }

  clear() {
    this.queue = []
    this.current = null
    this.committed.clear()
  }

  cancelPending() {
    this.queue = []
    if (this.current?.applied === 0) this.current = null
  }

  tick(now: number) {
    if (!this.current) {
      this.current = this.queue.shift() ?? null
    }
    const s = this.current
    if (!s) return
    // 교환의 한쪽만 먼저 움직이지 않는다. 완성된 단계 전체를 함께 검증·적용한다.
    if (s.open) return
    if (s.applied === 0) {
      const reason = (s.commitKey && this.committed.has(s.commitKey) ? '이미 반영한 발화의 동작' : null)
        ?? s.validate?.() ?? this.engine.validateStep(s.ops)
      if (reason) {
        this.hooks.onRejected?.(s, reason)
        this.current = null
        return
      }
      this.engine.beginStep()
      s.startedAt = now
      if (s.commitKey) this.committed.add(s.commitKey)
    }
    let applied = false
    while (s.applied < s.ops.length) {
      const d = this.engine.applyOp(s.ops[s.applied], now)
      if (s.applied === 0 && d > 0) this.hooks.onFirstOp(s, now)
      s.applied++
      applied ||= d > 0
      s.maxDur = Math.max(s.maxDur, (now - (s.startedAt ?? now)) + d)
    }
    if (applied) s.onApplied?.()
    if (s.cap && !s.capShown) {
      s.capShown = true
      this.hooks.onCaption(s)
    }
    if (!s.open) {
      const elapsed = now - (s.startedAt ?? now)
      if (!s.ops.length || elapsed >= clamp(s.maxDur + 250, 600, 4000)) this.current = null
    }
  }
}
