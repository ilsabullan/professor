import { type Box, boxCenter, inBox } from './geometry'

/** 표·배열: 가로선과 세로선(또는 상자 테두리)이 서로 교차해 만든 칸들 */
export interface GridCell {
  r: number
  c: number
  box: Box
  /** 칸 안에 든 객체 id */
  items: string[]
}

export interface Grid {
  id: string
  /** 표를 이루는 선·상자 객체 id */
  lineIds: string[]
  rows: number
  cols: number
  cells: GridCell[]
  bbox: Box
}

/** grid.ts가 읽는 최소한의 객체 모양 (board.ts의 BoardObj와 호환) */
export interface GridSource {
  id: string
  kind: string
  bbox: Box
  arrowEnd?: string
  strokes: { pts: { x: number; y: number }[] }[]
}

interface Seg {
  id: string
  dir: 'h' | 'v'
  /** 가로선이면 y, 세로선이면 x */
  pos: number
  from: number
  to: number
  /** 상자의 변인지 (상자는 그 자체로 닫힌 도형) */
  box?: boolean
}

/** 손으로 그린 선은 모서리가 둥글고 끝이 서로 떨어져 있다. 그만큼 너그럽게 */
const TOL = 45

type P = { x: number; y: number }

/** 꺾인 점만 남기기 (Ramer–Douglas–Peucker) */
function corners(pts: P[], eps: number): P[] {
  if (pts.length < 3) return pts
  const a = pts[0]
  const z = pts[pts.length - 1]
  const dx = z.x - a.x
  const dy = z.y - a.y
  const L = Math.hypot(dx, dy) || 1
  let best = -1
  let bi = 0
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs((pts[i].x - a.x) * dy - (pts[i].y - a.y) * dx) / L
    if (d > best) {
      best = d
      bi = i
    }
  }
  if (best <= eps) return [a, z]
  return [...corners(pts.slice(0, bi + 1), eps).slice(0, -1), ...corners(pts.slice(bi), eps)]
}

/**
 * 거의 수평/수직인 직선 구간과 상자의 네 변을 선분으로.
 * 한 획으로 꺾어 그린 테두리(ㄱ·ㄴ·ㄷ자)도 꺾인 곳에서 나눠 각각 선분으로 본다.
 */
export function segsOf(o: GridSource): Seg[] {
  const b = o.bbox
  if (o.kind === 'box') {
    return [
      { id: o.id, box: true, dir: 'h', pos: b.y, from: b.x, to: b.x + b.w },
      { id: o.id, box: true, dir: 'h', pos: b.y + b.h, from: b.x, to: b.x + b.w },
      { id: o.id, box: true, dir: 'v', pos: b.x, from: b.y, to: b.y + b.h },
      { id: o.id, box: true, dir: 'v', pos: b.x + b.w, from: b.y, to: b.y + b.h },
    ]
  }
  if (o.kind !== 'line' || o.arrowEnd) return []
  const out: Seg[] = []
  for (const s of o.strokes) {
    const v = corners(s.pts, 14)
    for (let i = 1; i < v.length; i++) {
      const a = v[i - 1]
      const z = v[i]
      const dx = Math.abs(z.x - a.x)
      const dy = Math.abs(z.y - a.y)
      if (dx > 60 && dy / dx < 0.2) out.push({ id: o.id, dir: 'h', pos: (a.y + z.y) / 2, from: Math.min(a.x, z.x), to: Math.max(a.x, z.x) })
      else if (dy > 60 && dx / dy < 0.2) out.push({ id: o.id, dir: 'v', pos: (a.x + z.x) / 2, from: Math.min(a.y, z.y), to: Math.max(a.y, z.y) })
    }
  }
  return out
}

/** 서로 다른 상자끼리는 실제로 맞닿아야 연결 (떨어져 놓인 상자들은 표가 아님) */
const tolOf = (a: Seg, b: Seg) => (a.box && b.box && a.id !== b.id ? 8 : TOL)

const crosses = (h: Seg, v: Seg) => {
  const t = tolOf(h, v)
  return v.pos > h.from - t && v.pos < h.to + t && h.pos > v.from - t && h.pos < v.to + t
}

/**
 * 같은 위치에서 겹치거나 맞닿은 선(상자 변과 겹쳐 그린 선 등)은 하나로.
 * 높이만 같고 멀리 떨어진 선(나란히 놓인 두 상자의 윗변 등)은 합치지 않는다.
 */
function merge(segs: Seg[]): Seg[] {
  const sorted = [...segs].sort((a, b) => a.pos - b.pos)
  const out: Seg[] = []
  for (const s of sorted) {
    const m = out.find((o) => Math.abs(o.pos - s.pos) < 15 && s.from <= o.to + tolOf(o, s) && s.to >= o.from - tolOf(o, s))
    if (m) {
      m.pos = (m.pos + s.pos) / 2
      m.from = Math.min(m.from, s.from)
      m.to = Math.max(m.to, s.to)
    } else out.push({ ...s })
  }
  return out.sort((a, b) => a.pos - b.pos)
}

