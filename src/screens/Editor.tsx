import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  ChevronLeft,
  Eraser,
  Highlighter,
  LayoutGrid,
  PenLine,
  Presentation,
  Redo2,
  Undo2,
  WandSparkles,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { Lecture, Stroke, Tool } from "../types";
import { getAllStrokes, getLecture, putLecture, putStrokes } from "../lib/db";
import { loadLecturePdf, type PDFDocumentProxy } from "../lib/pdf";
import { emitLaser, emitStroke } from "../lib/events";
import { uid } from "../lib/id";
import { PageCanvas } from "../components/PageCanvas";
import { Overview } from "../components/Overview";
import { IconButton } from "../components/IconButton";

const ICON = { size: 22, strokeWidth: 1.75 };
const TOOLS: { id: Tool; label: string; icon: ReactNode }[] = [
  { id: "pen", label: "펜", icon: <PenLine {...ICON} /> },
  { id: "highlighter", label: "형광펜", icon: <Highlighter {...ICON} /> },
  { id: "eraser", label: "지우개", icon: <Eraser {...ICON} /> },
  { id: "laser", label: "레이저 포인터", icon: <WandSparkles {...ICON} /> },
];
const PEN_COLORS = ["#1f1f1f", "#1e5eff", "#e53935", "#2e9d4f"];
const HIGHLIGHT_COLORS = ["#ffe14d", "#7ee08a", "#ff8fc7", "#7cc8ff"];
const PEN_SIZES = [0.0015, 0.003, 0.006]; // 페이지 너비 대비
const HIGHLIGHT_SIZES = [0.012, 0.02, 0.03];
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 4;
const SAVE_DELAY = 400;
const EMPTY: Stroke[] = [];

type History = { undo: Stroke[][]; redo: Stroke[][] };

