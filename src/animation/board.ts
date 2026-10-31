import type { InkEvent, InkPoint, InkStroke, PageInfo } from '../shared/ink'
import {
  type Box,
  type Pt,
  area,
  bboxOf,
  boxCenter,
  dist,
  distToSegment,
  dropRevisits,
  expand,
  inBox,
  intersects,
  nearestIdx,
  pathLen,
  simplify,
  straightness,
  unionBox,
} from './geometry'

export type ObjKind = 'box' | 'line' | 'mark' | 'dot' | 'text'

export interface BoardStroke {
  id: string
  pts: InkPoint[]
}

/** 필기를 해석해 묶은 객체. id는 o1, o2 … */
export interface BoardObj {
  id: string
  kind: ObjKind
  strokes: BoardStroke[]
  bbox: Box
  /** 선이면 그린 방향 순서의 대표 점들 */
  pts?: Pt[]
  text?: string
  /** 글자 도구로 만든 객체의 편집기 id */
  srcId?: string
  /** 마지막으로 획이 더해진 시각 */
  t: number
  arrowEnd?: 'start' | 'end'
  replaces?: string
  /** AI가 이미지로 한 번 읽은 손글씨 값 (한번 읽으면 기억해 다음부터 글자로 알려준다) */
  read?: string
  /** 장면 해석(LLM)이 정한 의미. 있으면 기하 추정보다 우선한다 */
  role?: SceneRole
  /** 장면 해석이 붙인 이름 (예: "심장", "송신자") */
  label?: string
  /** 화살표·연결선이 잇는 객체, 밑줄이 꾸미는 객체 */
  from?: string
  to?: string
}

/** 장면 해석이 정하는 객체의 의미 */
export type SceneRole = 'value' | 'box' | 'arrow' | 'connector' | 'frame' | 'underline' | 'drawing' | 'noise'

export const ROLE_KO: Record<SceneRole, string> = {
  value: '글자/값',
  box: '도형/노드',
  arrow: '화살표',
  connector: '연결선',
  frame: '칸/테두리',
  underline: '밑줄',
  drawing: '그림 일부',
  noise: '잡획',
}

/** 장면 해석 결과 (scene.ts가 모델 응답을 이 모양으로 정리한다) */
export interface SceneObj {
  role?: SceneRole
  read?: string
  label?: string
  head?: 'start' | 'end'
  from?: string
  to?: string
}

export interface SceneResult {
  objs: Record<string, SceneObj>
  merge: string[][]
  split: Record<string, string[][]>
}

export interface ErasedObj {
  id: string
  kind: ObjKind
  bbox: Box
  text?: string
  t: number
  rewritten?: string
}

/** 가리킨 궤적. id는 t1, t2 … */
export interface Trace {
  id: string
  pts: Pt[]
  t: number
  passes: string[]
  dur: number
}

export type BoardEventKind = '획' | '글자' | '화살표' | '덧그리기' | '다시 쓰기' | '지우기' | '가리키기'

export interface BoardEvent {
  kind: BoardEventKind
  desc: string
  t: number
  objId?: string
  /** 덧그리기가 그린 방향과 반대인지 */
  rev?: boolean
}

export const KIND_KO: Record<ObjKind, string> = {
  box: '상자',
  line: '선',
  mark: '손글씨/기호',
  dot: '점',
  text: '글자',
}

/**
 * 사용자별 크기 보정. px 임계값은 글씨를 크게 쓰는 화면(손글씨 높이 약 150px)에서 정했다.
 * 같은 페이지에서 쓴 손글씨 높이의 중앙값이 unit보다 작으면 임계값을 그 비율로 줄인다.
 * 값은 cases/의 보정용(calib) 획 라벨로 고르고 검증용(holdout)으로 확인한다 (src/evals/strokes.test.ts).
 */
export interface BoardTuning {
  /** 이 높이(px)의 손글씨를 쓰는 사람이 배율 1 */
  unit: number
  minScale: number
  maxScale: number
  /** 곧추선 획이 둘러싼 틀 높이의 이 비율 이상이면 칸 구분선 */
  dividerSpan: number
  /** 곧추선 획이 손글씨 높이 중앙값의 이 배수 이상이면 칸 구분선 */
  dividerVsWriting: number
}