const covers = (s: Seg, a: number, b: number) => {
  const tol = Math.max(TOL, 0.35 * (b - a))
  return s.from <= a + tol && s.to >= b - tol
}

/** 서로 교차하는 선 묶음마다 칸을 만든다. 칸이 2개 이상일 때만 표로 본다 */
export function detectGrids(objs: GridSource[]): Grid[] {
  const segs = objs.flatMap(segsOf)
  const hs = segs.filter((s) => s.dir === 'h')
  const vs = segs.filter((s) => s.dir === 'v')
  // 교차 관계로 묶음(연결 요소) 나누기
  const parent = segs.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  hs.forEach((h) =>
    vs.forEach((v) => {
      if (crosses(h, v)) parent[find(segs.indexOf(h))] = find(segs.indexOf(v))
    }),
  )
  const groups = new Map<number, Seg[]>()
  segs.forEach((s, i) => {
    const g = groups.get(find(i)) ?? []
    g.push(s)
    groups.set(find(i), g)
  })

  const grids: Grid[] = []
  for (const g of groups.values()) {
    const H0 = merge(g.filter((s) => s.dir === 'h'))
    const V0 = merge(g.filter((s) => s.dir === 'v'))
    if (H0.length < 2 || V0.length < 2) continue
    // 칸 경계: 표를 대부분(80%) 가로지르거나, 절반 이상 가로지르며 끝이 다른 테두리에 닿는 선
    // (칸 안에 길게 쓴 숫자 1은 위아래 테두리에서 떨어져 있어 제외된다)
    const boundary = (s: Seg, a: number, b: number, others: Seg[]) => {
      const cov = (Math.min(s.to, b) - Math.max(s.from, a)) / (b - a)
      const touches = others.some((o) => Math.abs(s.from - o.pos) < 25 || Math.abs(s.to - o.pos) < 25)
      return cov >= 0.8 || (cov >= 0.5 && touches)
    }
    const yTop = H0[0].pos
    const yBot = H0[H0.length - 1].pos
    const xL = V0[0].pos
    const xR = V0[V0.length - 1].pos
    // 닿는지 볼 상대는 긴 선만 (숫자 밑줄 같은 짧은 선에 닿은 건 치지 않음)
    const long = (s: Seg, a: number, b: number) => (Math.min(s.to, b) - Math.max(s.from, a)) / (b - a) >= 0.5
    const Hl = H0.filter((h) => long(h, xL, xR))
    const Vl = V0.filter((v) => long(v, yTop, yBot))
    const H = H0.filter((h) => boundary(h, xL, xR, Vl))
    const V = V0.filter((v) => boundary(v, yTop, yBot, Hl))
    if (H.length < 2 || V.length < 2) continue
    const cells: GridCell[] = []
    for (let r = 0; r < H.length - 1; r++) {
      for (let c = 0; c < V.length - 1; c++) {
        const x0 = V[c].pos
        const x1 = V[c + 1].pos
        const y0 = H[r].pos
        const y1 = H[r + 1].pos
        if (x1 - x0 < 24 || y1 - y0 < 24) continue
        const closed = covers(H[r], x0, x1) && covers(H[r + 1], x0, x1) && covers(V[c], y0, y1) && covers(V[c + 1], y0, y1)
        if (closed) cells.push({ r, c, box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, items: [] })
      }
    }
    if (cells.length < 2) continue
    const xs = cells.flatMap((c) => [c.box.x, c.box.x + c.box.w])
    const ys = cells.flatMap((c) => [c.box.y, c.box.y + c.box.h])
    const bbox = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
    // 행·열 번호를 실제로 칸이 있는 것만 0부터 다시 매긴다
    const rowsUsed = [...new Set(cells.map((c) => c.r))].sort((a, b) => a - b)
    const colsUsed = [...new Set(cells.map((c) => c.c))].sort((a, b) => a - b)
    cells.forEach((c) => {
      c.r = rowsUsed.indexOf(c.r)
      c.c = colsUsed.indexOf(c.c)
    })
    const used = new Set([...H, ...V].flatMap((s) => g.filter((x) => x.dir === s.dir && Math.abs(x.pos - s.pos) < 16).map((x) => x.id)))
    grids.push({
      id: 'g' + (grids.length + 1),
      lineIds: [...used],
      rows: rowsUsed.length,
      cols: colsUsed.length,
      cells,
      bbox,
    })
  }
  // 칸 안의 객체 채우기
  for (const grid of grids) {
    for (const o of objs) {
      if (grid.lineIds.includes(o.id)) continue
      const c = boxCenter(o.bbox)
      const cell = grid.cells.find((k) => inBox(c, k.box))
      if (cell) cell.items.push(o.id)
    }
  }
  return grids
}

export function cellOf(grids: Grid[], b: Box) {
  const c = boxCenter(b)
  for (const g of grids) {
    const cell = g.cells.find((k) => inBox(c, k.box))
    if (cell) return { grid: g, cell }
  }
  return null
}