export function Editor({
  lectureId,
  initialPage,
  onBack,
}: {
  lectureId: string;
  initialPage: number;
  onBack: () => void;
}) {
  const [lecture, setLecture] = useState<Lecture | null>(null);
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [pageIndex, setPageIndex] = useState(initialPage);
  const [tool, setTool] = useState<Tool>("pen");
  const [penColor, setPenColor] = useState(PEN_COLORS[0]);
  const [highlightColor, setHighlightColor] = useState(HIGHLIGHT_COLORS[0]);
  const [penSize, setPenSize] = useState(1);
  const [highlightSize, setHighlightSize] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [showOverview, setShowOverview] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  // 필기는 이벤트 도중 여러 번 바뀔 수 있어서 ref를 기준으로 두고 바뀔 때마다 다시 그린다
  const strokes = useRef<Record<string, Stroke[]>>({});
  const histories = useRef(new Map<string, History>());
  const eraseBase = useRef<Stroke[] | null>(null);
  const saveTimers = useRef(new Map<string, number>());
  const lectureRef = useRef(lecture);
  lectureRef.current = lecture;
  const sessionStart = useRef(performance.now());
  const clock = useCallback(() => performance.now() - sessionStart.current, []);

  const page = lecture?.pages[pageIndex];

  useEffect(() => {
    let alive = true;
    (async () => {
      const l = await getLecture(lectureId);
      if (!l) return onBack();
      const [doc, saved] = await Promise.all([loadLecturePdf(lectureId), getAllStrokes(lectureId)]);
      if (!alive) return;
      strokes.current = saved;
      setPdfDoc(doc);
      setLecture(l);
      setPageIndex((i) => Math.min(Math.max(0, i), l.pages.length - 1));
    })();
    return () => {
      alive = false;
    };
  }, [lectureId, onBack]);

  // ---- 저장 ----
  const savePage = useCallback(
    (pageId: string) => {
      clearTimeout(saveTimers.current.get(pageId));
      saveTimers.current.delete(pageId);
      putStrokes(lectureId, pageId, strokes.current[pageId] ?? EMPTY);
      if (lectureRef.current) putLecture({ ...lectureRef.current, updatedAt: Date.now() });
    },
    [lectureId],
  );

  const scheduleSave = (pageId: string) => {
    clearTimeout(saveTimers.current.get(pageId));
    saveTimers.current.set(pageId, window.setTimeout(() => savePage(pageId), SAVE_DELAY));
  };

  useEffect(() => {
    const flushAll = () => [...saveTimers.current.keys()].forEach(savePage);
    window.addEventListener("pagehide", flushAll);
    return () => {
      window.removeEventListener("pagehide", flushAll);
      flushAll();
    };
  }, [savePage]);

  // ---- 필기 변경과 실행 취소 ----
  const historyOf = (pageId: string) => {
    let h = histories.current.get(pageId);
    if (!h) histories.current.set(pageId, (h = { undo: [], redo: [] }));
    return h;
  };

  const setPageStrokes = (pageId: string, next: Stroke[], record: boolean) => {
    if (record) {
      const h = historyOf(pageId);
      h.undo.push(strokes.current[pageId] ?? EMPTY);
      h.redo = [];
    }
    strokes.current = { ...strokes.current, [pageId]: next };
    scheduleSave(pageId);
    rerender();
  };

  const undo = () => {
    if (!page) return;
    const h = historyOf(page.id);
    const prev = h.undo.pop();
    if (!prev) return;
    h.redo.push(strokes.current[page.id] ?? EMPTY);
    setPageStrokes(page.id, prev, false);
  };

  const redo = () => {
    if (!page) return;
    const h = historyOf(page.id);
    const next = h.redo.pop();
    if (!next) return;
    h.undo.push(strokes.current[page.id] ?? EMPTY);
    setPageStrokes(page.id, next, false);
  };

  // ---- 페이지 이동, 확대 ----
  const goTo = (index: number) => {
    if (!lecture) return;
    setPageIndex(Math.min(Math.max(0, index), lecture.pages.length - 1));
    stageRef.current?.scrollTo(0, 0);
  };

  useEffect(() => {
    window.history.replaceState(null, "", `#/l/${lectureId}/${pageIndex + 1}`);
  }, [lectureId, pageIndex]);

  const zoomTo = (target: number) => {
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(target * 100) / 100));
    const el = stageRef.current;
    if (el && next !== zoom) {
      // 화면 가운데를 기준으로 확대
      const ratio = next / zoom;
      const cx = el.scrollLeft + el.clientWidth / 2;
      const cy = el.scrollTop + el.clientHeight / 2;
      requestAnimationFrame(() => {
        el.scrollLeft = cx * ratio - el.clientWidth / 2;
        el.scrollTop = cy * ratio - el.clientHeight / 2;
      });
    }
    setZoom(next);
  };

  useEffect(() => {
    const el = stageRef.current!;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ---- 발표 모드 ----
  useEffect(() => {
    const onChange = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else rootRef.current?.requestFullscreen?.();
  };

  const addBlankPage = () => {
    if (!lecture) return;
    const last = lecture.pages[lecture.pages.length - 1];
    const next: Lecture = {
      ...lecture,
      updatedAt: Date.now(),
      pages: [...lecture.pages, { id: uid(), pdfPageIndex: null, width: last?.width ?? 1280, height: last?.height ?? 720 }],
    };
    setLecture(next);
    putLecture(next);
  };

  // ---- 키보드, 휠 (최신 상태를 쓰도록 ref로 연결) ----
  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => {});
  keyHandler.current = (e) => {
    if (showOverview) {
      if (e.key === "Escape") setShowOverview(false);
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    } else if (mod && e.key.toLowerCase() === "y") {
      e.preventDefault();
      redo();
    } else if (e.key === "ArrowRight" || e.key === "PageDown") goTo(pageIndex + 1);
    else if (e.key === "ArrowLeft" || e.key === "PageUp") goTo(pageIndex - 1);
  };
  const wheelHandler = useRef<(e: WheelEvent) => void>(() => {});
  wheelHandler.current = (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    zoomTo(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyHandler.current(e);
    const onWheel = (e: WheelEvent) => wheelHandler.current(e);
    const stage = stageRef.current!;
    window.addEventListener("keydown", onKey);
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      window.removeEventListener("keydown", onKey);
      stage.removeEventListener("wheel", onWheel);
    };
  }, []);

  const fitWidth = page ? Math.max(100, Math.min(box.w - 48, ((box.h - 48) * page.width) / page.height)) : 0;
  const isInk = tool === "pen" || tool === "highlighter";
  const colors = tool === "highlighter" ? HIGHLIGHT_COLORS : PEN_COLORS;
  const color = tool === "highlighter" ? highlightColor : penColor;
  const sizes = tool === "highlighter" ? HIGHLIGHT_SIZES : PEN_SIZES;
  const sizeIndex = tool === "highlighter" ? highlightSize : penSize;
  const history = page ? historyOf(page.id) : null;

  return (
    <div className="editor" ref={rootRef}>
      <header className="nav-bar">
        <div className="nav-side">
          <IconButton label="문서 목록" onClick={onBack}>
            <ChevronLeft size={26} strokeWidth={1.75} />
          </IconButton>
          <IconButton label="모아보기" onClick={() => setShowOverview(true)} disabled={!lecture}>
            <LayoutGrid {...ICON} />
          </IconButton>
        </div>
        <div className="nav-title">{lecture?.title}</div>
        <div className="nav-side nav-side-right">
          <IconButton label="실행 취소 (Ctrl+Z)" onClick={undo} disabled={!history?.undo.length}>
            <Undo2 {...ICON} />
          </IconButton>
          <IconButton label="다시 실행 (Ctrl+Shift+Z)" onClick={redo} disabled={!history?.redo.length}>
            <Redo2 {...ICON} />
          </IconButton>
          <IconButton label={fullscreen ? "발표 종료" : "발표 모드"} active={fullscreen} onClick={toggleFullscreen}>
            {fullscreen ? <X {...ICON} /> : <Presentation {...ICON} />}
          </IconButton>
        </div>
      </header>

      <div className="tool-bar">
        {TOOLS.map((t) => (
          <IconButton key={t.id} label={t.label} active={tool === t.id} onClick={() => setTool(t.id)}>
            {t.icon}
          </IconButton>
        ))}
        {isInk && (
          <>
            <span className="tool-divider" />
            {colors.map((c) => (
              <button
                key={c}
                aria-label={`색 ${c}`}
                className={`swatch${c === color ? " active" : ""}`}
                onClick={() => (tool === "highlighter" ? setHighlightColor(c) : setPenColor(c))}
              >
                <span style={{ background: c }} />
              </button>
            ))}
            <span className="tool-divider" />
            {sizes.map((_, i) => (
              <button
                key={i}
                aria-label={`굵기 ${i + 1}`}
                className={`size${i === sizeIndex ? " active" : ""}`}
                onClick={() => (tool === "highlighter" ? setHighlightSize(i) : setPenSize(i))}
              >
                <span style={{ width: 4 + i * 3, height: 4 + i * 3 }} />
              </button>
            ))}
          </>
        )}
      </div>

      <div className="stage" ref={stageRef}>
        {page && fitWidth > 0 ? (
          <div className="page-wrap">
            <PageCanvas
              key={page.id}
              page={page}
              pdfDoc={pdfDoc}
              strokes={strokes.current[page.id] ?? EMPTY}
              cssWidth={fitWidth * zoom}
              tool={tool}
              color={color}
              strokeWidth={sizes[sizeIndex]}
              clock={clock}
              onStroke={(s) => {
                setPageStrokes(s.pageId, [...(strokes.current[s.pageId] ?? EMPTY), s], true);
                emitStroke(s);
              }}
              onEraseStart={() => {
                eraseBase.current = strokes.current[page.id] ?? EMPTY;
              }}
              onErase={(ids) =>
                setPageStrokes(page.id, (strokes.current[page.id] ?? EMPTY).filter((s) => !ids.has(s.id)), false)
              }
              onEraseEnd={() => {
                const base = eraseBase.current;
                eraseBase.current = null;
                if (base && base !== (strokes.current[page.id] ?? EMPTY)) {
                  const h = historyOf(page.id);
                  h.undo.push(base);
                  h.redo = [];
                  rerender();
                }
              }}
              onLaser={emitLaser}
              onPan={(dx, dy) => stageRef.current?.scrollBy(dx, dy)}
            />
          </div>
        ) : (
          <div className="loading">불러오는 중...</div>
        )}
      </div>

      {lecture && (
        <div className="float-bar">
          <div className="pill">
            <button onClick={() => goTo(pageIndex - 1)} disabled={pageIndex <= 0} aria-label="이전 페이지">
              <ChevronLeft size={18} />
            </button>
            <span className="pill-text">
              {pageIndex + 1} / {lecture.pages.length}
            </span>
            <button
              onClick={() => goTo(pageIndex + 1)}
              disabled={pageIndex >= lecture.pages.length - 1}
              aria-label="다음 페이지"
            >
              <ChevronLeft size={18} style={{ transform: "scaleX(-1)" }} />
            </button>
          </div>
          <div className="pill">
            <button onClick={() => zoomTo(zoom / 1.25)} disabled={zoom <= ZOOM_MIN} aria-label="축소">
              <ZoomOut size={18} />
            </button>
            <button className="pill-text" onClick={() => zoomTo(1)} title="화면에 맞추기">
              {Math.round(zoom * 100)}%
            </button>
            <button onClick={() => zoomTo(zoom * 1.25)} disabled={zoom >= ZOOM_MAX} aria-label="확대">
              <ZoomIn size={18} />
            </button>
          </div>
        </div>
      )}

      {showOverview && lecture && (
        <Overview
          pages={lecture.pages}
          pdfDoc={pdfDoc}
          strokes={strokes.current}
          current={pageIndex}
          onPick={(i) => {
            goTo(i);
            setShowOverview(false);
          }}
          onAddBlank={addBlankPage}
          onClose={() => setShowOverview(false)}
        />
      )}
    </div>
  );
}
