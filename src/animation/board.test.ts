import { describe, expect, it } from 'vitest'
import type { InkPoint } from '../shared/ink'
import { Board, classify } from './board'

let clock = 1000
let sid = 0

/** 점 목록을 시각이 붙은 획으로 (획마다 시간이 흐르게) */
function ink(pts: [number, number][], durMs = 300): InkPoint[] {
  const t0 = clock
  clock += durMs
  return pts.map(([x, y], i) => ({ x, y, p: 0.5, t: t0 + (durMs * i) / Math.max(1, pts.length - 1) }))
}

function seg(x0: number, y0: number, x1: number, y1: number, n = 30): [number, number][] {
  return Array.from({ length: n + 1 }, (_, i) => [x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n])
}

function rect(x: number, y: number, w: number, h: number): [number, number][] {
  return [...seg(x, y, x + w, y), ...seg(x + w, y, x + w, y + h), ...seg(x + w, y + h, x, y + h), ...seg(x, y + h, x + 2, y + 4)]
}

/** 손으로 크게 쓴 숫자 5의 몸통 (위 가로획 제외) */
function five(x: number, y: number, s = 1): [number, number][] {
  const out: [number, number][] = seg(x + 5 * s, y, x, y + 45 * s, 10)
  for (let i = 0; i <= 24; i++) {
    const a = -Math.PI / 2 + (i / 24) * Math.PI * 1.25
    out.push([x + 20 * s + Math.cos(a) * 30 * s, y + 75 * s + Math.sin(a) * 30 * s])
  }
  return out
}

/** 손으로 쓴 8: 가운데에서 시작해 위 고리를 돌고 아래 고리를 돈다 */
function eight(x: number, y: number): [number, number][] {
  const out: [number, number][] = []
  for (let i = 0; i <= 30; i++) {
    const a = Math.PI / 2 - (i / 30) * Math.PI * 2
    out.push([x + 28 * Math.cos(a), y - 30 + 30 * Math.sin(a)])
  }
  for (let i = 0; i <= 30; i++) {
    const a = -Math.PI / 2 + (i / 30) * Math.PI * 2
    out.push([x + 32 * Math.cos(a), y + 32 + 32 * Math.sin(a)])
  }
  return out
}

function circle(cx: number, cy: number, r: number): [number, number][] {
  return Array.from({ length: 49 }, (_, i) => {
    const t = (i / 48) * Math.PI * 2
    return [cx + r * Math.cos(t), cy + r * Math.sin(t)] as [number, number]
  })
}

const stroke = (b: Board, pts: [number, number][], dur?: number) =>
  b.apply({ type: 'stroke', stroke: { id: 's' + ++sid, page: 1, points: ink(pts, dur) } })

const P = (pts: [number, number][]) => pts.map(([x, y]) => ({ x, y }))

describe('classify', () => {
  it('곧은 긴 획은 선', () => expect(classify(P(seg(0, 0, 300, 8)))).toBe('line'))
  it('모서리가 있는 닫힌 획은 상자', () => expect(classify(P(rect(0, 0, 200, 140)))).toBe('box'))
  it('크게 쓴 숫자 5는 손글씨 (실측에서 선으로 잘못 봄)', () => expect(classify(P(five(0, 0, 1.2)))).toBe('mark'))
  it('숫자 8은 상자가 아니라 손글씨', () => expect(classify(P(eight(100, 100)))).toBe('mark'))
  it('작은 동그라미(숫자 0)는 손글씨', () => expect(classify(P(circle(100, 100, 45)))).toBe('mark'))
  it('큰 동그라미는 감싸는 상자', () => expect(classify(P(circle(300, 300, 130)))).toBe('box'))
  it('길쭉하게 쓴 8은 상자가 아니라 손글씨 (실측에서 상자로 봄)', () => {
    const tall: [number, number][] = []
    for (let i = 0; i <= 30; i++) {
      const a = Math.PI / 2 - (i / 30) * Math.PI * 2
      tall.push([100 + 36 * Math.cos(a), 140 - 40 + 40 * Math.sin(a)])
    }
    for (let i = 0; i <= 30; i++) {
      const a = -Math.PI / 2 + (i / 30) * Math.PI * 2
      tall.push([100 + 37 * Math.cos(a), 140 + 41 + 41 * Math.sin(a)])
    }
    expect(classify(P(tall))).toBe('mark')
  })
  it('짧게 곧추선 획(숫자 1)은 손글씨', () => expect(classify(P(seg(800, 140, 803, 280)))).toBe('mark'))
  it('긴 세로선은 선', () => expect(classify(P(seg(800, 100, 806, 400)))).toBe('line'))
})

describe('Board', () => {
  it('5의 위 가로획을 화살표 머리로 보지 않고 같은 글자로 묶는다', () => {
    const b = new Board()
    stroke(b, seg(100, 400, 500, 400)) // 직전에 그린 선
    stroke(b, five(510, 330, 1.2))
    const ev = stroke(b, seg(516, 330, 560, 328, 8), 120)
    expect(ev?.kind).toBe('획')
    expect(b.objs.filter((o) => o.kind === 'mark')).toHaveLength(1)
    expect(b.objs.find((o) => o.kind === 'line')?.arrowEnd).toBeUndefined()
  })

  it('선 끝의 V자는 화살표 머리', () => {
    const b = new Board()
    stroke(b, seg(100, 300, 400, 300))
    const ev = stroke(b, [
      [380, 285],
      [402, 300],
      [380, 315],
    ], 150)
    expect(ev?.kind).toBe('화살표')
  })

  it('나란한 두 상자 사이의 화살표는 화살표로 남는다 (TCP 예시)', () => {
    const b = new Board()
    stroke(b, rect(110, 250, 200, 140))
    clock += 2000
    stroke(b, rect(970, 250, 200, 140))
    clock += 2000
    stroke(b, seg(320, 320, 955, 320))
    const ev = stroke(b, [
      [935, 309],
      [957, 320],
      [935, 331],
    ], 150)
    expect(b.get('o3')?.kind).toBe('line')
    expect(ev?.kind).toBe('화살표')
  })

  it('펜을 대기 직전의 짧은 떠 있음은 가리키기가 아니다', () => {
    const b = new Board()
    const ev = b.apply({ type: 'point', page: 1, points: ink(seg(100, 100, 220, 110, 10), 120) })
    expect(ev).toBeNull()
    const real = b.apply({ type: 'point', page: 1, points: ink(seg(100, 100, 600, 110, 20), 800) })
    expect(real?.kind).toBe('가리키기')
  })

  it('겹친 객체 사이를 오가는 반복 없이 지나간 순서만 남긴다', () => {
    const b = new Board()
    stroke(b, rect(100, 100, 200, 140))
    clock += 2000
    stroke(b, rect(400, 100, 200, 140))
    clock += 2000
    b.apply({ type: 'point', page: 1, points: ink(seg(150, 170, 550, 170, 40), 900) })
    expect(b.traces[0].passes).toEqual(['o1', 'o2'])
  })
})
