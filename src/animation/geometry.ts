export interface Pt {
  x: number
  y: number
}

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))

export const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)

export function bboxOf(pts: Pt[]): Box {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const p of pts) {
    if (p.x < x0) x0 = p.x
    if (p.y < y0) y0 = p.y
    if (p.x > x1) x1 = p.x
    if (p.y > y1) y1 = p.y
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

export function unionBox(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }
}

export const boxCenter = (b: Box): Pt => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 })

/** 점 n개로 고르게 줄이기 */
export function simplify<T extends Pt>(pts: T[], n: number): Pt[] {
  if (pts.length <= n) return pts.map((p) => ({ x: p.x, y: p.y }))
  const out: Pt[] = []
  for (let i = 0; i < n; i++) {
    const q = pts[Math.round((i * (pts.length - 1)) / (n - 1))]
    out.push({ x: q.x, y: q.y })
  }
  return out
}

export function pathLen(p: Pt[]): number {
  let L = 0
  for (let i = 1; i < p.length; i++) L += dist(p[i - 1], p[i])
  return L
}

/** 경로 위 비율 f(0~1) 지점 */
export function pointOnPath(p: Pt[], f: number): Pt {
  if (p.length === 1) return p[0]
  let target = clamp(f, 0, 1) * pathLen(p)
  for (let i = 1; i < p.length; i++) {
    const d = dist(p[i - 1], p[i])
    if (target <= d || i === p.length - 1) {
      const t = d ? clamp(target / d, 0, 1) : 0
      return { x: p[i - 1].x + (p[i].x - p[i - 1].x) * t, y: p[i - 1].y + (p[i].y - p[i - 1].y) * t }
    }
    target -= d
  }
  return p[p.length - 1]
}

export function nearestIdx(p: Pt, line: Pt[]) {
  let i = 0
  let d = Infinity
  line.forEach((q, k) => {
    const dd = dist(p, q)
    if (dd < d) {
      d = dd
      i = k
    }
  })
  return { i, d }
}

export const inBox = (p: Pt, b: Box, pad = 0) =>
  p.x > b.x - pad && p.x < b.x + b.w + pad && p.y > b.y - pad && p.y < b.y + b.h + pad

export const expand = (b: Box, pad: number): Box => ({ x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 })

export const intersects = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

export const area = (b: Box) => b.w * b.h

/** inner가 outer 안에 완전히 들어가는지 */
export const contains = (outer: Box, inner: Box) =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h

/** 시작점과 끝점 사이 직선거리 ÷ 실제 길이. 1에 가까울수록 곧은 획 */
export function straightness(pts: Pt[]) {
  const L = pathLen(pts)
  return L ? dist(pts[0], pts[pts.length - 1]) / L : 1
}

export function distToSegment(p: Pt, a: Pt, b: Pt) {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const L2 = dx * dx + dy * dy
  const t = L2 ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / L2, 0, 1) : 0
  return dist(p, { x: a.x + dx * t, y: a.y + dy * t })
}
