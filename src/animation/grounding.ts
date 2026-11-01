import type { Board } from './board'
import type { Op } from './ops'
import type { Engine } from './engine'
import { distToSegment } from './geometry'

export interface Grounding {
  id: string
  phase: 'preview' | 'final' | 'ink' | 'test'
  text: string
  targets: string[]
  move: boolean
  flow: boolean
  stop: boolean
  sort: boolean
  /** 움직인 것을 처음 자리로 되돌리라는 말 */
  restore: boolean
  /** "안 바뀌겠죠"처럼 움직이지 않는다고 한 말 */
  negated: boolean
}

const numberWords: Record<string, string> = { 영: '0', 일: '1', 이: '2', 삼: '3', 사: '4', 오: '5', 육: '6', 칠: '7', 팔: '8', 구: '9' }
const SWAP = /바[뀌뀔꾸꿀꿔뀝뀐꿉꾼]|교환/
// 실측(06시~07시)에서 놓친 표현: 바뀝니다·바뀐다·이동했어요·이동을 해볼게요·떨어져·돌아요·움직여줘·왔다 갔다·올라가면·내려와요
const MOVE = new RegExp([
  SWAP.source, '옮[기겨긴길]', '이동(?:[하해한할시했되됐됩돼]|을\\s*[해하시]|\\s*$|[.?!,])', '(?:앞|뒤)로.{0,8}(가|보내)', '넣', '꺼내', '밀[려리어]',
  '떨어[지져진질뜨트]', '움직[여이인일]', '돌[아고면며려리]', '돈다', '도는', '회전', '빙글', '굴러', '흔들', '왔다\\s*갔다', '올라[가와갑간갈]', '내려[가와오갑간갈]',
  '날아', '튀[어었]', '당[겨기]', '되돌', '제자리', 'push', 'pop', 'enqueue', 'dequeue',
].join('|'), 'i')
/** "안 바뀌겠죠", "못 옮겨요"처럼 움직이지 않는다는 말 (실측: "안 바뀌겠더라"에 5·8을 교환함) */
const NEGATED = /바꾸지|바뀌지|옮기지|움직이지|교환.{0,6}(없|않)|그대로|아직|하지\s*마|(?:안|못)\s*(?:바[뀌뀔꾸꿀꿔뀝뀐꿉]|옮|움직|떨어|돌|이동|교환|내려|올라)/
/** 처음 자리로 되돌리기 (실측: "다시 돌아오세요"를 표현할 동작이 없었음) */
const RESTORE = /되돌|원래\s*(?:자리|대로|위치|상태)|제자리|다시\s*돌아|돌아\s*(?:와|오|가)|처음\s*(?:자리|상태)로/

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
  // 서수는 값이 있는 칸만 센다. 말한 숫자가 모두 특정되면 숫자를 믿는다
  // (실측 024015: "3번째, 4번째 꺼 8과 1을"에서 읽지 못한 낙서까지 칸으로 세어 엉뚱한 쌍을 잡았다)
  const cells = ordered.filter((o) => o.read ?? o.text)
  const row = cells.length >= Math.max(0, ...ordinals) ? cells : ordered
  if (ordinals.length && !(named.length >= 2 && named.length === mentions.length)) {
    named = ordinals.flatMap((n) => row[n - 1] ? [row[n - 1].id] : [])
  }
  const compare = /(비교|비유|더\s*크|더\s*작)/.test(actionText)
  const freshFocus = focus.filter((id) => values.some((o) => o.id === id))
  let targets = named
  if (named.length === 1 && freshFocus.includes(named[0])) targets = freshFocus
  else if (!named.length && (compare || /둘|서로|자리|뒤로|앞으로/.test(actionText) || SWAP.test(actionText))) targets = freshFocus
  // 새 비교를 특정하지 못했다면 이전 쌍으로 잘못 넘기지 않는다.
  if (!ordinals.length && compare && mentions.length >= 2 && named.length !== mentions.length) targets = []
  const negated = NEGATED.test(actionText)
  const sort = !negated && /정[렬리]|조율/.test(text) && /(완료|완성|끝까지|끝나|최종)/.test(text)
  const move = !negated && (sort || MOVE.test(actionText))
  if (/버블|인접/.test(board.page.text ?? '')) {
    // "앞에 있는 값을 먼저 비교"는 처음 두 칸. 읽은 값과 일치할 때만 해석한다.
    const line = cells.length >= 2 ? cells : ordered
    if (/앞에.{0,25}먼저\s*비교/.test(actionText) && named.length === 1 && line.slice(0, 2).some((o) => o.id === named[0])) {
      targets = line.slice(0, 2).map((o) => o.id)
    }
    // 숫자 뒤 '일'은 조사 '이'를 잘못 받아쓴 것이다 (실측 bent-frame: "8일 뒤로 가겠죠"를 1이 뒤로 가는 말로 읽음)
    const directional = actionText.match(/(\d+|[영일이삼사오육칠팔구])(?:이|가|을|를|(?<=\d)일)?\s*(뒤로|앞으로)/)
    const subject = directional ? values.filter((o) => (o.read ?? o.text) === (numberWords[directional[1]] ?? directional[1])) : []
    const solo = subject.length === 1 ? subject[0].id : targets.length === 1 ? targets[0] : undefined
    if (move && solo && /뒤로|앞으로/.test(actionText)) {
      const index = line.findIndex((o) => o.id === solo)
      const other = index < 0 ? undefined : line[index + (/뒤로/.test(actionText) ? 1 : -1)]
      targets = other ? [solo, other.id] : []
    }
  }
  return {
    id, phase, text, targets, move, sort, negated,
    restore: !negated && RESTORE.test(text),
    flow: /(흘러|흐르|흐름|보내|전송|이동|지나가|들어가|들어와|퍼져|퍼지|전달|돌아와|순환|돌[아고면며]|돈다|도는|공전|회전|굴러)/.test(text),
    stop: /(멈춰|멈추|멈춘|정지|끊기|끊겨|끊어)/.test(text),
  }
}

