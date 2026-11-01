import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Board } from './board'
import { Engine } from './engine'
import { dropRevisits } from './geometry'
import { parseProgress } from './ai/parse'
import { quickFromBoard } from './quick'
import { alignDirection, alongToShift, followIntersections, groundSpeech, measureTranslation, repairOrbit, repairPendulum, keepGrounded, planNumericSort, rejectUngrounded } from './grounding'
import { sanitizeOp, type Op } from './ops'
import type { SceneResult } from './board'
import { describeScene, parseScene, SCENE_PROMPT } from './scene'
import type { InkEvent } from '../shared/ink'

interface RecordedCase {
  events: InkEvent[]
  /** scene 입력의 ids·after: 실측 당시 객체 번호별 획 (해석 요청 때, 반영 직후) */
  inputs: { n: number; at: number; type: string; event?: InkEvent; text?: string; raw?: string; ids?: Record<string, string[]>; after?: Record<string, string[]> }[]
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

  it('02:40 실측: "3번째, 4번째 꺼 8과 1을 비교"는 읽지 못한 낙서를 칸으로 세지 않고 8·1을 잡는다', () => {
    const b = boardFor(fixture('real-sort-024015'))
    for (const [id, read] of Object.entries({ o7: '3', o8: '5', o9: '8', o10: '1' })) b.get(id)!.read = read
    const text = '그다음에 이제 3번째, 4번째 꺼 8과 1을 비교해 볼게요. 8과 일 중에 누가 더 크죠?'
    const compare = groundSpeech(b, text.split(/그\s*다음(?:에)?/).at(-1)!, [], 'compare', 'preview')
    expect(compare.targets.sort()).toEqual(['o10', 'o9'])
    expect(groundSpeech(b, '그러면 둘이 자리밖에 바뀔 거예요', compare.targets, 'swap', 'final')).toMatchObject({ move: true })
  })

  it('05:04 실측: 연달아 찍은 입자 점을 손글씨 하나로 합치지 않는다', () => {
    const c = fixture('real-states-050404')
    const b = boardFor(c)
    const particles = ['s8', 's9', 's10', 's11', 's13', 's15', 's16', 's20', 's21', 's24', 's30', 's31']
    const owners = new Set(particles.map((sid) => b.objs.find((o) => o.strokes.some((st) => st.id === sid))!.id))
    expect(owners.size).toBe(particles.length)
    expect(Math.max(...b.objs.map((o) => o.strokes.length))).toBeLessThan(6)
  })

  it('08:28 실측: "오른쪽으로" 말했는데 왼쪽으로 민 그래프 이동을 오른쪽으로 바로잡는다', () => {
    const b = new Board()
    for (const input of fixture('real-graph-082838').inputs.filter((i) => i.type === 'ink' && i.n <= 93)) b.apply(input.event!)
    // 실측 AI 응답 그대로 (n=210, 271, 289, 334)
    const real: [string, [number, number], number][] = [
      ['y는 x 마이너스 2의 제곱 . 오른쪽으로 이만큼 옮기면', [-16, 0], 1],
      ['오른쪽으로 이만큼 더 이동해요', [-16, 0], 1],
      ['왼쪽으로 이만큼 더 이동해요', [-64, 0], -1],
      ['오른쪽으로 8만큼 더 이동해요', [-192, 0], 1],
    ]
    for (const [text, by, dir] of real) {
      const ops = alignDirection([{ v: 'move', id: 'o9', by, dur: 900 }], text)
      const g = groundSpeech(b, text, [], 'a', 'final')
      expect(rejectUngrounded(ops, g, b)).toBeNull()
      expect(Math.sign((ops[0] as { by: [number, number] }).by[0])).toBe(dir)
      expect(Math.abs((ops[0] as { by: [number, number] }).by[0])).toBe(Math.abs(by[0]))
    }
    // 방향을 말하지 않았거나 둘 다 말하면 그대로 둔다
    const same: Op[] = [{ v: 'move', id: 'o9', by: [-40, 0], dur: 900 }]
    expect(alignDirection(same, '이만큼 옮기면')).toBe(same)
    expect(alignDirection(same, '오른쪽이 아니라 왼쪽으로')).toEqual(same)
  })

