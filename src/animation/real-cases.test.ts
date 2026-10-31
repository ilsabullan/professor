import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Board } from './board'
import { Engine } from './engine'
import { dropRevisits } from './geometry'
import { parseProgress } from './ai/parse'
import { groundSpeech, rejectUngrounded } from './grounding'
import { sanitizeOp, type Op } from './ops'
import { parseScene } from './scene'
import type { InkEvent } from '../shared/ink'

interface RecordedCase {
  events: InkEvent[]
  inputs: { n: number; at: number; type: string; event?: InkEvent; text?: string; raw?: string }[]
  failures: { n: number; request?: { kind: string; desc: string; raw: string } }[]
}
const fixture = (name: string): RecordedCase => JSON.parse(readFileSync(new URL(`../../cases/${name}.json`, import.meta.url), 'utf8'))
const c35 = fixture('real-sort-035007')
const boardFor = (c: RecordedCase) => { const b = new Board(); c.events.forEach((e) => b.apply(e)); return b }

describe('최신 실측 회귀', () => {
  it('01:38 실측의 세 밑줄을 3, 3, 1로 판독해도 값 목록에 포함하지 않는다', () => {
    const b = boardFor(fixture('real-sort-013822'))
    for (const [id, read] of Object.entries({ o7: '5', o8: '3', o9: '8', o10: '1', o11: '3', o16: '3', o18: '1' })) b.get(id)!.read = read
    expect(['o11', 'o16', 'o18'].map((id) => b.underlineOf(id))).toEqual(['o7', 'o8', 'o10'])
    expect(b.values().filter((o) => o.read).map((o) => o.read)).toEqual(['5', '3', '8', '1'])
  })

  it('01:29 실측의 짧은 밑줄 o16을 별도 숫자 3으로 쓰지 않는다', () => {
    const b = boardFor(fixture('real-sort-012918'))
    expect(b.underlineOf('o16')).toBe('o9')
  })

  it('실제 잘못된 5·8 교환 응답을 현재 비교 대상 8·1로 제한한다', () => {
    const c = fixture('real-sort-013822')
    const b = boardFor(c)
    for (const [id, read] of Object.entries({ o7: '5', o8: '3', o9: '8', o10: '1' })) b.get(id)!.read = read
    const compare = groundSpeech(b, '팔 과일을 비유했을 때 누가 더 크죠?', [], 'compare', 'final')
    const g = groundSpeech(b, '그럼 둘이 바뀌겠죠?', compare.targets, 'swap', 'final')
    const raw = c.failures.find((f) => f.n === 132)!.request!.raw
    const ops = parseProgress(raw + '\n').steps[0].ops.map(sanitizeOp) as Op[]
    expect(rejectUngrounded(ops, g, b)).toBe('지금 말한 비교/이동 대상과 다름')
  })

  it('기존 TCP 실측에서 그린 선만으로 흐름을 앞질러 시작하지 않는다', () => {
    const c = fixture('real-tcp-012355')
    const b = boardFor(c)
    const ops = parseProgress(c.failures[0].request!.raw + '\n').steps[0].ops.map(sanitizeOp) as Op[]
    const g = groundSpeech(b, '선 o3 추가', [], 'ink', 'ink')
    expect(rejectUngrounded(ops, g, b)).not.toBeNull()
    expect(new Engine(b, () => {}).flows).toEqual([])
  })

  it('원본의 필기·중간 음성·확정 음성 순서와 수정된 받아쓰기를 보존한다', () => {
    for (const name of ['real-sort-012355', 'real-sort-012918', 'real-sort-013822']) {
      const c = fixture(name)
      expect(c.inputs.some((e) => e.type === 'interim')).toBe(true)
      expect(c.inputs.every((e, i) => !i || e.at >= c.inputs[i - 1].at)).toBe(true)
      const firstSpeech = c.inputs.findIndex((e) => e.type === 'final')
      expect(c.inputs.slice(firstSpeech + 1).some((e) => e.type === 'ink')).toBe(true)
    }
  })

  it('TCP 실측의 크게 그린 화살표 머리 세 개를 선에 붙인다 (손글씨 "5"로 오판독되던 o5)', () => {
    const b = boardFor(fixture('real-tcp-012355'))
    const arrows = b.objs.filter((o) => o.arrowEnd).map((o) => o.strokes.map((s) => s.id).join('+'))
    expect(arrows).toEqual(['s24+s25', 's30+s31', 's37+s38'])
    expect(b.values().some((o) => o.strokes.some((s) => s.id === 's25'))).toBe(false)
  })

  it('iPad 실측(035007)의 되돌아온 중복 점을 빼서 곧은 칸 구분선을 선으로 본다', () => {
    const b = boardFor(fixture('real-sort-035007'))
    const kindOf = (sid: string) => b.objs.find((o) => o.strokes.some((s) => s.id === sid))?.kind
    expect(['s24', 's26', 's27', 's28'].map(kindOf)).toEqual(['line', 'line', 'line', 'line'])
    expect(kindOf('s33')).toBe('mark') // 마지막 칸의 숫자 1은 그대로 손글씨
    const s33 = c35.events.find((e) => e.type === 'stroke' && e.stroke.id === 's33')
    expect(s33?.type === 'stroke' && dropRevisits(s33.stroke.points).length).toBeLessThan(s33?.type === 'stroke' ? s33.stroke.points.length / 2 : 0)
  })

  it('iPad 실측(040451)의 위쪽 교환 화살표 몸통을 숫자 후보로 쓰지 않는다', () => {
    const b = boardFor(fixture('real-sort-040451'))
    const arc = b.objs.find((o) => o.strokes.some((s) => s.id === 's51'))!
    expect(b.values().map((o) => o.id)).not.toContain(arc.id)
  })

  it('혈액순환 실측에서 폐 윤곽 옆에 쓴 "O2"를 윤곽과 따로 둔다', () => {
    const b = boardFor(fixture('real-blood-012355'))
    const groups = b.objs.map((o) => o.strokes.map((s) => s.id).join('+'))
    expect(groups).toContain('s52+s53')
    expect(groups).toContain('s54+s55')
  })
})


