// 사례(cases/<이름>.json)의 필기를 그림으로 그린다. 라벨(read, strokeLabels)을 붙일 때 본다.
// 사용: node scripts/render-case.mjs <사례 이름> [출력 폴더]   → <출력>/<이름>.svg (+ Chrome 있으면 .png)
//
// 획마다 id(s1, s2 …)를 적고, 현재 Board 휴리스틱이 묶은 객체를 같은 색과 상자로 표시한다.
// 상자 왼쪽 위 글자 = 객체 id·종류(·판독값). 지워진 획은 회색 점선.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createServer } from 'vite'

const [name, outDir = 'logs/renders'] = process.argv.slice(2)
if (!name) {
  console.error('사용: node scripts/render-case.mjs <사례 이름> [출력 폴더]')
  process.exit(1)
}
const c = JSON.parse(readFileSync(`cases/${name}.json`, 'utf8'))

const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
const { Board } = await vite.ssrLoadModule('/src/animation/board.ts')
const b = new Board()
const strokes = new Map()
const erased = new Set()
let page = { width: 1280, height: 720 }
// 끝에서 '전부 지우기'로 비면 지우기 직전 상태를 그린다
let beforeClear = null
for (const e of c.events) {
  if (e.type === 'page') page = e.info
  if (e.type === 'clear' && b.objs.length) beforeClear = { objs: [...b.objs], strokes: new Map(strokes), erased: new Set(erased) }
  if (e.type === 'clear' || e.type === 'page') { strokes.clear(); erased.clear() }
  if (e.type === 'stroke') strokes.set(e.stroke.id, e.stroke)
  if (e.type === 'erase') e.strokeIds.forEach((id) => erased.add(id))
  b.apply(e)
}
await vite.close()
const shown = !b.objs.length && beforeClear ? beforeClear : { objs: b.objs, strokes, erased }
if (shown === beforeClear) console.log('(전부 지우기 직전 상태)')

const PALETTE = ['#d62728', '#1f77b4', '#2ca02c', '#9467bd', '#ff7f0e', '#17becf', '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22']
const owner = new Map()
shown.objs.forEach((o, i) => o.strokes.forEach((s) => owner.set(s.id, { o, color: PALETTE[i % PALETTE.length] })))
const read = { ...(c.observedRead ?? {}), ...(c.read ?? {}) }
const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`)

const parts = []
for (const s of shown.strokes.values()) {
  const own = owner.get(s.id)
  const d = s.points.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ')
  const gone = shown.erased.has(s.id)
  parts.push(`<path d="${d}" fill="none" stroke="${gone ? '#bbb' : own?.color ?? '#000'}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"${gone ? ' stroke-dasharray="4 4"' : ''}/>`)
  const p0 = s.points[0]
  parts.push(`<text x="${p0.x + 3}" y="${p0.y - 3}" font-size="10" fill="#555">${esc(s.id)}</text>`)
}
for (const o of shown.objs) {
  const { color } = owner.get(o.strokes[0]?.id) ?? { color: '#000' }
  const { x, y, w, h } = o.bbox
  const label = `${o.id} ${o.kind}${o.arrowEnd ? '→' : ''}${read[o.id] != null ? ` "${read[o.id]}"` : ''}`
  parts.push(`<rect x="${x - 4}" y="${y - 4}" width="${w + 8}" height="${h + 8}" fill="none" stroke="${color}" stroke-width="1" stroke-dasharray="3 3"/>`)
  parts.push(`<text x="${x - 4}" y="${y + h + 16}" font-size="12" font-weight="bold" fill="${color}">${esc(label)}</text>`)
}
const W = Math.ceil(page.width)
const H = Math.ceil(page.height)
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="sans-serif">` +
  `<rect width="100%" height="100%" fill="#fff"/>` +
  `<text x="8" y="18" font-size="13" fill="#333">${esc(name)} — ${esc((page.text ?? '').slice(0, 80))}</text>${parts.join('')}</svg>`

mkdirSync(outDir, { recursive: true })
const svgPath = resolve(join(outDir, `${name}.svg`))
writeFileSync(svgPath, svg)
console.log(svgPath)

const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
if (existsSync(chrome)) {
  const png = resolve(join(outDir, `${name}.png`))
  execFileSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--window-size=${W},${H}`, `--screenshot=${png}`, `file://${svgPath}`], { stdio: 'ignore' })
  console.log(png)
}
console.log(shown.objs.map((o) => `${o.id} ${o.kind}${o.arrowEnd ? '→' : ''}: ${o.strokes.map((s) => s.id).join('+')}`).join('\n'))
