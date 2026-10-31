import type { Board } from './board'
import type { Op } from './ops'
import type { Engine } from './engine'

export interface Grounding {
  id: string
  phase: 'preview' | 'final' | 'ink' | 'test'
  text: string
  targets: string[]
  move: boolean
  flow: boolean
  stop: boolean
  sort: boolean
}

const numberWords: Record<string, string> = { 영: '0', 일: '1', 이: '2', 삼: '3', 사: '4', 오: '5', 육: '6', 칠: '7', 팔: '8', 구: '9' }
const MOVE = /바[뀌뀔꾸꿀꿔]|교환|옮[기겨]|이동[하해한할시]|(?:앞|뒤)로.{0,8}(가|보내)|넣|꺼내|밀[려리어]|push|pop|enqueue|dequeue/i

/** 독립된 수/조사 붙은 수만 읽는다. '과일', '사회', '오른쪽' 안의 글자는 숫자가 아니다. */
export function mentionedValues(text: string): string[] {
  const values: string[] = []
  text = text.replace(/([영일이삼사오육칠팔구])(랑|과|와|하고)(?=[영일이삼사오육칠팔구])/g, '$1$2 ')
  const re = /\d+(?:\.\d+)?|(?:^|[\s,])([영일이삼사오육칠팔구])(?=\s|$|[,.?!]|랑|하고|과|와|을|를|이|가|은|는|보다)/g
  for (const m of text.matchAll(re)) values.push(m[1] ? numberWords[m[1]] : m[0])
  // 실측 ASR의 '팔 과일을 비교'는 비교 문맥에서만 8과 1로 해석한다.
  if (/(비교|비유)/.test(text) && /(?:팔|8)\s*과일/.test(text)) values.push('8', '1')
  return [...new Set(values)]
}

export function groundSpeech(board: Board, text: string, focus: string[], id: string, phase: Grounding['phase'], engine?: Engine): Grounding {
  const values = board.values()
  // "바꾸고 그다음 X/Y 비교"에서 뒤의 비교 대상을 앞의 이동에 사용하지 않는다.
  const clauses = text.split(/그\s*다음(?:에)?/)
  const actionText = clauses.length > 1 && MOVE.test(clauses[0]) ? clauses[0] : text
  const mentions = mentionedValues(actionText)
  let named = mentions.flatMap((v) => {
    const matches = values.filter((o) => (o.read ?? o.text) === v)
    return matches.length === 1 ? [matches[0].id] : [] // 중복 숫자는 말만으로 특정하지 않는다
  })
  const ordered = [...values].sort((a, b) => (engine?.settled(a.id)?.x ?? a.bbox.x) - (engine?.settled(b.id)?.x ?? b.bbox.x))
  const ordinals = [...actionText.matchAll(/(\d+)\s*번째|첫\s*번째|두\s*번째/g)].map((m) => m[1] ? Number(m[1]) : m[0].startsWith('첫') ? 1 : 2)
  if (ordinals.length) {
    named = ordinals.flatMap((n) => ordered[n - 1] ? [ordered[n - 1].id] : [])
  }
  const compare = /(비교|비유|더\s*크|더\s*작)/.test(actionText)
  const freshFocus = focus.filter((id) => values.some((o) => o.id === id))
  let targets = named
  if (named.length === 1 && freshFocus.includes(named[0])) targets = freshFocus
  else if (!named.length && (compare || /둘|서로|자리|뒤로|앞으로|바[뀌뀔꾸꿀꿔]|교환/.test(actionText))) targets = freshFocus
  // 새 비교를 특정하지 못했다면 이전 쌍으로 잘못 넘기지 않는다.
  if (!ordinals.length && compare && mentions.length >= 2 && named.length !== mentions.length) targets = []
  const negated = /(바꾸지|바뀌지|옮기지|움직이지|교환.{0,6}(없|않)|그대로|아직|하지\s*마)/.test(actionText)
  const sort = !negated && /정[렬리]|조율/.test(text) && /(완료|완성|끝까지|끝나|최종)/.test(text)
  const move = !negated && (sort || MOVE.test(actionText))
  if (/버블|인접/.test(board.page.text ?? '')) {
    // "앞에 있는 값을 먼저 비교"는 처음 두 칸. 읽은 값과 일치할 때만 해석한다.
    if (/앞에.{0,25}먼저\s*비교/.test(actionText) && named.length === 1 && ordered.slice(0, 2).some((o) => o.id === named[0])) {
      targets = ordered.slice(0, 2).map((o) => o.id)
    }
    const directional = actionText.match(/(\d+|[영일이삼사오육칠팔구])(?:이|가|을|를)?\s*(뒤로|앞으로)/)
    const subject = directional ? values.filter((o) => (o.read ?? o.text) === (numberWords[directional[1]] ?? directional[1])) : []
    const solo = subject.length === 1 ? subject[0].id : targets.length === 1 ? targets[0] : undefined
    if (move && solo && /뒤로|앞으로/.test(actionText)) {
      const index = ordered.findIndex((o) => o.id === solo)
      const other = ordered[index + (/뒤로/.test(actionText) ? 1 : -1)]
      targets = other ? [solo, other.id] : []
    }
  }
  return {
    id, phase, text, targets, move, sort,
    flow: /(흘러|흐르|흐름|보내|전송|이동|지나가|들어가|들어와|퍼져|퍼지|전달|돌아와|순환)/.test(text),
    stop: /(멈춰|멈추|멈춘|정지|끊기|끊겨|끊어)/.test(text),
  }
}

