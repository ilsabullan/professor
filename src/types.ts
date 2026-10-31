/** 시간(t, startedAt, endedAt)은 모두 필기 화면을 연 시점부터의 ms */
export type Point = { x: number; y: number; t: number; p?: number }; // x,y: 페이지 기준 0~1, p: 필압(펜일 때만)

export type Stroke = {
  id: string;
  pageId: string;
  tool: "pen" | "highlighter";
  color: string;
  width: number; // 페이지 너비 대비 비율
  points: Point[];
  startedAt: number;
  endedAt: number;
};

export type LaserTrail = {
  pageId: string;
  points: { x: number; y: number; t: number }[];
};

export type Tool = "pen" | "highlighter" | "eraser" | "laser";

/** pdfPageIndex가 null이면 빈 페이지. width/height는 비율 계산용 */
export type Page = {
  id: string;
  pdfPageIndex: number | null;
  width: number;
  height: number;
};

export type Lecture = {
  id: string;
  title: string;
  fileName: string;
  createdAt: number;
  updatedAt: number;
  pages: Page[];
  thumbnail?: string;
};
