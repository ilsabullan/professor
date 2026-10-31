import { useEffect, useRef } from "react";
import { Plus } from "lucide-react";
import type { Page, Stroke } from "../types";
import type { PDFDocumentProxy } from "../lib/pdf";
import { PageThumb } from "./PageThumb";

const EMPTY: Stroke[] = [];

/** 모아보기: 차시의 전체 페이지를 바둑판으로 보여주고, 누르면 그 페이지로 이동 */
export function Overview({
  pages,
  pdfDoc,
  strokes,
  current,
  onPick,
  onAddBlank,
  onClose,
}: {
  pages: Page[];
  pdfDoc: PDFDocumentProxy | null;
  strokes: Record<string, Stroke[]>;
  current: number;
  onPick: (index: number) => void;
  onAddBlank: () => void;
  onClose: () => void;
}) {
  const currentRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: "center" });
  }, []);

  return (
    <div className="overview">
      <header className="nav-bar">
        <div className="nav-side">
          <button className="text-btn" onClick={onAddBlank}>
            <Plus size={18} strokeWidth={2} />빈 페이지
          </button>
        </div>
        <div className="nav-title">페이지 {pages.length}개</div>
        <div className="nav-side nav-side-right">
          <button className="text-btn strong" onClick={onClose}>
            완료
          </button>
        </div>
      </header>
      <div className="overview-grid">
        {pages.map((page, i) => (
          <button
            key={page.id}
            ref={i === current ? currentRef : undefined}
            className={`overview-item${i === current ? " current" : ""}`}
            onClick={() => onPick(i)}
          >
            <PageThumb page={page} pdfDoc={pdfDoc} strokes={strokes[page.id] ?? EMPTY} width={220} />
            <span className="overview-num">{i + 1}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