export const DEFAULT_TUNING: BoardTuning = { unit: 120, minScale: 0.4, maxScale: 1, dividerSpan: 0.8, dividerVsWriting: 1.6 }

/** 곧게 선 세로 획 (칸 구분선 또는 숫자 1) */
function upright(pts: Pt[], b: Box) {
  return b.h > 2.5 * b.w && straightness(pts) >= 0.8
}

/** 상자 네 모서리 근처를 획이 지나가는지. 사각형은 4곳, 원·숫자 0은 0곳 */
function cornersHit(pts: Pt[], b: Box) {
  const tol = 0.1 * Math.hypot(b.w, b.h)
  const corners = [
    { x: b.x, y: b.y },
    { x: b.x + b.w, y: b.y },
    { x: b.x, y: b.y + b.h },
    { x: b.x + b.w, y: b.y + b.h },
  ]
  return corners.filter((c) => pts.some((p) => dist(p, c) < tol)).length
}

/** 테두리 근처(가장자리 12% 안)를 지나는 점의 비율. 사각형은 거의 1, 8·0처럼 가운데를 지나면 낮다 */
function edgeShare(pts: Pt[], b: Box) {
  const mx = 0.12 * b.w
  const my = 0.12 * b.h
  const near = pts.filter((p) => p.x - b.x < mx || b.x + b.w - p.x < mx || p.y - b.y < my || b.y + b.h - p.y < my)
  return near.length / pts.length
}

/**
 * 획 하나의 모양 판별.
 * 크기보다 "곧은가, 닫혔는가, 모서리가 있는가"를 본다. 크게 쓴 숫자도 구불구불하면 손글씨(mark).
 */
export function classify(pts: Pt[], s = 1): Exclude<ObjKind, 'text'> {
  const L = pathLen(pts)
  const b = bboxOf(pts)
  const diag = Math.hypot(b.w, b.h)
  const size = Math.max(b.w, b.h)
  if (diag < 14 * s) return 'dot'
  const gap = dist(pts[0], pts[pts.length - 1])
  const closed = gap < Math.max(22 * s, 0.28 * diag) && L > 1.9 * diag && b.w > 34 * s && b.h > 34 * s
  if (closed) return (cornersHit(pts, b) >= 3 && edgeShare(pts, b) >= 0.75) || size >= 220 * s ? 'box' : 'mark'
  if (straightness(pts) >= 0.8) {
    // 짧게 곧추선 획은 숫자 1 같은 글자 (긴 세로선은 칸 구분선 등으로 선)
    if (b.h > 2.5 * b.w && b.h < 170 * s) return 'mark'
    return diag < 40 * s ? 'mark' : 'line'
  }
  // 납작하고 넓은 획(살짝 흔들린 밑줄·가로선)은 선
  if (b.w >= 40 * s && b.h < 0.25 * b.w) return 'line'
  return size < 200 * s ? 'mark' : 'line'
}

/** V자 획이면 꼭짓점과 양 끝을 돌려준다 */
function vShape(pts: Pt[]) {
  if (pts.length < 3) return null
  const a = pts[0]
  const z = pts[pts.length - 1]
  let best = -1
  let bi = -1
  pts.forEach((p, i) => {
    const d = distToSegment(p, a, z)
    if (d > best) {
      best = d
      bi = i
    }
  })
  if (bi <= 0 || bi >= pts.length - 1) return null
  const tip = pts[bi]
  if (Math.min(dist(tip, a), dist(tip, z)) < 8) return null
  const ux = a.x - tip.x
  const uy = a.y - tip.y
  const vx = z.x - tip.x
  const vy = z.y - tip.y
  const cos = (ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy) || 1)
  if (cos < -0.5) return null // 꼭짓점 각이 120°보다 넓으면 V가 아님
  return { tip, a, z }
}

/** a 넓이 중 b와 겹치는 비율 */
function overlapShare(a: Box, b: Box) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? (w * h) / Math.max(1, a.w * a.h) : 0
}

const lastT = (pts: InkPoint[]) => pts[pts.length - 1]?.t ?? performance.now()

