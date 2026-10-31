import { expect, it } from 'vitest'
import { Board } from './board'
import { Engine } from './engine'
import { groundSpeech, mentionedValues, planNumericSort } from './grounding'

it('새 비교가 불명확하면 이전 쌍으로 대체하지 않고, 숫자가 아닌 단어를 숫자로 읽지 않는다', () => {
  expect(mentionedValues('사회 과일 오른쪽')).toEqual([])
  expect(mentionedValues('오랑 삼을 비교')).toEqual(['5', '3'])
  expect(mentionedValues('오랑삼을 비교')).toEqual(['5', '3'])
  expect(mentionedValues('팔 과일을 비교')).toEqual(['8', '1'])
  const b = new Board()
  for (const [i, text] of ['5', '3', '8', '1'].entries()) b.apply({ type: 'text', page: 1, id: `s${i}`, text, x: i * 150 + 200, y: 300, t: 0 })
  expect(groundSpeech(b, '8은 그대로 있을 거고', ['o1', 'o3'], 'a', 'final').move).toBe(false)
  expect(groundSpeech(b, '7과 9를 비교', ['o1', 'o3'], 'a', 'final').targets).toEqual([])
  expect(groundSpeech(b, '비교했을 때 뭐가 더 크죠?', ['o1', 'o2'], 'a', 'final').targets).toEqual(['o1', 'o2'])
  expect(groundSpeech(b, '오랑 삼이 자리가 바뀔 거예요', [], 'a', 'final')).toMatchObject({ move: true, targets: ['o1', 'o2'] })
})

it('전체 정렬은 현재 자리의 순열로 계산하고 다시 실행해도 순서를 뒤집지 않는다', () => {
  const b = new Board()
  for (const [i, text] of ['5', '8', '3', '1'].entries()) b.apply({ type: 'text', page: 1, id: `s${i}`, text, x: i * 150 + 200, y: 300, t: 0 })
  const e = new Engine(b, () => {})
  const plan = planNumericSort(b, e, '정렬을 끝까지 해요')!
  expect(e.validateStep(plan.ops)).toBeNull()
  e.beginStep()
  plan.ops.forEach((op) => e.applyOp(op, 0))
  e.tick(1000, .05)
  const actual = b.values().sort((a, z) => e.center(a.id)!.x - e.center(z.id)!.x).map((o) => o.text)
  expect(actual).toEqual(['1', '3', '5', '8'])
  expect(planNumericSort(b, e, '정렬 완료')!.ops.every((op) => op.v === 'pulse')).toBe(true)
})
