import type { Board, BoardEvent } from './board'
import type { Engine } from './engine'
import { clamp } from './geometry'
import { COLORS, type Op } from './ops'

/**
 * 즉시 반응 규칙. AI 응답을 기다리지 않고 수십 ms 안에 뭔가 움직이게 한다.
 * 확실한 신호에만 반응하고, 자세한 대본은 AI가 이어서 채운다.
 * 여기서 만드는 효과의 id는 q로 시작한다 (AI에게는 알리지 않음).
 */

let seq = 0
const effectId = () => 'q' + ++seq

export function quickFromBoard(ev: BoardEvent, board: Board): Op[] {
  const id = ev.objId
  if (!id) return []
  switch (ev.kind) {
    case '화살표':
      return [{ v: 'flow', along: id, n: 6, speed: 1.2, color: COLORS.cyan, rev: !!ev.rev }]
    case '덧그리기': {
      // 표 테두리·밑줄을 다시 그은 건 강조일 뿐 흐름이 아니다. 화살표나 긴 선일 때만 흐름
      const o = board.get(id)
      const long = !!o?.pts && Math.hypot(o.bbox.w, o.bbox.h) > 150
      if (board.isGridLine(id) || board.underlineOf(id) || !(o?.arrowEnd || long)) return []
      return [{ v: 'flow', along: id, n: 10, speed: 1.6, color: '#cdf0ff', rev: !!ev.rev }]
    }
    case '다시 쓰기':
      return [{ v: 'pulse', id }]
    case '가리키기': {
      const tr = board.traces.find((t) => t.id === id)
      if (!tr) return []
      const p = tr.pts[0]
      const dot = effectId()
      const dur = clamp(tr.dur * 1000, 400, 2500)
      return [
        { v: 'spawn', id: dot, shape: 'dot', at: [p.x, p.y], text: '', color: COLORS.amber, r: 7, w: 60, h: 40, life: dur + 500 },
        { v: 'move', id: dot, along: id, dur },
      ]
    }
  }
  return []
}

/** 가장 최근에 그린 화살표 (흐름 키워드는 방향이 분명한 화살표에만) */
function latestArrow(board: Board) {
  return [...board.objs].reverse().find((o) => o.kind === 'line' && o.arrowEnd && !board.isGridLine(o.id))
}

/** 말에서 확실한 키워드가 나오면 바로 반영. 이미 쓴 규칙(fired)은 같은 문장에서 다시 쓰지 않는다 */
export function quickFromSpeech(text: string, board: Board, engine: Engine, fired: Set<string>): Op[] {
  const flowing = engine.flows.map((f) => f.along)
  const arrow = latestArrow(board)
  const rules: { key: string; re: RegExp; make: () => Op[] }[] = [
    {
      key: 'congest',
      re: /(막히|막혀|막힌|몰리|몰려|쌓이|쌓여|병목|밀려|정체)/,
      make: () => {
        const along = flowing[flowing.length - 1] ?? arrow?.id
        return along ? [{ v: 'flow', along, n: 16, speed: 0.35, color: COLORS.red, rev: !!arrow?.arrowEnd && arrow.arrowEnd === 'start' }] : []
      },
    },
    {
      key: 'stop',
      re: /(멈춰|멈추|멈춘|정지|끊기|끊겨|끊어)/,
      make: () => flowing.map((along) => ({ v: 'stop' as const, along })),
    },
    {
      key: 'flow',
      re: /(흘러|흐르|흐름|보내|전송|이동|지나가|들어가|들어와|퍼져|퍼지|전달)/,
      make: () =>
        arrow && !flowing.includes(arrow.id)
          ? [{ v: 'flow', along: arrow.id, n: 8, speed: 1.2, color: '#cdf0ff', rev: arrow.arrowEnd === 'start' }]
          : [],
    },
  ]
  for (const rule of rules) {
    if (fired.has(rule.key) || !rule.re.test(text)) continue
    const ops = rule.make()
    if (!ops.length) continue
    fired.add(rule.key)
    return ops
  }
  return []
}

/** 시간 접속어: 설명이 다음 단계로 넘어간다는 신호 */
export const CONNECTIVES =
  /(그\s?다음|그러면|그럼|그래서|그러고\s?나서|그리고\s?나서|다시|결국|이번엔|이번에는|마지막으로|먼저|처음엔|처음에는|그런데|이제|계속|반복)/g
