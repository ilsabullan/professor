import { describe, expect, it } from 'vitest'
import { Board } from './board'
import { Engine, Player, type PlayStep } from './engine'
import { type Op, sanitizeOp } from './ops'

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

describe('반복 이동과 화살표 만들기', () => {
  const page = () => {
    const b = new Board()
    b.apply({ type: 'page', info: { page: 1, width: 1280, height: 720 } })
    b.apply({ type: 'text', id: 'a', page: 1, text: '가계', x: 200, y: 300, t: 0 })
    b.apply({ type: 'text', id: 'b', page: 1, text: '기업', x: 800, y: 300, t: 0 })
    return b
  }

  it('AI가 만든 화살표는 흐름 경로로 쓸 수 있다', () => {
    const e = new Engine(page(), () => {})
    const ops = [sanitizeOp({ v: 'spawn', id: 'p1', shape: 'arrow', from: 'o1', to: 'o2', text: '노동' })!, sanitizeOp({ v: 'flow', along: 'p1' })!]
    expect(e.validateStep(ops)).toBeNull()
    e.beginStep()
    ops.forEach((op) => e.applyOp(op, 0))
    expect(e.flows.map((f) => f.along)).toEqual(['p1'])
    const pts = e.linePts('p1')!
    expect(pts[0].x).toBeLessThan(pts[1].x)
  })

  it('끝 객체가 없는 화살표는 만들지 않는다', () => {
    const e = new Engine(page(), () => {})
    expect(e.validateStep([sanitizeOp({ v: 'spawn', id: 'p1', shape: 'arrow', from: 'o1', to: 'o9' })!])).toBe('화살표 끝 객체가 없음')
  })

  it('loop 이동은 시간이 지나도 계속 돌고, stop id로 그 자리에 멈춘다', () => {
    const e = new Engine(page(), () => {})
    const ring: Op[] = [
      sanitizeOp({ v: 'spawn', id: 'p1', shape: 'arrow', from: 'o1', to: 'o2' })!,
      sanitizeOp({ v: 'spawn', id: 'p2', shape: 'dot', at: [300, 300] })!,
    ]
    e.beginStep()
    ring.forEach((op) => e.applyOp(op, 0))
    e.beginStep()
    e.applyOp(sanitizeOp({ v: 'move', id: 'p2', along: 'p1', loop: true, dur: 2000 })!, 0)
    const xs: number[] = []
    for (let t = 0; t <= 6000; t += 500) { e.tick(t, 0.5); xs.push(Math.round(e.center('p2')!.x)) }
    // 열린 경로라 왕복: 오른쪽 끝까지 갔다가 다시 돌아온다
    expect(Math.max(...xs.slice(0, 6))).toBeGreaterThan(600)
    expect(xs[6]).toBeLessThan(Math.max(...xs)) // 3초: 돌아오는 중
    e.beginStep()
    e.applyOp(sanitizeOp({ v: 'stop', id: 'p2' })!, 6000)
    const stopped = e.center('p2')!.x
    e.tick(7000, 1)
    expect(e.center('p2')!.x).toBe(stopped)
  })
})

describe('선을 따라 이동 (along)', () => {
  /** 아래쪽 가로선(축): (100,600)→(300,600) */
  const axis = (b: Board) => {
    const pts = Array.from({ length: 21 }, (_, i) => ({ x: 100 + i * 10, y: 600, p: 0.5, t: i }))
    b.objs.push({ id: 'ax', kind: 'line', strokes: [{ id: 'sax', pts }], bbox: { x: 100, y: 600, w: 200, h: 1 }, pts, t: 0 })
  }

  it('선에서 떨어진 물체는 선 위로 올라타지 않고 선의 방향·길이만큼 제자리에서 옮겨진다 (실측: 그래프가 축으로 뛰어감)', () => {
    const { b, e } = setup()
    axis(b)
    e.beginStep()
    e.applyOp({ v: 'move', id: 'o1', along: 'ax', dur: 500 }, 0)
    e.tick(10_000, 0.05)
    expect(e.settled('o1')).toEqual({ x: 400, y: 300 })
  })

  it('사전 검사도 실제로 갈 자리로 겹침을 본다 (선 끝 (300,600)이 아니라 옮긴 끝 (400,300) = o2 자리)', () => {
    const { b, e } = setup()
    axis(b)
    expect(e.validateStep([{ v: 'move', id: 'o1', along: 'ax', dur: 500 }])).toMatch(/겹침: o1, o2/)
  })
})

describe('겹침 게이트', () => {
  const swapOps = [
    { v: 'move' as const, id: 'o1', to: 'o2', dur: 500 },
    { v: 'move' as const, id: 'o2', to: 'o1', dur: 500 },
  ]
  it('3 자리에 덧쓴 3(o3)이 원래 겹쳐 있어도 5↔3 교환을 막지 않는다 (실측 055444)', () => {
    const { b, e } = setup()
    b.objs.push({ id: 'o3', kind: 'mark', strokes: [{ id: 'so3', pts: [{ x: 405, y: 300, p: 0.5, t: 0 }] }], bbox: { x: 385, y: 265, w: 40, h: 80 }, t: 0 })
    expect(e.validateStep(swapOps)).toBeNull()
  })
  it('원래 떨어져 있던 값과 새로 겹치게 되는 이동은 막는다', () => {
    const { b, e } = setup()
    b.objs.push({ id: 'o3', kind: 'mark', strokes: [{ id: 'so3', pts: [{ x: 600, y: 300, p: 0.5, t: 0 }] }], bbox: { x: 580, y: 260, w: 40, h: 80 }, t: 0 })
    expect(e.validateStep([{ v: 'move', id: 'o1', to: 'o3', dur: 500 }])).toMatch(/겹침/)
  })
})

describe('eraseAt (지우개로 애니메이션 지우기)', () => {
  it('새로 생긴 점은 닿으면 바로 지워진다', () => {
    const { e } = setup()
    run(e, [{ v: 'spawn', id: 'p1', shape: 'dot', at: [600, 300], color: '#ff5a46', text: '', r: 8, w: 0, h: 0 }])
    expect(e.exists('p1')).toBe(true)
    expect(e.eraseAt({ x: 900, y: 300 }, 10).erased).toEqual([])
    expect(e.eraseAt({ x: 605, y: 302 }, 10).erased).toEqual(['p1'])
    expect(e.exists('p1')).toBe(false)
  })

  it('움직인 필기는 옮겨진 자리에서 닿아야 하고, 그 획 id를 돌려준다', () => {
    const { e } = setup()
    run(e, [{ v: 'move', id: 'o1', to: [200, 500], dur: 300 }])
    expect(e.isTakenOver('o1')).toBe(true)
    // 원래 자리(200,300)는 비었으므로 안 지워진다
    expect(e.eraseAt({ x: 220, y: 300 }, 10).strokeIds).toEqual([])
    expect(e.eraseAt({ x: 220, y: 500 }, 10).strokeIds).toEqual(['so1'])
  })

  it('흐름은 그 선 위를 지나면 멈춘다', () => {
    const { e } = setup()
    run(e, [{ v: 'flow', along: 'o2', n: 6, speed: 1, color: '#cdf0ff', rev: false }])
    expect(e.flows.length).toBe(1)
    e.eraseAt({ x: 420, y: 300 }, 10)
    expect(e.flows.length).toBe(0)
  })
})
