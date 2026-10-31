import type { Stroke } from "../types";

type XY = { x: number; y: number };

/** 점들을 부드러운 곡선 경로로 잇는다 (x,y는 0~1, w/h는 캔버스 픽셀) */
export function tracePath(ctx: CanvasRenderingContext2D, pts: XY[], w: number, h: number): void {
  ctx.beginPath();
  ctx.moveTo(pts[0].x * w, pts[0].y * h);
  if (pts.length === 1) {
    ctx.lineTo(pts[0].x * w + 0.01, pts[0].y * h);
    return;
  }
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = ((pts[i].x + pts[i + 1].x) / 2) * w;
    const my = ((pts[i].y + pts[i + 1].y) / 2) * h;
    ctx.quadraticCurveTo(pts[i].x * w, pts[i].y * h, mx, my);
  }
  const last = pts[pts.length - 1];
  ctx.lineTo(last.x * w, last.y * h);
}

export function drawStroke(ctx: CanvasRenderingContext2D, stroke: Stroke, w: number, h: number): void {
  if (stroke.points.length === 0) return;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = stroke.color;
  ctx.lineWidth = stroke.width * w;
  if (stroke.tool === "highlighter") {
    // multiply로 섞어서 아래 글씨가 형광펜 색에 덮이지 않고 그대로 진하게 보이게 한다
    ctx.globalAlpha = 0.5;
    ctx.globalCompositeOperation = "multiply";
  }
  tracePath(ctx, stroke.points, w, h);
  ctx.stroke();
  ctx.restore();
}

export function drawHighlights(ctx: CanvasRenderingContext2D, strokes: Stroke[], w: number, h: number): void {
  for (const s of strokes) if (s.tool === "highlighter") drawStroke(ctx, s, w, h);
}

export function drawPens(ctx: CanvasRenderingContext2D, strokes: Stroke[], w: number, h: number): void {
  for (const s of strokes) if (s.tool === "pen") drawStroke(ctx, s, w, h);
}

/** 한 캔버스에 같이 그릴 때(썸네일): 형광펜을 먼저 그려서 펜 글씨가 형광펜에 가려지지 않게 한다 */
export function drawStrokes(ctx: CanvasRenderingContext2D, strokes: Stroke[], w: number, h: number): void {
  drawHighlights(ctx, strokes, w, h);
  drawPens(ctx, strokes, w, h);
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** (x,y) 지점에서 radius(px) 안에 획이 닿는지 */
export function hitStroke(stroke: Stroke, x: number, y: number, radius: number, w: number, h: number): boolean {
  const px = x * w;
  const py = y * h;
  const reach = radius + (stroke.width * w) / 2;
  const pts = stroke.points;
  if (pts.length === 1) return Math.hypot(px - pts[0].x * w, py - pts[0].y * h) <= reach;
  for (let i = 1; i < pts.length; i++) {
    if (distToSegment(px, py, pts[i - 1].x * w, pts[i - 1].y * h, pts[i].x * w, pts[i].y * h) <= reach) return true;
  }
  return false;
}
