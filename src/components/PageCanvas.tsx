import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { LaserTrail, Page, Point, Stroke, Tool } from "../types";
import { drawCachedPdfPage, renderPdfPage, renderPdfRegion, type PDFDocumentProxy } from "../lib/pdf";
import { drawHighlights, drawPens, drawStroke, hitStroke } from "../lib/ink";
import { Laser } from "../lib/laser";
import { uid } from "../lib/id";

const ERASER_RADIUS = 10; // 화면 기준 px
// 캔버스 4장이 다 이 크기라 너무 크면 확대·넘기기가 버벅인다. 화질과 부드러움 사이에서 고른 값
const MAX_PIXELS = 5_000_000;
// 손떨림 보정: 새 점을 이전 점 쪽으로 이만큼 끌어당긴다 (0이면 보정 없음). 최소한만 건다
const STABILIZE = 0.3;
const PDF_RERENDER_DELAY = 150; // 확대·이동이 끝나고 이만큼 지난 뒤에 PDF를 새 크기로 다시 그린다
const REGION_MARGIN = 96; // 필기 층을 보이는 영역보다 이만큼 넓게 그려서, 조금 움직일 때는 다시 그리지 않는다

type Region = { x: number; y: number; w: number; h: number };
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

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

  // ---- 필기 층은 화면에 보이는 부분만 화면 해상도 그대로 그린다 ----
  // 페이지 전체를 그리면 많이 확대했을 때 캔버스가 너무 커져서 해상도를 낮춰야 하고, 그러면 글씨가 깨진다.
  // 펜 글씨는 좌표로 저장돼 있어서 보이는 부분만 다시 그려도 가볍다.
  const rootRef = useRef<HTMLDivElement>(null);
  const tileRef = useRef<HTMLCanvasElement>(null);
  const region = useRef<Region>({ x: 0, y: 0, w: 0, h: 0 });
  const tile = useRef<{ timer: number; job: ReturnType<typeof renderPdfRegion> | null }>({ timer: 0, job: null });
  const dpr = window.devicePixelRatio || 1;
  const pageHeight = () => (latest.current.cssWidth * page.height) / page.width;

  /** 페이지 안에서 지금 화면에 보이는 영역(css px). 넘기기·확대 중 transform은 빼고 스크롤 위치로만 잰다 */
  const visibleArea = (margin: number): Region => {
    const w = latest.current.cssWidth;
    const h = pageHeight();
    const wrap = rootRef.current?.parentElement;
    const stage = wrap?.parentElement;
    if (!wrap || !stage) return { x: 0, y: 0, w, h };
    const x0 = Math.floor(clamp(stage.scrollLeft - wrap.offsetLeft - margin, 0, w));
    const x1 = Math.ceil(clamp(stage.scrollLeft + stage.clientWidth - wrap.offsetLeft + margin, 0, w));
    const y0 = Math.floor(clamp(stage.scrollTop - wrap.offsetTop - margin, 0, h));
    const y1 = Math.ceil(clamp(stage.scrollTop + stage.clientHeight - wrap.offsetTop + margin, 0, h));
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  };

  /** 캔버스를 비우고 좌표를 페이지 css 기준으로 맞춘다. 이후 그리기 함수는 페이지 css 크기를 그대로 쓴다 */
  const prepare = (canvas: HTMLCanvasElement) => {
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, -region.current.x * dpr, -region.current.y * dpr);
    return ctx;
  };

  const drawHighlightLayer = (current?: Stroke) => {
    const ctx = prepare(hlRef.current!);
    drawHighlights(ctx, latest.current.strokes, latest.current.cssWidth, pageHeight());
    if (current) drawStroke(ctx, current, latest.current.cssWidth, pageHeight());
  };

  const drawPenLayer = () => {
    drawPens(prepare(inkRef.current!), latest.current.strokes, latest.current.cssWidth, pageHeight());
  };

  /** 확대해서 PDF 전체 그림의 해상도가 모자랄 때, 손을 멈추면 보이는 부분만 선명하게 덧그린다 */
  const scheduleTile = () => {
    const t = tile.current;
    clearTimeout(t.timer);
    t.job?.cancel();
    t.job = null;
    const canvas = tileRef.current!;
    const { pdfDoc, cssWidth } = latest.current;
    const needed = Math.round(cssWidth * dpr);
    if (!pdfDoc || page.pdfPageIndex === null || pagePixelWidth(page, cssWidth) >= needed * 0.95) {
      canvas.style.display = "none";
      return;
    }
    t.timer = window.setTimeout(() => {
      const r = visibleArea(0);
      if (r.w <= 0 || r.h <= 0) return;
      const job = renderPdfRegion(pdfDoc, page.pdfPageIndex!, needed, { x: r.x * dpr, y: r.y * dpr, w: r.w * dpr, h: r.h * dpr });
      t.job = job;
      job.promise.then((image) => {
        if (!image || t.job !== job) return;
        canvas.width = image.width;
        canvas.height = image.height;
        canvas.getContext("2d")!.drawImage(image, 0, 0);
        Object.assign(canvas.style, { display: "block", left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
      });
    }, PDF_RERENDER_DELAY);
  };

  /** 보이는 영역이 그려 둔 영역을 벗어났으면(또는 크기가 바뀌었으면) 필기 층을 새 영역으로 다시 잡는다 */
  const applyRegion = (force: boolean) => {
    const seen = visibleArea(0);
    const cur = region.current;
    const inside =
      cur.w > 0 && seen.x >= cur.x && seen.y >= cur.y && seen.x + seen.w <= cur.x + cur.w && seen.y + seen.h <= cur.y + cur.h;
    if (force || !inside) {
      region.current = visibleArea(REGION_MARGIN);
      const { x, y, w, h } = region.current;
      for (const canvas of [hlRef.current!, inkRef.current!, liveRef.current!]) {
        canvas.width = Math.max(1, Math.round(w * dpr));
        canvas.height = Math.max(1, Math.round(h * dpr));
        Object.assign(canvas.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
      }
      drawHighlightLayer();
      drawPenLayer();
      dirty.current = true;
    }
    if (force) tileRef.current!.style.display = "none"; // 배율이 바뀌면 이전 선명한 그림은 맞지 않는다
    scheduleTile();
  };

  useLayoutEffect(() => applyRegion(true), [cssWidth]);

  // 획을 확정하는 순간 미리보기가 사라지고 저장된 필기가 늦게 그려져 깜빡이지 않도록 layout effect로 그린다
  useLayoutEffect(() => {
    drawHighlightLayer();
    drawPenLayer();
  }, [strokes]);

  useEffect(() => {
    const stage = rootRef.current?.parentElement?.parentElement;
    const onScroll = () => applyRegion(false);
    const onResize = () => applyRegion(true);
    stage?.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize);
    return () => {
      stage?.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
      clearTimeout(tile.current.timer);
      tile.current.job?.cancel();
    };
  }, []);

  useEffect(() => {
    let raf = 0;
    let laserVisible = false;
    const tick = () => {
      const canvas = liveRef.current;
      if (canvas && (dirty.current || laserVisible)) {
        const ctx = prepare(canvas);
        const w = latest.current.cssWidth;
        const h = pageHeight();
        const g = gesture.current;
        if (g?.kind === "ink") {
          // 형광펜 미리보기는 형광펜 층에 그려야 글씨 밑에 깔린다
          if (g.stroke.tool === "highlighter") drawHighlightLayer(g.stroke);
          else drawStroke(ctx, g.stroke, w, h);
        }
        if (g?.kind === "erase") {
          ctx.beginPath();
          ctx.arc(g.at.x * w, g.at.y * h, ERASER_RADIUS, 0, Math.PI * 2);
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
    const r = rootRef.current!.getBoundingClientRect();
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

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
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

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
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

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
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
    <div
      ref={rootRef}
      className={`page-canvas input-layer tool-${props.tool}`}
      style={style}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onContextMenu={(e) => e.preventDefault()}
    >
      <canvas ref={bgRef} style={style} />
      <canvas ref={tileRef} className="pdf-tile" />
      <canvas ref={hlRef} className="highlight-layer" />
      <canvas ref={inkRef} />
      <canvas ref={liveRef} />
    </div>
  );
}
