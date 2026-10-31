import type { LaserTrail, Stroke } from "../types";

// 애니메이션 쪽에 넘기는 이벤트. 구독하면 해제 함수를 돌려준다.
function channel<T>() {
  const listeners = new Set<(value: T) => void>();
  return {
    emit(value: T) {
      listeners.forEach((l) => l(value));
    },
    subscribe(listener: (value: T) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const strokeEnd = channel<Stroke>();
const laserEnd = channel<LaserTrail>();

/** 이번 세션에 그은 레이저 궤적 (화면에서 사라져도 남아 있음) */
export const laserLog: LaserTrail[] = [];

export const onStrokeEnd = strokeEnd.subscribe;
export const onLaserEnd = laserEnd.subscribe;

export function emitStroke(stroke: Stroke): void {
  strokeEnd.emit(stroke);
}

export function emitLaser(trail: LaserTrail): void {
  laserLog.push(trail);
  laserEnd.emit(trail);
}
