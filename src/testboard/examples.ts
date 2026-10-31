import type { InkPoint } from '../shared/ink'
import type { TestBoardController } from './controller'

/** 펜이 없어도 시험할 수 있게, 교안별 예시 그림을 사람이 그린 것처럼 순서대로 보낸다 */

const jitter = (v: number, a: number) => v + (Math.random() - 0.5) * a
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 점들에 그린 시각을 붙인다. 마지막 점이 지금 */
function timed(pts: { x: number; y: number }[], durMs: number, p = 0.6): InkPoint[] {
  const end = performance.now()
  return pts.map((q, i) => ({ x: q.x, y: q.y, p, t: end - durMs + (durMs * i) / Math.max(1, pts.length - 1) }))
}

function box(x: number, y: number, w: number, h: number) {
  const c = [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
    [x + 3, y + 5],
  ]
  const out: { x: number; y: number }[] = []
  for (let i = 0; i < c.length - 1; i++)
    for (let j = 0; j < 14; j++) {
      const t = j / 14
      out.push({ x: jitter(c[i][0] + (c[i + 1][0] - c[i][0]) * t, 2.5), y: jitter(c[i][1] + (c[i + 1][1] - c[i][1]) * t, 2.5) })
    }
  return timed(out, 800, 0.72)
}

function line(x0: number, y0: number, x1: number, y1: number, wave = 6) {
  const out: { x: number; y: number }[] = []
  const nx = -(y1 - y0)
  const ny = x1 - x0
  const L = Math.hypot(nx, ny) || 1
  for (let j = 0; j <= 40; j++) {
    const t = j / 40
    const s = Math.sin(t * Math.PI * 2) * wave
    out.push({ x: x0 + (x1 - x0) * t + (nx / L) * s, y: y0 + (y1 - y0) * t + (ny / L) * s })
  }
  return timed(out, 380, 0.4)
}

/** 선 끝(x1,y1)에 V자 화살표 머리 */
function head(x0: number, y0: number, x1: number, y1: number) {
  const a = Math.atan2(y1 - y0, x1 - x0)
  const s = 22
  const p1 = { x: x1 - Math.cos(a - 0.5) * s, y: y1 - Math.sin(a - 0.5) * s }
  const p2 = { x: x1 - Math.cos(a + 0.5) * s, y: y1 - Math.sin(a + 0.5) * s }
  return timed([p1, { x: x1 + 2, y: y1 }, p2], 160, 0.5)
}

async function arrow(b: TestBoardController, x0: number, y0: number, x1: number, y1: number) {
  b.addStroke(line(x0, y0, x1, y1, 4))
  await wait(250)
  b.addStroke(head(x0, y0, x1, y1))
}

export async function drawExample(b: TestBoardController, lessonId: string) {
  const gap = 350
  if (lessonId === 'tcp') {
    b.addStroke(box(110, 250, 200, 140))
    await wait(gap)
    b.addText('송신자', 160, 320)
    await wait(gap)
    b.addStroke(box(970, 250, 200, 140))
    await wait(gap)
    b.addText('수신자', 1020, 320)
    await wait(gap)
    await arrow(b, 320, 320, 955, 320)
    return
  }
  if (lessonId === 'sort') {
    const vals = ['5', '3', '8', '1']
    for (let i = 0; i < 4; i++) {
      b.addStroke(box(330 + i * 160, 290, 120, 120))
      await wait(250)
    }
    for (let i = 0; i < 4; i++) {
      b.addText(vals[i], 382 + i * 160, 350)
      await wait(200)
    }
    return
  }
  if (lessonId === 'blood') {
    b.addStroke(box(540, 290, 200, 130))
    await wait(gap)
    b.addText('심장', 610, 355)
    await wait(gap)
    b.addStroke(box(540, 60, 200, 110))
    await wait(gap)
    b.addText('폐', 630, 115)
    await wait(gap)
    b.addStroke(box(540, 550, 200, 120))
    await wait(gap)
    b.addText('온몸', 610, 610)
    await wait(gap)
    await arrow(b, 580, 285, 580, 180)
    await wait(gap)
    await arrow(b, 700, 180, 700, 285)
    return
  }
}

/** 예시: 두 지점 사이를 손으로 쓱 가리키는 동작 */
export function examplePointing(b: TestBoardController, x0: number, y0: number, x1: number, y1: number) {
  const pts: { x: number; y: number }[] = []
  for (let j = 0; j <= 30; j++) {
    const t = j / 30
    pts.push({ x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t - Math.sin(t * Math.PI) * 60 })
  }
  b.addPointing(timed(pts, 900, 0.5))
}
