import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { InkEvent } from '../shared/ink'
import { boardFrom, scoreStrokes, type StrokeLabel } from './strokes'

/**
 * Board 휴리스틱(획 분류·묶기)을 획 단위 라벨과 비교한다. API 호출 없음.
 * 임계값을 바꿀 때 보정용(calib)과 검증용(holdout) 점수를 함께 보고, 기준선 아래로 떨어지면 실패한다.
 * 상세 표: STROKE_REPORT=1 npx vitest run src/evals/strokes.test.ts
 */
interface Case { name: string; split?: string; events: InkEvent[]; strokeLabels?: StrokeLabel[] }

const dir = join(__dirname, '../../cases')
const cases: Case[] = readdirSync(dir).filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
  .filter((c: Case) => c.strokeLabels?.length)

/** 현재 휴리스틱의 점수. 개선하면 올리고, 내려가면 회귀다. */
const BASELINE = {
  calib: { digitsOk: 42, nonValueOk: 123, rowOk: 8 },
  holdout: { digitsOk: 8, nonValueOk: 14, rowOk: 0 },
}

describe('획 라벨 대비 Board 휴리스틱', () => {
  it('보정용·검증용 점수가 기준선 이상', () => {
    const total = { calib: { digits: 0, digitsOk: 0, nonValue: 0, nonValueOk: 0, rows: 0, rowOk: 0 }, holdout: { digits: 0, digitsOk: 0, nonValue: 0, nonValueOk: 0, rows: 0, rowOk: 0 } }
    const lines: string[] = []
    for (const c of cases) {
      const s = scoreStrokes(boardFrom(c.events), c.strokeLabels!)
      const t = total[c.split === 'holdout' ? 'holdout' : 'calib']
      t.digits += s.digits; t.digitsOk += s.digitsOk; t.nonValue += s.nonValue; t.nonValueOk += s.nonValueOk
      t.rows++; t.rowOk += +s.rowOk
      lines.push(`${s.rowOk ? '✓' : '✗'} ${c.name} [${c.split ?? 'calib'}] 숫자 ${s.digitsOk}/${s.digits} 비값 ${s.nonValueOk}/${s.nonValue}`)
      for (const e of s.errors) lines.push(`    ${e}`)
    }
    const fmt = (k: 'calib' | 'holdout') => `${k}: 숫자 ${total[k].digitsOk}/${total[k].digits}, 비값 ${total[k].nonValueOk}/${total[k].nonValue}, 행 ${total[k].rowOk}/${total[k].rows}`
    if (process.env.STROKE_REPORT) console.log([fmt('calib'), fmt('holdout'), ...lines].join('\n'))
    for (const k of ['calib', 'holdout'] as const) {
      expect(total[k].digitsOk, fmt(k)).toBeGreaterThanOrEqual(BASELINE[k].digitsOk)
      expect(total[k].nonValueOk, fmt(k)).toBeGreaterThanOrEqual(BASELINE[k].nonValueOk)
      expect(total[k].rowOk, fmt(k)).toBeGreaterThanOrEqual(BASELINE[k].rowOk)
    }
  })
})
