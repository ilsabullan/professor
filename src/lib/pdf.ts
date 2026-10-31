import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
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

/**
 * PDF 한 페이지를 pixelWidth 너비로 그린다.
 * 다 그린 뒤에 한 번에 옮겨서 확대/축소할 때 화면이 깜빡이지 않게 한다.
 */
export function renderPdfPage(
  doc: PDFDocumentProxy,
  pageIndex: number,
  target: HTMLCanvasElement,
  pixelWidth: number,
): { promise: Promise<void>; cancel(): void } {
  let task: RenderTask | null = null;
  let cancelled = false;
  const promise = (async () => {
    const page = await doc.getPage(pageIndex + 1);
    if (cancelled) return;
    const viewport = page.getViewport({ scale: pixelWidth / page.getViewport({ scale: 1 }).width });
    const off = document.createElement("canvas");
    off.width = Math.round(viewport.width);
    off.height = Math.round(viewport.height);
    task = page.render({ canvas: off, viewport });
    await task.promise;
    if (cancelled) return;
    target.width = off.width;
    target.height = off.height;
    target.getContext("2d")!.drawImage(off, 0, 0);
  })().catch((e) => {
    if (e?.name !== "RenderingCancelledException") console.error(e);
  });
  return {
    promise,
    cancel() {
      cancelled = true;
      task?.cancel();
    },
  };
}
