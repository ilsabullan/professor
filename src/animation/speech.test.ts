import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SpeechInput } from './speech'

class Recognition {
  static instances: Recognition[] = []
  onresult: ((e: unknown) => void) | null = null
  onend: (() => void) | null = null
  onerror: ((e: { error: string }) => void) | null = null
  start = vi.fn()
  stop = vi.fn()
  constructor() { Recognition.instances.push(this) }
}
beforeEach(() => { vi.useFakeTimers(); Recognition.instances = []; vi.stubGlobal('window', { SpeechRecognition: Recognition }) })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

it('브라우저가 종료하면 재연결하고 사용자가 끄면 예약된 재연결을 취소한다', async () => {
  const diagnostic = vi.fn()
  const input = new SpeechInput({ onFinal() {}, onInterim() {}, onState() {}, onDiagnostic: diagnostic })
  input.start()
  Recognition.instances[0].onend?.()
  await vi.advanceTimersByTimeAsync(250)
  expect(Recognition.instances).toHaveLength(2)
  Recognition.instances[1].onend?.()
  input.stop()
  await vi.advanceTimersByTimeAsync(2000)
  expect(Recognition.instances).toHaveLength(2)
  expect(diagnostic).toHaveBeenCalledWith('restart', expect.objectContaining({ reason: 'end' }))
})

it('일시적 network 오류는 재시도하지만 권한 거부는 재시도하지 않는다', async () => {
  const state = vi.fn()
  const input = new SpeechInput({ onFinal() {}, onInterim() {}, onState: state })
  input.start()
  Recognition.instances[0].onerror?.({ error: 'network' })
  await vi.advanceTimersByTimeAsync(250)
  expect(Recognition.instances).toHaveLength(2)
  Recognition.instances[1].onerror?.({ error: 'not-allowed' })
  Recognition.instances[1].onend?.()
  await vi.advanceTimersByTimeAsync(2000)
  expect(Recognition.instances).toHaveLength(2)
  expect(state).toHaveBeenLastCalledWith('blocked', expect.stringContaining('not-allowed'))
})
