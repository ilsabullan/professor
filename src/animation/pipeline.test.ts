import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InkBus } from '../shared/bus'
import { streamSteps } from './ai/client'
import { Pipeline } from './pipeline'

vi.mock('./ai/client', async (original) => ({ ...await original<typeof import('./ai/client')>(), streamSteps: vi.fn() }))

interface Request {
  text: (s: string) => void
  finish: () => void
  signal: AbortSignal
}
let requests: Request[] = []

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 16))
  requests = []
  vi.mocked(streamSteps).mockImplementation((_opts, _content, signal, text) => new Promise((resolve, reject) => {
    requests.push({ text, signal, finish: () => resolve({ model: 'test', inputTokens: 0, outputTokens: 0, cacheRead: 0 }) })
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  }))
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks() })

function setup() {
  const bus = new InkBus()
  const p = new Pipeline(bus, { headless: true })
  p.aiStatus = 'checking'
  bus.emit({ type: 'page', info: { page: 1, width: 1280, height: 720 } })
  for (const [i, text] of ['5', '3', '8', '1'].entries()) bus.emit({ type: 'text', id: `s${i}`, page: 1, text, x: 200 + i * 150, y: 300, t: 0 })
  p.resetAnimation()
  p.aiStatus = 'ready'
  return { p, bus }
}
const swap = (a = 'o1', b = 'o2') => JSON.stringify({ conf: .9, ops: [{ v: 'move', id: a, to: b }, { v: 'move', id: b, to: a }], cap: '교환' })
const say = async (p: Pipeline, text: string) => { p.say(text); await vi.advanceTimersByTimeAsync(1); return requests.at(-1)! }

describe('실측의 입력 중첩과 잘못된 대상', () => {
  it('동작 말로 끝난 받아쓰기는 바로 한 번 확정되고, 뒤늦은 브라우저 확정은 중복으로 무시된다', async () => {
    const { p } = setup()
    const before = p.reqs.length
    p.onInterim('5와 3을 바꿔요', 0)
    await vi.advanceTimersByTimeAsync(1000)
    expect(p.engine.settled('o1')?.x).toBe(358)
    const made = p.reqs.length - before
    expect(made).toBeGreaterThan(0)
    p.onFinal('5와 3을 바꿔요.', 10)
    await vi.advanceTimersByTimeAsync(2000)
    expect(p.reqs.length - before).toBe(made)
    expect(p.engine.settled('o1')?.x).toBe(358)
    expect(p.engine.overlaps()).toEqual([])
  })

  it('받아쓰기가 0.9초 멈추면 확정해 AI를 한 번만 부른다 (중간 글자마다 부르지 않음)', async () => {
    const { p } = setup()
    for (const t of ['이 배열은', '이 배열은 아직', '이 배열은 아직 정렬이', '이 배열은 아직 정렬이 안 됐어요']) {
      p.onInterim(t, 0)
      await vi.advanceTimersByTimeAsync(200)
    }
    expect(requests).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1000)
    expect(requests).toHaveLength(1)
    // 브라우저가 같은 덩어리를 이어서 보내면 확정한 앞부분은 빼고 뒷말만 다음 문장으로
    p.onInterim('이 배열은 아직 정렬이 안 됐어요 그럼 비교해 볼게요', 0)
    expect(p.interim).toBe('그럼 비교해 볼게요')
  })

  it('받아쓰기가 확정한 앞부분을 고쳐 써도 같은 문장을 다시 확정하지 않는다 (실측: "을"→"의")', async () => {
    const { p } = setup()
    p.onInterim('5와 3을 자리가 바뀌겠죠', 0)
    await vi.advanceTimersByTimeAsync(1000)
    const n = requests.length
    p.onInterim('5와 3의 자리가 바뀌겠죠 다음은 8이에요', 0)
    expect(p.interim).toBe('다음은 8이에요')
    expect(requests.length).toBe(n)
  })

  it('"바꿔 볼까요"는 "바꿔"에서 끊지 않는다', async () => {
    const { p } = setup()
    p.onInterim('8과 1의 자리를 바꿔', 0)
    await vi.advanceTimersByTimeAsync(100)
    expect(requests).toHaveLength(0)
  })

  it('비교만 말했는데 8·1 교환이 나오면 움직이지 않는다', async () => {
    const { p } = setup()
    const r = await say(p, '5와 8을 비교할 거예요')
    r.text(swap('o3', 'o4') + '\n')
    expect(p.engine.settled('o3')?.x).toBe(508)
    expect(p.reqs.at(-1)?.rejected).toBe(1)
  })

  it('팔 과일 비교 다음의 둘은 8·1로 확정하여 그 쌍만 함께 교환한다', async () => {
    const { p } = setup()
    const compare = await say(p, '팔 과일을 비유했을 때 누가 더 크죠?')
    compare.text('{"none":true}\n'); compare.finish()
    await vi.advanceTimersByTimeAsync(1)
    await say(p, '그럼 둘이 바뀌겠죠?')
    expect(p.engine.settled('o1')?.x).toBe(208)
    expect(p.engine.settled('o3')?.x).toBe(658)
    expect(p.reqs.at(-1)?.model).toBe('local-numeric-swap')
  })

  it('스트림 중단으로 남은 반쪽 교환과 늦은 콜백을 실행하지 않는다', async () => {
    const { p } = setup()
    const r = await say(p, '5와 3을 옮겨요')
    r.text('{"conf":0.9,"ops":[{"v":"move","id":"o1","to":"o2"},')
    await say(p, '그대로 둬요')
    r.text(swap() + '\n')
    expect(p.engine.settled('o1')?.x).toBe(208)
    expect(p.engine.overlaps()).toEqual([])
  })

  it('새 입력이 위치를 바꾸면 이전 배치를 전제로 만든 동작을 버린다', async () => {
    const { p } = setup()
    const r = await say(p, '5와 3을 옮겨요')
    p.engine.beginStep()
    p.engine.applyOp({ v: 'move', id: 'o1', to: [100, 100], dur: 500 }, 1)
    r.text(swap() + '\n')
    expect(p.engine.settled('o1')).toEqual({ x: 100, y: 100 })
    expect(p.reqs.at(-1)?.rejected).toBe(1)
  })

  it('페이지를 바꾸면 이전 발화·대상·타이머와 늦은 응답을 모두 무효화한다', async () => {
    const { p, bus } = setup()
    const r = await say(p, '5와 3을 비교해요')
    p.onInterim('그럼 둘을 바꿔요', 1)
    bus.emit({ type: 'page', info: { page: 2, width: 1280, height: 720 } })
    r.text(swap() + '\n')
    await vi.advanceTimersByTimeAsync(200)
    expect(p.utter).toEqual([])
    expect(p.interim).toBe('')
    expect(p.player.queue).toEqual([])
    expect(p.engine.anim).toEqual({})
    expect(p.busy()).toBe(false)
  })
})

