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

it('오래 듣다가 끝난 세션(침묵·network)은 실패로 세지 않아 계속 다시 연결한다', async () => {
  const state = vi.fn()
  const input = new SpeechInput({ onFinal() {}, onInterim() {}, onState: state })
  input.start()
  // 실측(Edge): 50초쯤 듣다가 network 오류로 끊김. 침묵이 길면 브라우저가 계속 세션을 끝낸다
  for (let i = 0; i < 12; i++) {
    await vi.advanceTimersByTimeAsync(8000)
    const rec = Recognition.instances.at(-1)!
    if (i % 3 === 0) rec.onerror?.({ error: 'network' })
    else { rec.onerror?.({ error: 'no-speech' }); rec.onend?.() }
    await vi.advanceTimersByTimeAsync(100)
  }
  expect(Recognition.instances).toHaveLength(13)
  expect(state).not.toHaveBeenCalledWith('blocked', expect.anything())
  input.stop()
})

it('시작 직후 끝나는 일이 연달아 반복되면 멈춘다', async () => {
  const state = vi.fn()
  const input = new SpeechInput({ onFinal() {}, onInterim() {}, onState: state })
  input.start()
  for (let i = 0; i < 10; i++) {
    Recognition.instances.at(-1)!.onend?.()
    await vi.runOnlyPendingTimersAsync()
  }
  expect(Recognition.instances).toHaveLength(6)
  expect(state).toHaveBeenLastCalledWith('blocked', expect.stringContaining('재연결'))
})

it('확정 결과의 대안 후보를 진단 기록으로 남긴다', () => {
  const diagnostic = vi.fn()
  const finals: string[] = []
  const input = new SpeechInput({ onFinal: (t) => finals.push(t), onInterim() {}, onState() {}, onDiagnostic: diagnostic })
  input.start()
  const result = Object.assign([{ transcript: '오랑 삼', confidence: 0.61 }, { transcript: '5랑 3', confidence: 0.3 }], { isFinal: true })
  Recognition.instances[0].onresult?.({ resultIndex: 0, results: [result] })
  expect(finals).toEqual(['오랑 삼'])
  expect(diagnostic).toHaveBeenCalledWith('alternatives', { alts: [{ text: '오랑 삼', conf: 0.61 }, { text: '5랑 3', conf: 0.3 }] })
})