/** 두 숫자의 명시적인 교환은 목표 자리를 엔진에 함께 넘긴다. */
export function planNumericSwap(board: Board, engine: Engine, g: Grounding): { ops: Op[]; cap: string } | null {
  if (!g.move || g.sort || g.targets.length !== 2) return null
  const [a, b] = g.targets.map((id) => board.values().find((o) => o.id === id))
  if (!a || !b || ![a, b].every((o) => /^-?\d+(\.\d+)?$/.test(o.read ?? o.text ?? ''))) return null
  const explicitSwap = /바[뀌뀔꾸꿀꿔]|교환/.test(g.text)
  const adjacentSort = /버블|인접/.test(board.page.text ?? '') && /뒤로|앞으로/.test(g.text)
  if (!explicitSwap && !adjacentSort) return null
  const pa = engine.settled(a.id)!, pb = engine.settled(b.id)!
  if (Math.abs(pa.y - pb.y) > Math.max(a.bbox.h, b.bbox.h) * .6) return null
  // 정렬의 방향 설명을 반복했다고 이미 순서가 맞는 쌍을 뒤집지 않는다.
  if (!explicitSwap && (pa.x < pb.x ? Number(a.read ?? a.text) <= Number(b.read ?? b.text) : Number(b.read ?? b.text) <= Number(a.read ?? a.text))) {
    return { ops: [{ v: 'pulse', id: a.id }, { v: 'pulse', id: b.id }], cap: '이미 설명한 순서입니다' }
  }
  return { ops: [{ v: 'move', id: a.id, to: b.id, dur: 700 }, { v: 'move', id: b.id, to: a.id, dur: 700 }], cap: `${a.read ?? a.text}와 ${b.read ?? b.text} 교환` }
}