/** 두 숫자의 명시적인 교환은 목표 자리를 엔진에 함께 넘긴다. */
export function planNumericSwap(board: Board, engine: Engine, g: Grounding): { ops: Op[]; cap: string } | null {
  if (!g.move || g.sort || g.targets.length !== 2) return null
  const [a, b] = g.targets.map((id) => board.values().find((o) => o.id === id))
  if (!a || !b || ![a, b].every((o) => /^-?\d+(\.\d+)?$/.test(o.read ?? o.text ?? ''))) return null
  const explicitSwap = SWAP.test(g.text)
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
/**
 * 막는 규칙의 강도 (실측 비교용).
 * strict: 지금 규칙 전부 / words: 이동·흐름·멈춤 단어 목록 검사를 끔 / minimal: 숫자 규칙과 구조 검사만
 */
export type GateMode = 'strict' | 'words' | 'minimal'

/** 말한 방향: 오른쪽 +1, 왼쪽 -1 (가로), 아래 +1, 위 -1 (세로). 둘 다 말하거나 안 말하면 0 */
function spokenDirection(text: string): [number, number] {
  const sign = (pos: boolean, neg: boolean) => pos === neg ? 0 : pos ? 1 : -1
  return [sign(/오른쪽/.test(text), /왼쪽/.test(text)), sign(/아래\s*(?:로|쪽)|밑으로/.test(text), /위\s*(?:로|쪽)/.test(text))]
}

/**
 * 말한 방향과 반대 부호인 by를 말한 방향으로 바로잡는다. 크기는 그대로 둔다.
 * 실측 082838: "오른쪽으로 8만큼"에 by [-192,0]처럼 매번 왼쪽으로 밀었다 (y=(x-2)²의 '마이너스'에 끌림)
 */
export function alignDirection(ops: Op[], text: string): Op[] {
  const [dx, dy] = spokenDirection(text)
  if (!dx && !dy) return ops
  return ops.map((op) => {
    if (op.v !== 'move' || !op.by) return op
    const [bx, by] = op.by
    const x = dx && Math.sign(bx) === -dx ? -bx : bx
    const y = dy && Math.sign(by) === -dy ? -by : by
    return x === bx && y === by ? op : { ...op, by: [x, y] as [number, number] }
  })
}

/**
 * "오른쪽으로 이만큼"의 이만큼은 방금 그린 이동량 화살표다. 그 화살표의 가로(세로) 변위로 by를 정한다.
 * 실측 082838: 60px 화살표를 그리고 "오른쪽으로 이만큼"이라 했는데 by [-16,0]으로 거의 안 움직였다.
 */
export function measureTranslation(ops: Op[], text: string, board: Board, now: number): Op[] {
  if (!/[이요그]\s*만큼|이\s*정도/.test(text)) return ops
  const [dx, dy] = spokenDirection(text)
  if (!dx && !dy) return ops
  const axes = board.axes()
  const arrow = board.objs
    .filter((o) => o.kind === 'line' && o.arrowEnd && o.pts && o.pts.length >= 2 && !axes.has(o.id) && now - o.t < 120000)
    .sort((a, b) => b.t - a.t)[0]
  if (!arrow?.pts) return ops
  const [a, z] = [arrow.pts[0], arrow.pts[arrow.pts.length - 1]]
  const vx = Math.abs(z.x - a.x), vy = Math.abs(z.y - a.y)
  const by: [number, number] = [dx ? dx * Math.round(vx) : 0, dy ? dy * Math.round(vy) : 0]
  if (Math.hypot(...by) < 20) return ops
  return ops.map((op) => op.v === 'move' && op.by && op.id !== arrow.id ? { ...op, by } : op)
}

/**
 * 공전: 궤도 안쪽 객체를 제자리에서 돌리는 응답을, 궤도 위에 있는 객체가 궤도를 따라 도는 이동으로 바꾼다.
 * 실측 084606: "태양 주위를 도는 지구"라고 한 뒤 "지구가 돌면서"에 가운데 큰 원(태양)을 돌렸다.
 * "자전"이라고 말했으면 제자리 회전이 맞으므로 그대로 둔다.
 */
export function repairOrbit(ops: Op[], text: string, board: Board): Op[] {
  if (/자전/.test(text) || !/돌|공전|궤도|주위/.test(text)) return ops
  const center = (b: { x: number; y: number; w: number; h: number }) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 })
  const paths = board.objs.filter((o) => o.kind === 'line' && o.pts && o.pts.length >= 3 && !board.underlineOf(o.id))
  return ops.map((op) => {
    if (op.v !== 'rotate' || !op.loop || (op.about !== undefined && op.about !== op.id)) return op
    const hub = board.get(op.id)
    if (!hub) return op
    const c = center(hub.bbox)
    const path = paths.find((p) => p.id !== hub.id && c.x > p.bbox.x && c.x < p.bbox.x + p.bbox.w && c.y > p.bbox.y && c.y < p.bbox.y + p.bbox.h)
    if (!path?.pts) return op
    const pts = path.pts
    const near = (o: typeof hub) => {
      const q = center(o.bbox)
      const d = Math.min(...pts.slice(1).map((b, i) => distToSegment(q, pts[i], b)))
      return d <= Math.max(40, Math.hypot(o.bbox.w, o.bbox.h) / 2 + 20)
    }
    const riders = board.objs.filter((o) => o.id !== hub.id && o.id !== path.id && o.kind !== 'line' && o.kind !== 'text' && near(o))
    if (riders.length !== 1) return op
    return { v: 'move', id: riders[0].id, along: path.id, loop: true, dur: op.dur }
  })
}

