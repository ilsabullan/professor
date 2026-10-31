import type { Board, BoardObj } from './board'
import { type Pt, boxCenter, clamp, pathLen, pointOnPath } from './geometry'
import type { Op } from './ops'

interface PathAnim {
  pts: Pt[]
  t0: number
  dur: number
  base: Pt
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
}

/** 즉시 반응이 만든 효과(q…)는 AI에게 알리지 않는다. AI가 대상 객체로 착각하지 않게 */
export const isEffectId = (id: string) => id.startsWith('q')

interface Spawned {
  shape: 'dot' | 'circle' | 'box' | 'label'
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

interface Tween {
  set: (v: number) => void
  from: number
  to: number
  t0: number
  dur: number
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
 * 칠판 위 애니메이션 상태와 그리기.
 * 그린 객체(o…)를 움직이거나 색을 바꾸면 편집기에 원래 필기를 숨겨 달라고 요청하고, 여기서 대신 그린다.
 */
export class Engine {
  anim: Record<string, AnimState> = {}
  spawned: Record<string, Spawned> = {}
  flows: Flow[] = []
  /** 흰 종이 위에 그릴 때 true (PDF 편집기). 어두운 칠판이면 false */
  paper = false
  private tweens: Tween[] = []
  private takenOver = new Set<string>()
  /** 지금 단계가 시작될 때의 위치 (한 단계 안의 move는 모두 이 기준으로 동시에 움직인다) */
  private frozen = new Map<string, Pt>()
  /** 이번 단계의 move (id → 목적지 객체 id). 서로 맞바꾸는 쌍을 알아보려고 */
  private stepMoves = new Map<string, string>()
  /** 마지막으로 맞바꾼 쌍과 시각 */
  private lastSwap: { pair: string; t: number } | null = null

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
    this.tweens = []
  }

