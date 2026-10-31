import type { InkEvent, InkPoint, InkStroke, PageInfo } from '../shared/ink'
import {
  type Box,
  type Pt,
  area,
  bboxOf,
  boxCenter,
  dist,
  distToSegment,
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
export function classify(pts: Pt[]): Exclude<ObjKind, 'text'> {
  const L = pathLen(pts)
  const b = bboxOf(pts)
  const diag = Math.hypot(b.w, b.h)
  const size = Math.max(b.w, b.h)
  if (diag < 14) return 'dot'
  const gap = dist(pts[0], pts[pts.length - 1])
  const closed = gap < Math.max(22, 0.28 * diag) && L > 1.9 * diag && b.w > 34 && b.h > 34
  if (closed) return (cornersHit(pts, b) >= 3 && edgeShare(pts, b) >= 0.75) || size >= 220 ? 'box' : 'mark'
  if (straightness(pts) >= 0.8) {
    // 짧게 곧추선 획은 숫자 1 같은 글자 (긴 세로선은 칸 구분선 등으로 선)
    if (b.h > 2.5 * b.w && b.h < 170) return 'mark'
    return diag < 40 ? 'mark' : 'line'
  }
  // 납작하고 넓은 획(살짝 흔들린 밑줄·가로선)은 선
  if (b.w >= 40 && b.h < 0.25 * b.w) return 'line'
  return size < 200 ? 'mark' : 'line'
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

const lastT = (pts: InkPoint[]) => pts[pts.length - 1]?.t ?? performance.now()

/** 편집기에서 온 필기 이벤트를 객체와 사건으로 해석한다 */
export class Board {
  page: PageInfo = { page: 1, width: 1280, height: 720 }
  objs: BoardObj[] = []
  erased: ErasedObj[] = []
  traces: Trace[] = []
  events: BoardEvent[] = []
  private nextId = 1
  private nextTrace = 1

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
    if (!o || o.kind !== 'line' || o.arrowEnd) return undefined
    const b = o.bbox
    if (b.w > 180 || b.h > b.w * 0.35) return undefined
    return this.objs.find((m) => {
      if (m.kind !== 'mark' && m.kind !== 'text') return false
      const bottom = m.bbox.y + m.bbox.h
      const overlap = Math.min(b.x + b.w, m.bbox.x + m.bbox.w) - Math.max(b.x, m.bbox.x)
      return b.y > bottom - 20 && b.y < bottom + 50 && overlap > 0.4 * Math.min(b.w, m.bbox.w)
    })?.id
  }

  /** 이벤트를 반영하고, AI를 부를 만한 사건이면 돌려준다 */
  apply(e: InkEvent): BoardEvent | null {
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
        if (e.stroke.points.length) ev = this.addStroke(e.stroke)
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
    const pts = s.points.length === 1 ? [s.points[0], { ...s.points[0], x: s.points[0].x + 1 }] : s.points
    const t = lastT(pts)
    const kind = classify(pts)
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

    // ② 화살표 머리: 최근에 그린 선 끝에 V자 획, 꼭짓점이 선 끝을 향함
    if (diag < 70) {
      const v = vShape(pts)
      if (v) {
        const ln = [...this.objs]
          .reverse()
          .find((o) => o.kind === 'line' && !o.arrowEnd && o.pts && t - o.t < 5000)
        if (ln?.pts) {
          const lp = ln.pts
          for (const end of ['end', 'start'] as const) {
            const tipEnd = end === 'end' ? lp[lp.length - 1] : lp[0]
            const before = end === 'end' ? lp[Math.max(0, lp.length - 4)] : lp[Math.min(lp.length - 1, 3)]
            const dx = tipEnd.x - before.x
            const dy = tipEnd.y - before.y
            const behind = (p: Pt) => (p.x - v.tip.x) * dx + (p.y - v.tip.y) * dy < 0
            if (dist(v.tip, tipEnd) < 30 && behind(v.a) && behind(v.z)) {
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
    }

    // ③ 손글씨는 이어 쓴 가까운 획끼리 하나로 묶는다 (여러 획으로 쓴 숫자·글자)
    const last = this.objs[this.objs.length - 1]
    if (last && kind !== 'box' && diag < 160 && t - last.t < 1200) {
      const lastDiag = Math.hypot(last.bbox.w, last.bbox.h)
      const joinable = last.kind === 'mark' || last.kind === 'dot' || (last.kind === 'line' && !last.arrowEnd && lastDiag < 120)
      const nb = unionBox(last.bbox, b)
      if (joinable && intersects(expand(last.bbox, 30), b) && nb.w < 300 && nb.h < 220) {
        last.kind = 'mark'
        delete last.pts
        last.strokes.push(stroke)
        last.bbox = nb
        last.t = t
        return { kind: '획', desc: `손글씨 ${last.id}에 획 추가`, t, objId: last.id }
      }
    }

    // 곧추선 직선이 다른 선에 닿지 않고 떠 있으면 숫자 1 같은 글자 (구분선은 테두리에 닿아 있다)
    const k = kind === 'line' && this.floatingUpright(pts, b) ? 'mark' : kind
    const o: BoardObj = { id: this.newId(), kind: k, strokes: [stroke], bbox: b, t }
    if (k === 'line') o.pts = simplify(pts, 24)
    this.objs.push(o)
    return this.rewriteCheck(o, t) ?? { kind: '획', desc: `${KIND_KO[kind]} ${o.id} 추가`, t, objId: o.id }
  }

  private floatingUpright(pts: InkPoint[], b: Box) {
    if (!(b.h > 2.5 * b.w && b.h < 280)) return false
    const ends = [pts[0], pts[pts.length - 1]]
    const others = this.objs.filter((o) => o.kind === 'line' || o.kind === 'box')
    if (!others.length) return false
    // 이미 그려진 도형(선·상자들이 둘러싼 범위) 안쪽에 있어야 한다
    const area = others.map((o) => o.bbox).reduce((u, x) => unionBox(u, x))
    if (!(b.x > area.x && b.x + b.w < area.x + area.w && b.y > area.y && b.y + b.h < area.y + area.h)) return false
    return !ends.some((e) => others.some((o) => o.strokes.some((st) => st.pts.some((q) => dist(q, e) < 30))))
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
