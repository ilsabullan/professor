import { describe, expect, it } from 'vitest'
import type { Stroke } from '../types'
import { inkDiff } from './inkBridge'

const stroke = (id: string, tool: Stroke['tool']): Stroke => ({
  id, pageId: 'p', tool, color: '#000', width: 0.003, points: [{ x: 0.1, y: 0.1, t: 0 }], startedAt: 0, endedAt: 0,
})

describe('inkDiff (편집기 → 애니메이션)', () => {
  it('형광펜은 칠판 필기로 보내지 않는다', () => {
    const pen = stroke('a', 'pen')
    const hl = stroke('b', 'highlighter')
    expect(inkDiff([], [pen, hl])).toEqual({ added: [pen], removed: [] })
    expect(inkDiff([pen, hl], [])).toEqual({ added: [], removed: ['a'] })
  })

  it('이미 있던 펜 획은 다시 보내지 않는다', () => {
    const a = stroke('a', 'pen')
    const b = stroke('b', 'pen')
    expect(inkDiff([a], [a, b])).toEqual({ added: [b], removed: [] })
  })
})