/** 편집기에서 온 필기 이벤트를 객체와 사건으로 해석한다 */
export class Board {
  page: PageInfo = { page: 1, width: 1280, height: 720 }
  objs: BoardObj[] = []
  erased: ErasedObj[] = []
  traces: Trace[] = []
  events: BoardEvent[] = []
  /** 필기가 바뀔 때마다 오른다. 늦게 도착한 장면 해석을 버릴 때 쓴다 */
  version = 0
  private nextId = 1
  private nextTrace = 1

  constructor(readonly tuning: BoardTuning = DEFAULT_TUNING) {}

  /** 곧추선 획을 뺀 손글씨 객체 높이의 중앙값. 2개 미만이면 모름 */
  private writingHeight() {
    const hs = this.objs
      .filter((o) => o.kind === 'mark' && !o.role && !(o.strokes.length === 1 && upright(o.strokes[0].pts, o.bbox)))
      .map((o) => o.bbox.h)
      .sort((a, b) => a - b)
    return hs.length >= 2 ? hs[hs.length >> 1] : undefined
  }

  /** 이 사람의 손글씨 크기에 맞춘 임계값 배율 */
  scale() {
    const h = this.writingHeight()
    const { unit, minScale, maxScale } = this.tuning
    return h ? Math.min(maxScale, Math.max(minScale, h / unit)) : 1
  }

  reset() {
    this.objs = []
    this.erased = []
    this.traces = []
    this.events = []
    this.nextId = 1
    this.nextTrace = 1
  }

  get(id: string) {
    return this.objs.find((o) => o.id === id)
  }

  /** 손글씨·글자 바로 아래에 그은 짧은 가로선이면 그 대상 id (밑줄 = 강조, 흐름 아님) */
  underlineOf(id: string): string | undefined {
    const o = this.get(id)
    if (o?.role) return o.role === 'underline' && o.to && this.get(o.to) ? o.to : undefined
    if (!o || !['line', 'mark'].includes(o.kind) || o.arrowEnd) return undefined
    const b = o.bbox
    // 짧거나 여러 번 덧그은 밑줄은 모양 분류에서 mark가 될 수 있다.
    if (b.w < 18 || b.w > 180 || b.h > b.w * 0.45) return undefined
    return this.objs.find((m) => {
      if (m.id === id || (m.kind !== 'mark' && m.kind !== 'text') || (m.role && m.role !== 'value') || m.t > o.t) return false
      if (m.bbox.h < Math.max(24, b.h * 2)) return false
      const bottom = m.bbox.y + m.bbox.h
      const overlap = Math.min(b.x + b.w, m.bbox.x + m.bbox.w) - Math.max(b.x, m.bbox.x)
      return b.y > bottom - Math.min(35, m.bbox.h * 0.25) && b.y < bottom + 50 && overlap > 0.3 * Math.min(b.w, m.bbox.w)
    })?.id
  }

  /** 숫자/글자 후보. 밑줄의 OCR 결과가 배열 원소에 섞이지 않게 모든 소비자가 공유한다. */
  values() {
    return this.objs.filter((o) => (o.role ? o.role === 'value' : o.kind === 'mark' || o.kind === 'text') && !this.underlineOf(o.id))
  }

  /** 흐름 경로: 화살표, 가리킨 궤적, 또는 서로 다른 객체를 잇는 열린 선. */
  isFlowPath(id: string) {
    if (this.traces.some((t) => t.id === id)) return true
    const o = this.get(id)
    if (!o || o.kind !== 'line' || !o.pts || this.underlineOf(id)) return false
    if (o.role) return o.role === 'arrow' || o.role === 'connector'
    if (o.arrowEnd) return true
    const ends = [o.pts[0], o.pts[o.pts.length - 1]]
    const near = ends.map((p) => this.objs
      .filter((x) => x.id !== id && (x.kind === 'box' || x.kind === 'text' || x.role === 'value'))
      .filter((x) => inBox(p, x.bbox, 35))
      .sort((a, b) => area(a.bbox) - area(b.bbox))[0]?.id)
    return !!near[0] && !!near[1] && near[0] !== near[1]
  }

