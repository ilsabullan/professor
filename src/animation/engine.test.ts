import { describe, expect, it } from 'vitest'
import { Board } from './board'
import { Engine, Player, type PlayStep } from './engine'

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

  it('이동 중 새 목표를 주면 이전 애니메이션이 화면 좌표를 덮어쓰지 않는다', () => {
    const { e } = setup()
    e.beginStep()
    e.applyOp({ v: 'move', id: 'o1', to: [500, 300], dur: 2000 }, 0)
    e.tick(100, .05)
    e.beginStep()
    e.applyOp({ v: 'move', id: 'o1', to: [100, 300], dur: 300 }, 100)
    e.tick(500, .05)
    expect(e.center('o1')).toEqual({ x: 100, y: 300 })
    e.tick(3000, .05)
    expect(e.center('o1')).toEqual({ x: 100, y: 300 })
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

describe('발화 단위 실행', () => {
  const swapStep = (key: string, open = false): PlayStep => ({
    reqId: 1, commitKey: key, ops: [
      { v: 'move', id: 'o1', to: 'o2', dur: 500 },
      { v: 'move', id: 'o2', to: 'o1', dur: 500 },
    ], applied: 0, cap: '교환', capShown: false, open, startedAt: null, maxDur: 0,
  })

  it('같은 발화의 교환은 한 번만, 새 발화의 재교환은 15초 안에도 허용한다', () => {
    const { e } = setup()
    const rejected: string[] = []
    const p = new Player(e, { onFirstOp() {}, onCaption() {}, onRejected: (_s, r) => rejected.push(r) })
    p.push(swapStep('speech:1'))
    p.tick(1000)
    p.tick(2000)
    p.push(swapStep('speech:1'))
    p.tick(3000)
    expect(e.settled('o1')).toEqual({ x: 400, y: 300 })
    expect(rejected).toHaveLength(1)
    p.push(swapStep('speech:2'))
    p.tick(4000)
    expect(e.settled('o1')).toEqual({ x: 200, y: 300 })
  })

  it('교환의 반쪽이 도착한 상태에서 취소되면 아무것도 움직이지 않는다', () => {
    const { e } = setup()
    const p = new Player(e, { onFirstOp() {}, onCaption() {} })
    const step = swapStep('speech:1', true)
    step.ops.pop()
    p.push(step)
    p.tick(1000)
    p.drop(1)
    p.tick(2000)
    expect(e.settled('o1')).toEqual({ x: 200, y: 300 })
    expect(e.settled('o2')).toEqual({ x: 400, y: 300 })
  })

  it('한쪽 이동만 있는 완성 응답도 겹침과 잘못된 자막을 함께 차단한다', () => {
    const { e } = setup()
    const captions: string[] = []
    const p = new Player(e, { onFirstOp() {}, onCaption: (s) => captions.push(s.cap) })
    const step = swapStep('speech:1')
    step.ops.pop()
    p.push(step)
    p.tick(1000)
    expect(e.settled('o1')).toEqual({ x: 200, y: 300 })
    expect(captions).toEqual([])
  })
})

describe('선을 따라 이동 (along)', () => {
  it('선에서 떨어진 물체는 선 위로 올라타지 않고 선의 방향·길이만큼 제자리에서 옮겨진다 (실측: 그래프가 축으로 뛰어감)', () => {
    const { b, e } = setup()
    // 아래쪽 가로선(축): (100,600)→(300,600)
    const pts = Array.from({ length: 21 }, (_, i) => ({ x: 100 + i * 10, y: 600, p: 0.5, t: i }))
    b.objs.push({ id: 'ax', kind: 'line', strokes: [{ id: 'sax', pts }], bbox: { x: 100, y: 600, w: 200, h: 1 }, pts, t: 0 })
    e.beginStep()
    e.applyOp({ v: 'move', id: 'o1', along: 'ax', dur: 500 }, 0)
    e.tick(10_000, 0.05)
    expect(e.settled('o1')).toEqual({ x: 400, y: 300 })
  })
})
