import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AudioLog } from './audiolog'

class Recorder {
  static instances: Recorder[] = []
  static isTypeSupported = (m: string) => m === 'audio/webm;codecs=opus'
  state = 'inactive'
  ondataavailable: ((e: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  constructor(public stream: unknown, public opts: { mimeType: string }) { Recorder.instances.push(this) }
  get mimeType() { return this.opts.mimeType }
  start = vi.fn(() => { this.state = 'recording' })
  stop = vi.fn(() => { this.state = 'inactive'; this.onstop?.() })
}
class Reader {
  result = ''
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  error = null
  readAsDataURL(b: Blob) { void b.text().then((t) => { this.result = 'data:audio/webm;base64,' + Buffer.from(t).toString('base64'); this.onload?.() }) }
}
const trackStop = vi.fn()
beforeEach(() => {
  Recorder.instances = []
  vi.stubGlobal('MediaRecorder', Recorder)
  vi.stubGlobal('FileReader', Reader)
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: trackStop }], getAudioTracks: () => [{ getSettings: () => ({ sampleRate: 48000 }) }] })) } })
})
afterEach(() => { vi.unstubAllGlobals(); trackStop.mockClear() })

const flush = () => new Promise((r) => setTimeout(r, 10))

it('마이크가 켜진 동안 녹음 조각을 순서대로 기록하고 끄면 마이크를 놓는다', async () => {
  const log = vi.fn()
  const audio = new AudioLog(log)
  audio.sync(true)
  audio.sync(true)
  await flush()
  expect(Recorder.instances).toHaveLength(1)
  const r = Recorder.instances[0]
  r.ondataavailable?.({ data: new Blob(['a']) })
  r.ondataavailable?.({ data: new Blob(['b']) })
  audio.sync(false)
  await flush()
  const types = log.mock.calls.map(([t]) => t)
  expect(types).toEqual(['audio-start', 'audio', 'audio', 'audio-stop'])
  const parts = log.mock.calls.filter(([t]) => t === 'audio').map(([, d]) => [d.rec, d.part, Buffer.from(d.audioB64, 'base64').toString(), d.t0 <= d.t1])
  expect(parts).toEqual([[1, 1, 'a', true], [1, 2, 'b', true]])
  expect(trackStop).toHaveBeenCalled()
})

it('권한을 기다리는 사이 마이크가 꺼지면 녹음을 바로 멈춘다', async () => {
  const log = vi.fn()
  const audio = new AudioLog(log)
  audio.sync(true)
  audio.sync(false)
  await flush()
  expect(Recorder.instances[0].stop).toHaveBeenCalled()
  expect(trackStop).toHaveBeenCalled()
})

it('녹음 권한이 없으면 마이크를 다시 켤 때까지 재시도하지 않는다', async () => {
  const log = vi.fn()
  const getUserMedia = vi.fn(async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }) })
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
  const audio = new AudioLog(log)
  audio.sync(true)
  await flush()
  audio.sync(true)
  audio.sync(true)
  await flush()
  expect(getUserMedia).toHaveBeenCalledTimes(1)
  expect(log).toHaveBeenCalledWith('audio-error', { reason: 'NotAllowedError' })
  audio.sync(false)
  audio.sync(true)
  await flush()
  expect(getUserMedia).toHaveBeenCalledTimes(2)
})
