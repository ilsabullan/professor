import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { InkEvent } from '../shared/ink'
import { Board } from './board'
import { describeScene, parseScene, SceneParser } from './scene'

const realBoard = (name: string) => {
  const c = JSON.parse(readFileSync(new URL(`../../cases/${name}.json`, import.meta.url), 'utf8')) as { events: InkEvent[] }
  const b = new Board()
  c.events.forEach((e) => b.apply(e))
  return b
}

describe('장면 해석 응답 정리', () => {
  it('코드블록·설명이 붙어도 JSON만 꺼내고 모르는 role과 "?" 판독은 버린다', () => {
    const r = parseScene('```json\n{"objs":{"o5":{"role":"drawing","label":"혈관"},"o9":{"role":"value","read":"?"},"o2":{"role":"heart"},"x1":{"role":"box"}},"merge":[["o12"],["o1","o4"]],"split":{"o11":[["s50"],["s51"]]}}\n```')
    expect(r).toEqual({
      objs: { o5: { role: 'drawing', label: '혈관' }, o9: { role: 'value' }, o2: {} },
      merge: [['o1', 'o4']],
      split: { o11: [['s50'], ['s51']] },
    })
    expect(parseScene('모르겠어요')).toBeNull()
  })
})

describe('장면 해석 반영 (실측 혈액순환 필기)', () => {
  it('세로 혈관 o5를 값에서 빼고, 섞인 o11을 획 단위로 나누고, 점들을 묶는다', () => {
    const b = realBoard('real-blood-012355')
    expect(b.values().map((o) => o.id)).toContain('o5')
    const v = b.version
    const res = b.applyScene({
      objs: { o5: { role: 'drawing', label: '대동맥' }, o9: { role: 'drawing', label: '온몸' }, o13: { role: 'value', read: 'O2' } },
      merge: [['o1', 'o4']],
      split: { o11: [['s50'], ['s51']] },
    })
    expect(res.removed).toEqual(['o4'])
    expect(res.added).toHaveLength(1)
    expect(b.get('o11')!.strokes.map((s) => s.id)).toEqual(['s50'])
    expect(b.get(res.added[0])!.strokes.map((s) => s.id)).toEqual(['s51'])
    expect(b.get('o1')!.strokes.map((s) => s.id)).toEqual(['s40', 's43'])
    expect(b.values().map((o) => o.id)).not.toContain('o5')
    expect(b.get('o13')!.read).toBe('O2')
    expect(b.version).toBeGreaterThan(v)
  })

  it('획을 빠뜨린 나누기와 옮기는 중인 객체의 묶기는 받지 않는다', () => {
    const b = realBoard('real-blood-012355')
    const res = b.applyScene({ objs: {}, merge: [['o2', 'o3']], split: { o12: [['s52']] } }, (id) => id === 'o3')
    expect(res).toMatchObject({ removed: [], added: [], changed: 0 })
    expect(b.get('o12')!.strokes).toHaveLength(2)
  })

  it('정렬 실측의 배열 칸 선은 칸으로, 숫자는 값으로 둔다', () => {
    const b = realBoard('real-sort-013822')
    b.applyScene({
      objs: { o2: { role: 'frame' }, o7: { role: 'value', read: '5' }, o11: { role: 'underline', to: 'o7' }, o12: { role: 'connector', from: 'o8', to: 'o9' } },
      merge: [],
      split: {},
    })
    expect(b.isFlowPath('o2')).toBe(false)
    expect(b.underlineOf('o11')).toBe('o7')
    expect(b.values().find((o) => o.id === 'o7')!.read).toBe('5')
    expect(b.isFlowPath('o12')).toBe(true)
  })

  it('모델에 획 id와 이전 판단을 함께 알린다', () => {
    const b = realBoard('real-blood-012355')
    b.applyScene({ objs: { o5: { role: 'drawing', label: '대동맥' } }, merge: [], split: {} })
    const text = describeScene(b)
    expect(text).toContain('획 s50[')
    expect(text).toContain('이전판단:drawing(대동맥)')
  })
})

describe('장면 해석 비동기 실행', () => {
  const deps = (b: Board, call: () => Promise<{ text: string }>, logs: [string, Record<string, unknown>][]) => ({
    board: b, call, snapshot: () => undefined, keep: () => false,
    log: (type: string, data: Record<string, unknown>) => logs.push([type, data]),
    onApplied: () => {}, onStatus: () => {},
  })

  it('해석 중 칠판이 바뀌면 결과를 버린다', async () => {
    const b = realBoard('real-blood-012355')
    const logs: [string, Record<string, unknown>][] = []
    const sp = new SceneParser(deps(b, async () => {
      b.apply({ type: 'erase', strokeIds: ['s49'], t: 0 } as InkEvent)
      return { text: '{"objs":{"o5":{"role":"drawing"}}}' }
    }, logs))
    await sp.run()
    expect(b.get('o5')!.role).toBeUndefined()
    expect(sp.status.last?.discarded).toBe('해석 중 칠판이 바뀜')
    expect(logs.map(([t]) => t)).toEqual(['scene-request', 'scene'])
  })

  it('칠판이 그대로면 반영하고 결과를 기록한다', async () => {
    const b = realBoard('real-blood-012355')
    const logs: [string, Record<string, unknown>][] = []
    const sp = new SceneParser(deps(b, async () => ({ text: '{"objs":{"o5":{"role":"drawing"}}}' }), logs))
    await sp.run()
    expect(b.get('o5')!.role).toBe('drawing')
    expect(sp.status.last).toMatchObject({ objs: 1 })
    expect(logs[1][1].objs).toBeDefined()
  })
})

describe('장면 해석 충돌', () => {
  it('같은 객체를 나누면서 묶으라는 응답(실측 호출에서 나옴)은 나누기만 반영한다', () => {
    const b = realBoard('real-blood-012355')
    const res = b.applyScene({ objs: {}, merge: [['o11', 'o12']], split: { o11: [['s50'], ['s51']] } })
    expect(res.removed).toEqual([])
    expect(b.get('o11')!.strokes.map((s) => s.id)).toEqual(['s50'])
    expect(b.get('o12')!.strokes.map((s) => s.id)).toEqual(['s52', 's53'])
  })
})