/**
 * 진자: 매단 점(실의 위쪽 끝)을 고정점으로 실과 추를 함께 흔든다.
 * - AI가 준 기준점이 진자의 맨 위 끝에서 멀면 그 끝점으로 바로잡는다 (실측 090717: about [746,0], 페이지 맨 위를 축으로 흔듦)
 * - 추만 흔들면 추에 닿아 위로 뻗은 실도 같은 고정점으로 함께 흔든다
 * 위쪽 끝 근처에 가로선(천장)이 있으면 그 높이에 붙인다.
 */
export function repairPendulum(ops: Op[], board: Board): Op[] {
  const swings = ops.filter((op): op is Extract<Op, { v: 'rotate' }> => op.v === 'rotate' && !!op.loop && Math.abs(op.deg) < 360 && !!board.get(op.id))
  if (!swings.length) return ops
  const ids = new Set(swings.map((op) => op.id))
  const ptsOf = (id: string) => board.get(id)!.strokes.flatMap((st) => st.pts)
  const top = (id: string) => ptsOf(id).reduce((a, b) => (b.y < a.y ? b : a))
  // 추에 닿아 위로 뻗은 실 (같은 단계에서 이미 흔드는 객체는 빼고)
  const strings = board.objs.filter((o) => {
    if (ids.has(o.id) || o.kind !== 'line' || !o.pts || o.arrowEnd || board.underlineOf(o.id)) return false
    const [a, z] = [o.pts[0], o.pts[o.pts.length - 1]]
    const [low, high] = a.y > z.y ? [a, z] : [z, a]
    if (low.y - high.y < 30) return false
    return swings.some((op) => {
      const b = board.get(op.id)!.bbox
      return low.x > b.x - 25 && low.x < b.x + b.w + 25 && low.y > b.y - 25 && low.y < b.y + b.h + 25 && high.y < b.y
    })
  })
  const parts = [...ids, ...strings.map((o) => o.id)]
  let pivot: { x: number; y: number } = parts.map(top).reduce((a, b) => (b.y < a.y ? b : a))
  const height = Math.max(...parts.map((id) => ptsOf(id).reduce((m, p) => Math.max(m, p.y), -Infinity))) - pivot.y
  const ceiling = board.objs.find((o) => !parts.includes(o.id) && o.kind === 'line' && o.bbox.w > 3 * o.bbox.h && o.bbox.w > 60
    && Math.abs(o.bbox.y + o.bbox.h / 2 - pivot.y) < 25 && pivot.x > o.bbox.x - 20 && pivot.x < o.bbox.x + o.bbox.w + 20)
  if (ceiling) pivot = { x: pivot.x, y: ceiling.bbox.y + ceiling.bbox.h / 2 }
  const at: [number, number] = [Math.round(pivot.x), Math.round(pivot.y)]
  const far = (about: Extract<Op, { v: 'rotate' }>['about']) => {
    if (!Array.isArray(about)) return true
    return Math.hypot(about[0] - at[0], about[1] - at[1]) > Math.max(30, 0.15 * height)
  }
  const first = swings[0]
  const out = ops.map((op) => op.v === 'rotate' && ids.has(op.id) && far(op.about) ? { ...op, about: at } : op)
  return [...out, ...strings.map((o) => ({ v: 'rotate' as const, id: o.id, deg: first.deg, about: at, dur: first.dur, loop: true }))]
}

