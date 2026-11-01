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
  SWAP.source, '옮[기겨긴길]', '이동(?:[하해한할시했되됐됩돼]|을\\s*[해하시]|\\s*$|[.?!,])', '(?:앞으|뒤)로.{0,8}(?:[가갈간갑]|보내|[오올와])', '넣', '꺼내', '밀[려리어]',
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

/**
 * 인접 비교 규칙("8이 뒤로")을 쓸 칠판: 정렬 교안이거나, 숫자 3개 이상이 한 줄에 놓였다.
 * 실측 035550: TCP 교안 위에 배열을 그려 정렬해 "8이 뒤로 갈 거예요"를 해석하지 못함
 */
function rowOfNumbers(board: Board, engine?: Engine) {
  if (/버블|인접|정렬/.test(board.page.text ?? '')) return true
  const nums = board.values().filter((o) => /^-?\d+(\.\d+)?$/.test(o.read ?? o.text ?? ''))
  if (nums.length < 3) return false
  const ys = nums.map((o) => engine?.settled(o.id)?.y ?? o.bbox.y + o.bbox.h / 2)
  return Math.max(...ys) - Math.min(...ys) <= 0.6 * Math.max(...nums.map((o) => o.bbox.h))
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
  // "다 끝내게 되면", "정렬이 되면"도 완료 (실측 021538, 034920). "정렬되면서"는 진행 중
  const sort = !negated && /정[렬리]|조율/.test(text) && /(완료|완성|끝까지|끝[나내난]|최종|다\s*되|(?:정[렬리]|진열)이?\s*되면(?!서))/.test(text)
  const move = !negated && (sort || MOVE.test(actionText))
  if (rowOfNumbers(board, engine)) {
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
    flow: /(흘러|흐르|흐름|보내|보낼|보냈|보냄|전송|이동|지나가|들어가|들어와|퍼져|퍼지|전달|돌아와|순환|돌[아고면며]|돈다|도는|공전|회전|굴러)/.test(text),
    stop: /(멈춰|멈추|멈춘|정지|끊기|끊겨|끊어)/.test(text),
  }
}

/** 두 숫자의 명시적인 교환은 목표 자리를 엔진에 함께 넘긴다. */
export function planNumericSwap(board: Board, engine: Engine, g: Grounding): { ops: Op[]; cap: string } | null {
  if (!g.move || g.sort || g.targets.length !== 2) return null
  const [a, b] = g.targets.map((id) => board.values().find((o) => o.id === id))
  if (!a || !b || ![a, b].every((o) => /^-?\d+(\.\d+)?$/.test(o.read ?? o.text ?? ''))) return null
  const explicitSwap = SWAP.test(g.text)
  const adjacentSort = rowOfNumbers(board, engine) && /뒤로|앞으로/.test(g.text)
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
 * 공전: 잘못 고른 회전을 궤도 위 객체가 궤도를 따라 도는 이동으로 바꾼다. "자전"이라고 말했으면 그대로 둔다.
 * - 궤도 안쪽 객체를 제자리에서 돌림 (실측 084606: "태양 주위를 도는 지구"에 태양을 돌림)
 * - 궤도 자체를 가운데 객체 기준으로 돌림 (실측 085717: 궤도 타원을 태양 둘레로 돌림)
 * 궤도 위 객체에 겹쳐 그린 것(자전축 등)은 같이 붙어서 움직인다.
 */
export function repairOrbit(ops: Op[], text: string, board: Board): Op[] {
  if (/자전/.test(text) || !/돌|공전|궤도|주위/.test(text)) return ops
  const center = (b: { x: number; y: number; w: number; h: number }) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 })
  const inside = (q: { x: number; y: number }, b: { x: number; y: number; w: number; h: number }) => q.x > b.x && q.x < b.x + b.w && q.y > b.y && q.y < b.y + b.h
  const pathPts = (id: string) => {
    const o = board.get(id)
    if (!o || board.underlineOf(id) || o.kind === 'text' || o.kind === 'dot') return null
    const pts = o.pts ?? (o.kind === 'box' || board.isFlowPath(id) ? o.strokes[0]?.pts : undefined)
    return pts && pts.length >= 3 ? pts : null
  }
  const out: Op[] = []
  for (const op of ops) {
    if (op.v !== 'rotate' || !op.loop) { out.push(op); continue }
    let path: string | undefined
    let hub: string | undefined
    const aboutId = typeof op.about === 'string' && op.about !== op.id ? op.about : undefined
    const aboutPt = aboutId ? (board.get(aboutId) ? center(board.get(aboutId)!.bbox) : null) : Array.isArray(op.about) ? { x: op.about[0], y: op.about[1] } : null
    const self = board.get(op.id)
    if (self && aboutPt && pathPts(op.id) && inside(aboutPt, self.bbox)) {
      path = op.id
      hub = aboutId
    } else if (self && !aboutPt) {
      const c = center(self.bbox)
      path = board.objs.find((p) => p.id !== op.id && pathPts(p.id) && p.kind === 'line' && inside(c, p.bbox))?.id
        ?? board.objs.find((p) => p.id !== op.id && pathPts(p.id) && inside(c, p.bbox) && p.bbox.w * p.bbox.h > 2 * self.bbox.w * self.bbox.h)?.id
      hub = op.id
    }
    const pts = path ? pathPts(path) : null
    if (!path || !pts) { out.push(op); continue }
    const near = (o: NonNullable<typeof self>) => {
      const q = center(o.bbox)
      const d = Math.min(...pts.slice(1).map((b, i) => distToSegment(q, pts[i], b)))
      return d <= Math.max(40, Math.hypot(o.bbox.w, o.bbox.h) / 2 + 20)
    }
    const overlap = (a: NonNullable<typeof self>, b: NonNullable<typeof self>) =>
      a.bbox.x < b.bbox.x + b.bbox.w + 10 && b.bbox.x < a.bbox.x + a.bbox.w + 10 && a.bbox.y < b.bbox.y + b.bbox.h + 10 && b.bbox.y < a.bbox.y + a.bbox.h + 10
    const riders = board.objs.filter((o) => o.id !== hub && o.id !== path && o.kind !== 'text' && !board.underlineOf(o.id) && near(o))
    const body = riders.filter((o) => o.kind !== 'line' && o.kind !== 'dot')
    // 궤도 위 덩어리가 하나일 때만 (겹쳐 그린 자전축 등은 같은 덩어리)
    if (!body.length || !riders.every((o) => overlap(o, body[0]))) { out.push(op); continue }
    for (const o of riders) out.push({ v: 'move', id: o.id, along: path, loop: true, dur: op.dur })
  }
  return out
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

