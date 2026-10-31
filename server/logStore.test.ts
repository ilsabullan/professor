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