  /**
   * 장면 해석(LLM) 결과를 반영한다. 기하(좌표·획)는 그대로 두고 의미만 덮는다.
   * keep: 애니메이션이 옮기고 있는 객체처럼 묶기·나누기를 하면 안 되는 id.
   * 돌려주는 removed는 합쳐져 사라진 id (엔진에서 잊어야 함), added는 나눠져 새로 생긴 id.
   */
  applyScene(r: SceneResult, keep: (id: string) => boolean = () => false) {
    const removed: string[] = []
    const added: string[] = []
    let changed = 0
    for (const [id, groups] of Object.entries(r.split)) {
      const o = this.get(id)
      if (!o || o.kind === 'text' || keep(id) || groups.length < 2) continue
      const byId = new Map(o.strokes.map((st) => [st.id, st]))
      const parts = groups.map((g) => g.map((sid) => byId.get(sid)).filter((st): st is BoardStroke => !!st)).filter((g) => g.length)
      // 모든 획을 정확히 한 번씩 나눈 경우만 받아들인다
      if (parts.length < 2 || parts.flat().length !== o.strokes.length || new Set(parts.flat()).size !== o.strokes.length) continue
      const at = this.objs.indexOf(o)
      const made = parts.slice(1).map((strokes) => {
        const n: BoardObj = { id: this.newId(), kind: 'mark', strokes, bbox: bboxOf(strokes.flatMap((st) => st.pts)), t: o.t }
        added.push(n.id)
        return n
      })
      o.strokes = parts[0]
      o.bbox = bboxOf(o.strokes.flatMap((st) => st.pts))
      delete o.read
      if (o.kind === 'line') o.pts = simplify(o.strokes[0].pts, 24)
      this.objs.splice(at + 1, 0, ...made)
      changed++
    }
    // 나누기를 먼저. 같은 응답에서 나눈 객체를 다시 묶으라는 지시는 모순이므로 무시한다
    for (const group of r.merge) {
      if (group.some((id) => id in r.split)) continue
      const objs = group.map((id) => this.get(id))
      if (objs.length < 2 || objs.some((o) => !o || o.kind === 'text' || keep(o.id))) continue
      const [head, ...rest] = objs as BoardObj[]
      head.strokes = [...head.strokes, ...rest.flatMap((o) => o.strokes)]
      head.bbox = bboxOf(head.strokes.flatMap((st) => st.pts))
      head.t = Math.max(head.t, ...rest.map((o) => o.t))
      delete head.read
      this.objs = this.objs.filter((o) => !rest.includes(o))
      removed.push(...rest.map((o) => o.id))
      changed++
    }
    for (const [id, s] of Object.entries(r.objs)) {
      const o = this.get(id)
      if (!o || o.kind === 'text') continue
      if (s.role) o.role = s.role
      if (s.label) o.label = s.label
      if (s.from && this.get(s.from)) o.from = s.from
      if (s.to && this.get(s.to)) o.to = s.to
      if (s.role === 'value') {
        if (o.kind !== 'mark') { o.kind = 'mark'; delete o.pts; delete o.arrowEnd }
        if (s.read) o.read = s.read
      } else if (s.role === 'box') {
        o.kind = 'box'
        delete o.pts
        delete o.read
      } else if (s.role === 'arrow' || s.role === 'connector' || s.role === 'frame' || s.role === 'underline') {
        if (o.kind !== 'line') {
          const longest = [...o.strokes].sort((a, b) => pathLen(b.pts) - pathLen(a.pts))[0]
          o.kind = 'line'
          o.pts = simplify(longest.pts, 24)
        }
        delete o.read
        if (s.role === 'arrow' && s.head) o.arrowEnd = s.head
        if (s.role !== 'arrow') delete o.arrowEnd
      } else if (s.role) {
        delete o.read
        delete o.arrowEnd
      }
      changed++
    }
    if (changed) this.version++
    return { removed, added, changed }
  }