/** 실측 기록에서 n번 이벤트 직전까지의 필기와 반영된 장면 해석으로 만든 칠판 */
const boardAt = (c: RecordedCase, n: number) => {
  const b = new Board()
  for (const e of c.inputs.filter((x) => x.n < n)) {
    if (e.type === 'ink') b.apply(e.event!)
    else if (e.type === 'scene') b.applyScene(parseScene(e.raw!)!)
  }
  return b
}
const opsOf = (raw: string) => parseProgress(raw + '\n').steps[0].ops.map(sanitizeOp) as Op[]

describe('04시 실측 회귀', () => {
  it('04:04 포물선 평행이동: 포물선을 자기 곡선을 따라 옮기는 응답은 실행하지 않는다', () => {
    const c = fixture('real-parabola-040451')
    const f = c.failures.find((x) => x.n === 466)!
    const e = new Engine(boardAt(c, f.n), () => {})
    expect(e.validateStep(opsOf(f.request!.raw))).toMatch(/자기 자신을 따라 이동/)
  })

  it('04:04 포물선 평행이동: by로 밀면 x만 바뀌고 y는 그대로다', () => {
    const c = fixture('real-parabola-040451')
    const b = boardAt(c, 466)
    const e = new Engine(b, () => {})
    const before = e.settled('o4')!
    const ops: Op[] = [sanitizeOp({ v: 'move', id: 'o4', by: [80, 0], dur: 600 })!]
    expect(e.validateStep(ops)).toBeNull()
    e.beginStep()
    ops.forEach((op) => e.applyOp(op, 0))
    const after = e.settled('o4')!
    expect(after.x - before.x).toBeCloseTo(80)
    expect(after.y).toBeCloseTo(before.y)
  })

  it('04:04 정렬: 배열 위에 따로 쓴 8과 1을 바꾸는 응답은 다른 줄 교환으로 막는다', () => {
    const c = fixture('real-sort-040451')
    const f = c.failures.find((x) => x.n === 2017)!
    const b = boardAt(c, f.n)
    for (const [id, read] of Object.entries({ o6: '5', o7: '3', o8: '8', o9: '1', o16: '8' })) b.get(id)!.read = read
    const g = groundSpeech(b, '일 보다 크니까 뒤로 가겠죠', ['o9', 'o16'], 'swap', 'final')
    expect(rejectUngrounded(opsOf(f.request!.raw), { ...g, targets: ['o9', 'o16'] }, b)).toBe('다른 줄의 값과 교환')
  })

  it('04:25 장면 해석이 서로 다른 값 5와 3을 합치라고 해도 따로 둔다', () => {
    const c = fixture('real-sort-042514')
    const b = boardAt(c, 229)
    // logs/20261101-042514-zxxz.jsonl n=229 장면 해석 응답 원문
    const raw = '{"objs":{"o1":{"role":"frame"},"o2":{"role":"frame"},"o3":{"role":"frame"},"o4":{"role":"frame"},"o5":{"role":"frame"},"o6":{"role":"frame"},"o7":{"role":"noise"},"o8":{"role":"value","read":"5"},"o9":{"role":"value","read":"3"},"o10":{"role":"value","read":"8"},"o11":{"role":"value","read":"1"},"o12":{"role":"noise"},"o13":{"role":"underline","to":"o8"},"o14":{"role":"underline","to":"o9"}},"merge":[["o8","o9"]],"split":{}}'
    b.applyScene(parseScene(raw)!)
    expect(b.values().map((o) => o.read)).toEqual(['5', '3', '8', '1'])
  })
})

