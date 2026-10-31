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
  expect: { marks?: number; boxes?: number; underlines?: number; arrows?: number }
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
      if (x.marks != null) expect(b.objs.filter((o) => o.kind === 'mark').length).toBe(x.marks)
      if (x.boxes != null) expect(b.objs.filter((o) => o.kind === 'box').length).toBe(x.boxes)
      if (x.underlines != null) {
        expect(b.objs.filter((o) => b.underlineOf(o.id)).length).toBe(x.underlines)
      }
      if (x.arrows != null) {
        expect(b.objs.filter((o) => o.arrowEnd).length).toBe(x.arrows)
      }
    })
  }
})
