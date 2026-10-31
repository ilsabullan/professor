import { expect, it, vi } from 'vitest'

it('keeps the same access code when Vite reloads its configuration', async () => {
  const env: NodeJS.ProcessEnv = {}
  const { getDevAccessCode } = await import('./accessCode')
  const original = getDevAccessCode({}, env)
  expect(original).toMatch(/^[a-f0-9]{8}$/)
  vi.resetModules()
  const reloaded = await import('./accessCode')
  expect(reloaded.getDevAccessCode({}, env)).toBe(original)
  expect(reloaded.getDevAccessCode({}, {})).not.toBe(original)
})

it('restores the explicitly configured code and rejects invalid values', async () => {
  const { getDevAccessCode } = await import('./accessCode')
  const env = { ILSABULLAN_DEV_ACCESS_CODE: 'aaaaaaaa' }
  expect(getDevAccessCode({ ILSABULLAN_DEV_ACCESS_CODE: 'bbbbbbbb' }, env)).toBe('bbbbbbbb')
  expect(env.ILSABULLAN_DEV_ACCESS_CODE).toBe('bbbbbbbb')
  expect(() => getDevAccessCode({ ILSABULLAN_DEV_ACCESS_CODE: 'invalid' }, {})).toThrow('Invalid')
})

it('treats tunnelled loopback requests as remote so they need the access code', async () => {
  const { isDirectLocal } = await import('./accessCode')
  expect(isDirectLocal('127.0.0.1', {})).toBe(true)
  expect(isDirectLocal('::1', { host: 'localhost:5173' })).toBe(true)
  expect(isDirectLocal('127.0.0.1', { 'cf-connecting-ip': '203.0.113.7' })).toBe(false)
  expect(isDirectLocal('::ffff:127.0.0.1', { 'x-forwarded-for': '203.0.113.7' })).toBe(false)
  expect(isDirectLocal('192.168.0.10', {})).toBe(false)
})

it('accepts only the exact access code cookie', async () => {
  const { hasCodeCookie, isAccessCode } = await import('./accessCode')
  expect(isAccessCode('bd209140')).toBe(true)
  expect(isAccessCode('short')).toBe(false)
  expect(isAccessCode('')).toBe(false)
  expect(hasCodeCookie('a=1; lb_code=bd209140', 'bd209140')).toBe(true)
  expect(hasCodeCookie('lb_code=bd209141', 'bd209140')).toBe(false)
  expect(hasCodeCookie('lb_code=bd2091', 'bd209140')).toBe(false)
  expect(hasCodeCookie(undefined, 'bd209140')).toBe(false)
  expect(hasCodeCookie('lb_code=', '')).toBe(false)
})
