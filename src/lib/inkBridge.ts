import type { InkPoint, InkStroke, PageInfo } from "../shared/ink";
import type { LaserTrail, Page, Point, Stroke } from "../types";

/**
 * 편집기 필기(페이지 비율 0~1, 화면을 연 뒤 ms)를 애니메이션 계약(src/shared/ink.ts)의 페이지 좌표로 바꾼다.
 * 애니메이션 쪽 크기 기준(선 굵기, 글자 크기, 판정 거리)이 폭 1280 칠판에 맞춰져 있어서 페이지 폭을 1280으로 맞춘다.
 */
export const BRIDGE_PAGE_WIDTH = 1280;

export function pageInfo(page: Page, pageNumber: number, text?: string): PageInfo {
  const width = BRIDGE_PAGE_WIDTH;
  return { page: pageNumber, width, height: Math.round((width * page.height) / page.width), ...(text ? { text } : {}) };
}

/** sessionStart: 편집기 시계의 0에 해당하는 performance.now() 값 */
function toInkPoint(p: Point, page: Page, sessionStart: number): InkPoint {
  const height = (BRIDGE_PAGE_WIDTH * page.height) / page.width;
  return { x: p.x * BRIDGE_PAGE_WIDTH, y: p.y * height, p: p.p ?? 0.5, t: p.t + sessionStart };
}

export function toInkStroke(s: Stroke, page: Page, pageNumber: number, sessionStart: number): InkStroke {
  return {
    id: s.id,
    page: pageNumber,
    points: s.points.map((p) => toInkPoint(p, page, sessionStart)),
    color: s.color,
    width: s.width * BRIDGE_PAGE_WIDTH,
  };
}

/**
 * 편집기 획 목록이 바뀐 것을 애니메이션에 보낼 추가·삭제로 나눈다.
 * 형광펜은 PDF 글자 강조라서 칠판 필기로 보지 않는다 (AI가 선·밑줄로 읽고 움직이지 않게).
 */
export function inkDiff(prev: Stroke[], next: Stroke[]): { added: Stroke[]; removed: string[] } {
  const pens = (list: Stroke[]) => list.filter((s) => s.tool === "pen");
  const p = pens(prev);
  const n = pens(next);
  const nextIds = new Set(n.map((s) => s.id));
  const prevIds = new Set(p.map((s) => s.id));
  return { added: n.filter((s) => !prevIds.has(s.id)), removed: p.filter((s) => !nextIds.has(s.id)).map((s) => s.id) };
}

/** 지우개 위치(페이지 비율)와 반경(페이지 너비 대비)을 페이지 좌표로 */
export function toEraseAt(p: Point, radius: number, page: Page, pageNumber: number) {
  const height = (BRIDGE_PAGE_WIDTH * page.height) / page.width;
  return {
    type: "eraseAt" as const,
    page: pageNumber,
    x: p.x * BRIDGE_PAGE_WIDTH,
    y: p.y * height,
    r: radius * BRIDGE_PAGE_WIDTH,
    t: performance.now(),
  };
}

export function toInkPoints(trail: LaserTrail, page: Page, sessionStart: number): InkPoint[] {
  return trail.points.map((p) => toInkPoint(p, page, sessionStart));
}