type P = { x: number; y: number }
function segCross(a: P, b: P, c: P, d: P): P | null {
  const den = (b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x)
  if (Math.abs(den) < 1e-9) return null
  const t = ((c.x - a.x) * (d.y - c.y) - (c.y - a.y) * (d.x - c.x)) / den
  const u = ((c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x)) / den
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) } : null
}
/** 두 꺾은선의 교점 중 near에 가장 가까운 것 */
function crossing(p: P[], q: P[], near?: P): P | null {
  let best: P | null = null
  for (let i = 1; i < p.length; i++) for (let j = 1; j < q.length; j++) {
    const x = segCross(p[i - 1], p[i], q[j - 1], q[j])
    if (x && (!best || !near || Math.hypot(x.x - near.x, x.y - near.y) < Math.hypot(best.x - near.x, best.y - near.y))) best = x
  }
  return best
}
const LINE_WORD = /수요|공급|곡선|직선|그래프|포물선|선을|선이|선은/

/**
 * 교점 표시(균형점 E 등)는 선이 옮겨지면 새 교점으로 따라간다. 선을 말하지 않고 가격·균형점이 오른다고만 하면 선을 밀지 않는다.
 * 실측 090717: 수요선을 오른쪽으로 민 뒤 "위로 올라가서 가격이 올라요"에 수요선을 위로 또 밀고, 균형점은 따로 놀았다.
 */