  it('08:14 실측: 좌표평면에 그린 이동량 화살표에 흐름을 붙이지 않는다', () => {
    const c = fixture('real-graph-081421')
    const b = new Board()
    let arrow: ReturnType<Board['apply']> = null
    // 마지막 좌표평면(n 1870~)을 그리고 이동량 화살표(n 1937)를 그은 순간까지
    for (const input of c.inputs.filter((i) => i.type === 'ink' && i.n <= 1937)) {
      const ev = b.apply(input.event!)
      if (ev?.kind === '화살표') arrow = ev
    }
    expect(arrow?.kind).toBe('화살표')
    expect(b.axes().size).toBeGreaterThan(0)
    expect(quickFromBoard(arrow!, b)).toEqual([])
  })

  it('08:28 실측: "오른쪽으로 이만큼"은 방금 그린 60px 이동량 화살표만큼 민다', () => {
    // 화살표 머리를 그은 순간까지 (사례 끝에서는 칠판을 지웠다)
    const b = new Board()
    for (const input of fixture('real-graph-082838').inputs.filter((i) => i.type === 'ink' && i.n <= 93)) b.apply(input.event!)
    const arrow = b.objs.find((o) => o.arrowEnd)!
    const now = arrow.t + 5000
    const move = (by: [number, number]): Op[] => [{ v: 'move', id: 'o9', by, dur: 900 }]
    const right = measureTranslation(alignDirection(move([-16, 0]), '오른쪽으로 이만큼 옮기면'), '오른쪽으로 이만큼 옮기면', b, now)
    expect((right[0] as { by: number[] }).by).toEqual([60, 0])
    const left = measureTranslation(move([-64, 0]), '왼쪽으로 이만큼 더 이동해요', b, now)
    expect((left[0] as { by: number[] }).by).toEqual([-60, 0])
    // 숫자로 말한 양("8만큼")은 AI 값을 그대로 둔다
    expect(measureTranslation(move([192, 0]), '오른쪽으로 8만큼 더 이동해요', b, now)).toEqual(move([192, 0]))
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


/** 실측 당시 객체 번호 → 같은 획을 가진 지금 칠판의 객체 번호. Board 휴리스틱이 바뀌어 번호가 밀려도 맞춘다 */
const idMap = (b: Board, ids: Record<string, string[]> = {}) => (id: string) => {
  const sid = ids[id]?.[0]
  return (sid && b.objs.find((o) => o.strokes.some((s) => s.id === sid))?.id) || id
}

const remapScene = (r: SceneResult, f: (id: string) => string): SceneResult => ({
  objs: Object.fromEntries(Object.entries(r.objs).map(([id, s]) => [f(id), { ...s, from: s.from && f(s.from), to: s.to && f(s.to) }])),
  merge: r.merge.map((g) => [...new Set(g.map(f))]).filter((g) => g.length >= 2),
  split: Object.fromEntries(Object.entries(r.split).map(([id, g]) => [f(id), g])),
})

/** 실측 기록에서 n번 이벤트 직전까지의 필기와 반영된 장면 해석으로 만든 칠판 */
const boardAt = (c: RecordedCase, n: number) => {
  const b = new Board()
  for (const e of c.inputs.filter((x) => x.n < n)) {
    if (e.type === 'ink') b.apply(e.event!)
    else if (e.type === 'scene') b.applyScene(remapScene(parseScene(e.raw!)!, idMap(b, e.ids)))
  }
  return b
}

/** n번 이벤트 때 AI가 본 객체 번호(마지막 장면 해석 직후 기준)를 지금 칠판 번호로 */
const realIds = (c: RecordedCase, b: Board, n: number) =>
  idMap(b, c.inputs.filter((x) => x.type === 'scene' && x.n < n).at(-1)?.after)
const remapOps = (ops: Op[], f: (id: string) => string): Op[] =>
  JSON.parse(JSON.stringify(ops).replace(/"(o\d+)"/g, (_, id: string) => JSON.stringify(f(id))))
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
    const id = realIds(c, b, f.n)
    for (const [rid, read] of Object.entries({ o6: '5', o7: '3', o8: '8', o9: '1', o16: '8' })) b.get(id(rid))!.read = read
    const targets = [id('o9'), id('o16')]
    const g = groundSpeech(b, '일 보다 크니까 뒤로 가겠죠', targets, 'swap', 'final')
    expect(rejectUngrounded(remapOps(opsOf(f.request!.raw), id), { ...g, targets }, b)).toBe('다른 줄의 값과 교환')
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

  it('확정 발화의 "돌면서"는 이동 지시다 (06:20 실측에서 "지구가 돌아요"가 막혔음)', () => {
    const { b } = setupEarth()
    const g = groundSpeech(b, text, [], 'earth', 'final')
    expect(g.move).toBe(true)
    expect(rejectUngrounded(orbit, g, b, 'strict')).toBeNull()
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

describe('06~07시 실측 회귀', () => {
  // logs/20261101-064132-7bx0.jsonl: 손글씨 5 3 8 1
  const sortAt = (n: number) => {
    const c = fixture('real-sort-064132')
    const b = boardAt(c, n)
    const id = realIds(c, b, n)
    for (const [rid, read] of Object.entries({ o8: '5', o9: '3', o10: '8', o11: '1' })) b.get(id(rid))!.read = read
    return { b, id }
  }

  it('"5와 3이 바뀝니다"를 교환 지시로 보고 모델의 5↔3 교환을 통과시킨다 (n=217에서 막혔음)', () => {
    const { b, id } = sortAt(210)
    const g = groundSpeech(b, '뭐가 더 크겠죠? 그러면은 5와 3이 바뀝니다', [], 'swap', 'final')
    expect(g).toMatchObject({ move: true, targets: [id('o8'), id('o9')] })
    const raw = '{"ops":[{"v":"move","id":"o8","to":"o9"},{"v":"move","id":"o9","to":"o8"}],"cap":"5와 3을 서로 바꿈"}'
    expect(rejectUngrounded(remapOps(opsOf(raw), id), g, b)).toBeNull()
  })

  it('"안 바뀌겠더라"는 교환하지 않는다 (n=402에서 5↔8을 교환했음)', () => {
    const { b, id } = sortAt(398)
    const g = groundSpeech(b, '안 바뀌겠더라.', [id('o8'), id('o10')], 'noswap', 'final')
    expect(g.move).toBe(false)
    const raw = '{"conf":1,"ops":[{"v":"move","id":"o8","to":"o10","dur":700},{"v":"move","id":"o10","to":"o8","dur":700}],"cap":"5와 8 교환"}'
    expect(rejectUngrounded(remapOps(opsOf(raw), id), g, b)).toBe('이동을 지시한 입력이 없음')
  })

  it('실측에서 놓친 이동 표현과 부정 표현', () => {
    const b = new Board()
    const move = (t: string) => groundSpeech(b, t, [], 'm', 'final').move
    for (const t of ['빨리 바뀐다', '이동을 해볼게요.', '오른쪽으로 이만큼 이동', '포물선이 오른쪽으로 이동했어요.', '공은 떨어져봐.', '지구가 돌아요', '진자를 움직여줘', '이 호를 따라 왔다 갔다 해요.', '끝까지 올라가면', '잠깐 멈췄다가 다시 내려와요.'])
      expect(move(t), t).toBe(true)
    for (const t of ['안 바뀌겠죠.', '정현욱 씨 공이 안 떨어져요', '앞에 평행이동이에요', '여기 정렬 안 된 배열이 있어요.'])
      expect(move(t), t).toBe(false)
    expect(groundSpeech(b, '다시 돌아오세요. 다시 돌아오세요.', [], 'r', 'final').restore).toBe(true)
  })

  it('오른쪽으로 옮기자는데 왼쪽으로 미는 응답은 막는다 (064132 n=705: by [-96,0])', () => {
    const b = new Board()
    const g = groundSpeech(b, '포물선을 오른쪽으로 이만큼 이동', [], 'dir', 'final')
    expect(rejectUngrounded([sanitizeOp({ v: 'move', id: 'o5', by: [-96, 0], dur: 900 })!], g, b)).toBe('말한 방향과 반대로 이동')
    expect(rejectUngrounded([sanitizeOp({ v: 'move', id: 'o5', by: [96, 0], dur: 900 })!], g, b)).toBeNull()
  })

  // logs/20261101-062040-k4sv.jsonl n=1195: "그래서 지구가 돌면서 여름에서 겨울로 바뀌어요"에 대한 응답 원문
  const earthRaw = '{"conf":0.7,"ops":[{"v":"flow","along":"o2","n":6,"speed":1.0,"color":"amber"},{"v":"move","id":"o1","along":"o2","loop":true,"dur":6000}],"cap":"지구가 공전 궤도를 따라 돈다"}'
  const earthAt = () => {
    const c = fixture('real-orbit-062040')
    const b = boardAt(c, 1189)
    const id = realIds(c, b, 1189)
    return { b, id, g: groundSpeech(b, '그래서 지구가 돌면서 여름에서 겨울로 바뀌어요', [], 'earth', 'final') }
  }

  it('장면 해석이 "공전 궤도"라고 붙인 타원을 흐름·공전 경로로 쓴다', () => {
    const { b, id, g } = earthAt()
    expect(b.get(id('o2'))?.label).toMatch(/궤도/)
    const ops = remapOps(opsOf(earthRaw), id)
    expect(keepGrounded(ops, g, b)).toMatchObject({ ops, dropped: [], reason: null })
    expect(new Engine(b, () => {}).validateStep(ops)).toBeNull()
  })

  it('흐름 하나가 근거 없이 막혀도 같은 단계의 공전 이동은 살린다', () => {
    const { b, id, g } = earthAt()
    const ops = remapOps(opsOf(earthRaw), id)
    const badFlow = { ...ops[0], along: id('o3') } as Op // 태양(경로 아님)
    const kept = keepGrounded([badFlow, ops[1]], g, b)
    expect(kept.ops).toEqual([ops[1]])
    expect(kept.reason).toBe('흐름의 근거 또는 연결 경로가 없음')
  })

  it('교환의 한쪽만 막히면 단계 전체를 막는다', () => {
    const { b, id } = sortAt(210)
    const g = groundSpeech(b, '5와 3이 바뀝니다', [], 'swap', 'final')
    const ops = remapOps(opsOf('{"ops":[{"v":"move","id":"o8","to":"o10"},{"v":"move","id":"o10","to":"o8"}],"cap":"x"}'), id)
    expect(keepGrounded(ops, g, b).ops).toEqual([])
  })

  // logs/20261101-065948-uid5.jsonl: 천장 o36, 진자 원 o37
  it('진자: 매단 점을 축으로 왕복시키고 stop·restore로 멈추고 되돌린다', () => {
    const c = fixture('real-pendulum-065948')
    const b = boardAt(c, 1727)
    // 실측의 진자(줄+추를 한 객체로 그림, 장면 해석은 '세포'로 붙임)
    const bob = b.objs.find((o) => o.strokes.some((s) => s.id === 'mvwyfxh7zwh4srsw'))!.id
    expect(b.get(bob)?.label).toBe('세포')
    const g = groundSpeech(b, '진자를 움직여줘', [], 'pend', 'final')
    const swing = sanitizeOp({ v: 'rotate', id: bob, deg: 30, about: [500, 35], loop: true, dur: 2000 })!
    expect(rejectUngrounded([swing], g, b)).toBeNull()
    expect(rejectUngrounded([swing], groundSpeech(b, '진자가 매달려 있어요.', [], 'p0', 'final'), b)).toBe('돌리라는 입력이 없음')
    const e = new Engine(b, () => {})
    expect(e.validateStep([swing])).toBeNull()
    const before = e.settled(bob)
    e.beginStep()
    e.applyOp(swing, 0)
    e.tick(500, .5)
    expect(e.anim[bob].rot).toBeCloseTo(Math.PI / 6)
    expect(e.settled(bob)).toEqual(before) // 왕복은 제자리 기준
    expect(e.describe()).toContain(`${bob}(왕복)`)
    e.applyOp({ v: 'stop', id: bob }, 600)
    e.tick(1500, .5)
    expect(e.anim[bob].rot).toBeCloseTo(Math.PI / 6)
    e.applyOp({ v: 'restore', dur: 300 }, 1600)
    e.tick(2000, .4)
    expect(e.anim[bob].rot).toBeCloseTo(0)
  })

  it('장면 해석 프롬프트에 최근 발화가 들어간다 (공을 사람 머리, 진자를 세포로 붙였음)', () => {
    const b = boardAt(fixture('real-pendulum-065948'), 1727)
    const text = describeScene(b, ['천장에', '진자가 매달려 있어요.'])
    expect(text).toContain('교수자의 최근 발화')
    expect(text).toContain('진자가 매달려 있어요.')
    expect(SCENE_PROMPT).not.toContain('세포')
  })
})

it('064132: 장면 해석 전의 왼쪽 테두리 획이 있어도 정렬 완료를 계산한다', () => {
  const c = fixture('real-sort-064132')
  const b = boardFor(c)
  for (const [id, read] of Object.entries({ o8: '5', o9: '3', o10: '8', o11: '1' })) b.get(id)!.read = read
  const plan = planNumericSort(b, new Engine(b, () => {}), '아무튼 정렬이 완료되면은')
  expect(plan?.cap).toBe('1, 3, 5, 8 순서로 정렬')
})

describe('좌표축 (06:48 실측: x축 화살표에 TCP 패킷 같은 입자가 흐름)', () => {
  /** 사례를 다시 그리며 '화살표' 사건마다 즉시 반응을 모은다 */
  const arrowQuicks = (name: string) => {
    const b = new Board()
    const out: { id: string; ops: Op[] }[] = []
    for (const e of fixture(name).events) {
      const ev = b.apply(e)
      if (ev?.kind === '화살표' && ev.objId) out.push({ id: ev.objId, ops: quickFromBoard(ev, b) })
    }
    return { b, out }
  }

  it('좌표평면의 x축·이동량 화살표에는 입자를 흘리지 않는다', () => {
    const { b, out } = arrowQuicks('real-graph-064858')
    expect(out.length).toBeGreaterThanOrEqual(3)
    expect(out.every((q) => q.ops.length === 0)).toBe(true)
    expect([...b.axes()].sort()).toEqual(['o2', 'o3'])
    expect(b.isFlowPath('o3')).toBe(false)
  })

  it('포물선 실측의 축(머리를 한 획에 그린 x축)도 축으로 본다', () => {
    for (const name of ['real-parabola-040451', 'real-parabola-041515']) expect(boardFor(fixture(name)).axes().size, name).toBe(2)
  })

  it('TCP 화살표와 배열 테두리는 축이 아니고, TCP 화살표에는 그대로 입자가 흐른다', () => {
    const { out } = arrowQuicks('real-tcp-012355')
    expect(out.length).toBeGreaterThan(0)
    expect(out.every((q) => q.ops[0]?.v === 'flow')).toBe(true)
    for (const name of ['real-sort-012355', 'real-sort-064132', 'real-sort-022839', 'real-sort-055444', 'bubble-sort-tall-eight', 'real-blood-012355', 'real-orbit-062040']) {
      const b = new Board()
      for (const e of fixture(name).events) { b.apply(e); expect(b.axes().size, name).toBe(0) }
    }
  })
})

describe('08:46 실측: 태양 주위를 도는 지구', () => {
  // logs 084606 n=486: "그래서 지구가 돌면서 여름에서 겨울로 바뀌어요"에 대한 응답 원문
  const raw = '{"conf":0.8,"ops":[{"v":"rotate","id":"o8","deg":360,"about":"o8","dur":6000,"loop":true},{"v":"flow","along":"o9","n":4,"speed":0.8,"color":"amber"}],"cap":"지구 자전으로 낮과 밤이 바뀜"}'
  const text = '그래서 지구가 돌면서 여름에서 겨울로 바뀌어요'

  it('가운데 큰 원을 돌리지 않고 궤도 위 작은 원을 궤도를 따라 돌린다', () => {
    const c = fixture('real-orbit-084606')
    const b = boardAt(c, 484)
    const id = realIds(c, b, 484)
    const ops = repairOrbit(remapOps(opsOf(raw), id), text, b)
    expect(ops[0]).toMatchObject({ v: 'move', id: id('o10'), along: id('o9'), loop: true })
    const g = groundSpeech(b, text, [], 'a', 'final')
    expect(keepGrounded(ops, g, b).ops.map((op) => op.v)).toContain('move')
    expect(new Engine(b, () => {}).validateStep(ops)).toBeNull()
  })

  it('"자전"이라고 말하면 제자리 회전을 그대로 둔다', () => {
    const c = fixture('real-orbit-084606')
    const b = boardAt(c, 484)
    const ops = remapOps(opsOf(raw), realIds(c, b, 484))
    expect(repairOrbit(ops, '지구가 자전해요', b)[0].v).toBe('rotate')
  })
})

describe('09:07 실측: 천장에 매단 진자', () => {
  // logs 090717 n=542: "천장에 매달린 진자요 이 추는 여기 그려진 이 호를 왔다갔다해요"에 대한 응답 원문
  const raw = '{"conf":0.85,"ops":[{"v":"rotate","id":"o26","deg":30,"about":[746,0],"dur":900,"loop":true}],"cap":"추가 진자처럼 왔다 갔다"}'

  it('페이지 맨 위가 아니라 천장에 닿은 실의 위쪽 끝을 고정점으로 흔든다', () => {
    const c = fixture('real-pendulum-090717')
    const b = boardAt(c, 540)
    const id = realIds(c, b, 540)
    const ops = repairPendulum(remapOps(opsOf(raw), id), b)
    expect(ops).toHaveLength(1)
    const about = (ops[0] as { about: [number, number] }).about
    expect(Math.abs(about[0] - 838)).toBeLessThan(6) // 실이 시작한 점 (838,341)
    expect(Math.abs(about[1] - 340)).toBeLessThan(6) // 천장 높이
    expect(new Engine(b, () => {}).validateStep(ops)).toBeNull()
  })

  it('이미 실 끝을 기준점으로 준 응답은 그대로 둔다', () => {
    const c = fixture('real-pendulum-090717')
    const b = boardAt(c, 540)
    const ops = remapOps(opsOf(raw.replace('[746,0]', '[836,345]')), realIds(c, b, 540))
    expect(repairPendulum(ops, b)).toEqual(ops)
  })
})

describe('08:57 실측: 궤도 자체를 돌린 응답', () => {
  // logs 085717 n=155: 태양 o2, 궤도 타원 o3(상자), 지구 o4, 지구에 그린 자전축 o5
  const raw = '{"conf":0.7,"ops":[{"v":"pulse","id":"o2"},{"v":"rotate","id":"o3","deg":360,"about":"o2","dur":4000,"loop":true}],"cap":"지구가 태양 주위를 돈다"}'
  const text = '지구는 반대편으로 가도 죽은 같은 방향이에요 그래서 지구가 돌면서 여름에서 겨울로 바뀌어요'

  it('궤도를 돌리지 않고 지구와 자전축을 함께 궤도를 따라 돌린다', () => {
    const c = fixture('real-orbit-085717')
    const b = boardAt(c, 153)
    const id = realIds(c, b, 153)
    const ops = repairOrbit(remapOps(opsOf(raw), id), text, b)
    expect(ops.find((op) => op.v === 'rotate')).toBeUndefined()
    const moved = ops.filter((op) => op.v === 'move').map((op) => op as { id: string; along: string; loop: boolean })
    expect(moved.map((op) => op.id).sort()).toEqual([id('o4'), id('o5')].sort())
    expect(moved.every((op) => op.along === id('o3') && op.loop)).toBe(true)
    expect(keepGrounded(ops, groundSpeech(b, text, [], 'a', 'final'), b).ops.filter((op) => op.v === 'move')).toHaveLength(2)
    expect(new Engine(b, () => {}).validateStep(ops)).toBeNull()
  })
})

describe('09:07 실측: 수요가 오른쪽으로 옮겨 가면 균형점이 새 교점으로', () => {
  // 수요 o21, 공급 o22, 교점에 쓴 E (o23, o24)
  const c = fixture('real-pendulum-090717')

  it('수요선을 민 만큼 E가 새 교점(위·오른쪽)으로 따라간다', () => {
    const b = boardAt(c, 392)
    const id = realIds(c, b, 392)
    const e = new Engine(b, () => {})
    // n=399 실행된 동작
    const ops = followIntersections([{ v: 'move', id: id('o21'), by: [60, 0], dur: 700 }], '수요 그래프가 오른쪽으로 옮겨 가요 그러면 균형 점이', b, e)
    const follow = ops.filter((op) => op.v === 'move' && op.id !== id('o21')) as { id: string; by: [number, number] }[]
    expect(follow.map((op) => op.id).sort()).toEqual([id('o23'), id('o24')].sort())
    for (const op of follow) {
      expect(op.by[0]).toBeGreaterThan(15) // 오른쪽
      expect(op.by[1]).toBeLessThan(-15) // 위 (가격 상승)
    }
    expect(e.validateStep(ops)).toBeNull()
  })

  it('"위로 올라가서 가격이 올라요"에 수요선을 위로 또 밀지 않는다 (n=408 응답)', () => {
    const b = boardAt(c, 392)
    const id = realIds(c, b, 392)
    const e = new Engine(b, () => {})
    const raw = remapOps(opsOf('{"ops":[{"v":"move","id":"o21","by":[0,-60],"dur":900},{"v":"pulse","id":"o24"}],"cap":"x"}'), id)
    expect(followIntersections(raw, '위로 올라가서 가격이 올라요', b, e).map((op) => op.v)).toEqual(['pulse'])
  })
})

describe('05:04 실측: 한 획으로 그린 화살표', () => {
  // 화살표를 그은 순간의 칠판으로 본다 (나중에 지우거나 장면 해석이 바꿈)
  const arrows = (name: string) => {
    const b = new Board()
    const out: { obj: NonNullable<ReturnType<Board['get']>>; quick: Op[]; path: boolean }[] = []
    for (const e of fixture(name).events) {
      const ev = b.apply(e)
      if (ev?.kind !== '화살표' || !ev.desc.startsWith('화살표 o')) continue
      const obj = b.get(ev.objId!)!
      out.push({ obj: { ...obj, pts: [...obj.pts!] }, quick: quickFromBoard(ev, b), path: b.isFlowPath(obj.id) })
    }
    return out
  }

  it('확산 교안: 몸통과 머리를 한 획으로 그린 화살표를 화살표로 보고 바로 흐름을 붙인다 (반응 없음)', () => {
    const got = arrows('real-diffusion-050449')
    expect(got.length).toBeGreaterThanOrEqual(6)
    for (const a of got) {
      expect(a.obj).toMatchObject({ kind: 'line', arrowEnd: 'end' })
      expect(a.quick.map((op) => op.v)).toEqual(['flow'])
    }
  })

  it('광합성 교안: 나중에 그린 CO2·O2 화살표도 흐름 경로가 된다', () => {
    const got = arrows('real-photo-050449')
    expect(got.length).toBeGreaterThanOrEqual(1)
    expect(got.every((a) => a.path)).toBe(true)
  })

  it('화살표의 경로는 머리 끝에서 끝나고 날개로 꺾이지 않는다', () => {
    for (const { obj } of arrows('real-diffusion-050449')) {
      const all = obj.strokes[0].pts
      const start = all[0]
      const tip = obj.pts![obj.pts!.length - 1]
      expect(Math.hypot(tip.x - start.x, tip.y - start.y)).toBeCloseTo(Math.max(...all.map((p) => Math.hypot(p.x - start.x, p.y - start.y))), 0)
    }
  })
})

describe('05:04 실측: 포물선을 화살표·축을 "따라" 옮긴 응답', () => {
  const c = fixture('real-parabola-050449')

  it('위에 있지 않은 화살표를 따라가지 않고 화살표 시작→머리 끝만큼 평행이동한다 (n=210 응답)', () => {
    const b = boardAt(c, 210)
    const id = realIds(c, b, 210)
    const e = new Engine(b, () => {})
    const [op] = alongToShift(remapOps(opsOf('{"ops":[{"v":"move","id":"o4","along":"o5","dur":900}],"cap":"x"}'), id), b, e, 1e12) as { v: string; by?: [number, number] }[]
    expect(op.v).toBe('move')
    expect(op.by![0]).toBeGreaterThan(150) // 오른쪽으로 화살표 길이(약 194px)
    expect(Math.abs(op.by![1])).toBeLessThan(10) // y로 내려가지 않음
  })
})