  /** 이벤트를 반영하고, AI를 부를 만한 사건이면 돌려준다 */
  apply(e: InkEvent): BoardEvent | null {
    if (e.type !== 'point') this.version++
    let ev: BoardEvent | null = null
    switch (e.type) {
      case 'page':
        this.page = e.info
        this.reset()
        return null
      case 'clear':
        this.reset()
        return null
      case 'stroke':
        if (e.stroke.points.length) {
          ev = this.addStroke(e.stroke)
          this.promoteDividers()
        }
        break
      case 'text':
        ev = this.addText(e.id, e.text, e.x, e.y, e.t)
        break
      case 'erase':
        ev = this.erase(e.strokeIds, e.t)
        break
      case 'point':
        ev = this.addTrace(e.points)
        break
    }
    if (ev) {
      this.events.push(ev)
      if (this.events.length > 40) this.events.shift()
    }
    return ev
  }

  private newId() {
    return 'o' + this.nextId++
  }

  private addStroke(s: InkStroke): BoardEvent {
    const raw = dropRevisits(s.points)
    const pts = raw.length === 1 ? [raw[0], { ...raw[0], x: raw[0].x + 1 }] : raw
    const t = lastT(pts)
    const sc = this.scale()
    const kind = classify(pts, sc)
    const b = bboxOf(pts)
    const diag = Math.hypot(b.w, b.h)
    const stroke: BoardStroke = { id: s.id, pts }

    // ① 덧그리기: 이미 있는 선을 따라 다시 그음
    if (kind === 'line' && diag > 40) {
      const sm = simplify(pts, 12)
      for (const o of this.objs) {
        if (o.kind !== 'line' || !o.pts) continue
        const near = sm.map((p) => nearestIdx(p, o.pts!))
        const avg = near.reduce((a, n) => a + n.d, 0) / near.length
        if (avg < 18) {
          o.strokes.push(stroke)
          o.t = t
          const rev = near[near.length - 1].i < near[0].i
          return {
            kind: '덧그리기',
            desc: `${o.id} 선을 ${rev ? '그린 방향과 반대로' : '그린 방향 그대로'} 덧그림 (이 선을 따라 강조)`,
            t,
            objId: o.id,
            rev,
          }
        }
      }
    }

    // ② 화살표 머리: 최근에 그린 선 끝에 V자 획, 꼭짓점이 선 끝을 향함.
    // 실측에서 머리를 선 길이의 절반 가까이 크게 그리기도 한다 (TCP 실측 s38: 머리 대각선 161, 선 317)
    if (diag < 200) {
      const v = vShape(pts)
      const ln = v && [...this.objs]
        .reverse()
        .find((o) => o.kind === 'line' && !o.arrowEnd && o.pts && t - o.t < 5000)
      if (v && ln?.pts && (diag < 70 || diag < 0.6 * pathLen(ln.pts))) {
        const lp = ln.pts
        for (const end of ['end', 'start'] as const) {
          const tipEnd = end === 'end' ? lp[lp.length - 1] : lp[0]
          const before = end === 'end' ? lp[Math.max(0, lp.length - 4)] : lp[Math.min(lp.length - 1, 3)]
          const dx = tipEnd.x - before.x
          const dy = tipEnd.y - before.y
          const behind = (p: Pt) => (p.x - v.tip.x) * dx + (p.y - v.tip.y) * dy < 0
          if (dist(v.tip, tipEnd) < Math.max(30, 0.35 * diag) && behind(v.a) && behind(v.z)) {
            ln.arrowEnd = end
            ln.strokes.push(stroke)
            ln.t = t
            return {
              kind: '화살표',
              desc: `${ln.id} 선이 화살표가 됨 (머리: (${Math.round(tipEnd.x)},${Math.round(tipEnd.y)}) 쪽으로 이동·인과)`,
              t,
              objId: ln.id,
              rev: end === 'start',
            }
          }
        }
      }
    }

    // ③ 손글씨는 이어 쓴 가까운 획끼리 하나로 묶는다 (여러 획으로 쓴 숫자·글자)
    const last = this.objs[this.objs.length - 1]
    if (last && kind !== 'box' && diag < 160 * sc && t - last.t < 1200) {
      const lastDiag = Math.hypot(last.bbox.w, last.bbox.h)
      const joinable = last.kind === 'mark' || last.kind === 'dot' || (last.kind === 'line' && !last.arrowEnd && lastDiag < 120 * sc)
      const nb = unionBox(last.bbox, b)
      // 큰 그림 옆에 쓴 작은 글자는 따로 둔다 (혈액순환 실측: 폐 윤곽 옆 "O2")
      const tiny = lastDiag >= 150 * sc && diag < 0.35 * lastDiag && overlapShare(b, last.bbox) < 0.3
      if (joinable && !tiny && intersects(expand(last.bbox, 30 * sc), b) && nb.w < 300 * sc && nb.h < 220 * sc) {
        last.kind = 'mark'
        delete last.pts
        last.strokes.push(stroke)
        last.bbox = nb
        last.t = t
        delete last.read // 획이 바뀌면 이전 이미지의 판독값은 더 이상 확정값이 아니다
        return { kind: '획', desc: `손글씨 ${last.id}에 획 추가`, t, objId: last.id }
      }
    }

    // 곧추선 직선이 다른 선에 닿지 않고 떠 있으면 숫자 1 같은 글자 (구분선은 테두리에 닿아 있다)
    const k = kind === 'line' && this.floatingUpright(pts, b, sc) ? 'mark' : kind
    const o: BoardObj = { id: this.newId(), kind: k, strokes: [stroke], bbox: b, t }
    if (k === 'line') o.pts = simplify(pts, 24)
    this.objs.push(o)
    return this.rewriteCheck(o, t) ?? { kind: '획', desc: `${KIND_KO[kind]} ${o.id} 추가`, t, objId: o.id }
  }