/** 모델의 캡션 대신 확정된 입력을 근거로 상태를 바꾸는 동작을 허용한다. */
export function rejectUngrounded(ops: Op[], g: Grounding, board: Board): string | null {
  if (g.phase === 'test') return null
  if (g.phase === 'preview' && ops.some((op) => op.v !== 'pulse' && op.v !== 'color')) return '말이 아직 확정되지 않음'
  const moves = ops.filter((op) => op.v === 'move')
  if (moves.length) {
    if (!g.move) return '이동을 지시한 입력이 없음'
    if (moves.some((op) => board.underlineOf(op.id) || (typeof op.to === 'string' && board.underlineOf(op.to)))) return '밑줄은 이동할 값이 아님'
    const numeric = board.values().filter((o) => /^-?\d+(\.\d+)?$/.test(o.read ?? o.text ?? ''))
    const movedNumbers = moves.filter((op) => numeric.some((o) => o.id === op.id))
    // 숫자끼리 자리를 바꿀 때 다른 줄로 보내지 않는다 (실측: 배열 위에 따로 쓴 "8"과 1을 바꿔 1이 튐)
    const cy = (o: { bbox: { y: number; h: number } }) => o.bbox.y + o.bbox.h / 2
    for (const op of movedNumbers) {
      const a = numeric.find((o) => o.id === op.id)!
      const b = typeof op.to === 'string' ? numeric.find((o) => o.id === op.to) : undefined
      if (b && Math.abs(cy(a) - cy(b)) > Math.max(a.bbox.h, b.bbox.h) * 0.6) return '다른 줄의 값과 교환'
    }
    if (movedNumbers.length && !g.sort) {
      if (!g.targets.length) return '이동할 값이 특정되지 않음'
      if (movedNumbers.some((op) => !g.targets.includes(op.id) || (typeof op.to === 'string' && numeric.some((o) => o.id === op.to) && !g.targets.includes(op.to)))) {
        return '지금 말한 비교/이동 대상과 다름'
      }
    }
  }
  if (ops.some((op) => op.v === 'flow' && (!g.flow || !board.isFlowPath(op.along)))) return '흐름의 근거 또는 연결 경로가 없음'
  if (g.phase === 'ink' && ops.some((op) => op.v === 'flow' && !g.targets.includes(op.along))) return '지금 그린 경로와 다름'
  if (ops.some((op) => op.v === 'stop') && !g.stop) return '흐름을 멈추라는 입력이 없음'
  if (g.phase === 'ink' && ops.some((op) => !['pulse', 'color', 'flow'].includes(op.v))) return '필기만으로 다음 과정을 실행할 수 없음'
  return null
}

/** 명시적인 전체 정렬 요청에서만 사용. 값이 불명확하거나 여러 행이면 모델에 맡긴다. */
export function planNumericSort(board: Board, engine: Engine, text: string): { ops: Op[]; cap: string } | null {
  const values = board.values()
  const numbers = values.filter((o) => /^-?\d+(\.\d+)?$/.test(o.read ?? o.text ?? ''))
  if (numbers.length < 2) return null
  const row = numbers.map((o) => ({ o, p: engine.settled(o.id)!, v: Number(o.read ?? o.text) })).sort((a, b) => a.p.x - b.p.x)
  const h = Math.max(...numbers.map((o) => o.bbox.h))
  if (Math.max(...row.map((r) => r.p.y)) - Math.min(...row.map((r) => r.p.y)) > h * .6) return null
  if (values.some((o) => !numbers.includes(o) && Math.abs(engine.settled(o.id)!.y - row[0].p.y) < h * .6)) return null
  const direction = /내림|큰\s*값부터|큰\s*수부터/.test(text) ? -1 : 1
  const sorted = [...row].sort((a, b) => direction * (a.v - b.v))
  const ops: Op[] = sorted.flatMap((r, i) => r.o.id === row[i].o.id ? []
    : [{ v: 'move' as const, id: r.o.id, to: [row[i].p.x, row[i].p.y] as [number, number], dur: 700 }])
  if (!ops.length) ops.push(...sorted.map((r) => ({ v: 'pulse' as const, id: r.o.id })))
  return { ops, cap: `${sorted.map((r) => r.v).join(', ')} 순서로 정렬` }
}

export function describeGrounding(g: Grounding) {
  return `이번 입력의 실행 범위: ${g.phase === 'preview' ? '말하는 중: pulse/color만. 이동은 확정 후.' : g.phase === 'ink' ? '필기 해석과 강조만.' : '확정 발화.'}\n현재 특정된 대상: ${g.targets.join(', ') || '(미확정)'}\n이동 허용: ${g.move ? '예' : '아니오'}, 전체 정렬 요청: ${g.sort ? '예' : '아니오'}\n이 범위 밖의 대상이나 다음 비교를 추측하지 않는다.`
}
