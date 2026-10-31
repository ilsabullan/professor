import type { Board } from './board'
import { drawStrokes, type Engine } from './engine'

/** "좌표+이미지" 모드용: 필기와 객체 id를 그린 작은 JPEG(base64) */
export function snapshotB64(board: Board, engine: Engine, maxW = 640): string {
  const { width: W, height: H } = board.page
  const sc = Math.min(1, maxW / W)
  const cv = document.createElement('canvas')
  cv.width = Math.round(W * sc)
  cv.height = Math.round(H * sc)
  const c = cv.getContext('2d')!
  c.scale(sc, sc)
  c.fillStyle = '#1b2420'
  c.fillRect(0, 0, W, H)
  c.strokeStyle = '#eef0e6'
  c.fillStyle = '#eef0e6'
  c.lineCap = 'round'
  for (const o of board.objs) {
    drawStrokes(c, o.strokes.map((s) => s.pts))
    if (o.kind === 'text' && o.text) {
      c.font = "30px 'Nanum Pen Script', cursive"
      c.textBaseline = 'middle'
      c.fillText(o.text, o.bbox.x, o.bbox.y + o.bbox.h / 2)
    }
  }
  engine.render(c)
  // 축소된 이미지에서도 읽히도록 최종 크기 14px 기준. 표 테두리 선에는 id를 달지 않는다(복잡해짐)
  c.fillStyle = '#ff5a46'
  c.font = `bold ${Math.round(14 / sc)}px sans-serif`
  c.textBaseline = 'alphabetic'
  for (const o of board.objs) if (!board.isGridLine(o.id)) c.fillText(o.id, o.bbox.x - 4, o.bbox.y - 4)
  return cv.toDataURL('image/jpeg', 0.8).split(',')[1]
}