  private floatingUpright(pts: Pt[], b: Box, s: number) {
    if (!(b.h > 2.5 * b.w && b.h < 280 * s)) return false
    const others = this.objs.filter((o) => o.kind === 'line' || o.kind === 'box')
    if (!others.length) return false
    // 이미 그려진 도형(선·상자들이 둘러싼 범위) 안쪽에 있어야 한다
    const area = others.map((o) => o.bbox).reduce((u, x) => unionBox(u, x))
    if (!(b.x > area.x && b.x + b.w < area.x + area.w && b.y > area.y && b.y + b.h < area.y + area.h)) return false
    return !this.touchesFrame(pts, others, 30 * s)
  }

  private touchesFrame(pts: Pt[], frame: BoardObj[], tol: number) {
    const ends = [pts[0], pts[pts.length - 1]]
    return ends.some((e) => frame.some((o) => o.strokes.some((st) => st.pts.some((q) => dist(q, e) < tol))))
  }

  /**
   * 손글씨로 분류된 곧추선 획 하나를 지금 맥락으로 다시 본다. 틀에 끝이 닿아 있고 틀 높이에 가깝거나
   * 손글씨보다 훨씬 길면 칸 구분선(선)이다. 구분선은 보통 숫자보다 먼저 그려서, 그릴 때는 비교할
   * 손글씨 크기가 없다. 숫자 1은 틀에 닿지 않으므로 바뀌지 않는다. 선을 손글씨로 되돌리지는 않는다.
   */
  private promoteDividers() {
    const { dividerSpan, dividerVsWriting } = this.tuning
    const writing = this.writingHeight()
    const frame = this.objs.filter((x) => (x.kind === 'line' || x.kind === 'box') && !(x.strokes.length === 1 && upright(x.strokes[0].pts, x.bbox)))
    if (!frame.length) return
    const area = frame.map((x) => x.bbox).reduce((u, x) => unionBox(u, x))
    const tol = 30 * this.scale()
    for (const o of this.objs) {
      if (o.kind !== 'mark' || o.role || o.read || o.strokes.length !== 1) continue
      const pts = o.strokes[0].pts
      if (!upright(pts, o.bbox)) continue
      const spans = o.bbox.h >= dividerSpan * area.h
      const tall = writing != null && o.bbox.h >= dividerVsWriting * writing
      if (!(spans || tall) || !this.touchesFrame(pts, frame, tol)) continue
      o.kind = 'line'
      o.pts = simplify(pts, 24)
    }
  }

