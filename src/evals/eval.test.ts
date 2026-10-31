import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Pipeline } from '../animation/pipeline'
import { InkBus } from '../shared/bus'
import type { InkEvent } from '../shared/ink'

/**
 * AI 동작 채점 (실제 API 호출, 돈 듦). `npm run eval` 로만 돈다.
 * 각 사례를 RUNS번 재생: 필기를 그리고(이때는 AI 끔), 읽은 값을 넣은 뒤, 말을 실측처럼
 * "말하는 중" 글자가 조금씩 들어오다 확정되는 식으로 흘려보낸다. 말마다 AI 반응이 끝나면
 * 읽은 손글씨를 왼쪽→오른쪽으로 놓은 순서를 checks 와 비교한다. 겹침이 있으면 실패.
 */

const RUNS = Number(process.env.EVAL_RUNS ?? 3)
const ONLY = process.env.EVAL_CASE

// .env 의 ANTHROPIC_API_KEY 읽기
try {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
} catch {}
globalThis.requestAnimationFrame ??= ((cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 16)) as unknown as typeof requestAnimationFrame

interface Check {
  after: number
  order: string
  note?: string
}
interface Case {
  name: string
  note: string
  read: Record<string, string>
  checks: Check[]
  speech: string[]
  events: InkEvent[]
}

const dir = join(__dirname, '../../cases')
const cases: Case[] = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
  .filter((c: Case) => c.checks?.length && typeof c.speech?.[0] === 'string' && (!ONLY || c.name === ONLY))

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 반응(요청·재생)이 다 끝날 때까지 시간을 흘린다 */
async function settle(p: Pipeline, max = 20000) {
  const start = performance.now()
  let last = start
  let idleSince = 0
  while (performance.now() - start < max) {
    await wait(16)
    const now = performance.now()
    p.tick(now, Math.min(0.05, (now - last) / 1000))
    last = now
    if (p.busy()) idleSince = 0
    else if (!idleSince) idleSince = now
    else if (now - idleSince > 400) break
  }
  // 남은 애니메이션 마무리
  for (let i = 0; i < 60; i++) p.tick(performance.now() + i * 100, 0.05)
}

function order(p: Pipeline, ids: string[]) {
  return p.board.objs
    .filter((o) => ids.includes(o.id) && o.read)
    .map((o) => ({ v: o.read!, x: p.engine.settled(o.id)!.x }))
    .sort((a, b) => a.x - b.x)
    .map((o) => o.v)
    .join(' ')
}

/** 실측처럼: 2~3글자씩 말하는 중 → 잠시 뒤 확정 */
async function speak(p: Pipeline, text: string) {
  let lastAt = performance.now()
  for (let i = 3; i < text.length; i += 3) {
    lastAt = performance.now()
    p.onInterim(text.slice(0, i), lastAt)
    await wait(180)
    p.tick(performance.now(), 0.016)
  }
  lastAt = performance.now()
  p.onInterim(text, lastAt)
  await wait(500)
  p.onFinal(text, lastAt)
}

interface Result {
  case: string
  after: number
  speech: string
  expected: string
  got: string[]
}

async function runOnce(c: Case) {
  const bus = new InkBus()
  const p = new Pipeline(bus, { headless: true })
  p.aiStatus = 'checking' // 필기 재생 동안은 AI 끔
  for (const e of c.events) bus.emit(e)
  for (const [id, v] of Object.entries(c.read)) {
    const o = p.board.get(id)
    if (o) o.read = v
  }
  await settle(p, 1000)
  p.aiStatus = 'ready'
  const got: string[] = []
  const last = Math.max(...c.checks.map((k) => k.after))
  for (let i = 0; i <= last; i++) {
    await speak(p, c.speech[i])
    await settle(p)
    const ov = p.engine.overlaps()
    got[i] = order(p, Object.keys(c.read)) + (ov.length ? ` (겹침 ${ov.map((x) => x.join('·')).join(',')})` : '')
  }
  return got
}

describe.skipIf(!process.env.EVAL)('AI 동작 채점', () => {
  it(
    `사례 ${cases.length}개 × ${RUNS}번`,
    async () => {
      const results: Result[] = []
      await Promise.all(
        cases.map(async (c) => {
          const runs = await Promise.all(Array.from({ length: RUNS }, () => runOnce(c)))
          for (const k of c.checks) {
            results.push({ case: c.name, after: k.after, speech: c.speech[k.after], expected: k.order, got: runs.map((r) => r[k.after]) })
          }
        }),
      )
      const ok = (r: Result, g: string) => r.expected.split('|').map((s) => s.trim()).includes(g)
      let pass = 0
      let total = 0
      const lines: string[] = []
      for (const c of cases) {
        const rs = results.filter((r) => r.case === c.name).sort((a, b) => a.after - b.after)
        const cp = rs.reduce((n, r) => n + r.got.filter((g) => ok(r, g)).length, 0)
        const ct = rs.reduce((n, r) => n + r.got.length, 0)
        pass += cp
        total += ct
        lines.push(`\n## ${c.name}  ${cp}/${ct} (${Math.round((100 * cp) / ct)}%)`)
        for (const r of rs) {
          const marks = r.got.map((g) => (ok(r, g) ? '✓' : '✗')).join('')
          const bad = r.got.filter((g) => !ok(r, g))
          lines.push(`[${r.after}] ${marks} 기대 ${r.expected}${bad.length ? ` / 실제 ${[...new Set(bad)].join(', ')}` : ''}  — ${r.speech.slice(0, 40)}`)
        }
      }
      const head = `# AI 동작 채점: 전체 ${pass}/${total} (${Math.round((100 * pass) / total)}%)`
      const report = [head, ...lines].join('\n')
      console.log('\n' + report)
      mkdirSync('logs', { recursive: true })
      writeFileSync(`logs/eval-${new Date().toISOString().replace(/[:.]/g, '-')}.md`, report + '\n')
      expect(total).toBeGreaterThan(0)
    },
    30 * 60 * 1000,
  )
})
