import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { flushSync } from "react-dom";
import {
  ArrowLeftToLine,
  ArrowRightToLine,
  ChevronDown,
  ChevronLeft,
  Ellipsis,
  Eraser,
  Highlighter,
  LayoutGrid,
  Minus,
  PenLine,
  Redo2,
  Trash,
  Undo2,
  WandSparkles,
} from "lucide-react";
import type { Lecture, Page, Stroke, Tool } from "../types";
import { deleteStrokes, getAllStrokes, getLecture, putLecture, putStrokes } from "../lib/db";
import { loadLecturePdf, type PDFDocumentProxy } from "../lib/pdf";
import { emitLaser, emitStroke } from "../lib/events";
import { uid } from "../lib/id";
import { PageCanvas } from "../components/PageCanvas";
import { PageThumb } from "../components/PageThumb";
import { Overview } from "../components/Overview";
import { IconButton } from "../components/IconButton";
import { Menu } from "../components/Menu";
import { ConfirmDialog } from "../components/Dialog";
import { TitleEditor } from "../components/TitleEditor";
import { renameLecture } from "../lib/titles";

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
const ZOOM_MIN = 1; // 화면에 맞춘 크기보다 작게는 줄이지 않는다
const ZOOM_MAX = 4;
const SAVE_DELAY = 400;
// 페이지 둘레 여백 (피그마 02 필기 화면 기준)
const STAGE_PAD = { x: 76, y: 72 };
const SWIPE_DISTANCE = 0.18; // 화면 너비 대비 이만큼 밀면 넘긴다
const SWIPE_SPEED = 0.5; // px/ms, 이보다 빠르게 튕기면 짧게 밀어도 넘긴다
const SLIDE_MS = 240;
const SLIDE_EASE = `transform ${SLIDE_MS}ms cubic-bezier(0.25, 0.8, 0.3, 1)`;
const EMPTY: Stroke[] = [];

type History = { undo: Stroke[][]; redo: Stroke[][] };
type XY = { x: number; y: number };
type TouchGesture =
  | {
      kind: "drag";
      mode: "undecided" | "pan" | "swipe";
      start: XY;
      last: XY;
      lastTime: number;
      speed: number;
      over: number; // 확대 상태에서 가로 끝을 넘어 더 민 거리 (넘기기로 이어진다)
    }
  | {
      kind: "pinch";
      d0: number;
      origin: XY; // 손가락 사이 지점의 페이지 안 위치 (시작할 때)
      start: { left: number; top: number; w: number; h: number }; // 시작할 때 페이지 위치·크기
      stage: { left: number; top: number; w: number; h: number };
      scale: number;
      target: { left: number; top: number }; // 손을 떼면 페이지가 놓일 화면 위치
    }
  | { kind: "idle" }; // 핀치 뒤 남은 손가락은 다 뗄 때까지 무시

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * 확대된 페이지가 실제로 놓일 수 있는 화면 위치 (한 축). 화면보다 작으면 가운데, 크면 스크롤로 갈 수 있는 범위 안.
 * 확대하는 동안에도 이 범위 안에서만 움직여서 손을 뗄 때 위치가 튀지 않게 한다.
 */
