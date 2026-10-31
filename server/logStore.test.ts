import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createLogStore } from './logStore'

describe('log storage', () => {
  it('deduplicates retries and beacon overlap, including after a server restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ilsabullan-log-test-'))
    const store = createLogStore(dir)
    const entry = { n: 1, type: '../../escape', imageB64: Buffer.from('image').toString('base64') }
    const payload = { session: 'session-test', entries: [entry] }
    expect(store(payload)).toEqual({ ack: [1] })
    expect(store(payload)).toEqual({ ack: [1] })
    expect(createLogStore(dir)({ ...payload, entries: [entry, { n: 2, type: 'submit' }] })).toEqual({ ack: [1, 2] })
    const lines = readFileSync(join(dir, 'session-test.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(lines.map((line) => line.n)).toEqual([1, 2])
    expect(lines[0].imageFile).toBe('logs/session-test/image-1.jpg')
    expect(readFileSync(join(dir, 'session-test/image-1.jpg'), 'utf8')).toBe('image')
    expect(entry.imageB64).toBeDefined()
  })

  it('validates all entries before persisting a batch', () => {
    const store = createLogStore(mkdtempSync(join(tmpdir(), 'ilsabullan-log-test-')))
    expect(() => store({ session: '../escape', entries: [{ n: 1, type: 'test' }] })).toThrow()
    expect(() => store({ session: 'session-test', entries: [{ n: 1, type: 'test' }, { n: 0, type: 'test' }] })).toThrow()
  })
})

describe('audio storage', () => {
  it('appends audio parts of one recording into a single file once, even when retried', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ilsabullan-log-test-'))
    const store = createLogStore(dir)
    const part = (n: number, text: string) => ({ n, type: 'audio', rec: 1, part: n, mime: 'audio/webm;codecs=opus', t0: n * 1000, t1: n * 1000 + 1000, audioB64: Buffer.from(text).toString('base64') })
    store({ session: 'session-audio', entries: [part(1, 'head')] })
    store({ session: 'session-audio', entries: [part(1, 'head'), part(2, '-tail')] })
    expect(readFileSync(join(dir, 'session-audio/audio-1.webm'), 'utf8')).toBe('head-tail')
    const lines = readFileSync(join(dir, 'session-audio.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(lines.map((l) => [l.audioFile, l.bytes, l.t0, l.audioB64])).toEqual([['logs/session-audio/audio-1.webm', 4, 1000, undefined], ['logs/session-audio/audio-1.webm', 5, 2000, undefined]])
  })

  it('rejects unknown audio formats without writing', () => {
    const store = createLogStore(mkdtempSync(join(tmpdir(), 'ilsabullan-log-test-')))
    expect(() => store({ session: 'session-audio', entries: [{ n: 1, type: 'audio', rec: 1, mime: 'text/html', audioB64: 'eA==' }] })).toThrow()
  })
})
