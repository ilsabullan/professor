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