  /** 지워진 객체의 애니메이션 정리 */
  forget(ids: string[]) {
    for (const id of ids) {
      delete this.anim[id]
      this.takenOver.delete(id)
      this.flows = this.flows.filter((f) => f.along !== id)
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

  private tween(set: (v: number) => void, from: number, to: number, dur: number, now: number) {
    this.tweens.push({ set, from, to, t0: now, dur: Math.max(1, dur) })
  }

  /** 애니메이션이 대신 그리고 있는 객체인지 (원래 필기는 숨겨짐) */
  isTakenOver(id: string) {
    return this.takenOver.has(id)
  }

  /** 새 단계 시작: 단계 시작 위치 기록을 비운다 */
  beginStep() {
    this.frozen.clear()
    this.stepMoves.clear()
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
  overlaps(): [string, string][] {
    const items = this.board.objs.filter((o) => o.kind === 'mark' || o.kind === 'text')
    const boxes = items.map((o) => {
      const off = this.offset(o.id)
      return { id: o.id, x: o.bbox.x + off.x, y: o.bbox.y + off.y, w: o.bbox.w, h: o.bbox.h }
    })
    const out: [string, string][] = []
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]
        const b = boxes[j]
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

  linePts(id: string): Pt[] | null {
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
      case 'stop':
        this.flows = this.flows.filter((f) => f.along !== op.along)
        return 300
      case 'spawn': {
        let p: Pt = { x: W / 2, y: H / 2 }
        if (op.at) p = { x: op.at[0], y: op.at[1] }
        else if (op.on) p = this.center(op.on) ?? p
        this.spawned[op.id] = {
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
        // 방금(15초 안) 맞바꾼 두 객체를 다시 맞바꾸면 되돌리기가 되므로 무시한다
        // (말하는 중 요청과 확정 요청이 같은 교환을 두 번 실행하던 문제)
        if (typeof op.to === 'string') {
          const pair = [op.id, op.to].sort().join('|')
          if (this.lastSwap && this.lastSwap.pair === pair && now - this.lastSwap.t < 15000 && this.stepMoves.get(op.to) !== op.id) {
            return 0
          }
          this.stepMoves.set(op.id, op.to)
          if (this.stepMoves.get(op.to) === op.id) this.lastSwap = { pair, t: now }
        }
        // 출발점과 도착점 모두 '이 단계가 시작될 때의 위치' 기준. 같은 단계의 move들은 동시에 움직이므로
        // o7→o8, o8→o7 을 같이 쓰면 교환이 된다. 도착지에 무엇이 있든 엔진이 따로 손대지 않는다
        const from = this.startPos(op.id)
        if (!from) return 0
        const sp = this.spawned[op.id]
        if (!sp) this.takeOver(op.id)
        const a = this.A(op.id)
        if (op.along) {
          const pts = this.linePts(op.along)
          if (!pts) return 0
          const end = pts[pts.length - 1]
          const base = sp ? { x: 0, y: 0 } : { x: from.x - this.offset(op.id).x, y: from.y - this.offset(op.id).y }
          a.path = { pts, t0: now, dur: op.dur, base }
          if (sp) {
            sp.gx = end.x
            sp.gy = end.y
          } else {
            a.gx = end.x - base.x
            a.gy = end.y - base.y
          }
          return op.dur
        }
        const to = typeof op.to === 'string' ? this.startPos(op.to) : op.to ? { x: op.to[0], y: op.to[1] } : null
        if (!to) return 0
        if (sp) {
          sp.gx = to.x
          sp.gy = to.y
          this.tween((v) => (sp.x = v), sp.x, to.x, op.dur, now)
          this.tween((v) => (sp.y = v), sp.y, to.y, op.dur, now)
        } else {
          const gx = this.offset(op.id).x + to.x - from.x
          const gy = this.offset(op.id).y + to.y - from.y
          a.gx = gx
          a.gy = gy
          this.tween((v) => (a.dx = v), a.dx, gx, op.dur, now)
          this.tween((v) => (a.dy = v), a.dy, gy, op.dur, now)
        }
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
      if (a.path) {
        const k = clamp((now - a.path.t0) / a.path.dur, 0, 1)
        const q = pointOnPath(a.path.pts, k)
        const sp = this.spawned[id]
        if (sp) {
          sp.x = q.x
          sp.y = q.y
        } else {
          a.dx = q.x - a.path.base.x
          a.dy = q.y - a.path.base.y
        }
        if (k >= 1) a.path = null
      }
    }
    for (const f of this.flows) {
      const p = this.linePts(f.along)
      const L = p ? pathLen(p) : 300
      f.phase += (dt * f.speed * 120) / Math.max(80, L)
    }
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
    for (const [id, s] of Object.entries(this.spawned)) {
      const a = this.anim[id]
      c.save()
      c.globalAlpha = clamp(a?.alpha ?? 1, 0, 1)
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
    c.translate(cc.x + a.dx, cc.y + a.dy)
    c.scale(a.sc, a.sc)
    c.translate(-cc.x, -cc.y)
    const ink = this.col(a.color ?? INK)
    if (a.pulse > 0) {
      c.shadowColor = this.col(a.color ?? '#5ec8e6')
      c.shadowBlur = 26 * a.pulse
    }
    c.strokeStyle = ink
    c.fillStyle = ink
    c.lineCap = 'round'
    c.lineJoin = 'round'
    drawStrokes(c, o.strokes.map((s) => s.pts))
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
    const sp = Object.entries(this.spawned).filter(([id]) => !isEffectId(id))
    if (sp.length) out.push('네가 만든 객체: ' + sp.map(([id, s]) => `${id} ${s.shape}${s.text ? ' "' + s.text + '"' : ''} (${r(s.x)},${r(s.y)})`).join(', '))
    return out.join('\n') || '(움직이는 것 없음)'
  }
}

export function drawStrokes(c: CanvasRenderingContext2D, strokes: { x: number; y: number; p: number }[][]) {
  for (const s of strokes) {
    if (s.length === 1) {
      c.beginPath()
      c.arc(s[0].x, s[0].y, 2.5, 0, Math.PI * 2)
      c.fill()
      continue
    }
    for (let i = 1; i < s.length; i++) {
      c.lineWidth = 1.8 + (s[i].p ?? 0.5) * 3.6
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
}

/** 단계를 순서대로 재생한다. 도착한 동작은 단계 안에서 즉시 실행 */
export class Player {
  queue: PlayStep[] = []
  current: PlayStep | null = null

  constructor(
    private engine: Engine,
    private hooks: {
      onFirstOp: (step: PlayStep, now: number) => void
      onCaption: (step: PlayStep) => void
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
    if (this.current?.reqId === reqId) this.current.open = false
  }

  clear() {
    this.queue = []
    this.current = null
  }

  tick(now: number) {
    if (!this.current) {
      this.current = this.queue.shift() ?? null
      if (this.current) {
        this.current.startedAt = now
        this.engine.beginStep()
      }
    }
    const s = this.current
    if (!s) return
    while (s.applied < s.ops.length) {
      const d = this.engine.applyOp(s.ops[s.applied], now)
      if (s.applied === 0) this.hooks.onFirstOp(s, now)
      s.applied++
      s.maxDur = Math.max(s.maxDur, (now - (s.startedAt ?? now)) + d)
    }
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
