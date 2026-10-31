import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InkBus } from '../shared/bus'
import { streamSteps } from './ai/client'
import type { ReqRecord } from './metrics'
import { Pipeline } from './pipeline'
import { snapshotB64 } from './snapshot'

vi.mock('./ai/client', async (original) => ({
  ...await original<typeof import('./ai/client')>(),
  streamSteps: vi.fn(),
  prewarm: vi.fn(),
}))
vi.mock('./snapshot', () => ({ snapshotB64: vi.fn(() => 'image') }))

const result = { model: 'actual-model-version', cacheRead: 10, inputTokens: 20, outputTokens: 30 }
const response = '{"conf":0.8,"ops":[{"v":"pulse","id":"o1"}],"cap":"강조"}\n'
type Event = { type: string; rec?: ReqRecord; reason?: string; [key: string]: unknown }

function setup() {
  const p = new Pipeline(new InkBus(), { headless: true })
  const events: Event[] = []
  p.log = (type, data) => events.push(structuredClone({ type, ...data }))
  p.utter.push({ text: '강조', t: 0 })
  p.board.objs.push({ id: 'o1', kind: 'mark', strokes: [], bbox: { x: 0, y: 0, w: 20, h: 20 }, t: 0 })
  const run = () => (p as unknown as { run: (trigger: { kind: string; desc: string; t: number }) => Promise<void> }).run({ kind: '말', desc: '강조', t: 1 })
  return { p, events, run }
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', vi.fn())
  vi.mocked(streamSteps).mockReset()
  vi.mocked(snapshotB64).mockReset().mockReturnValue('image')
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('request lifecycle logging', () => {
  it('logs initial settings and captures the settings and actual model used by a completed request', async () => {
    const { p, events, run } = setup()
    expect(events[0]).toMatchObject({ type: 'settings', initial: true, settings: { image: 'off', thr: 0.3 } })
    vi.mocked(streamSteps).mockImplementation(async (options, _content, _signal, onText) => {
      expect(options).toEqual({ model: 'claude-haiku-5-5', thinking: 'off' })
      p.update({ thr: 0.95, quick: false })
      onText(response)
      return result
    })
    await run()
    const rec = p.reqs[0]
    expect(rec).toMatchObject({ status: '재생', settings: { thr: 0.3, quick: true }, model: result.model })
    expect(rec.tEnd).toBe(rec.tDone)
    expect(rec.cfg).toContain('즉시켬/확신0.3')
    expect(events.find((e) => e.type === 'request-start')?.rec).toMatchObject({ status: '진행 중', settings: { thr: 0.3 } })
    expect(events.filter((e) => e.type === 'request')).toHaveLength(1)
    expect(events.find((e) => e.type === 'request')).toMatchObject({ prompt: expect.any(String), raw: response, rec: { status: '재생' } })
  })

  it('persists first playback after completion without rewriting the completion event', async () => {
    const { p, events, run } = setup()
    const tick = vi.spyOn(p.player, 'tick').mockImplementation(() => {})
    vi.mocked(streamSteps).mockImplementation(async (_options, _content, _signal, onText) => { onText(response); return result })
    await run()
    expect(events.find((e) => e.type === 'request')?.rec?.tFirstOp).toBeUndefined()
    tick.mockRestore()
    p.tick(performance.now() + 100, 0.016)
    expect(events.at(-2)).toMatchObject({ type: 'applied' })
    expect(events.find((e) => e.reason === 'first-op')?.rec?.tFirstOp).toBeTypeOf('number')
    expect(events.find((e) => e.type === 'request')?.rec?.tFirstOp).toBeUndefined()
  })

  it('persists abort immediately and keeps its timestamp/status when a late success arrives', async () => {
    const { p, events, run } = setup()
    let finish!: (value: typeof result) => void
    vi.mocked(streamSteps).mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const pending = run()
    p.resetAnimation()
    const aborted = events.find((e) => e.reason === 'abort')?.rec
    expect(aborted).toMatchObject({ status: '중단(초기화)', tEnd: expect.any(Number) })
    expect(events.some((e) => e.type === 'request')).toBe(false)
    finish(result)
    await pending
    expect(p.reqs[0]).toMatchObject({ status: aborted?.status, tEnd: aborted?.tEnd })
    expect(p.reqs[0].tDone).toBeUndefined()
    expect(events.find((e) => e.type === 'request')?.rec).toMatchObject({ status: aborted?.status, tEnd: aborted?.tEnd })
  })

  it('records preparation failures and stream failures as terminated requests', async () => {
    const { p, events, run } = setup()
    p.update({ image: 'on' })
    vi.mocked(snapshotB64).mockImplementationOnce(() => { throw new Error('snapshot failed') })
    await run()
    expect(streamSteps).not.toHaveBeenCalled()
    expect(events.find((e) => e.type === 'request')?.rec).toMatchObject({ status: '오류: snapshot failed', tEnd: expect.any(Number) })
    p.update({ image: 'off' })
    vi.mocked(streamSteps).mockRejectedValueOnce(new Error('stream failed'))
    await run()
    expect(p.reqs[1]).toMatchObject({ status: '오류: stream failed', tEnd: expect.any(Number) })
    expect(p.reqs[1].tDone).toBeUndefined()
  })

  it('persists playback rejection that happens after the stream completes', async () => {
    const { p, events, run } = setup()
    const tick = vi.spyOn(p.player, 'tick').mockImplementation(() => {})
    vi.mocked(streamSteps).mockImplementation(async (_options, _content, _signal, onText) => { onText(response); return result })
    await run()
    p.player.queue[0].validate = () => 'changed layout'
    tick.mockRestore()
    p.tick(performance.now() + 100, 0.016)
    expect(events.find((e) => e.reason === 'rejected')?.rec).toMatchObject({ status: '보류: changed layout', rejected: 1 })
  })
})