export function followIntersections(ops: Op[], text: string, board: Board, engine: Engine): Op[] {
  const axes = board.axes()
  const lines = board.objs.filter((o) => o.kind === 'line' && !axes.has(o.id) && !board.underlineOf(o.id) && engine.linePts(o.id))
  const small = board.objs.filter((o) => o.kind !== 'line' && o.kind !== 'box' && Math.hypot(o.bbox.w, o.bbox.h) < 45)
  const markersOn = (d: string) => {
    const found: { id: string; s: string; at: P }[] = []
    for (const s of lines) {
      if (s.id === d) continue
      const x = crossing(engine.linePts(d)!, engine.linePts(s.id)!)
      if (!x) continue
      for (const m of small) {
        const c = engine.settled(m.id)
        if (c && Math.hypot(c.x - x.x, c.y - x.y) < 30) found.push({ id: m.id, s: s.id, at: x })
      }
    }
    return found
  }
  let out = ops
  // 선을 말하지 않은 "가격/균형점이 올라요"에는 교점 표시가 있는 선을 밀지 않는다
  if (/가격|균형|교점|만나는\s*점/.test(text) && !LINE_WORD.test(text)) {
    out = out.filter((op) => !(op.v === 'move' && op.by && lines.some((l) => l.id === op.id) && markersOn(op.id).length))
  }
  const moved = new Set(out.filter((op) => op.v === 'move').map((op) => (op as { id: string }).id))
  const follow: Op[] = []
  const followed = new Set<string>()
  for (const op of out) {
    if (op.v !== 'move' || !op.by || !lines.some((l) => l.id === op.id)) continue
    const by = op.by
    const shifted = engine.linePts(op.id)!.map((p) => ({ x: p.x + by[0], y: p.y + by[1] }))
    for (const m of markersOn(op.id)) {
      if (moved.has(m.s) || followed.has(m.id)) continue
      const x = crossing(shifted, engine.linePts(m.s)!, m.at)
      if (!x) continue
      followed.add(m.id)
      follow.push({ v: 'move', id: m.id, by: [Math.round(x.x - m.at.x), Math.round(x.y - m.at.y)], dur: op.dur })
    }
  }
  if (!follow.length) return out
  // AI가 표시를 따로 민 것은 계산한 교점 이동으로 바꾼다
  return [...out.filter((op) => !(op.v === 'move' && followed.has(op.id))), ...follow]
}

/**
 * 평행이동: 위에 있지 않은 화살표나 좌표축을 along으로 "따라" 옮기라는 응답은 경로가 아니라 변위다.
 * 화살표면 시작→머리 끝, 축이면 최근 이동량 화살표를 그 축 방향으로 잘라 by로 바꾼다. 근거가 없으면 그대로 둔다.
 * 실측 050449: 포물선을 화살표·x축을 따라 옮겨 화살표 날개 끝까지 내려가거나 축 길이만큼 날아감
 */
export function alongToShift(ops: Op[], board: Board, engine: Engine, now: number): Op[] {
  const axes = board.axes()
  const arrows = board.objs.filter((o) => o.kind === 'line' && o.arrowEnd && o.pts && !axes.has(o.id)).sort((a, b) => b.t - a.t)
  // 꼬리→머리 끝. 머리 끝은 꼬리에서 가장 먼 점이다 (한 획 화살표는 마지막 점이 날개 끝)
  const vec = (o: (typeof arrows)[number]) => {
    const pts = o.strokes.length === 1 ? o.strokes[0].pts : o.pts!
    const a = o.arrowEnd === 'start' ? o.pts![o.pts!.length - 1] : o.pts![0]
    const z = pts.reduce((m, p) => (Math.hypot(p.x - a.x, p.y - a.y) > Math.hypot(m.x - a.x, m.y - a.y) ? p : m))
    return { a, v: [z.x - a.x, z.y - a.y] as [number, number] }
  }
  return ops.map((op) => {
    if (op.v !== 'move' || !op.along || op.loop || op.by || op.to) return op
    const path = board.get(op.along)
    const self = board.get(op.id)
    const at = engine.settled(op.id)
    if (!path || !self || !at || path.kind !== 'line' || !path.pts) return op
    let by: [number, number] | null = null
    if (axes.has(path.id)) {
      const recent = arrows.find((o) => o.id !== op.id && now - o.t < 120000)
      if (!recent) return op
      const v = vec(recent).v
      const [ax, ay] = [path.pts[path.pts.length - 1].x - path.pts[0].x, path.pts[path.pts.length - 1].y - path.pts[0].y]
      by = Math.abs(ax) >= Math.abs(ay) ? [Math.round(v[0]), 0] : [0, Math.round(v[1])]
    } else if (path.id !== op.id) {
      // 객체가 화살표·선 위(시작점 근처)에 있으면 경로를 따라가는 것이 맞다.
      // 머리를 따로 못 알아본 선은 그린 방향(시작→가장 먼 점)을 변위로 본다 (실측 050449 s5: 날개 하나짜리 화살표)
      const { a, v } = vec(path)
      if (Math.hypot(a.x - at.x, a.y - at.y) < Math.max(40, Math.min(self.bbox.w, self.bbox.h) / 4)) return op
      by = [Math.round(v[0]), Math.round(v[1])]
    }
    if (!by || Math.hypot(...by) < 20) return op
    return { v: 'move', id: op.id, by, dur: op.dur }
  })
}

