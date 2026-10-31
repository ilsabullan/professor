import { randomBytes, timingSafeEqual } from 'node:crypto'

/** 설정 자동 재시작에는 코드를 유지한다. 로컬 환경에 지정한 코드가 있으면 우선한다. */
export function getDevAccessCode(config: Record<string, string | undefined> = {}, env: NodeJS.ProcessEnv = process.env): string {
  const configured = config.ILSABULLAN_DEV_ACCESS_CODE
  if (configured && !/^[a-f0-9]{8,64}$/.test(configured)) throw new Error('Invalid ILSABULLAN_DEV_ACCESS_CODE')
  return env.ILSABULLAN_DEV_ACCESS_CODE = configured || env.ILSABULLAN_DEV_ACCESS_CODE || randomBytes(4).toString('hex')
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const PROXY_HEADERS = ['x-forwarded-for', 'cf-connecting-ip', 'forwarded', 'x-real-ip']

/**
 * 이 Mac에서 직접 연 요청인가. 터널(cloudflared 등)이나 프록시를 거친 요청은 연결이 127.0.0.1에서
 * 오더라도 외부 요청이므로 접속 코드가 필요하다.
 */
export function isDirectLocal(remoteAddress: string | undefined, headers: Record<string, string | string[] | undefined>): boolean {
  return LOOPBACK.has(remoteAddress ?? '') && !PROXY_HEADERS.some((h) => headers[h] != null)
}

/** 접속 코드 형식: 16진수 8~64자 */
export function isAccessCode(code: string | undefined): code is string {
  return !!code && /^[a-f0-9]{8,64}$/.test(code)
}

/** 쿠키에 같은 접속 코드가 있는가 (길이가 같을 때 시간 차이 없이 비교) */
export function hasCodeCookie(cookie: string | undefined, code: string): boolean {
  const got = /(?:^|;\s*)lb_code=([^;]+)/.exec(cookie ?? '')?.[1]
  if (!got || !code || got.length !== code.length) return false
  return timingSafeEqual(Buffer.from(got), Buffer.from(code))
}
