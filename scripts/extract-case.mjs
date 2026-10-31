// 테스트 기록(logs/*.jsonl)에서 필기 이벤트만 뽑아 버그 사례(cases/<이름>.json)로 저장한다.
// 사용: node scripts/extract-case.mjs logs/<세션>.jsonl <사례 이름> "<무엇이 문제였나>"
// 저장 뒤 cases/<이름>.json 의 "expect"를 채우면 npm test 가 매번 재생해 확인한다.
import { readFileSync, writeFileSync } from 'node:fs'

const [log, name, note = ''] = process.argv.slice(2)
if (!log || !name) {
  console.error('사용: node scripts/extract-case.mjs logs/<세션>.jsonl <사례 이름> "<설명>"')
  process.exit(1)
}
const lines = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
const events = lines.filter((l) => l.type === 'ink').map((l) => l.event)
const speech = lines.filter((l) => l.type === 'final' && l.text).map((l) => ({ t: l.t, text: l.text }))
const out = { name, note, source: log, expect: {}, speech, events }
writeFileSync(`cases/${name}.json`, JSON.stringify(out, null, 0) + '\n')
console.log(`cases/${name}.json: 필기 이벤트 ${events.length}개, 말 ${speech.length}개`)
