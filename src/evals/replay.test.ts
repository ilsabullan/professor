import { afterEach, expect, it, vi } from 'vitest'
import { InkBus } from '../shared/bus'
import type { Pipeline } from '../animation/pipeline'
import { replayInputs } from './replay'

afterEach(() => vi.useRealTimers())
it('서버 도착 순서가 뒤집혀도 원래 입력 순서와 중간 음성 수정, 시간 간격을 보존한다', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'performance'] })
  const p = { onFinal: vi.fn(), onInterim: vi.fn() } as unknown as Pipeline
  const bus = new InkBus()
  await replayInputs(p, bus, [
    { n: 1, at: 0, type: 'interim', text: '팔' },
    { n: 3, at: 500, type: 'final', text: '오랑 삼' },
    { n: 2, at: 200, type: 'interim', text: '오랑 삼' },
  ], async (ms) => { await vi.advanceTimersByTimeAsync(ms) })
  expect(p.onInterim).toHaveBeenNthCalledWith(1, '팔', 0)
  expect(p.onInterim).toHaveBeenNthCalledWith(2, '오랑 삼', 200)
  expect(p.onFinal).toHaveBeenCalledWith('오랑 삼', 200)
  expect(performance.now()).toBe(500)
})