describe('말한 직후 필기 (실측 043036, 050404)', () => {
  const line = (bus: InkBus, id: string) => bus.emit({ type: 'stroke', stroke: { id, page: 1, points: Array.from({ length: 20 }, (_, i) => ({ x: 200 + i * 20, y: 520, t: i * 10, p: 0.5 })) } })

  it('확정 발화 요청이 진행 중일 때 그은 획이 그 요청을 취소하지 않고, 끝난 뒤에 따로 부른다', async () => {
    const { p, bus } = setup()
    const r = await say(p, '5와 3을 옮겨요')
    line(bus, 'k1')
    await vi.advanceTimersByTimeAsync(1500)
    expect(r.signal.aborted).toBe(false)
    const n = requests.length
    r.text(swap() + '\n')
    r.finish()
    await vi.advanceTimersByTimeAsync(2000)
    expect(p.engine.settled('o1')?.x).toBe(358)
    expect(requests.length).toBe(n + 1)
  })

  it('새 확정 발화는 이전 확정 발화 요청을 취소하고 미뤄 둔 획도 버린다', async () => {
    const { p, bus } = setup()
    const r = await say(p, '5와 3을 옮겨요')
    line(bus, 'k1')
    await vi.advanceTimersByTimeAsync(1500)
    const r2 = await say(p, '8과 1을 옮겨요')
    expect(r.signal.aborted).toBe(true)
    const n = requests.length
    r2.finish()
    await vi.advanceTimersByTimeAsync(2000)
    expect(requests.length).toBe(n)
  })
})

describe('어미만 따로 확정된 조각 (실측 083151)', () => {
  it('"요"만 확정되어도 앞 문장의 요청을 취소하지 않고 앞 문장에 붙인다', async () => {
    const { p } = setup()
    const r = await say(p, '5와 3을 옮겨')
    const n = requests.length
    await say(p, '요')
    expect(r.signal.aborted).toBe(false)
    expect(requests.length).toBe(n)
    expect(p.utter.at(-1)?.text).toBe('5와 3을 옮겨요')
  })
})

describe('04시 실측: 쪼개진 받아쓰기', () => {
  it('"서로 바꿔요"가 두 조각에 연달아 들어와도 3과 1을 한 번만 바꾼다 (logs 042636)', async () => {
    const { p } = setup()
    const x2 = p.engine.settled('o2')!.x, x4 = p.engine.settled('o4')!.x
    await say(p, '서로 바꿔요 3이 1보다')
    await vi.advanceTimersByTimeAsync(2000)
    expect(p.engine.settled('o2')!.x).toBe(x4)
    await say(p, '딱히니까 서로 바꿔요')
    requests.at(-1)?.text(swap('o2', 'o4') + '\n')
    requests.at(-1)?.finish()
    await vi.advanceTimersByTimeAsync(2000)
    expect(p.engine.settled('o2')!.x).toBe(x4)
    expect(p.engine.settled('o4')!.x).toBe(x2)
  })
})
