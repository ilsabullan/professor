import { useEffect, useRef, useState } from "react";
import type { Page, Stroke } from "../types";
import { renderPdfPage, type PDFDocumentProxy } from "../lib/pdf";
import { drawStrokes } from "../lib/ink";

/** 모아보기용 작은 페이지 (자료 + 필기). 화면에 보일 때만 그린다 */
export function PageThumb({
  page,
  pdfDoc,
  strokes,
  width,
}: {
  page: Page;
  pdfDoc: PDFDocumentProxy | null;
  strokes: Stroke[];
  width: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const height = (width * page.height) / page.width;

  useEffect(() => {
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: "300px" },
    );
    io.observe(ref.current!);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    const canvas = ref.current!;
    const pw = Math.round(width * (window.devicePixelRatio || 1));
    const drawInk = () => drawStrokes(canvas.getContext("2d")!, strokes, canvas.width, canvas.height);
    if (pdfDoc && page.pdfPageIndex !== null) {
      let cancelled = false;
      const job = renderPdfPage(pdfDoc, page.pdfPageIndex, canvas, pw);
      job.promise.then(() => {
        if (!cancelled) drawInk();
      });
      return () => {
        cancelled = true;
        job.cancel();
      };
    }
    canvas.width = pw;
    canvas.height = Math.round((pw * page.height) / page.width);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    drawInk();
  }, [visible, pdfDoc, page, strokes, width]);

  return <canvas ref={ref} className="thumb-canvas" style={{ width, height }} />;
}
