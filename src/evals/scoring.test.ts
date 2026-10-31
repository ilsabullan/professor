import { expect, it } from 'vitest'
import { passes, type Frame } from './scoring'

it('순서가 되돌아왔어도 움직이면 안 되는 값이 움직였으면 실패', () => {
  const s: Frame = { before: '5 3 8 1', order: '5 3 8 1', overlap: [], flows: [], moved: ['o7', 'o8'] }
  expect(passes({ after: 0, unchanged: true }, s)).toBe(false)
  expect(passes({ after: 0, forbiddenMoved: ['o7'] }, s)).toBe(false)
})
it('기대한 경로 외의 선에도 흐르면 실패', () => {
  expect(passes({ after: 0, flows: ['o3'] }, { before: '', order: '', overlap: [], flows: ['o3', 'o4'], moved: [] })).toBe(false)
})