export function rejectUngrounded(ops: Op[], g: Grounding, board: Board, mode: GateMode = 'strict'): string | null {
  if (g.phase === 'test') return null
  const strict = mode === 'strict'
  const minimal = mode === 'minimal'
  if (!minimal && g.phase === 'preview' && ops.some((op) => op.v !== 'pulse' && op.v !== 'color')) return '말이 아직 확정되지 않음'
  if (strict && ops.some((op) => op.v === 'rotate') && !g.move) return '돌리라는 입력이 없음'
  if (strict && ops.some((op) => op.v === 'restore') && !g.restore && !g.move) return '되돌리라는 입력이 없음'
  const moves = ops.filter((op) => op.v === 'move')
  if (moves.length) {
    if (strict && !g.move) return '이동을 지시한 입력이 없음'
    if (moves.some((op) => board.underlineOf(op.id) || (typeof op.to === 'string' && board.underlineOf(op.to)))) return '밑줄은 이동할 값이 아님'
    // 말한 방향과 반대로 미는 것 (실측: 오른쪽으로 옮기자는 말에 포물선을 왼쪽으로 -96 밀었다)
    const right = /오른쪽/.test(g.text), left = /왼쪽/.test(g.text)
    if (right !== left && moves.some((op) => op.by && (right ? op.by[0] < -10 : op.by[0] > 10))) return '말한 방향과 반대로 이동'
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
  // AI가 만든 화살표(p…)가 경로인지는 엔진이 확인한다
  if (ops.some((op) => op.v === 'flow' && ((strict && !g.flow) || (!op.along.startsWith('p') && !board.isFlowPath(op.along))))) return '흐름의 근거 또는 연결 경로가 없음'
  if (!minimal && g.phase === 'ink' && ops.some((op) => op.v === 'flow' && !g.targets.includes(op.along))) return '지금 그린 경로와 다름'
  if (strict && ops.some((op) => op.v === 'stop') && !g.stop) return '흐름을 멈추라는 입력이 없음'
  if (!minimal && g.phase === 'ink' && ops.some((op) => !['pulse', 'color', 'flow'].includes(op.v))) return '필기만으로 다음 과정을 실행할 수 없음'
  return null
}

/**
 * "원래대로/다시 돌아와"라고 분명히 말했고 움직인 것이 있으면 모델 없이 되돌린다
 * (실측: 모델이 restore 대신 교환을 다시 써서 '이동할 값이 특정되지 않음'으로 막혔다)
 */
export function planRestore(engine: Engine, g: Grounding): { ops: Op[]; cap: string } | null {
  if (!g.restore || !/되돌|원래|제자리|다시\s*돌아/.test(g.text)) return null
  return engine.changed().length ? { ops: [{ v: 'restore', dur: 700 }], cap: '처음 자리로 되돌림' } : null
}

/** 상태를 바꾸는 동작. 교환의 한쪽만 실행되지 않게 묶음 단위로만 통과시킨다 */
const STATE_CHANGE = new Set<Op['v']>(['move', 'rotate', 'restore'])
const DECORATION = new Set<Op['v']>(['pulse', 'color', 'label'])

/**
 * 근거 없는 동작만 빼고 나머지는 살린다 (실측: 궤도 흐름 하나가 막히면서 맞는 지구 공전 이동까지 버려졌다).
 * 상태를 바꾸는 동작이 막히거나, 남은 것이 강조뿐인데 핵심 동작이 빠지면 단계 전체를 막는다.
 */
export function keepGrounded(ops: Op[], g: Grounding, board: Board, mode: GateMode = 'strict'): { ops: Op[]; dropped: Op[]; reason: string | null } {
  const reason = rejectUngrounded(ops, g, board, mode)
  if (!reason) return { ops, dropped: [], reason: null }
  const kept = ops.filter((op) => !rejectUngrounded([op], g, board, mode))
  const dropped = ops.filter((op) => !kept.includes(op))
  const lost = dropped.some((op) => STATE_CHANGE.has(op.v))
    || (kept.every((op) => DECORATION.has(op.v)) && dropped.some((op) => !DECORATION.has(op.v)))
  if (!kept.length || lost || rejectUngrounded(kept, g, board, mode)) return { ops: [], dropped: ops, reason }
  return { ops: kept, dropped, reason }
}

/** 명시적인 전체 정렬 요청에서만 사용. 값이 불명확하거나 여러 행이면 모델에 맡긴다. */
export function planNumericSort(board: Board, engine: Engine, text: string): { ops: Op[]; cap: string } | null {
  const values = board.values()
  const numbers = values.filter((o) => /^-?\d+(\.\d+)?$/.test(o.read ?? o.text ?? ''))
  if (numbers.length < 2) return null
  const row = numbers.map((o) => ({ o, p: engine.settled(o.id)!, v: Number(o.read ?? o.text) })).sort((a, b) => a.p.x - b.p.x)
  const h = Math.max(...numbers.map((o) => o.bbox.h))
  if (Math.max(...row.map((r) => r.p.y)) - Math.min(...row.map((r) => r.p.y)) > h * .6) return null
  // 줄 끝의 읽지 않은 가는 세로 획은 배열 테두리다 (실측 064132: 장면 해석 전의 왼쪽 테두리 o1 때문에 정렬을 못 함)
  const [minX, maxX] = [row[0].p.x, row[row.length - 1].p.x]
  const border = (o: (typeof values)[number]) => !o.read && !o.text && o.bbox.w < o.bbox.h * .2 && o.bbox.h >= h * .8
    && (engine.settled(o.id)!.x < minX || engine.settled(o.id)!.x > maxX)
  if (values.some((o) => !numbers.includes(o) && !border(o) && Math.abs(engine.settled(o.id)!.y - row[0].p.y) < h * .6)) return null
  const direction = /내림|큰\s*값부터|큰\s*수부터/.test(text) ? -1 : 1
  const sorted = [...row].sort((a, b) => direction * (a.v - b.v))
  const ops: Op[] = sorted.flatMap((r, i) => r.o.id === row[i].o.id ? []
    : [{ v: 'move' as const, id: r.o.id, to: [row[i].p.x, row[i].p.y] as [number, number], dur: 700 }])
  if (!ops.length) ops.push(...sorted.map((r) => ({ v: 'pulse' as const, id: r.o.id })))
  return { ops, cap: `${sorted.map((r) => r.v).join(', ')} 순서로 정렬` }
}

export function describeGrounding(g: Grounding, mode: GateMode = 'strict') {
  const scope = mode === 'minimal'
    ? g.phase === 'preview' ? '말하는 중: 결과가 분명히 말해진 만큼은 움직여도 된다.' : g.phase === 'ink' ? '필기 해석. 교수자가 보여주려는 움직임이 분명하면 실행해도 된다.' : '확정 발화.'
    : g.phase === 'preview' ? '말하는 중: pulse/color만. 이동은 확정 후.' : g.phase === 'ink' ? '필기 해석과 강조만.' : '확정 발화.'
  const allow = mode === 'strict' ? `\n이동 허용: ${g.move ? '예' : '아니오'}` : ''
  return `이번 입력의 실행 범위: ${scope}\n현재 특정된 대상: ${g.targets.join(', ') || '(미확정)'}${allow}, 전체 정렬 요청: ${g.sort ? '예' : '아니오'}\n이 범위 밖의 대상이나 다음 비교를 추측하지 않는다.`
}
