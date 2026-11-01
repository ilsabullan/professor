import { readFileSync } from 'node:fs'
import { it } from 'vitest'
import { Board } from './board'
import { Engine } from './engine'
import { parseScene } from './scene'
import { groundSpeech, keepGrounded, planNumericSort, planNumericSwap, planRestore, rejectUngrounded } from './grounding'
import { sanitizeOp, type Op } from './ops'

const S = process.env.PROBE_FILE!
const FROM = Number(process.env.PROBE_FROM ?? 0)
const UPTO = Number(process.env.PROBE_UPTO ?? 1e9)
const MODE = process.env.PROBE_MODE ?? 'sim' // sim: apply current local plans; real: apply logged applied moves
it('probe', () => {
  const all = [...new Map(readFileSync(S, 'utf8').trim().split('\n').map((l) => { const e = JSON.parse(l); return [e.n, e] })).values()].sort((a: any, b: any) => a.n - b.n) as any[]
  const b = new Board(); const e = new Engine(b, () => {})
  let focus: { ids: string[]; t: number } = { ids: [], t: 0 }
  const order = () => b.values().filter((o) => o.read).sort((x, y) => e.settled(x.id)!.x - e.settled(y.id)!.x).map((o) => `${o.id}=${o.read}`).join(' ')
  const reads = (raw: string) => { for (const m of raw.matchAll(/"read"\s*:\s*(\{[^}]*\})/g)) { try { for (const [k, v] of Object.entries(JSON.parse(m[1]))) { const o = b.get(k); if (o && v && v !== '?' && !o.read) o.read = String(v) } } catch {} } }
  const apply = (ops: Op[]) => { e.beginStep(); for (const op of ops) e.applyOp(op, 0); for (let i = 0; i < 200; i++) e.tick(i * 16, 16) }
  const finals: string[] = []
  for (const l of all) {
    if (l.n > UPTO) break
    if (l.type === 'ink') { b.apply(l.event); if (l.event.type === 'page') focus = { ids: [], t: 0 }; continue }
    if (l.type === 'scene' && typeof l.raw === 'string' && !l.discarded && !l.error) { const r = parseScene(l.raw); if (r) b.applyScene(r) }
    if (l.type === 'request' && l.raw) reads(l.raw)
    if (l.type === 'state' || l.type === 'board') for (const o of l.objs ?? []) { const x = b.get(o.id); if (x && o.read && !x.read) x.read = o.read }
    if (MODE === 'real' && l.type === 'applied' && l.ops.some((op: Op) => op.v === 'move')) { apply(l.ops); if (l.n >= FROM) console.log(`  [${l.n}] real applied ${JSON.stringify(l.ops.map((o: any) => [o.id, o.to]))} -> ${order()}`) }
    if (l.type === 'final' && l.text?.trim() && l.n >= 0) {
      const text = l.text.trim()
      if (/^(?:요|죠|네요|어요|에요|예요|다)[.?!]*$/.test(text)) continue
      const t = l.t
      const g = groundSpeech(b, text, t - focus.t < 30000 ? focus.ids : [], 'x', 'final', e)
      if (/(비교|비유|더\s*크|더\s*작)/.test(text) || g.targets.length === 2) {
        const next = text.split(/그\s*다음(?:에)?/).at(-1)!
        const ng = next !== text ? groundSpeech(b, next, t - focus.t < 30000 ? focus.ids : [], 'y', 'preview', e) : g
        focus = { ids: ng.targets, t }
      }
      const restore = planRestore(e, g)
      const plan = restore ?? (g.sort ? planNumericSort(b, e, g.text) : planNumericSwap(b, e, g))
      // the AI ops of the request answering this final
      const req = all.find((r) => r.type === 'request' && r.n > l.n && r.rec?.kind === '말' && r.rec?.desc?.includes(text.slice(0, 8)))
      let ai = ''
      if (req?.raw) {
        const ops = [...req.raw.matchAll(/"ops"\s*:\s*(\[[^\]]*\])/g)].flatMap((m) => { try { return [JSON.parse(m[1])] } catch { return [] } })
        ai = ops.map((step: any[]) => { const so = step.map((o) => sanitizeOp(o)).filter(Boolean) as Op[]; const k = keepGrounded(so, g, b); return `${JSON.stringify(step.filter((o) => o.v === 'move').map((o) => [o.id, o.to]))}${k.reason ? ' REJ:' + k.reason : ' OK'}` }).filter((s) => !s.startsWith('[]')).join(' | ')
      }
      if (l.n >= FROM) console.log(`[${l.n}] ${JSON.stringify(text)}\n   targets=${g.targets} move=${g.move} sort=${g.sort} neg=${g.negated} restore=${g.restore} focus=${focus.ids}\n   plan=${plan ? plan.cap + ' ' + JSON.stringify(plan.ops.map((o: any) => [o.v, o.id, o.to])) : 'none(->AI)'}${ai ? '\n   loggedAI: ' + ai : ''}\n   board: ${order()}`)
      if (MODE === 'sim' && plan) apply(plan.ops)
    }
  }
  if (process.env.PROBE_DUMP) console.log(b.values().map((o) => `${o.id}:${o.kind}:${o.read ?? ''}:${o.bbox.x},${o.bbox.y},${o.bbox.w}x${o.bbox.h}`).join('\n'), '\nall:', b.objs.map((o) => `${o.id}:${o.kind}${b.underlineOf(o.id) ? '(ul)' : ''}`).join(' '))
})