/** AI 응답을 실행 전에 바로잡는 규칙들 (확정 발화에만) */
export function repairOps(ops: Op[], text: string, board: Board, engine: Engine, now: number): Op[] {
  let out = alignDirection(alongToShift(ops, board, engine, now), text)
  out = measureTranslation(out, text, board, now)
  out = repairOrbit(out, text, board)
  out = repairPendulum(out, board)
  return followIntersections(out, text, board, engine)
}

/** 데이터 패킷을 보내고, 늘리고, 버리는 말 (TCP 혼잡 제어 실측: "하나만 보낼 거야", "2개 4개 두 배씩", "넘친 패킷은 버려져요") */
const SEND = /보내|보낼|보냈|보냄|전송|흘러|흐르|패킷|패키지|버려|버리|버린|손실|넘치|넘쳐|넘친|배씩|두\s*배|절반|반으로|줄[이여]|늘[어려리고]|하나씩|\d+\s*개|[한두세네]\s*개|하나만/
/** 응답(ACK)이 돌아오는 말 */
const ACK = /응답|ack|애크|에크|확인\s*신호|돌아[오와]/i
/** 개수를 계산해서 정하는 말. 이때는 말한 수가 아니어도 된다 */
const RECKON = /배씩|두\s*배|절반|반으로|하나씩|줄[이여]|늘[어려리고]/

/** 말한 패킷 개수들 ("하나만", "2개 4개"). "하나씩"은 늘리는 폭이라 뺀다 */
export function spokenCounts(text: string): number[] {
  const out: number[] = []
  for (const m of text.matchAll(/(\d+)\s*개/g)) out.push(Number(m[1]))
  const words: [RegExp, number][] = [[/하나(?!씩)|한\s*개/, 1], [/두\s*개/, 2], [/세\s*개/, 3], [/네\s*개/, 4]]
  for (const [re, n] of words) if (re.test(text)) out.push(n)
  return [...new Set(out)]
}