  private addText(srcId: string, text: string, x: number, y: number, t: number): BoardEvent {
    const w = Math.max(16, text.length * 14)
    const o: BoardObj = { id: this.newId(), kind: 'text', text, srcId, strokes: [], bbox: { x, y: y - 14, w, h: 28 }, t }
    this.objs.push(o)
    return this.rewriteCheck(o, t) ?? { kind: '글자', desc: `글자 ${o.id} "${text}" 추가`, t, objId: o.id }
  }

  /** ④ 지우고 같은 자리에 다시 씀 = 상태 변화 */
  private rewriteCheck(o: BoardObj, t: number): BoardEvent | null {
    const c = boxCenter(o.bbox)
    const e = [...this.erased].reverse().find((x) => t - x.t < 8000 && !x.rewritten && inBox(c, x.bbox, 20))
    if (!e) return null
    e.rewritten = o.id
    o.replaces = e.id
    return {
      kind: '다시 쓰기',
      desc: `${o.id}: 지운 ${e.id}(${KIND_KO[e.kind]}${e.text ? ' "' + e.text + '"' : ''}) 자리에 새로 씀 → 상태가 바뀜`,
      t,
      objId: o.id,
    }
  }

  private erase(ids: string[], t: number): BoardEvent | null {
    const set = new Set(ids)
    const gone: ErasedObj[] = []
    for (let k = this.objs.length - 1; k >= 0; k--) {
      const o = this.objs[k]
      if (o.kind === 'text') {
        if (o.srcId && set.has(o.srcId)) {
          this.objs.splice(k, 1)
          gone.push({ id: o.id, kind: o.kind, bbox: o.bbox, text: o.text, t })
        }
        continue
      }
      const before = o.strokes.length
      o.strokes = o.strokes.filter((s) => !set.has(s.id))
      if (o.strokes.length === before) continue
      if (!o.strokes.length) {
        this.objs.splice(k, 1)
        gone.push({ id: o.id, kind: o.kind, bbox: o.bbox, text: o.text, t })
      } else {
        o.bbox = bboxOf(o.strokes.flatMap((s) => s.pts))
        delete o.read
        if (o.kind === 'line') o.pts = simplify(o.strokes[0].pts, 24)
      }
    }
    if (!gone.length) return null
    this.erased.push(...gone)
    if (this.erased.length > 20) this.erased.splice(0, this.erased.length - 20)
    return {
      kind: '지우기',
      desc: `지움: ${gone.map((g) => `${g.id}(${KIND_KO[g.kind]}${g.text ? ' "' + g.text + '"' : ''})`).join(', ')}`,
      t,
    }
  }

  /** 가리킨 궤적이 지나간 객체: 점마다 가장 알맞은 객체 하나만 (겹친 상자 사이를 오가는 반복 방지) */
  private passesOf(points: Pt[]) {
    const passes: string[] = []
    for (const q of points) {
      let hit: BoardObj | undefined
      for (const o of this.objs) {
        if (o.kind === 'line') continue
        if (inBox(q, o.bbox, 10) && (!hit || area(o.bbox) < area(hit.bbox))) hit = o
      }
      hit ??= this.objs.find((o) => o.kind === 'line' && o.pts?.some((p) => dist(p, q) < 18))
      if (hit && passes[passes.length - 1] !== hit.id) passes.push(hit.id)
    }
    return passes.slice(0, 12)
  }

  private addTrace(points: InkPoint[]): BoardEvent | null {
    if (points.length < 3) return null
    const dur = (points[points.length - 1].t - points[0].t) / 1000
    // 펜을 대기 직전·직후의 짧은 떠 있음은 가리키기가 아님
    if (dur < 0.25 || pathLen(points) < 80) return null
    const id = 't' + this.nextTrace++
    const t = lastT(points)
    const passes = this.passesOf(points)
    this.traces.push({ id, pts: simplify(points, 24), t, passes, dur })
    if (this.traces.length > 8) this.traces.shift()
    return {
      kind: '가리키기',
      desc: `궤적 ${id}를 가리킴 (${dur.toFixed(1)}초, 지나간 객체: ${passes.join('→') || '없음'})`,
      t,
      objId: id,
    }
  }
}
