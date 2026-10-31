// 일반 빌드는 최신 브라우저 기능(Map.getOrInsert 등)을 써서 아이패드 사파리에서 PDF가 열리지 않는다.
// 구형 브라우저용 legacy 빌드를 쓴다.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { getPdf } from "./db";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export type { PDFDocumentProxy };

export function openPdf(data: ArrayBuffer): Promise<PDFDocumentProxy> {
  // pdf.js가 넘겨받은 버퍼를 워커로 옮기면서 비우기 때문에 복사본을 넘긴다
  return pdfjs.getDocument({ data: new Uint8Array(data.slice(0)) }).promise;
}

const docs = new Map<string, Promise<PDFDocumentProxy | null>>();

export function loadLecturePdf(lectureId: string): Promise<PDFDocumentProxy | null> {
  let doc = docs.get(lectureId);
  if (!doc) {
    doc = getPdf(lectureId).then((data) => (data ? openPdf(data) : null));
    docs.set(lectureId, doc);
  }
  return doc;
}

export function forgetLecturePdf(lectureId: string): void {
  docs.get(lectureId)?.then((doc) => doc?.loadingTask.destroy());
  docs.delete(lectureId);
}

// ---- 그려 둔 페이지 보관 ----
// 넘기기 직전에 옆 페이지를 미리 그려 두고, 넘길 때는 그려 둔 그림을 옮기기만 해서 애니메이션이 끊기지 않게 한다
const CACHE_PIXELS = 24_000_000; // 보관하는 그림 전체 픽셀 수 한도 (메모리 약 100MB)
const images = new WeakMap<PDFDocumentProxy, Map<string, Promise<HTMLCanvasElement>>>();
const sizes = new Map<Promise<HTMLCanvasElement>, number>();
const ready = new WeakMap<Promise<HTMLCanvasElement>, HTMLCanvasElement>(); // 다 그려진 것은 기다리지 않고 바로 꺼낸다

function pageImage(doc: PDFDocumentProxy, pageIndex: number, pixelWidth: number): Promise<HTMLCanvasElement> {
  let byKey = images.get(doc);
  if (!byKey) images.set(doc, (byKey = new Map()));
  const key = `${pageIndex}@${pixelWidth}`;
  const hit = byKey.get(key);
  if (hit) {
    // 최근에 쓴 것으로 표시 (Map은 넣은 순서를 기억한다)
    byKey.delete(key);
    byKey.set(key, hit);
    return hit;
  }
  const image = (async () => {
    const page = await doc.getPage(pageIndex + 1);
    const viewport = page.getViewport({ scale: pixelWidth / page.getViewport({ scale: 1 }).width });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const task: RenderTask = page.render({ canvas, viewport });
    await task.promise;
    return canvas;
  })();
  byKey.set(key, image);
  image.then(
    (canvas) => {
      sizes.set(image, canvas.width * canvas.height);
      ready.set(image, canvas);
    },
    () => byKey.delete(key),
  );
  // 한도를 넘으면 오래 안 쓴 것부터 버린다
  let total = 0;
  for (const p of byKey.values()) total += sizes.get(p) ?? 0;
  for (const [k, p] of byKey) {
    if (total <= CACHE_PIXELS || p === image) break;
    total -= sizes.get(p) ?? 0;
    sizes.delete(p);
    byKey.delete(k);
  }
  return image;
}

/** 이미 다 그려 둔 그림이 있으면 target에 바로 옮기고 true를 돌려준다 (넘기는 순간 빈 화면이 보이지 않게) */
export function drawCachedPdfPage(
  doc: PDFDocumentProxy,
  pageIndex: number,
  target: HTMLCanvasElement,
  pixelWidth: number,
): boolean {
  const pending = images.get(doc)?.get(`${pageIndex}@${pixelWidth}`);
  const image = pending && ready.get(pending);
  if (!image) return false;
  target.width = image.width;
  target.height = image.height;
  target.getContext("2d")!.drawImage(image, 0, 0);
  return true;
}

/**
 * 확대했을 때 화면에 보이는 부분만 선명하게 그린다.
 * pixelWidth는 페이지 전체를 그렸다고 칠 때의 너비, region은 그중 그릴 부분(같은 픽셀 단위).
 */
export function renderPdfRegion(
  doc: PDFDocumentProxy,
  pageIndex: number,
  pixelWidth: number,
  region: { x: number; y: number; w: number; h: number },
): { promise: Promise<HTMLCanvasElement | null>; cancel(): void } {
  let task: RenderTask | null = null;
  let cancelled = false;
  const promise = (async () => {
    const page = await doc.getPage(pageIndex + 1);
    if (cancelled) return null;
    const viewport = page.getViewport({ scale: pixelWidth / page.getViewport({ scale: 1 }).width });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(region.w);
    canvas.height = Math.round(region.h);
    task = page.render({ canvas, viewport, transform: [1, 0, 0, 1, -region.x, -region.y] });
    await task.promise;
    return cancelled ? null : canvas;
  })().catch((e) => {
    if (e?.name !== "RenderingCancelledException") console.error(e);
    return null;
  });
  return {
    promise,
    cancel() {
      cancelled = true;
      task?.cancel();
    },
  };
}

/**
 * PDF 한 페이지를 pixelWidth 너비로 target에 그린다.
 * 다 그린 그림을 한 번에 옮겨서 확대/축소할 때 화면이 깜빡이지 않게 하고, 그려 둔 게 있으면 바로 옮긴다.
 */
export function renderPdfPage(
  doc: PDFDocumentProxy,
  pageIndex: number,
  target: HTMLCanvasElement,
  pixelWidth: number,
): { promise: Promise<void>; cancel(): void } {
  let cancelled = false;
  const promise = pageImage(doc, pageIndex, pixelWidth)
    .then((image) => {
      if (cancelled) return;
      target.width = image.width;
      target.height = image.height;
      target.getContext("2d")!.drawImage(image, 0, 0);
    })
    .catch((e) => {
      if (e?.name !== "RenderingCancelledException") console.error(e);
    });
  return {
    promise,
    cancel() {
      cancelled = true;
    },
  };
}
