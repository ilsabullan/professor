import { randomBytes } from 'node:crypto'

/** 설정 자동 재시작에는 코드를 유지한다. 로컬 환경에 지정한 코드가 있으면 우선한다. */
export function getDevAccessCode(config: Record<string, string | undefined> = {}, env: NodeJS.ProcessEnv = process.env): string {
  const configured = config.ILSABULLAN_DEV_ACCESS_CODE
  if (configured && !/^[a-f0-9]{8,64}$/.test(configured)) throw new Error('Invalid ILSABULLAN_DEV_ACCESS_CODE')
  return env.ILSABULLAN_DEV_ACCESS_CODE = configured || env.ILSABULLAN_DEV_ACCESS_CODE || randomBytes(4).toString('hex')
}
