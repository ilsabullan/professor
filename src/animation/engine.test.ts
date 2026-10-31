import { describe, expect, it } from 'vitest'
import { Board } from './board'
import { Engine } from './engine'

/** 손글씨 두 개(o1 왼쪽, o2 오른쪽)를 둔 보드 */
function setup() {
  const b = new Board()
  const mark = (id: string, x: number) => {
    const pts = Array.from({ length: 25 }, (_, i) => ({ x: x + 20 * Math.cos(i / 4), y: 300 + 40 * Math.sin(i / 3), p: 0.5, t: i }))
    b.objs.push({ id, kind: 'mark', strokes: [{ id: 's' + id, pts }], bbox: { x: x - 20, y: 260, w: 40, h: 80 }, t: 0 })
  }
  mark('o1', 200)
  mark('o2', 400)
  const e = new Engine(b, () => {})
  return { b, e }
}

const run = (e: Engine, ops: Parameters<Engine['applyOp']>[0][]) => {
  e.beginStep()
  ops.forEach((op) => e.applyOp(op, 0))
  e.tick(10_000, 0.05)
}

describe('move', () => {
  it('같은 단계의 move 두 개로 교환된다 (단계 시작 위치 기준)', () => {
    const { e } = setup()
    run(e, [
      { v: 'move', id: 'o1', to: 'o2', dur: 500 },
      { v: 'move', id: 'o2', to: 'o1', dur: 500 },
    ])
    expect(e.settled('o1')).toEqual({ x: 400, y: 300 })
    expect(e.settled('o2')).toEqual({ x: 200, y: 300 })
  })

  it('도착지에 객체가 있어도 자동으로 맞바꾸지 않고, 겹침으로 알린다', () => {
    const { e } = setup()
    run(e, [{ v: 'move', id: 'o1', to: 'o2', dur: 500 }])
    expect(e.settled('o2')).toEqual({ x: 400, y: 300 })
    expect(e.overlaps()).toEqual([['o1', 'o2']])
  })

  it('다음 단계는 이전 단계가 끝난 자리 기준', () => {
    const { e } = setup()
    run(e, [
      { v: 'move', id: 'o1', to: 'o2', dur: 500 },
      { v: 'move', id: 'o2', to: 'o1', dur: 500 },
    ])
    run(e, [
      { v: 'move', id: 'o1', to: 'o2', dur: 500 },
      { v: 'move', id: 'o2', to: 'o1', dur: 500 },
    ])
    expect(e.settled('o1')).toEqual({ x: 200, y: 300 })
    expect(e.settled('o2')).toEqual({ x: 400, y: 300 })
  })
})
