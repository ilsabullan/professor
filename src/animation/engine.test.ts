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

const run = (e: Engine, ops: Parameters<Engine['applyOp']>[0][], t = 0) => {
  e.beginStep()
  ops.forEach((op) => e.applyOp(op, t))
  e.tick(t + 10_000, 0.05)
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

  it('다음 단계는 이전 단계가 끝난 자리 기준 (15초 넘게 지나 다시 맞바꾸면 원위치)', () => {
    const { e } = setup()
    run(e, [
      { v: 'move', id: 'o1', to: 'o2', dur: 500 },
      { v: 'move', id: 'o2', to: 'o1', dur: 500 },
    ])
    run(
      e,
      [
        { v: 'move', id: 'o1', to: 'o2', dur: 500 },
        { v: 'move', id: 'o2', to: 'o1', dur: 500 },
      ],
      20_000,
    )
    expect(e.settled('o1')).toEqual({ x: 200, y: 300 })
    expect(e.settled('o2')).toEqual({ x: 400, y: 300 })
  })
})

describe('되돌리기 방지', () => {
  it('방금 맞바꾼 쌍을 곧바로 다시 맞바꾸지 않는다 (실측: 5↔3이 두 번 실행돼 원위치)', () => {
    const { e } = setup()
    const swap = (t: number) => {
      e.beginStep()
      e.applyOp({ v: 'move', id: 'o1', to: 'o2', dur: 500 }, t)
      e.applyOp({ v: 'move', id: 'o2', to: 'o1', dur: 500 }, t)
      e.tick(t + 10_000, 0.05)
    }
    swap(1000)
    swap(5000)
    expect(e.settled('o1')).toEqual({ x: 400, y: 300 })
    expect(e.settled('o2')).toEqual({ x: 200, y: 300 })
  })
})
