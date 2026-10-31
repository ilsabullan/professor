import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { LaserTrail, Page, Point, Stroke, Tool } from "../types";
import { renderPdfPage, type PDFDocumentProxy } from "../lib/pdf";
import { drawStroke, drawStrokes, hitStroke } from "../lib/ink";
import { Laser } from "../lib/laser";
import { uid } from "../lib/id";

const ERASER_RADIUS = 10; // 화면 기준 px
const MAX_PIXELS = 12_000_000; // 아이패드 사파리의 캔버스 크기 제한을 넘지 않게

// 펜을 한 번이라도 쓰면 그때부터 손가락 터치는 필기 대신 화면 이동으로 쓴다 (손바닥 무시)
let penSeen = false;

type Gesture =
  | { kind: "ink"; pointerId: number; stroke: Stroke }
  | { kind: "erase"; pointerId: number; at: Point }
  | { kind: "laser"; pointerId: number }
  | { kind: "pan"; pointerId: number; x: number; y: number };

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
  onPan: (dx: number, dy: number) => void;
};

/** 한 페이지: PDF(맨 아래) + 저장된 필기 + 지금 긋는 획·레이저(맨 위, 입력도 여기서 받음) */
export function PageCanvas(props: Props) {
  const { page, pdfDoc, strokes, cssWidth } = props;
  const cssHeight = (cssWidth * page.height) / page.width;
  const scale = Math.min(window.devicePixelRatio || 1, Math.sqrt(MAX_PIXELS / (cssWidth * cssHeight)));
  const pw = Math.round(cssWidth * scale);
  const ph = Math.round(cssHeight * scale);

  const bgRef = useRef<HTMLCanvasElement>(null);
  const inkRef = useRef<HTMLCanvasElement>(null);
  const liveRef = useRef<HTMLCanvasElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const gesture = useRef<Gesture | null>(null);
  const dirty = useRef(true);
  const [laser] = useState(() => new Laser());

  useEffect(() => {
    const canvas = bgRef.current!;
    if (pdfDoc && page.pdfPageIndex !== null) {
      const job = renderPdfPage(pdfDoc, page.pdfPageIndex, canvas, pw);
      return () => job.cancel();
    }
    canvas.width = pw;
    canvas.height = ph;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, pw, ph);
  }, [pdfDoc, page, pw, ph]);

  // 획을 확정하는 순간 미리보기가 사라지고 저장된 필기가 늦게 그려져 깜빡이지 않도록 layout effect로 그린다
  useLayoutEffect(() => {
    const canvas = inkRef.current!;
    canvas.width = pw;
    canvas.height = ph;
    drawStrokes(canvas.getContext("2d")!, strokes, pw, ph);
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
        if (g?.kind === "ink") drawStroke(ctx, g.stroke, w, h);
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
    if (ev.pointerType === "pen") penSeen = true;
    if (gesture.current) {
      // 손바닥으로 화면 이동 중이어도 펜이 닿으면 펜을 우선한다
      if (gesture.current.kind === "pan" && ev.pointerType !== "touch") gesture.current = null;
      else return;
    }
    if (ev.pointerType === "touch" && penSeen) {
      gesture.current = { kind: "pan", pointerId: ev.pointerId, x: ev.clientX, y: ev.clientY };
      e.currentTarget.setPointerCapture(ev.pointerId);
      return;
    }
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
    if (g.kind === "pan") {
      latest.current.onPan(g.x - ev.clientX, g.y - ev.clientY);
      g.x = ev.clientX;
      g.y = ev.clientY;
      return;
    }
    const coalesced = ev.getCoalescedEvents?.();
    for (const ce of coalesced?.length ? coalesced : [ev]) {
      const p = toPoint(ce);
      if (g.kind === "ink") g.stroke.points.push(p);
      else if (g.kind === "erase") {
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
      g.stroke.endedAt = g.stroke.points[g.stroke.points.length - 1].t;
      latest.current.onStroke(g.stroke);
    } else if (g.kind === "erase") {
      latest.current.onEraseEnd();
    } else if (g.kind === "laser") {
      const points = laser.up(performance.now());
      if (points) latest.current.onLaser({ pageId: page.id, points: points.map(({ x, y, t }) => ({ x, y, t })) });
    }
  };

  const style = { width: cssWidth, height: cssHeight };
  return (
    <div className="page-canvas" style={style}>
      <canvas ref={bgRef} style={style} />
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
