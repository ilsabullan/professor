import type { InkBus } from '../shared/bus'
import type { InkPoint, InkStroke, PageInfo } from '../shared/ink'

/**
 * 테스트용 필기 캔버스. 실제 PDF 편집기가 할 일(필기 그리기, 지우기, 가리키기)을 흉내 내고
 * 계약(src/shared/ink.ts)대로 InkBus에 이벤트를 보낸다.
 */

export type Tool = 'pen' | 'erase' | 'point' | 'text'

interface TextItem {
  id: string
  text: string
  x: number
  y: number
}

const BG = '#1b2420'
const INK = '#eef0e6'
const FONT = "'Nanum Pen Script', cursive"

export class TestBoardController {
  page: PageInfo = { page: 1, width: 1280, height: 720 }
  tool: Tool = 'pen'
  onToolChange: ((t: Tool) => void) | null = null
  /** 글자 도구로 누른 자리 (화면에 입력칸을 띄우기 위해) */
  onTextRequest: ((at: { x: number; y: number; left: number; top: number }) => void) | null = null

  private strokes: InkStroke[] = []
  private texts: TextItem[] = []
  private hidden = new Set<string>()
  private cur: { pid: number; pts: InkPoint[] } | null = null
  private erasing: { pid: number; ids: string[] } | null = null
  private pointing: { pid: number | 'hover'; pts: InkPoint[] } | null = null
  private hoverTimer: ReturnType<typeof setTimeout> | undefined
  private hoverBlockedUntil = 0
  private trail: InkPoint[] = []
  private seq = 0
  private canvas: HTMLCanvasElement | null = null
  private raf = 0
  private offRequest: () => void

  constructor(private bus: InkBus) {
    this.offRequest = bus.onRequest((r) => {
      if (r.type === 'hideStrokes') r.strokeIds.forEach((id) => (r.hidden ? this.hidden.add(id) : this.hidden.delete(id)))
    })
  }

  dispose() {
    this.offRequest()
    this.detach()
  }

  setTool(t: Tool) {
    this.tool = t
    this.onToolChange?.(t)
  }

  openPage(info: PageInfo) {
    this.page = info
    this.strokes = []
    this.texts = []
    this.hidden.clear()
    this.bus.emit({ type: 'page', info })
  }

  clear() {
    this.strokes = []
    this.texts = []
    this.hidden.clear()
    this.bus.emit({ type: 'clear', page: this.page.page })
  }

  undo() {
    const s = this.strokes.pop()
    if (s) this.bus.emit({ type: 'erase', page: this.page.page, strokeIds: [s.id], t: performance.now() })
  }

  // ---------- 캔버스 ----------
  attach(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    canvas.addEventListener('pointerdown', this.down)
    canvas.addEventListener('pointermove', this.move)
    canvas.addEventListener('pointerup', this.up)
    canvas.addEventListener('pointercancel', this.up)
    canvas.addEventListener('pointerleave', this.leave)
    const loop = () => {
      this.draw()
      this.raf = requestAnimationFrame(loop)
    }
    this.raf = requestAnimationFrame(loop)
  }

  detach() {
    const c = this.canvas
    if (!c) return
    c.removeEventListener('pointerdown', this.down)
    c.removeEventListener('pointermove', this.move)
    c.removeEventListener('pointerup', this.up)
    c.removeEventListener('pointercancel', this.up)
    c.removeEventListener('pointerleave', this.leave)
    cancelAnimationFrame(this.raf)
    this.canvas = null
  }

  private toPage(e: PointerEvent): InkPoint {
    const r = this.canvas!.getBoundingClientRect()
    let p = e.pressure
    if (e.pointerType === 'mouse' || !(p > 0 && p < 1)) p = 0.5
    return {
      x: ((e.clientX - r.left) / r.width) * this.page.width,
      y: ((e.clientY - r.top) / r.height) * this.page.height,
      p,
      t: performance.now(),
    }
  }

  private points(e: PointerEvent) {
    const list = e.getCoalescedEvents?.() ?? []
    return (list.length ? list : [e]).map((v) => this.toPage(v))
  }

  private down = (e: PointerEvent) => {
    const q = this.toPage(e)
    if (this.tool === 'text') {
      const r = this.canvas!.getBoundingClientRect()
      this.onTextRequest?.({ x: q.x, y: q.y, left: e.clientX - r.left, top: e.clientY - r.top })
      return
    }
    this.canvas!.setPointerCapture(e.pointerId)
    const penEraser = e.pointerType === 'pen' && (e.button === 5 || (e.buttons & 32) !== 0)
    if (this.tool === 'erase' || penEraser) {
      this.erasing = { pid: e.pointerId, ids: [] }
      this.eraseAt(q)
      return
    }
    if (this.tool === 'point') {
      this.pointing = { pid: e.pointerId, pts: [q] }
      return
    }
    // 펜이 닿기 직전까지 떠 있던 것은 가리키기가 아니라 쓰려고 다가온 것
    this.cancelHover()
    this.cur = { pid: e.pointerId, pts: [q] }
  }

  private move = (e: PointerEvent) => {
    if (this.erasing && e.pointerId === this.erasing.pid) {
      this.points(e).forEach((q) => this.eraseAt(q))
      return
    }
    if (this.pointing && this.pointing.pid === e.pointerId) {
      const qs = this.points(e)
      this.pointing.pts.push(...qs)
      this.trail.push(...qs)
      return
    }
    if (this.cur && e.pointerId === this.cur.pid) {
      this.cur.pts.push(...this.points(e))
      return
    }
    // 펜을 화면에 대지 않고 띄운 채 움직이기 = 가리키기 (획을 막 뗀 직후는 제외)
    if (e.pointerType === 'pen' && e.buttons === 0 && this.tool === 'pen' && performance.now() > this.hoverBlockedUntil) {
      this.pointing ??= { pid: 'hover', pts: [] }
      if (this.pointing.pid === 'hover') {
        const qs = this.points(e)
        this.pointing.pts.push(...qs)
        this.trail.push(...qs)
        clearTimeout(this.hoverTimer)
        this.hoverTimer = setTimeout(() => this.finishHover(), 450)
      }
    }
  }