function sendUngrounded(op: Extract<Op, { v: 'send' }>, g: Grounding, strict: boolean): string | null {
  if (!strict) return null
  if (op.ack) return ACK.test(g.text) ? null : '응답을 말하지 않음'
  // "응답이 돌아오면"만 말했는데 다음 전송을 앞질러 보내지 않는다 (실측 재현: 2개를 미리 보내 "2개 4개"에서 4만 남음)
  if (!SEND.test(g.text)) return '패킷을 보낼 근거가 없음'
  const counts = spokenCounts(g.text)
  if (counts.length && !RECKON.test(g.text) && !counts.includes(op.n)) return '말한 패킷 개수와 다름'
  return null
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
  for (const op of ops) {
    if (op.v !== 'send') continue
    if (!op.along.startsWith('p') && !board.isFlowPath(op.along)) return '패킷을 보낼 연결 경로가 없음'
    const why = sendUngrounded(op, g, strict)
    if (why) return why
  }
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

/** 말한 순서대로의 패킷 개수 ("2개 4개" → [2, 4]) */
function orderedCounts(text: string): number[] {
  const hits: [number, number][] = []
  for (const m of text.matchAll(/(\d+)\s*개/g)) hits.push([m.index!, Number(m[1])])
  for (const [re, n] of [[/하나(?!씩)|한\s*개/g, 1], [/두\s*개/g, 2], [/세\s*개/g, 3], [/네\s*개/g, 4]] as [RegExp, number][])
    for (const m of text.matchAll(re)) hits.push([m.index!, n])
  return hits.sort((a, b) => a[0] - b[0]).map(([, n]) => n)
}

/**
 * 이미 패킷을 보낸 뒤 "두 배씩 / 절반으로 / 하나씩 늘려요"라고 하면 보낼 개수를 계산해서 단계마다 보낸다.
 * (실측 062040·041959: 모델이 "2개 4개" 중 하나만 보내거나 5개의 절반을 2개로 보내고 '하나씩 늘림'은 빠뜨렸다)
 * 버림·응답은 어디서 넘치는지 등 판단이 필요해 모델에 맡긴다.
 * 처음 보내는 것은 흐르던 경로가 하나뿐이고 개수를 하나만 말했을 때만 여기서 정한다.
 */
export function planWindow(engine: Engine, g: Grounding, board?: Board): { ops: Op[]; cap: string; more: { ops: Op[]; cap: string }[] } | null {
  if (g.phase !== 'final') return null
  const last = engine.sent.filter((x) => !x.ack).at(-1)
  // "넘친 패킷은 버려져요": 직전 수의 두 배를 보내고 뒤쪽 1/4이 버퍼에서 버려진다 (실측 041959: 모델이 흐름만 다시 쓰거나 빨간 흐름을 냄)
  if (/버려|버리|버린|넘치|넘쳐|넘친|손실/.test(g.text) && !/절반|반으로/.test(g.text)) {
    const along = last?.along ?? (engine.flows.length === 1 ? engine.flows[0].along : null)
    if (!along || !engine.linePts(along)) return null
    const n = Math.min(16, last ? last.n * 2 : 8)
    const buffer = board?.objs.find((o) => /버퍼|라우터|buffer|router/i.test(`${o.label ?? ''} ${o.text ?? ''} ${o.read ?? ''}`))
    const op: Op = { v: 'send', along, n, color: '#cdf0ff', rev: last?.rev ?? engine.flows[0]?.rev ?? false, drop: Math.max(1, Math.round(n / 4)), ...(buffer ? { at: buffer.id } : {}) }
    return { ops: [op], cap: `버퍼가 넘쳐 ${op.drop}개 버려짐`, more: [] }
  }
  // 흐르던 경로가 하나뿐일 때 "처음에는 하나만 보낼 거야"는 그 경로로 말한 개수만 보낸다
  // (실측 재현 062040: 같은 말에 흐름 n=1을 다시 써서 개수가 안 보임)
  if (!last && !RECKON.test(g.text) && /보내|보낼|보냈|전송/.test(g.text) && engine.flows.length === 1) {
    const counts = orderedCounts(g.text).filter((n) => n >= 1 && n <= 16)
    const f = engine.flows[0]
    if (counts.length !== 1 || !engine.linePts(f.along)) return null
    return { ops: [{ v: 'send', along: f.along, n: counts[0], color: '#cdf0ff', rev: f.rev, drop: 0 }], cap: `패킷 ${counts[0]}개 보냄`, more: [] }
  }
  if (!RECKON.test(g.text) || !last || !engine.linePts(last.along)) return null
  const halve = /절반|반으로/.test(g.text)
  const inc = /하나씩|한\s*개씩|1\s*개?씩/.test(g.text)
  const dbl = /두\s*배|배씩|배로/.test(g.text)
  let seq: number[] = []
  let why = ''
  if (halve) {
    const h = Math.max(1, Math.ceil(last.n / 2))
    seq = inc ? [h, h + 1, h + 2] : [h]
    why = '절반으로'
  } else if (dbl) {
    const said = orderedCounts(g.text)
    // 이미 보낸 수까지는 건너뛴다 ("1개, 2개, 4개"에서 1은 보냈음)
    while (said.length && said[0] <= last.n) said.shift()
    seq = said.length ? said : [last.n * 2, last.n * 4]
    why = '두 배로'
  } else if (inc) {
    seq = [last.n + 1, last.n + 2]
    why = '하나씩 늘려'
  }
  seq = seq.filter((n) => n >= 1 && n <= 16).slice(0, 4)
  if (!seq.length) return null
  const steps = seq.map((n) => ({
    ops: [{ v: 'send' as const, along: last.along, n, color: '#cdf0ff', rev: last.rev, drop: 0 }],
    cap: `${why} ${n}개 보냄`,
  }))
  return { ...steps[0], more: steps.slice(1) }
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
  // 점·이름표를 새로 띄우는 것만 남아도 강조뿐이다 (실측 재현: 흐름이 막히고 점 하나만 떠서 다음 "흘러가요"가 이미 보여준 것으로 처리됨)
  const minor = (op: Op) => DECORATION.has(op.v) || (op.v === 'spawn' && op.shape !== 'arrow')
  const lost = dropped.some((op) => STATE_CHANGE.has(op.v))
    || (kept.every(minor) && dropped.some((op) => !minor(op)))
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
  // 숫자 밑의 읽지 않은 납작한 표시(밑줄류)는 값이 아니다 (실측 034920: 8 밑의 표시 때문에 정렬을 못 함)
  const flat = (o: (typeof values)[number]) => !o.read && !o.text && o.bbox.h < h * .4 && o.bbox.w > o.bbox.h
  if (values.some((o) => !numbers.includes(o) && !border(o) && !flat(o) && Math.abs(engine.settled(o.id)!.y - row[0].p.y) < h * .6)) return null
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
