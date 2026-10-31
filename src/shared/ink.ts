/**
 * 필기 데이터 계약: PDF 편집기(필기 캔버스) ↔ 애니메이션 레이어.
 *
 * - 좌표는 모두 "페이지 좌표"다. 페이지 폭을 1280으로 맞춘 px 기준이라(src/lib/inkBridge.ts)
 *   확대·스크롤과 상관없이 같은 지점은 같은 값을 가진다.
 * - 시각(t)은 같은 페이지의 performance.now() 값(ms)이다.
 * - 편집기는 아래 InkEvent를 InkBus.emit()으로 보내고,
 *   애니메이션 레이어가 보내는 LayerRequest를 InkBus.onRequest()로 받아 처리한다.
 */

export interface InkPoint {
  x: number
  y: number
  /** 필압 0~1. 필압이 없는 입력(마우스 등)은 0.5 */
  p: number
  /** performance.now() 기준 ms */
  t: number
}

export interface InkStroke {
  /** 편집기가 정하는 고유 id. 지우기(erase) 때 같은 id로 알려준다 */
  id: string
  page: number
  points: InkPoint[]
  color?: string
  /** 페이지 좌표 기준 선 굵기 */
  width?: number
  /** 형광펜: 반투명하게 겹쳐 그린다 */
  highlight?: boolean
}

export interface PageInfo {
  page: number
  /** 페이지 좌표계 크기 */
  width: number
  height: number
  /** PDF 페이지에서 뽑은 글자. AI가 강의 맥락으로 쓴다 (없어도 됨) */
  text?: string
}

/** 편집기 → 애니메이션 레이어 */
export type InkEvent =
  /** 페이지가 열리거나 바뀜 (크기·글자 포함) */
  | { type: 'page'; info: PageInfo }
  /** 펜 획 하나가 끝남 (펜을 뗀 순간) */
  | { type: 'stroke'; stroke: InkStroke }
  /** 지우개로 획(또는 글자)이 지워짐 */
  | { type: 'erase'; page: number; strokeIds: string[]; t: number }
  /** 글자 도구로 입력한 글자 */
  | { type: 'text'; page: number; id: string; text: string; x: number; y: number; t: number }
  /**
   * 가리키기 궤적. 잉크는 남지 않음 (펜을 띄운 채 움직이기, 포인터 도구 등).
   * 의도한 가리키기만 보낸다: 펜이 닿기 직전까지의 호버, 획을 뗀 직후 0.4초, 0.4초 미만의 짧은 호버는 보내지 않는다.
   * (애니메이션 쪽도 0.25초·80px 미만 궤적은 무시한다)
   */
  | { type: 'point'; page: number; points: InkPoint[] }
  /** 페이지 필기 전부 지움 */
  | { type: 'clear'; page: number }
  /**
   * 지우개가 지나가는 자리 (움직일 때마다). 애니메이션이 그린 것(움직인 필기, 새로 생긴 점·도형·이름표, 흐름)도 지운다.
   * 움직인 필기에 닿으면 애니메이션 쪽이 removeStrokes로 그 획을 지워 달라고 요청한다
   */
  | { type: 'eraseAt'; page: number; x: number; y: number; r: number; t: number }

/** 애니메이션 레이어 → 편집기 */
export type LayerRequest =
  /**
   * 애니메이션이 필기를 직접 움직이거나 색을 바꿀 때, 원래 필기를 잠시 숨겨 달라는 요청.
   * 숨긴 동안에는 애니메이션 레이어가 그 획을 대신 그린다.
   */
  | { type: 'hideStrokes'; strokeIds: string[]; hidden: boolean }
  /** 지우개가 애니메이션이 대신 그리던 필기에 닿음. 편집기는 그 획을 지우고 평소처럼 erase를 보낸다 */
  | { type: 'removeStrokes'; strokeIds: string[] }
