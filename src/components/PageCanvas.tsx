import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { LaserTrail, Page, Point, Stroke, Tool } from "../types";
import { drawCachedPdfPage, renderPdfPage, type PDFDocumentProxy } from "../lib/pdf";
import { drawHighlights, drawPens, drawStroke, hitStroke } from "../lib/ink";
import { Laser } from "../lib/laser";
import { uid } from "../lib/id";

const ERASER_RADIUS = 10; // 화면 기준 px
// 캔버스 4장이 다 이 크기라 너무 크면 확대·넘기기가 버벅인다. 화질과 부드러움 사이에서 고른 값
const MAX_PIXELS = 5_000_000;
// 손떨림 보정: 새 점을 이전 점 쪽으로 이만큼 끌어당긴다 (0이면 보정 없음). 최소한만 건다
const STABILIZE = 0.3;
const PDF_RERENDER_DELAY = 150; // 확대가 끝나고 이만큼 지난 뒤에 PDF를 새 크기로 다시 그린다

/** 화면 너비(css px)에 대해 실제로 그릴 캔버스 픽셀 너비. 미리 그려 두기(prefetch)에서도 같은 값을 쓴다 */
export function pagePixelWidth(page: Page, cssWidth: number): number {
  const cssHeight = (cssWidth * page.height) / page.width;
  const scale = Math.min(window.devicePixelRatio || 1, Math.sqrt(MAX_PIXELS / (cssWidth * cssHeight)));
  return Math.round(cssWidth * scale);
}

type Gesture =
  | { kind: "ink"; pointerId: number; stroke: Stroke }
  | { kind: "erase"; pointerId: number; at: Point }
  | { kind: "laser"; pointerId: number };

type Props = {
  page: Page;
  pdfDoc: PDFDocumentProxy | null;
  strokes: Stroke[];
  cssWidth: number;
  tool: Tool;
  color: string;
  strokeWidth: number;
  clock: () => number;
  onStroke: (stroke: Stroke) => void;
  onEraseStart: () => void;
  onErase: (ids: Set<string>) => void;
  onEraseEnd: () => void;
  onLaser: (trail: LaserTrail) => void;
};

/**
 * 한 페이지. 아래부터 PDF, 형광펜(multiply로 섞여 글씨 밑에 깔린다), 펜, 지금 긋는 획·레이저.
 * 필기는 펜과 마우스로만 한다. 손가락 터치는 그대로 위로 올려 보내서 필기 화면이 확대·이동·넘기기에 쓴다.
 */