  private up = (e: PointerEvent) => {
    if (this.erasing && e.pointerId === this.erasing.pid) {
      const ids = this.erasing.ids
      this.erasing = null
      if (ids.length) this.bus.emit({ type: 'erase', page: this.page.page, strokeIds: ids, t: performance.now() })
      return
    }
    if (this.pointing && this.pointing.pid === e.pointerId) {
      this.finishPointing()
      return
    }
    if (!this.cur || e.pointerId !== this.cur.pid) return
    const pts = this.cur.pts
    this.cur = null
    this.hoverBlockedUntil = performance.now() + 400
    this.addStroke(pts)
  }

  private leave = (e: PointerEvent) => {
    if (e.pointerType === 'pen') this.finishHover()
  }

  private cancelHover() {
    clearTimeout(this.hoverTimer)
    if (this.pointing?.pid === 'hover') this.pointing = null
  }

  private finishHover() {
    clearTimeout(this.hoverTimer)
    // 0.4초도 안 되는 떠 있음은 의도한 가리키기로 보지 않는다
    const p = this.pointing
    if (p?.pid === 'hover' && p.pts.length && p.pts[p.pts.length - 1].t - p.pts[0].t < 400) {
      this.pointing = null
      return
    }
    if (this.pointing?.pid === 'hover') this.finishPointing()
  }

  private finishPointing() {
    const p = this.pointing
    this.pointing = null
    if (p && p.pts.length >= 3) this.bus.emit({ type: 'point', page: this.page.page, points: p.pts })
  }

  private eraseAt(q: InkPoint) {
    if (!this.erasing) return
    for (let k = this.strokes.length - 1; k >= 0; k--) {
      const s = this.strokes[k]
      if (s.points.some((p) => Math.hypot(p.x - q.x, p.y - q.y) < 14)) {
        this.strokes.splice(k, 1)
        this.erasing.ids.push(s.id)
      }
    }
    for (let k = this.texts.length - 1; k >= 0; k--) {
      const t = this.texts[k]
      const w = Math.max(16, t.text.length * 14)
      if (q.x > t.x - 6 && q.x < t.x + w + 6 && q.y > t.y - 20 && q.y < t.y + 20) {
        this.texts.splice(k, 1)
        this.erasing.ids.push(t.id)
      }
    }
  }

  addStroke(points: InkPoint[]) {
    if (!points.length) return
    const stroke: InkStroke = { id: 's' + ++this.seq, page: this.page.page, points }
    this.strokes.push(stroke)
    this.bus.emit({ type: 'stroke', stroke })
  }

  addText(text: string, x: number, y: number) {
    const id = 'x' + ++this.seq
    this.texts.push({ id, text, x, y })
    this.bus.emit({ type: 'text', page: this.page.page, id, text, x, y, t: performance.now() })
  }

  /** 가리키기 궤적을 코드로 보냄 (예시용) */
  addPointing(points: InkPoint[]) {
    this.trail.push(...points)
    this.bus.emit({ type: 'point', page: this.page.page, points })
  }

  private draw() {
    const cv = this.canvas
    if (!cv) return
    const r = cv.getBoundingClientRect()
    const d = window.devicePixelRatio || 1
    const w = Math.max(1, Math.round(r.width * d))
    const h = Math.max(1, Math.round(r.height * d))
    if (cv.width !== w || cv.height !== h) {
      cv.width = w
      cv.height = h
    }
    const c = cv.getContext('2d')!
    const sc = (r.width / this.page.width) * d
    c.setTransform(sc, 0, 0, sc, 0, 0)
    c.fillStyle = BG
    c.fillRect(0, 0, this.page.width, this.page.height)
    c.strokeStyle = INK
    c.fillStyle = INK
    c.lineCap = 'round'
    c.lineJoin = 'round'
    for (const s of this.strokes) if (!this.hidden.has(s.id)) drawLine(c, s.points)
    if (this.cur) drawLine(c, this.cur.pts)
    c.font = `30px ${FONT}`
    c.textBaseline = 'middle'
    for (const t of this.texts) if (!this.hidden.has(t.id)) c.fillText(t.text, t.x, t.y)
    // 가리키기 자취: 빨간 꼬리로 잠깐
    const now = performance.now()
    while (this.trail.length && now - this.trail[0].t > 1200) this.trail.shift()
    for (let i = 1; i < this.trail.length; i++) {
      const a = 1 - (now - this.trail[i].t) / 1200
      c.strokeStyle = `rgba(255,90,70,${a})`
      c.lineWidth = 4 * a + 1
      c.beginPath()
      c.moveTo(this.trail[i - 1].x, this.trail[i - 1].y)
      c.lineTo(this.trail[i].x, this.trail[i].y)
      c.stroke()
    }
  }
}

function drawLine(c: CanvasRenderingContext2D, pts: InkPoint[]) {
  if (pts.length === 1) {
    c.beginPath()
    c.arc(pts[0].x, pts[0].y, 2.5, 0, Math.PI * 2)
    c.fill()
    return
  }
  for (let i = 1; i < pts.length; i++) {
    c.lineWidth = 1.8 + (pts[i].p ?? 0.5) * 3.6
    c.beginPath()
    c.moveTo(pts[i - 1].x, pts[i - 1].y)
    c.lineTo(pts[i].x, pts[i].y)
    c.stroke()
  }
}
