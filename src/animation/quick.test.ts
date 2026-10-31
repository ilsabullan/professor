import { expect, it } from 'vitest'
import { Board } from './board'
import { Engine } from './engine'
import { quickFromSpeech } from './quick'

it('여러 흐름에서 대상 없는 혼잡 발화가 마지막 경로를 임의로 바꾸지 않는다', () => {
  const b = new Board()
  const e = new Engine(b, () => {})
  e.flows = ['path1', 'path2'].map((along) => ({ along, n: 5, speed: 1, color: '#fff', rev: false, phase: 0 }))
  expect(quickFromSpeech('막혀요', b, e, new Set())).toEqual([])
  e.flows.pop()
  expect(quickFromSpeech('막혀요', b, e, new Set())).toMatchObject([{ v: 'flow', along: 'path1' }])
})
