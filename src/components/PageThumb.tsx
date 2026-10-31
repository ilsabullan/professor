import { useEffect, useRef, useState } from "react";
import type { Page, Stroke } from "../types";
import { renderPdfPage, type PDFDocumentProxy } from "../lib/pdf";
import { drawStrokes } from "../lib/ink";
import { pagePixelWidth } from "./PageCanvas";

const EAGER_DELAY = 250; // 지금 페이지를 먼저 그리도록 옆 페이지는 조금 늦게 그린다

/**
 * 작은 페이지 그림 (자료 + 필기).
 * 모아보기에서는 화면에 보일 때만 그리고, eager면(넘기기용 옆 페이지) 바로 그리되 필기 화면과 같은 해상도로 그려서
 * 넘겨 온 페이지가 그 그림을 그대로 이어받게 한다.
 */
export function PageThumb({
  page,
  pdfDoc,
  strokes,
  width,
  eager = false,
}: {
  page: Page;
  pdfDoc: PDFDocumentProxy | null;
  strokes: Stroke[];
  width: number;
  eager?: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(eager);
  const height = (width * page.height) / page.width;

  useEffect(() => {
    if (eager) return;
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
  }, [eager]);

  useEffect(() => {
    if (!visible) return;
    const canvas = ref.current!;
    const pw = eager ? pagePixelWidth(page, width) : Math.round(width * (window.devicePixelRatio || 1));
    const drawInk = () => drawStrokes(canvas.getContext("2d")!, strokes, canvas.width, canvas.height);
    let cancelled = false;
    let job: ReturnType<typeof renderPdfPage> | null = null;
    const draw = () => {
      if (pdfDoc && page.pdfPageIndex !== null) {
        job = renderPdfPage(pdfDoc, page.pdfPageIndex, canvas, pw);
        job.promise.then(() => {
          if (!cancelled) drawInk();
        });
        return;
      }
      canvas.width = pw;
      canvas.height = Math.round((pw * page.height) / page.width);
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      drawInk();
    };
    const timer = window.setTimeout(draw, eager ? EAGER_DELAY : 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      job?.cancel();
    };
  }, [visible, eager, pdfDoc, page, strokes, width]);

  return <canvas ref={ref} className="thumb-canvas" style={{ width, height }} />;
}