export function PageCanvas(props: Props) {
  const { page, pdfDoc, strokes, cssWidth } = props;
  const cssHeight = (cssWidth * page.height) / page.width;
  const pw = pagePixelWidth(page, cssWidth);
  const ph = Math.round((pw * page.height) / page.width);

  const bgRef = useRef<HTMLCanvasElement>(null);
  const hlRef = useRef<HTMLCanvasElement>(null);
  const inkRef = useRef<HTMLCanvasElement>(null);
  const liveRef = useRef<HTMLCanvasElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const gesture = useRef<Gesture | null>(null);
  const dirty = useRef(true);
  const [laser] = useState(() => new Laser());
  const bgDrawn = useRef(false);

  // 넘겨 온 페이지처럼 미리 그려 둔 그림이 있으면 화면에 나오기 전에 바로 옮긴다
  useLayoutEffect(() => {
    if (!bgDrawn.current && pdfDoc && page.pdfPageIndex !== null) {
      bgDrawn.current = drawCachedPdfPage(pdfDoc, page.pdfPageIndex, bgRef.current!, pw);
    }
  }, [pdfDoc, page, pw]);

  useEffect(() => {
    const canvas = bgRef.current!;
    if (pdfDoc && page.pdfPageIndex !== null) {
      // 처음에는 바로 그리고, 확대로 크기가 바뀔 때는 손을 뗀 뒤 잠깐 기다렸다가 다시 그린다.
      // 그동안은 이전 그림이 늘어난 채로 보여서 확대 중에 버벅이지 않는다
      let job: ReturnType<typeof renderPdfPage> | null = null;
      const timer = window.setTimeout(
        () => {
          job = renderPdfPage(pdfDoc, page.pdfPageIndex!, canvas, pw);
          bgDrawn.current = true;
        },
        bgDrawn.current ? PDF_RERENDER_DELAY : 0,
      );
      return () => {
        clearTimeout(timer);
        job?.cancel();
      };
    }
    canvas.width = pw;
    canvas.height = ph;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, pw, ph);
  }, [pdfDoc, page, pw, ph]);

  const drawHighlightLayer = (current?: Stroke) => {
    const canvas = hlRef.current!;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawHighlights(ctx, latest.current.strokes, canvas.width, canvas.height);
    if (current) drawStroke(ctx, current, canvas.width, canvas.height);
  };

  // 획을 확정하는 순간 미리보기가 사라지고 저장된 필기가 늦게 그려져 깜빡이지 않도록 layout effect로 그린다
  useLayoutEffect(() => {
    for (const ref of [hlRef, inkRef]) {
      ref.current!.width = pw;
      ref.current!.height = ph;
    }
    drawHighlightLayer();
    drawPens(inkRef.current!.getContext("2d")!, strokes, pw, ph);
  }, [strokes, pw, ph]);

  useLayoutEffect(() => {
    liveRef.current!.width = pw;
    liveRef.current!.height = ph;
    dirty.current = true;
  }, [pw, ph]);

  useEffect(() => {
    let raf = 0;
    let laserVisible = false;
    const tick = () => {
      const canvas = liveRef.current;
      if (canvas && (dirty.current || laserVisible)) {
        const ctx = canvas.getContext("2d")!;
        const { width: w, height: h } = canvas;
        ctx.clearRect(0, 0, w, h);
        const g = gesture.current;
        if (g?.kind === "ink") {
          // 형광펜 미리보기는 형광펜 층에 그려야 글씨 밑에 깔린다
          if (g.stroke.tool === "highlighter") drawHighlightLayer(g.stroke);
          else drawStroke(ctx, g.stroke, w, h);
        }
        if (g?.kind === "erase") {
          ctx.beginPath();
          ctx.arc(g.at.x * w, g.at.y * h, (ERASER_RADIUS * w) / canvas.clientWidth, 0, Math.PI * 2);
          ctx.strokeStyle = "rgba(0, 0, 0, 0.5)";
          ctx.lineWidth = 1;
          ctx.stroke();
        }
        laserVisible = laser.draw(ctx, w, h, performance.now());
        dirty.current = false;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [laser]);

  const toPoint = (e: PointerEvent): Point => {
    const r = liveRef.current!.getBoundingClientRect();
    const p: Point = {
      x: Math.round(((e.clientX - r.left) / r.width) * 1e5) / 1e5,
      y: Math.round(((e.clientY - r.top) / r.height) * 1e5) / 1e5,
      t: Math.round(latest.current.clock()),
    };
    if (e.pointerType === "pen") p.p = Math.round(e.pressure * 1000) / 1000;
    return p;
  };

  const eraseAt = (p: Point) => {
    const { strokes, cssWidth, onErase } = latest.current;
    const h = (cssWidth * page.height) / page.width;
    const hit = new Set(strokes.filter((s) => hitStroke(s, p.x, p.y, ERASER_RADIUS, cssWidth, h)).map((s) => s.id));
    if (hit.size) onErase(hit);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const ev = e.nativeEvent;
    if (ev.pointerType === "touch" || gesture.current) return;
    if (ev.pointerType === "mouse" && ev.button !== 0) return;
    e.currentTarget.setPointerCapture(ev.pointerId);

    const p = toPoint(ev);
    const { tool, color, strokeWidth, onEraseStart } = latest.current;
    if (tool === "pen" || tool === "highlighter") {
      gesture.current = {
        kind: "ink",
        pointerId: ev.pointerId,
        stroke: { id: uid(), pageId: page.id, tool, color, width: strokeWidth, points: [p], startedAt: p.t, endedAt: p.t },
      };
    } else if (tool === "eraser") {
      onEraseStart();
      gesture.current = { kind: "erase", pointerId: ev.pointerId, at: p };
      eraseAt(p);
    } else {
      laser.down(p, performance.now());
      gesture.current = { kind: "laser", pointerId: ev.pointerId };
    }
    dirty.current = true;
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const g = gesture.current;
    const ev = e.nativeEvent;
    if (!g || g.pointerId !== ev.pointerId) return;
    const coalesced = ev.getCoalescedEvents?.();
    for (const ce of coalesced?.length ? coalesced : [ev]) {
      const p = toPoint(ce);
      if (g.kind === "ink") {
        const prev = g.stroke.points[g.stroke.points.length - 1];
        p.x = Math.round((p.x + (prev.x - p.x) * STABILIZE) * 1e5) / 1e5;
        p.y = Math.round((p.y + (prev.y - p.y) * STABILIZE) * 1e5) / 1e5;
        g.stroke.points.push(p);
      } else if (g.kind === "erase") {
        g.at = p;
        eraseAt(p);
      } else laser.move(p);
    }
    dirty.current = true;
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const g = gesture.current;
    if (!g || g.pointerId !== e.nativeEvent.pointerId) return;
    gesture.current = null;
    dirty.current = true;
    if (g.kind === "ink") {
      // 보정으로 끝이 덜 따라온 만큼 펜을 뗀 자리까지 이어서 끝낸다
      const end = toPoint(e.nativeEvent);
      const last = g.stroke.points[g.stroke.points.length - 1];
      if (g.stroke.points.length > 1 && (end.x !== last.x || end.y !== last.y)) g.stroke.points.push(end);
      g.stroke.endedAt = g.stroke.points[g.stroke.points.length - 1].t;
      latest.current.onStroke(g.stroke);
    } else if (g.kind === "erase") {
      latest.current.onEraseEnd();
    } else {
      const points = laser.up(performance.now());
      if (points) latest.current.onLaser({ pageId: page.id, points: points.map(({ x, y, t }) => ({ x, y, t })) });
    }
  };

  const style = { width: cssWidth, height: cssHeight };
  return (
    <div className="page-canvas" style={style}>
      <canvas ref={bgRef} style={style} />
      <canvas ref={hlRef} style={style} className="highlight-layer" />
      <canvas ref={inkRef} style={style} />
      <canvas
        ref={liveRef}
        style={style}
        className={`input-layer tool-${props.tool}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onContextMenu={(e) => e.preventDefault()}
      />
    </div>
  );
}
