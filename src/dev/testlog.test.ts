import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetModules(); vi.useRealTimers() })

describe('acknowledged log transport', () => {
  it('keeps an immutable snapshot through HTTP failure and retries it', async () => {
    const logger = await import('./testlog')
    const nested = { values: [1], thr: 0.35, conf: 0.85 }
    logger.logEntry('request', { nested })
    nested.values.push(2)
    const fetcher = vi.fn().mockResolvedValueOnce({ ok: false, status: 503 }).mockResolvedValueOnce({ ok: true, json: async () => ({ ack: [1] }) })
    vi.stubGlobal('fetch', fetcher)
    expect(await logger.flush()).toBe(false)
    expect(logger.getLogStatus()).toMatchObject({ pending: 1, error: true, savedThrough: 0 })
    expect(await logger.flush()).toBe(true)
    expect(fetcher.mock.calls[1][1].body).toBe(fetcher.mock.calls[0][1].body)
    expect(JSON.parse(fetcher.mock.calls[1][1].body).entries[0].nested).toEqual({ values: [1], thr: 0.35, conf: 0.85 })
    expect(logger.getLogStatus()).toMatchObject({ pending: 0, error: false, savedThrough: 1 })
  })

  it('serializes overlapping flushes and retains newly queued entries until acknowledged', async () => {
    const logger = await import('./testlog')
    let finish!: (value: unknown) => void
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { finish = resolve })).mockResolvedValue({ ok: true, json: async () => ({ ack: [2] }) })
    vi.stubGlobal('fetch', fetcher)
    logger.logEntry('one', {})
    const first = logger.flush()
    logger.logEntry('two', {})
    const second = logger.flush()
    expect(fetcher).toHaveBeenCalledTimes(1)
    finish({ ok: true, json: async () => ({ ack: [1] }) })
    expect(await first).toBe(true)
    expect(await second).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(logger.getLogStatus().savedThrough).toBe(2)
  })

  it('aborts a stalled request and leaves the entry available for retry', async () => {
    vi.useFakeTimers()
    const logger = await import('./testlog')
    logger.logEntry('one', {})
    vi.stubGlobal('fetch', vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')))
    })))
    const pending = logger.flush()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await pending).toBe(false)
    expect(logger.getLogStatus()).toMatchObject({ pending: 1, saving: false, error: true })
  })

  it('requires explicit acknowledgments and never treats beacon acceptance as saved', async () => {
    const logger = await import('./testlog')
    logger.logEntry('one', {})
    vi.stubGlobal('navigator', { sendBeacon: vi.fn(() => true) })
    expect(await logger.flush(true)).toBe(false)
    expect(logger.getLogStatus().pending).toBe(1)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ack: [] }) }))
    expect(await logger.flush()).toBe(false)
    expect(logger.getLogStatus()).toMatchObject({ pending: 1, error: true })
  })
})

it('retains records on remote authentication failure and clears the error after authentication', async () => {
  const logger = await import('./testlog')
  logger.logEntry('submit', {})
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce({ ok: false, status: 403 })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ ack: [1] }) }))
  expect(await logger.flush()).toBe(false)
  expect(logger.getLogStatus()).toMatchObject({ pending: 1, savedThrough: 0 })
  expect(logger.getLogStatus().errorMessage).toContain('원격 접속 인증 만료')
  expect(await logger.flush()).toBe(true)
  expect(logger.getLogStatus()).toMatchObject({ pending: 0, error: false, errorMessage: '' })
})

it('distinguishes an old server response from a network or authentication failure', async () => {
  const logger = await import('./testlog')
  logger.logEntry('submit', {})
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => { throw new SyntaxError('Unexpected token o') } }))
  expect(await logger.flush()).toBe(false)
  expect(logger.getLogStatus()).toMatchObject({ pending: 1 })
  expect(logger.getLogStatus().errorMessage).toContain('서버 응답 형식 불일치')
})