const placeAxis = (want: number, size: number, stageStart: number, stageSize: number, pad: number) =>
  size + pad * 2 <= stageSize
    ? stageStart + (stageSize - size) / 2
    : clamp(want, stageStart + stageSize - pad - size, stageStart + pad);

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
  const [inkTool, setInkTool] = useState<"pen" | "highlighter">("pen"); // 지우개·레이저일 때 도구 모음에 보여 줄 색·굵기
  const [penColor, setPenColor] = useState(PEN_COLORS[0]);
  const [highlightColor, setHighlightColor] = useState(HIGHLIGHT_COLORS[0]);
  const [penSize, setPenSize] = useState(1);
  const [highlightSize, setHighlightSize] = useState(1);
  const [straightHighlight, setStraightHighlight] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [showOverview, setShowOverview] = useState(false);
  const [showPageMenu, setShowPageMenu] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  const stageRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
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
      setPageIndex((i) => clamp(i, 0, l.pages.length - 1));
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

  const updateLecture = (next: Lecture) => {
    setLecture(next);
    putLecture(next);
  };

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

  // ---- 페이지 이동, 추가, 삭제 ----
  const goTo = (index: number) => {
    if (!lecture) return;
    setPageIndex(clamp(index, 0, lecture.pages.length - 1));
    setZoom(1);
    stageRef.current?.scrollTo(0, 0);
  };

  useEffect(() => {
    window.history.replaceState(null, "", `#/l/${lectureId}/${pageIndex + 1}`);
  }, [lectureId, pageIndex]);

  const insertBlankPage = (at: number) => {
    if (!lecture || !page) return;
    const blank: Page = { id: uid(), pdfPageIndex: null, width: page.width, height: page.height };
    const pages = [...lecture.pages];
    pages.splice(at, 0, blank);
    updateLecture({ ...lecture, pages, updatedAt: Date.now() });
    setPageIndex(at);
    setZoom(1);
  };

  const deleteCurrentPage = () => {
    setConfirmDelete(false);
    if (!lecture || !page || lecture.pages.length <= 1) return;
    clearTimeout(saveTimers.current.get(page.id));
    saveTimers.current.delete(page.id);
    const rest = { ...strokes.current };
    delete rest[page.id];
    strokes.current = rest;
    histories.current.delete(page.id);
    deleteStrokes(lectureId, page.id);
    const pages = lecture.pages.filter((p) => p.id !== page.id);
    updateLecture({ ...lecture, pages, updatedAt: Date.now() });
    setPageIndex(Math.min(pageIndex, pages.length - 1));
    setZoom(1);
  };

  // ---- 확대 ----
  const zoomTo = (target: number) => {
    const next = clamp(Math.round(target * 100) / 100, ZOOM_MIN, ZOOM_MAX);
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

  useLayoutEffect(() => {
    const el = stageRef.current!;
    setBox({ w: el.clientWidth, h: el.clientHeight }); // 첫 화면부터 바로 맞춘 크기로 그린다
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ---- 손가락 제스처: 두 손가락으로 확대·축소, 한 손가락으로 넘기기(확대 중이면 이동) ----
  const touches = useRef(new Map<number, XY>());
  const touchGesture = useRef<TouchGesture | null>(null);
  const penDown = useRef(false); // 펜으로 쓰는 동안 닿는 손바닥은 무시한다
  const sliding = useRef(false);
  const pinchTarget = useRef<{ left: number; top: number } | null>(null);

  const pendingTransform = useRef<{ transform: string; origin: string } | null>(null);
  const transformFrame = useRef(0);

  const setWrapTransform = (transform: string, transition = "none", origin = "") => {
    cancelAnimationFrame(transformFrame.current);
    transformFrame.current = 0;
    pendingTransform.current = null;
    const wrap = wrapRef.current;
    if (!wrap) return;
    wrap.style.transition = transition;
    wrap.style.transformOrigin = origin;
    wrap.style.transform = transform;
  };

  // 손가락이 움직일 때마다 바로 바꾸지 않고 화면을 그리는 박자(프레임)에 한 번만 바꿔서 끊김을 줄인다
  const queueWrapTransform = (transform: string, origin = "") => {
    pendingTransform.current = { transform, origin };
    if (transformFrame.current) return;
    transformFrame.current = requestAnimationFrame(() => {
      transformFrame.current = 0;
      const next = pendingTransform.current;
      if (next) setWrapTransform(next.transform, "none", next.origin);
    });
  };

  /**
   * 화면을 옮기고 바로 scroll 이벤트를 보낸다. 브라우저의 scroll 이벤트는 다음 프레임에 오는데,
   * 그 전에 필기 층이 새 위치에 맞춰 그려져야 옮기는 순간 빈 곳이 보이지 않는다
   */
  const scrollStage = (dx: number, dy: number) => {
    const stage = stageRef.current;
    if (!stage) return;
    stage.scrollBy(dx, dy);
    stage.dispatchEvent(new Event("scroll"));
  };

  const startPinch = () => {
    const [a, b] = [...touches.current.values()];
    const m0 = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    setWrapTransform(""); // 넘기던 중이었으면 제자리로 돌린 뒤에 잰다
    const r = wrapRef.current!.getBoundingClientRect();
    const stage = stageRef.current!;
    const s = stage.getBoundingClientRect();
    touchGesture.current = {
      kind: "pinch",
      d0: Math.hypot(a.x - b.x, a.y - b.y),
      origin: { x: m0.x - r.left, y: m0.y - r.top },
      start: { left: r.left, top: r.top, w: r.width, h: r.height },
      stage: { left: s.left, top: s.top, w: stage.clientWidth, h: stage.clientHeight },
      scale: 1,
      target: { left: r.left, top: r.top },
    };
  };

  const finishSwipe = (dx: number, speed: number) => {
    const stage = stageRef.current;
    const l = lectureRef.current;
    if (!stage || !l) return;
    const width = stage.clientWidth;
    const dir = dx < 0 ? 1 : -1; // 왼쪽으로 밀면 다음 페이지
    const target = pageIndex + dir;
    const go = (Math.abs(dx) > width * SWIPE_DISTANCE || Math.abs(speed) > SWIPE_SPEED) && target >= 0 && target < l.pages.length;
    sliding.current = true;
    if (!go) {
      setWrapTransform("translate3d(0, 0, 0)", SLIDE_EASE);
      window.setTimeout(() => {
        setWrapTransform("");
        sliding.current = false;
      }, SLIDE_MS);
      return;
    }
    if (zoom > 1) {
      // 확대 상태에서는 옆에 붙여 둔 페이지가 없어서, 지금 페이지를 내보낸 뒤 새 페이지를 화면에 맞춘 크기로 반대편에서 들여온다
      setWrapTransform(`translate3d(${-dir * width}px, 0, 0)`, SLIDE_EASE);
      window.setTimeout(() => {
        flushSync(() => {
          setPageIndex(target);
          setZoom(1);
        });
        stage.scrollTo(0, 0);
        setWrapTransform(`translate3d(${dir * width}px, 0, 0)`);
        void wrapRef.current?.offsetWidth; // 시작 위치를 먼저 적용해야 들어오는 움직임이 보인다
        setWrapTransform("translate3d(0, 0, 0)", SLIDE_EASE);
        window.setTimeout(() => {
          setWrapTransform("");
          sliding.current = false;
        }, SLIDE_MS);
      }, SLIDE_MS);
      return;
    }
    // 옆에 붙어 있던 페이지가 가운데로 들어올 때까지 함께 민 다음, 같은 순간에 진짜 페이지로 바꿔 끼운다
    setWrapTransform(`translate3d(${-dir * width}px, 0, 0)`, SLIDE_EASE);
    window.setTimeout(() => {
      flushSync(() => {
        setPageIndex(target);
        setZoom(1);
      });
      setWrapTransform("");
      sliding.current = false;
    }, SLIDE_MS);
  };

  const onStagePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "pen") {
      penDown.current = true;
      return;
    }
    if (e.pointerType !== "touch" || penDown.current || sliding.current) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = { x: e.clientX, y: e.clientY };
    touches.current.set(e.pointerId, p);
    if (touches.current.size === 1) {
      touchGesture.current = { kind: "drag", mode: "undecided", start: p, last: p, lastTime: e.timeStamp, speed: 0, over: 0 };
    } else if (touches.current.size === 2) {
      if (touchGesture.current?.kind === "drag" && touchGesture.current.mode === "swipe") setWrapTransform("");
      startPinch();
    }
  };

  const onStagePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== "touch" || !touches.current.has(e.pointerId)) return;
    const p = { x: e.clientX, y: e.clientY };
    touches.current.set(e.pointerId, p);
    const g = touchGesture.current;
    if (!g || g.kind === "idle") return;

    if (g.kind === "pinch") {
      const [a, b] = [...touches.current.values()];
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const s = clamp((zoom * Math.hypot(a.x - b.x, a.y - b.y)) / g.d0, ZOOM_MIN, ZOOM_MAX) / zoom;
      g.scale = s;
      // 손가락 사이 지점이 손가락을 따라가게 놓되, 손을 뗀 뒤 실제로 갈 수 있는 위치로만 놓는다
      g.target = {
        left: placeAxis(m.x - g.origin.x * s, g.start.w * s, g.stage.left, g.stage.w, STAGE_PAD.x),
        top: placeAxis(m.y - g.origin.y * s, g.start.h * s, g.stage.top, g.stage.h, STAGE_PAD.y),
      };
      const tx = g.target.left - g.start.left - g.origin.x * (1 - s);
      const ty = g.target.top - g.start.top - g.origin.y * (1 - s);
      queueWrapTransform(`translate3d(${tx}px, ${ty}px, 0) scale(${s})`, `${g.origin.x}px ${g.origin.y}px`);
      return;
    }

    const dx = p.x - g.last.x;
    const dy = p.y - g.last.y;
    const dt = Math.max(1, e.timeStamp - g.lastTime);
    g.speed = dx / dt;
    g.last = p;
    g.lastTime = e.timeStamp;
    if (g.mode === "undecided") {
      const tx = p.x - g.start.x;
      const ty = p.y - g.start.y;
      if (Math.hypot(tx, ty) < 8) return;
      g.mode = zoom <= ZOOM_MIN && Math.abs(tx) > Math.abs(ty) ? "swipe" : "pan";
    }
    if (g.mode === "pan") {
      // 확대 상태: 가로 끝까지 이동한 뒤 같은 방향으로 더 밀면 페이지를 끌어서 넘기기로 이어 간다
      const stage = stageRef.current!;
      const maxX = stage.scrollWidth - stage.clientWidth;
      const pushingEdge =
        Math.abs(dx) > Math.abs(dy) && ((dx > 0 && stage.scrollLeft <= 1) || (dx < 0 && stage.scrollLeft >= maxX - 1));
      if (g.over === 0 && !pushingEdge) {
        scrollStage(-dx, -dy);
        return;
      }
      const over = g.over + dx;
      if (g.over !== 0 && Math.sign(over) !== Math.sign(g.over)) {
        // 반대로 되돌리면 다시 화면 이동으로
        g.over = 0;
        setWrapTransform("");
        scrollStage(-over, -dy);
        return;
      }
      g.over = over;
      const target = pageIndex + (over < 0 ? 1 : -1);
      const hasTarget = target >= 0 && target < (lectureRef.current?.pages.length ?? 0);
      scrollStage(0, -dy);
      queueWrapTransform(`translate3d(${hasTarget ? over : over * 0.3}px, 0, 0)`);
    } else {
      let tx = p.x - g.start.x;
      const atEdge = (tx > 0 && pageIndex === 0) || (tx < 0 && pageIndex >= (lectureRef.current?.pages.length ?? 1) - 1);
      if (atEdge) tx *= 0.3; // 첫·마지막 페이지에서는 살짝만 끌려오고 돌아간다
      queueWrapTransform(`translate3d(${tx}px, 0, 0)`);
    }
  };

  const onStagePointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "pen") {
      penDown.current = false;
      return;
    }
    if (e.pointerType !== "touch" || !touches.current.has(e.pointerId)) return;
    touches.current.delete(e.pointerId);
    const g = touchGesture.current;
    if (g?.kind === "pinch" && touches.current.size < 2) {
      // 확대 배율을 확정하고, 손을 떼기 직전 모습 그대로 남도록 스크롤을 맞춘다 (배율은 반올림하지 않는다)
      const next = clamp(zoom * g.scale, ZOOM_MIN, ZOOM_MAX);
      const snapped = next < 1.03 ? 1 : next;
      pinchTarget.current = snapped === 1 ? null : g.target;
      flushSync(() => setZoom(snapped));
      setWrapTransform("");
      touchGesture.current = { kind: "idle" };
    } else if (g?.kind === "drag" && g.mode === "swipe") {
      finishSwipe(g.last.x - g.start.x, g.speed);
    } else if (g?.kind === "drag" && g.mode === "pan" && g.over !== 0) {
      finishSwipe(g.over, g.speed);
    }
    if (touches.current.size === 0) touchGesture.current = null;
  };

  useLayoutEffect(() => {
    const target = pinchTarget.current;
    const wrap = wrapRef.current;
    const stage = stageRef.current;
    if (!target || !wrap || !stage) return;
    pinchTarget.current = null;
    // 이 시점에는 아직 확대 중 모습(transform)이 남아 있어서 그것을 뺀 실제 자리로 잰다
    const prev = wrap.style.transform;
    wrap.style.transform = "";
    const r = wrap.getBoundingClientRect();
    wrap.style.transform = prev;
    scrollStage(r.left - target.left, r.top - target.top);
  }, [zoom]);

  // ---- 키보드, 휠 (최신 상태를 쓰도록 ref로 연결) ----
  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => {});
  keyHandler.current = (e) => {
    if (showOverview || confirmDelete) {
      if (e.key === "Escape") {
        setShowOverview(false);
        setConfirmDelete(false);
      }
      return;
    }
    if ((e.target as HTMLElement).tagName === "INPUT") return;
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

  // ---- 도구 ----
  const selectTool = (t: Tool) => {
    setTool(t);
    if (t === "pen" || t === "highlighter") setInkTool(t);
  };
  const isInk = tool === "pen" || tool === "highlighter";
  const colors = inkTool === "highlighter" ? HIGHLIGHT_COLORS : PEN_COLORS;
  const color = inkTool === "highlighter" ? highlightColor : penColor;
  const sizes = inkTool === "highlighter" ? HIGHLIGHT_SIZES : PEN_SIZES;
  const sizeIndex = inkTool === "highlighter" ? highlightSize : penSize;
  const pickColor = (c: string) => (inkTool === "highlighter" ? setHighlightColor(c) : setPenColor(c));
  const pickSize = (i: number) => (inkTool === "highlighter" ? setHighlightSize(i) : setPenSize(i));

  const fitWidthOf = (p: Page) =>
    Math.max(100, Math.min(box.w - STAGE_PAD.x * 2, ((box.h - STAGE_PAD.y * 2) * p.width) / p.height));
  const fitWidth = page ? fitWidthOf(page) : 0;
  const history = page ? historyOf(page.id) : null;

  // 넘기기용으로 지금 페이지 양옆(화면 한 폭 거리)에 붙여 두는 앞뒤 페이지. 화면에 맞춘 크기일 때만 둔다
  const peeks =
    lecture && page && zoom === 1 && box.w > 0
      ? ([-1, 1] as const).flatMap((side) => {
          const p = lecture.pages[pageIndex + side];
          if (!p) return [];
          const w = fitWidthOf(p);
          const h = (w * p.height) / p.width;
          const curH = (fitWidth * page.height) / page.width;
          return [{ side, page: p, w, left: side * box.w + (fitWidth - w) / 2, top: (curH - h) / 2 }];
        })
      : [];

  return (
    <div className="editor">
      <header className="nav-bar">
        <div className="nav-side">
          <IconButton label="문서 목록" onClick={onBack}>
            <ChevronLeft size={26} strokeWidth={1.75} />
          </IconButton>
          <IconButton label="모아보기" onClick={() => setShowOverview(true)} disabled={!lecture}>
            <LayoutGrid {...ICON} />
          </IconButton>
        </div>
        <div className="menu-anchor nav-title-anchor">
          <button className="nav-title-btn" onClick={() => setEditingTitle(true)} disabled={!lecture}>
            <span className="nav-title">{lecture?.title}</span>
            <ChevronDown size={16} strokeWidth={2} />
          </button>
          {editingTitle && lecture && (
            <TitleEditor
              initial={lecture.title}
              onSave={async (title) => setLecture(await renameLecture(lecture, title))}
              onClose={() => setEditingTitle(false)}
            />
          )}
        </div>
        <div className="nav-side nav-side-right">
          <IconButton label="실행 취소 (Ctrl+Z)" onClick={undo} disabled={!history?.undo.length}>
            <Undo2 {...ICON} />
          </IconButton>
          <IconButton label="다시 실행 (Ctrl+Shift+Z)" onClick={redo} disabled={!history?.redo.length}>
            <Redo2 {...ICON} />
          </IconButton>
          <div className="menu-anchor">
            <IconButton label="페이지 메뉴" active={showPageMenu} onClick={() => setShowPageMenu(true)} disabled={!page}>
              <Ellipsis {...ICON} />
            </IconButton>
            {showPageMenu && lecture && (
              <Menu
                align="right"
                onClose={() => setShowPageMenu(false)}
                items={[
                  { label: "앞에 빈 페이지 추가", icon: <ArrowLeftToLine size={18} />, onSelect: () => insertBlankPage(pageIndex) },
                  { label: "뒤에 빈 페이지 추가", icon: <ArrowRightToLine size={18} />, onSelect: () => insertBlankPage(pageIndex + 1) },
                  {
                    label: "이 페이지 삭제",
                    icon: <Trash size={18} />,
                    danger: true,
                    disabled: lecture.pages.length <= 1,
                    onSelect: () => setConfirmDelete(true),
                  },
                ]}
              />
            )}
          </div>
        </div>
      </header>

      <div className="tool-bar">
        {TOOLS.map((t) => (
          // 누르는 순간 바로 바뀌도록 click보다 먼저 오는 pointerdown에서 고른다
          <IconButton
            key={t.id}
            label={t.label}
            active={tool === t.id}
            onPointerDown={() => selectTool(t.id)}
            onClick={() => selectTool(t.id)}
          >
            {t.icon}
          </IconButton>
        ))}
        <span className="tool-divider" />
        {colors.map((c) => (
          <button
            key={c}
            aria-label={`색 ${c}`}
            className={`swatch${c === color ? " active" : ""}`}
            disabled={!isInk}
            onPointerDown={() => isInk && pickColor(c)}
            onClick={() => pickColor(c)}
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
            disabled={!isInk}
            onPointerDown={() => isInk && pickSize(i)}
            onClick={() => pickSize(i)}
          >
            <span style={{ width: 4 + i * 3, height: 4 + i * 3 }} />
          </button>
        ))}
        <span className="tool-divider" />
        {/* 형광펜 직선 그리기 (굿노트의 "직선으로 그리기"). 형광펜일 때만 바꿀 수 있다 */}
        <button
          className={`toggle-btn${straightHighlight ? " active" : ""}`}
          aria-pressed={straightHighlight}
          disabled={tool !== "highlighter"}
          onPointerDown={() => setStraightHighlight((v) => !v)}
          onClick={(e) => e.detail === 0 && setStraightHighlight((v) => !v)} // 키보드로 누를 때만 (손·마우스는 위에서 처리)
        >
          <Minus size={18} strokeWidth={2.25} />
          직선
        </button>
      </div>

      <div className="stage-area">
        <div
          className="stage"
          ref={stageRef}
          // 화면에 맞춘 크기에서는 스크롤할 게 없고, 옆에 붙여 둔 페이지 때문에 스크롤이 생기지 않게 감춘다
          style={{ padding: `${STAGE_PAD.y}px ${STAGE_PAD.x}px`, overflow: zoom > 1 ? "auto" : "hidden" }}
          onPointerDown={onStagePointerDown}
          onPointerMove={onStagePointerMove}
          onPointerUp={onStagePointerUp}
          onPointerCancel={onStagePointerUp}
        >
          {page && fitWidth > 0 ? (
            <div className="page-wrap" ref={wrapRef}>
              <PageCanvas
                key={page.id}
                page={page}
                pdfDoc={pdfDoc}
                strokes={strokes.current[page.id] ?? EMPTY}
                cssWidth={fitWidth * zoom}
                tool={tool}
                color={color}
                strokeWidth={sizes[sizeIndex]}
              straightHighlight={straightHighlight}
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
              />
              {peeks.map((peek) => (
                <div
                  key={peek.page.id}
                  className="page-peek"
                  aria-hidden="true"
                  style={{ left: peek.left, top: peek.top }}
                >
                  <PageThumb
                    page={peek.page}
                    pdfDoc={pdfDoc}
                    strokes={strokes.current[peek.page.id] ?? EMPTY}
                    width={peek.w}
                    eager
                  />
                </div>
              ))}
            </div>
          ) : (
            <div className="loading">불러오는 중...</div>
          )}
        </div>
        {lecture && (
          <div className="page-badge" aria-live="polite">
            {pageIndex + 1} / {lecture.pages.length}
          </div>
        )}
      </div>

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
          onClose={() => setShowOverview(false)}
        />
      )}
      {confirmDelete && (
        <ConfirmDialog
          title={`${pageIndex + 1}쪽을 삭제할까요?`}
          message="이 페이지의 필기도 함께 지워지고 되돌릴 수 없어요."
          confirmLabel="삭제"
          danger
          onConfirm={deleteCurrentPage}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </div>
  );
}
