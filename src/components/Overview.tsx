import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Page, Stroke } from "../types";
import type { PDFDocumentProxy } from "../lib/pdf";
import { PageThumb } from "./PageThumb";

const EMPTY: Stroke[] = [];
const PAD = 20; // 팝업 안쪽 좌우 여백
const GAP = 20; // 썸네일 사이 간격
const MIN_THUMB = 200;

/** 모아보기: 필기 화면 위에 팝업으로 전체 페이지를 보여주고, 누르면 그 페이지로 이동. 바깥을 누르면 닫힌다 */
export function Overview({
  pages,
  pdfDoc,
  strokes,
  current,
  onPick,
  onClose,
}: {
  pages: Page[];
  pdfDoc: PDFDocumentProxy | null;
  strokes: Record<string, Stroke[]>;
  current: number;
  onPick: (index: number) => void;
  onClose: () => void;
}) {
  const gridRef = useRef<HTMLDivElement>(null);
  const currentRef = useRef<HTMLButtonElement>(null);
  const [gridWidth, setGridWidth] = useState(0);

  useLayoutEffect(() => {
    const el = gridRef.current!;
    setGridWidth(el.clientWidth); // 첫 화면부터 바로 그리도록 열자마자 잰다
    const ro = new ResizeObserver(() => setGridWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (gridWidth) currentRef.current?.scrollIntoView({ block: "center" });
  }, [gridWidth > 0]);

  // 팝업 너비를 썸네일로 꽉 채워서 양옆 빈 공간이 남지 않게 한다
  const inner = gridWidth - PAD * 2;
  const cols = Math.max(1, Math.floor((inner + GAP) / (MIN_THUMB + GAP)));
  const thumbWidth = Math.floor((inner - GAP * (cols - 1)) / cols);

  return (
    <div className="overview" onClick={onClose}>
      <div
        className="overview-panel"
        role="dialog"
        aria-modal="true"
        aria-label="페이지 모아보기"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="nav-bar overview-header">
          <div className="nav-side" />
          <div className="nav-title">페이지 {pages.length}개</div>
          <div className="nav-side nav-side-right">
            <button className="text-btn strong" onClick={onClose}>
              완료
            </button>
          </div>
        </header>
        <div
          ref={gridRef}
          className="overview-grid"
          style={{ padding: `20px ${PAD}px`, gap: `24px ${GAP}px`, gridTemplateColumns: `repeat(${cols}, ${thumbWidth}px)` }}
        >
          {thumbWidth > 0 &&
            pages.map((page, i) => (
              <button
                key={page.id}
                ref={i === current ? currentRef : undefined}
                className={`overview-item${i === current ? " current" : ""}`}
                onClick={() => onPick(i)}
              >
                <PageThumb page={page} pdfDoc={pdfDoc} strokes={strokes[page.id] ?? EMPTY} width={thumbWidth} />
                <span className="overview-num">{i + 1}</span>
              </button>
            ))}
        </div>
      </div>
    </div>
  );
}
