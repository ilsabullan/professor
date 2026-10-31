import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 녹음 형식 → 확장자. 목록에 없는 형식은 저장하지 않는다 */
const AUDIO_EXT: Record<string, string> = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a' }
const audioExt = (mime: unknown) => AUDIO_EXT[String(mime ?? '').split(';')[0]]

/** 재전송과 페이지 종료 시 중복 전송을 디스크에 저장된 번호로 제거한다. */
export function createLogStore(dir: string) {
  const sessions = new Map<string, Set<number>>()
  return (payload: unknown) => {
    const { session, entries } = payload as { session?: unknown; entries?: unknown }
    if (typeof session !== 'string' || !/^[\w-]{6,64}$/.test(session) || !Array.isArray(entries) || !entries.length || entries.length > 10000) throw new Error('bad payload')
    for (const e of entries) {
      if (!e || typeof e !== 'object' || !Number.isSafeInteger(e.n) || e.n < 1 || typeof e.type !== 'string') throw new Error('bad entry')
      if (typeof e.audioB64 === 'string' && (!audioExt(e.mime) || !Number.isSafeInteger(e.rec) || e.rec < 1)) throw new Error('bad audio entry')
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
        if (typeof e.audioB64 === 'string') {
          // 한 마이크 세션의 조각을 순서대로 이어 붙이면 그대로 재생 가능한 파일이 된다
          const name = `audio-${e.rec}.${audioExt(e.mime)}`
          const data = Buffer.from(e.audioB64, 'base64')
          appendFileSync(join(dir, session, name), data)
          delete e.audioB64
          e.audioFile = `logs/${session}/${name}`
          e.bytes = data.length
        }
        appendFileSync(file, JSON.stringify(e) + '\n')
        seen.add(e.n)
      }
      ack.push(entry.n)
    }
    return { ack }
  }
}
