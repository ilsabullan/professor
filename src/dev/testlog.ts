/**
 * 테스트 기록 (개발용). 이벤트를 모아 1초마다 개발 서버로 보내면 logs/<세션>.jsonl 에 쌓인다.
 * 이미지(imageB64)는 서버가 logs/<세션>/ 아래 파일로 따로 저장한다.
 */

const pad = (n: number) => String(n).padStart(2, '0')
const d = new Date()
export const logSession = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${Math.random().toString(36).slice(2, 6)}`

let queue: Record<string, unknown>[] = []
let seq = 0

export function logEntry(type: string, data: Record<string, unknown>) {
  queue.push({ n: ++seq, type, t: performance.now(), wall: new Date().toISOString(), ...data })
}

/** 소수는 한 자리로 줄여 파일 크기를 줄인다 */
const round = (_k: string, v: unknown) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 10) / 10 : v)

export function flush(beacon = false) {
  if (!queue.length) return
  const body = JSON.stringify({ session: logSession, entries: queue }, round)
  queue = []
  if (beacon) navigator.sendBeacon('/api/log', new Blob([body], { type: 'application/json' }))
  else void fetch('/api/log', { method: 'POST', headers: { 'content-type': 'application/json' }, body }).catch(() => {})
}

export function startTestLog() {
  logEntry('session', { userAgent: navigator.userAgent, screen: [window.innerWidth, window.innerHeight, window.devicePixelRatio] })
  setInterval(() => flush(), 1000)
  window.addEventListener('pagehide', () => flush(true))
}
