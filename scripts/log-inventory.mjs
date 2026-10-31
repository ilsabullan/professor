// 실측 기록(logs/*.jsonl)에서 사례로 뽑을 만한 구간을 찾는다.
// 사용: node scripts/log-inventory.mjs [logs 폴더] [--json]
//
// 세션마다 페이지 구간을 나눠 획·확정 발화·피드백(✓/✗) 수와 피드백 메모를 보여 준다.
// 이미 cases/*.json 의 source 로 쓰인 세션은 '사례 있음'으로 표시한다.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const dir = args.find((a) => !a.startsWith('--')) ?? 'logs'

const used = new Set()
if (existsSync('cases')) {
  for (const f of readdirSync('cases').filter((f) => f.endsWith('.json'))) {
    const src = JSON.parse(readFileSync(join('cases', f), 'utf8')).source
    if (src) used.add(basename(src))
  }
}

const read = (file) => [...new Map(readFileSync(file, 'utf8').trim().split('\n').flatMap((l) => {
  try { const e = JSON.parse(l); return [[e.n, e]] } catch { return [] }
})).values()].sort((a, b) => a.n - b.n)

const sessions = []
for (const f of readdirSync(dir).filter((f) => /^\d{8}-\d{6}-\w+\.jsonl$/.test(f)).sort()) {
  const lines = read(join(dir, f))
  const pages = []
  let cur = null
  for (const l of lines) {
    if (l.type === 'ink' && l.event?.type === 'page') {
      const text = (l.event.info?.text ?? '').replace(/\s+/g, ' ').slice(0, 40)
      cur = { first: l.n, last: l.n, page: l.event.info?.page, text, strokes: 0, finals: 0, ok: 0, bad: 0, notes: [] }
      pages.push(cur)
    }
    if (!cur) continue
    cur.last = l.n
    if (l.type === 'ink' && l.event?.type === 'stroke') cur.strokes++
    else if (l.type === 'final' && l.text) cur.finals++
    else if (l.type === 'feedback') {
      l.ok ? cur.ok++ : cur.bad++
      if (l.note) cur.notes.push(`${l.ok ? '✓' : '✗'}#${l.n} ${l.note}`)
    } else if (l.type === 'issue' && l.note) cur.notes.push(`🚩#${l.n} ${l.note}`)
  }
  const live = pages.filter((p) => p.strokes >= 3)
  if (live.length) sessions.push({ file: f, used: used.has(f), pages: live })
}

if (asJson) {
  console.log(JSON.stringify(sessions, null, 1))
} else {
  for (const s of sessions) {
    console.log(`\n${s.file}${s.used ? '  (사례 있음)' : ''}`)
    for (const p of s.pages) {
      console.log(`  n${p.first}-${p.last} p${p.page} 획${p.strokes} 말${p.finals} ✓${p.ok} ✗${p.bad}  ${p.text}`)
      for (const n of p.notes) console.log(`      ${n.slice(0, 100)}`)
    }
  }
}
