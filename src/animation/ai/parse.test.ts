import { describe, expect, it } from 'vitest'
import { parseProgress, scanOps } from './parse'

describe('scanOps', () => {
  it('줄이 끝나기 전에도 완성된 동작만 꺼낸다', () => {
    const partial = '{"conf":0.9,"ops":[{"v":"flow","along":"o3","n":8},{"v":"pulse","id":"o'
    expect(scanOps(partial)).toEqual([{ v: 'flow', along: 'o3', n: 8 }])
  })

  it('문자열 안의 괄호는 무시한다', () => {
    const line = '{"ops":[{"v":"label","id":"o1","text":"}{]"}],"cap":"x"}'
    expect(scanOps(line)).toEqual([{ v: 'label', id: 'o1', text: '}{]' }])
  })
})

describe('parseProgress', () => {
  it('끝난 줄과 진행 중인 줄을 구분한다', () => {
    const text =
      '{"conf":0.8,"ops":[{"v":"flow","along":"o1"}],"cap":"패킷 이동"}\n{"ops":[{"v":"color","id":"o2","color":"red"}'
    const r = parseProgress(text)
    expect(r.steps).toHaveLength(2)
    expect(r.steps[0]).toMatchObject({ closed: true, cap: '패킷 이동', conf: 0.8 })
    expect(r.steps[1]).toMatchObject({ closed: false, ops: [{ v: 'color', id: 'o2', color: 'red' }] })
  })

  it('확신 값은 줄이 끝나기 전에도 읽는다', () => {
    expect(parseProgress('{"conf":0.25,"ops":[').steps[0].conf).toBe(0.25)
  })

  it('none 줄을 알아본다', () => {
    expect(parseProgress('{"none":true}\n').none).toBe(true)
  })

  it('코드블록 표시는 걸러낸다', () => {
    const r = parseProgress('```json\n{"ops":[{"v":"pulse","id":"o1"}],"cap":"a"}\n```\n')
    expect(r.steps).toHaveLength(1)
    expect(r.steps[0].ops).toEqual([{ v: 'pulse', id: 'o1' }])
  })
})
