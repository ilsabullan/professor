// 📤 보내기가 들어오면 한 줄씩 알린다 (Claude가 모니터로 걸어두고 깨어나는 데 쓴다).
// 사용: node scripts/watch-submit.mjs   (logs/*.jsonl 의 "type":"submit" 새 줄을 감시)
import { readdirSync, readFileSync } from 'node:fs'

const seen = new Set()
const scan = (announce) => {
  let files = []
  try {
    files = readdirSync('logs').filter((f) => f.endsWith('.jsonl') && !f.startsWith('eval'))
  } catch {
    return
  }
  for (const f of files) {
    let text = ''
    try {
      text = readFileSync(`logs/${f}`, 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (!line.includes('"type":"submit"')) continue
      try {
        const e = JSON.parse(line)
        const key = `${f}#${e.n}`
        if (seen.has(key)) continue
        seen.add(key)
        if (announce) console.log(`SUBMIT logs/${f} ${e.note ?? ''}`)
      } catch {}
    }
  }
}
scan(false) // 이미 있던 보내기는 무시
setInterval(() => scan(true), 3000)
