/** 개발용 실측 기록. 서버 저장 확인을 받을 때까지 원본 스냅샷을 보관한다. */
const pad = (n: number) => String(n).padStart(2, '0')
const d = new Date()
export const logSession = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${Math.random().toString(36).slice(2, 6)}`
const queue: { n: number; json: string; bytes: number }[] = []
let seq = 0
let running: Promise<boolean> | undefined
let started = false
let status = { pending: 0, saving: false, error: false, errorMessage: '', savedThrough: 0 }
const listeners = new Set<() => void>()
export const subscribeLogStatus = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
export const getLogStatus = () => status
function update(patch: Partial<typeof status>) {
  status = { ...status, ...patch, pending: queue.length }
  listeners.forEach((listener) => listener())
}
export function logEntry(type: string, data: Record<string, unknown>) {
  const n = seq + 1
  // 직렬화 시점에 복사해 후속 상태 변경이 재전송 내용을 바꾸지 않게 한다.
  const json = JSON.stringify({ ...data, n, type, t: performance.now(), wall: new Date().toISOString() })
  seq = n
  queue.push({ n, json, bytes: new TextEncoder().encode(json).length })
  update({})
  return n
}
export const getLogSequence = () => seq
function batch(limit: number) {
  let bytes = 128
  const entries: typeof queue = []
  for (const entry of queue) {
    if (bytes + entry.bytes > limit && entries.length) break
    if (bytes + entry.bytes > limit && limit < 1e6) break
    entries.push(entry)
    bytes += entry.bytes + 1
  }
  return entries
}
const bodyFor = (entries: typeof queue) => `{"session":${JSON.stringify(logSession)},"entries":[${entries.map((e) => e.json).join(',')}]}`
/** true는 호출 당시까지의 모든 기록이 서버에서 확인됐다는 뜻이다. */
export async function flush(beacon = false): Promise<boolean> {
  const target = seq
  if (beacon) {
    const entries = batch(48_000)
    // Beacon 접수는 저장 확인이 아니다. 큐에 남겨 다음 fetch에서 재확인한다.
    if (entries.length) {
      try {
        if (!navigator.sendBeacon('/api/log', new Blob([bodyFor(entries)], { type: 'application/json' }))) update({ error: true })
      } catch { update({ error: true }) }
    }
    return status.savedThrough >= target
  }
  if (running) {
    if (!await running) return false
    return status.savedThrough >= target || flush()
  }
  if (!queue.length) return true
  update({ saving: true })
  running = (async () => {
    try {
      while (queue.length && status.savedThrough < target) {
        const entries = batch(5_000_000)
        if (entries[0].bytes > 19_000_000) throw new Error('log entry exceeds server limit')
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 10_000)
        try {
          const res = await fetch('/api/log', { method: 'POST', headers: { 'content-type': 'application/json' }, body: bodyFor(entries), signal: controller.signal })
          if (res.status === 403) throw new Error('원격 접속 인증 만료 · 같은 브라우저의 새 탭에서 최신 접속 주소로 인증하세요')
          if (!res.ok) throw new Error(`저장 서버 HTTP ${res.status}`)
          let result: { ack?: number[] }
          try { result = await res.json() } catch { throw new Error('저장 서버 응답 형식 불일치 · 서버 버전을 확인하세요') }
          const acknowledged = new Set(result.ack)
          if (!Array.isArray(result.ack) || entries.some((e) => !acknowledged.has(e.n))) throw new Error('서버의 저장 확인 누락')
          queue.splice(0, entries.length)
          update({ savedThrough: entries[entries.length - 1].n, error: false, errorMessage: '' })
        } finally { clearTimeout(timer) }
      }
      return true
    } catch (err) {
      update({ error: true, errorMessage: err instanceof Error ? (err.name === 'AbortError' ? '저장 응답 시간 초과' : err.message) : '저장 서버 연결 실패' })
      return false
    } finally { update({ saving: false }) }
  })()
  try { return await running } finally { running = undefined }
}
export function startTestLog() {
  if (started) return
  started = true
  logEntry('session', { userAgent: navigator.userAgent, screen: [window.innerWidth, window.innerHeight, window.devicePixelRatio] })
  setInterval(() => { void flush() }, 1000)
  window.addEventListener('pagehide', () => { void flush(true) })
  window.addEventListener('online', () => { void flush() })
}
