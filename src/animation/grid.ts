import { type Box, boxCenter, inBox, straightness } from './geometry'

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
}

const TOL = 28

/** 곧고 거의 수평/수직인 선, 그리고 상자의 네 변을 선분으로 */
function segsOf(o: GridSource): Seg[] {
  const b = o.bbox
  if (o.kind === 'box') {
    return [
      { id: o.id, dir: 'h', pos: b.y, from: b.x, to: b.x + b.w },
      { id: o.id, dir: 'h', pos: b.y + b.h, from: b.x, to: b.x + b.w },
      { id: o.id, dir: 'v', pos: b.x, from: b.y, to: b.y + b.h },
      { id: o.id, dir: 'v', pos: b.x + b.w, from: b.y, to: b.y + b.h },
    ]
  }
  if (o.kind !== 'line' || o.arrowEnd) return []
  const pts = o.strokes[0]?.pts
  if (!pts || pts.length < 2 || straightness(pts) < 0.9) return []
  const a = pts[0]
  const z = pts[pts.length - 1]
  const dx = Math.abs(z.x - a.x)
  const dy = Math.abs(z.y - a.y)
  const mean = (k: 'x' | 'y') => pts.reduce((s, p) => s + p[k], 0) / pts.length
  if (dx > 60 && dy / dx < 0.2) return [{ id: o.id, dir: 'h', pos: mean('y'), from: b.x, to: b.x + b.w }]
  if (dy > 60 && dx / dy < 0.2) return [{ id: o.id, dir: 'v', pos: mean('x'), from: b.y, to: b.y + b.h }]
  return []
}

const crosses = (h: Seg, v: Seg) =>
  v.pos > h.from - TOL && v.pos < h.to + TOL && h.pos > v.from - TOL && h.pos < v.to + TOL

/**
 * 같은 위치에서 겹치거나 맞닿은 선(상자 변과 겹쳐 그린 선 등)은 하나로.
 * 높이만 같고 멀리 떨어진 선(나란히 놓인 두 상자의 윗변 등)은 합치지 않는다.
 */
function merge(segs: Seg[]): Seg[] {
  const sorted = [...segs].sort((a, b) => a.pos - b.pos)
  const out: Seg[] = []
  for (const s of sorted) {
    const m = out.find((o) => Math.abs(o.pos - s.pos) < 15 && s.from <= o.to + TOL && s.to >= o.from - TOL)
    if (m) {
      m.pos = (m.pos + s.pos) / 2
      m.from = Math.min(m.from, s.from)
      m.to = Math.max(m.to, s.to)
    } else out.push({ ...s })
  }
  return out.sort((a, b) => a.pos - b.pos)
}

const covers = (s: Seg, a: number, b: number) => s.from <= a + TOL && s.to >= b - TOL

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
    // 표 전체를 거의 가로지르는 선만 칸 경계로 (칸 안에 길게 쓴 숫자 1 같은 건 제외)
    const spanOk = (s: Seg, a: number, b: number) => Math.min(s.to, b) - Math.max(s.from, a) >= 0.75 * (b - a)
    const yTop = H0[0].pos
    const yBot = H0[H0.length - 1].pos
    const xL = V0[0].pos
    const xR = V0[V0.length - 1].pos
    const H = H0.filter((h) => spanOk(h, xL, xR))
    const V = V0.filter((v) => spanOk(v, yTop, yBot))
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
