import type { Point } from "../types";
import { tracePath } from "./ink";

const HOLD_MS = 500; // 펜을 뗀 뒤 궤적이 그대로 남아 있는 시간
const FADE_MS = 200; // 그 뒤 서서히 사라지는 시간

/**
 * 레이저 포인터 궤적.
 * 펜을 떼고 0.5초 안에 다시 대면 앞 궤적을 유지하고, 마지막으로 뗀 뒤 0.5초가 지나면 0.2초 동안 흐려지며 사라진다.
 */
export class Laser {
  private trails: Point[][] = [];
  private current: Point[] | null = null;
  private liftedAt = 0;

  down(p: Point, now: number): void {
    // 이미 사라지기 시작했으면 새로 시작
    if (this.trails.length && now - this.liftedAt >= HOLD_MS) this.trails = [];
    this.current = [p];
    this.trails.push(this.current);
  }

  move(p: Point): void {
    this.current?.push(p);
  }

  /** 펜을 뗄 때 방금 그은 궤적을 돌려준다 */
  up(now: number): Point[] | null {
    const done = this.current;
    this.current = null;
    this.liftedAt = now;
    return done;
  }

  /** 보이는 게 있으면 true */
  draw(ctx: CanvasRenderingContext2D, w: number, h: number, now: number): boolean {
    if (!this.trails.length) return false;
    let alpha = 1;
    if (!this.current) {
      const elapsed = now - this.liftedAt;
      if (elapsed >= HOLD_MS + FADE_MS) {
        this.trails = [];
        return false;
      }
      if (elapsed > HOLD_MS) alpha = 1 - (elapsed - HOLD_MS) / FADE_MS;
    }
    const width = Math.max(4, w * 0.006);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const trail of this.trails) {
      ctx.shadowColor = "rgba(255, 0, 0, 0.9)";
      ctx.shadowBlur = width * 2;
      ctx.strokeStyle = "rgba(255, 45, 45, 0.85)";
      ctx.lineWidth = width;
      tracePath(ctx, trail, w, h);
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = "rgba(255, 225, 225, 0.95)";
      ctx.lineWidth = width / 3;
      ctx.stroke();
    }
    ctx.restore();
    return true;
  }
}
