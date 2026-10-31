import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { InkEvent } from '../shared/ink'
import { Board } from './board'

/**
 * 실측 버그 사례 재생. cases/*.json 의 필기 이벤트를 그대로 다시 넣고 expect를 확인한다.
 * 사례 추가: node scripts/extract-case.mjs logs/<세션>.jsonl <이름> "<설명>" 후 expect 채우기
 */
interface Case {
  name: string
  note: string
  expect: { grid?: [number, number]; cellsWithMark?: number; underlines?: number; arrows?: number }
  events: InkEvent[]
}

const dir = join(__dirname, '../../cases')
const cases: Case[] = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))

describe('실측 버그 사례', () => {
  for (const c of cases) {
    it(`${c.name}: ${c.note}`, () => {
      const b = new Board()
      for (const e of c.events) b.apply(e)
      const x = c.expect
      if (x.grid) {
        expect(b.grids.map((g) => [g.rows, g.cols])).toContainEqual(x.grid)
      }
      if (x.cellsWithMark != null) {
        const g = b.grids[0]
        const n = g?.cells.filter((cell) => cell.items.some((id) => ['mark', 'text'].includes(b.get(id)?.kind ?? ''))).length
        expect(n).toBe(x.cellsWithMark)
      }
      if (x.underlines != null) {
        expect(b.objs.filter((o) => b.underlineOf(o.id)).length).toBe(x.underlines)
      }
      if (x.arrows != null) {
        expect(b.objs.filter((o) => o.arrowEnd).length).toBe(x.arrows)
      }
    })
  }
})
