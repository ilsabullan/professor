// 테스트 기록(logs/*.jsonl)을 사례(cases/<이름>.json)로 뽑는다.
// 사용: node scripts/extract-case.mjs logs/<세션>.jsonl <사례 이름> "<무엇이 문제였나>"
//
// 사례에는 필기 이벤트, 확정된 말 목록, AI가 읽은 손글씨 값이 들어간다.
// 화면에 "말 → AI 반응 → ✓/✗" 타임라인을 출력하니, 보고 cases/<이름>.json 의 checks 를 채운다.
//   checks: [{ "after": <말 번호>, "order": "3 5 8 1" | "3 5 8 1|3 5 1 8", "note": "..." }]
//   (order = 읽은 손글씨 값을 왼쪽→오른쪽으로 놓은 순서. | 로 허용 답을 여러 개)
// 필기 해석 기대(expect: marks, boxes, underlines, arrows)는 npm test 가, checks 는 npm run eval 이 확인한다.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const [log, name, note = '', firstN = '0', lastN = 'Infinity'] = process.argv.slice(2)
if (!log || !name) {
  console.error('사용: node scripts/extract-case.mjs logs/<세션>.jsonl <사례 이름> "<설명>"')
  process.exit(1)
}
if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error('사례 이름은 영문 소문자/숫자/하이픈만 허용')
// 예전 로그의 동시 flush는 도착 순서가 뒤집힐 수 있다. 원래 이벤트 번호로 복원한다.
const all = [...new Map(readFileSync(log, 'utf8').trim().split('\n').map((l) => {
  const e = JSON.parse(l)
  return [e.n, e]
})).values()].sort((a, b) => a.n - b.n)
const lines = all.filter((l) => l.n >= Number(firstN) && l.n <= Number(lastN))
if (!lines.length || !lines.some((l) => l.type === 'ink' && l.event.type === 'page')) throw new Error('범위에 페이지 시작 이벤트가 필요합니다')
const t0 = lines[0].t
// 실제 interim 수정, 필기/말 중첩과 시간 간격을 보존한다. speech 배열은 이전 평가와의 호환용.
const inputs = lines.filter((l) => ['ink', 'interim', 'final'].includes(l.type)).map((l) => ({
  n: l.n, at: l.t - t0, type: l.type,
  ...(l.event ? { event: l.event } : { text: l.text }),
}))
const failures = lines.filter((l) => l.type === 'feedback' || l.type === 'issue').map((l) => {
  const req = lines.find((r) => r.type === 'request' && r.rec?.id === l.reqId)
  return { n: l.n, at: l.t - t0, note: l.note, ok: l.ok, reqId: l.reqId,
    ...(req ? { request: { kind: req.rec.kind, desc: req.rec.desc, raw: req.raw } } : {}) }
})
const events = lines.filter((l) => l.type === 'ink').map((l) => l.event)
const speech = lines.filter((l) => l.type === 'final' && l.text).map((l) => l.text)

// AI가 읽은 손글씨 값: 상태 기록의 read 필드 + 응답 원문의 "read":{...}
const read = {}
for (const l of lines) {
  for (const o of l.objs ?? []) if (o.read) read[o.id] ??= o.read
  if (l.type === 'request' && l.raw) {
    for (const m of l.raw.matchAll(/"read"\s*:\s*(\{[^}]*\})/g)) {
      try {
        for (const [k, v] of Object.entries(JSON.parse(m[1]))) read[k] ??= String(v)
      } catch {}
    }
  }
}

// 타임라인: 확정된 말(번호), 재생된 AI 반응, ✓/✗, 🚩
let i = -1
const timeline = []
for (const l of lines) {
  if (l.type === 'final' && l.text) timeline.push(`[${++i}] 말: ${l.text}`)
  else if (l.type === 'request' && l.rec?.status === '재생') timeline.push(`     AI(${l.rec.kind}): ${l.rec.cap} | ${(l.raw ?? '').replace(/\n/g, ' / ').slice(0, 160)}`)
  else if (l.type === 'feedback') timeline.push(`     ${l.ok ? '✓' : '✗'} ${l.cap}${l.note ? ' — ' + l.note : ''}`)
  else if (l.type === 'issue') timeline.push(`     🚩 ${l.note}`)
  else if (l.type === 'submit') timeline.push(`     📤 보내기 ${l.note ?? ''}`)
}

const file = `cases/${name}.json`
const prev = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
// AI가 읽은 값은 정답이 아니다. 새 사례의 read는 검토 후 수동으로 붙인다.
const out = { name, note: note || prev.note || '', source: log, sourceRange: [lines[0].n, lines.at(-1).n],
  expect: prev.expect ?? {}, read: prev.read ?? {}, observedRead: read, checks: prev.checks ?? [],
  speech, events, inputs, failures }
writeFileSync(file, JSON.stringify(out) + '\n')
console.log(`${file}: 필기 이벤트 ${events.length}개, 말 ${speech.length}개, 읽은 값 ${JSON.stringify(read)}\n`)
console.log(timeline.join('\n'))