describe('막는 규칙 강도 (04:19 지구 공전 실측)', () => {
  // logs/20261101-041959-k1lc n=951: 말하는 중 "반대편으로 가도 축을 같은 방향이에요 그래서 지구가 돌면서 여름에서 겨울로"
  const text = '반대편으로 가도 축을 같은 방향이에요 그래서 지구가 돌면서 여름에서 겨울로'
  const orbit: Op[] = [sanitizeOp({ v: 'move', id: 'o1', along: 'o8', loop: true, dur: 4000 })!]
  const setupEarth = () => {
    const b = boardAt(fixture('real-orbit-041959'), 951)
    return { b, g: groundSpeech(b, text, [], 'earth', 'preview') }
  }

  it('엄격·단어 목록 끔: 말하는 중에는 궤도 이동을 막는다', () => {
    const { b, g } = setupEarth()
    expect(rejectUngrounded(orbit, g, b, 'strict')).toBe('말이 아직 확정되지 않음')
    expect(rejectUngrounded(orbit, g, b, 'words')).toBe('말이 아직 확정되지 않음')
  })

  it('최소: 말하는 중이라도 궤도 이동을 허용하고 엔진도 실행할 수 있다', () => {
    const { b, g } = setupEarth()
    expect(rejectUngrounded(orbit, g, b, 'minimal')).toBeNull()
    expect(new Engine(b, () => {}).validateStep(orbit)).toBeNull()
  })

  it('단어 목록 끔: 확정 발화에 이동 단어("돌면서")가 없어도 막지 않는다', () => {
    const { b } = setupEarth()
    const g = groundSpeech(b, text, [], 'earth', 'final')
    expect(g.move).toBe(false)
    expect(rejectUngrounded(orbit, g, b, 'strict')).toBe('이동을 지시한 입력이 없음')
    expect(rejectUngrounded(orbit, g, b, 'words')).toBeNull()
  })

  it('최소에서도 숫자 규칙(지금 말한 대상만 이동)은 남는다', () => {
    const c = fixture('real-sort-013822')
    const b = boardFor(c)
    for (const [id, read] of Object.entries({ o7: '5', o8: '3', o9: '8', o10: '1' })) b.get(id)!.read = read
    const compare = groundSpeech(b, '팔 과일을 비유했을 때 누가 더 크죠?', [], 'compare', 'final')
    const g = groundSpeech(b, '그럼 둘이 바뀌겠죠?', compare.targets, 'swap', 'final')
    const raw = c.failures.find((f) => f.n === 132)!.request!.raw
    expect(rejectUngrounded(opsOf(raw), g, b, 'minimal')).toBe('지금 말한 비교/이동 대상과 다름')
  })
})
