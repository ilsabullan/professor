import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 재전송과 페이지 종료 시 중복 전송을 디스크에 저장된 번호로 제거한다. */
export function createLogStore(dir: string) {
  const sessions = new Map<string, Set<number>>()
  return (payload: unknown) => {
    const { session, entries } = payload as { session?: unknown; entries?: unknown }
    if (typeof session !== 'string' || !/^[\w-]{6,64}$/.test(session) || !Array.isArray(entries) || !entries.length || entries.length > 10000) throw new Error('bad payload')
    for (const e of entries) {
      if (!e || typeof e !== 'object' || !Number.isSafeInteger(e.n) || e.n < 1 || typeof e.type !== 'string') throw new Error('bad entry')
    }
    const file = join(dir, `${session}.jsonl`)
    let seen = sessions.get(session)
    if (!seen) {
      seen = new Set<number>()
      if (existsSync(file)) for (const line of readFileSync(file, 'utf8').split('\n').filter(Boolean)) seen.add(JSON.parse(line).n)
      sessions.set(session, seen)
    }
    mkdirSync(join(dir, session), { recursive: true })
    const ack: number[] = []
    for (const entry of entries) {
      if (!seen.has(entry.n)) {
        const e = { ...entry }
        if (typeof e.imageB64 === 'string') {
          const name = `image-${e.n}.jpg`
          writeFileSync(join(dir, session, name), Buffer.from(e.imageB64, 'base64'))
          delete e.imageB64
          e.imageFile = `logs/${session}/${name}`
        }
        appendFileSync(file, JSON.stringify(e) + '\n')
        seen.add(e.n)
      }
      ack.push(entry.n)
    }
    return { ack }
  }
}
