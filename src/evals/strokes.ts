import { Board } from '../animation/board'
import type { InkEvent } from '../shared/ink'

/**
 * 획 단위 정답 라벨 (cases/*.json 의 strokeLabels). 사람이 렌더 그림을 보고 붙인다.
 * - digit: strokes 전체가 정확히 한 객체여야 하고, 그 객체가 값 후보(board.values())여야 한다.
 * - frame·underline·arrow·circle: 각 획이 값 후보 객체에 들어가면 안 된다 (묶음 주장 아님).
 * - other: 판단 보류. 채점하지 않는다.
 */
export type StrokeRole = 'digit' | 'frame' | 'underline' | 'arrow' | 'circle' | 'other'
export interface StrokeLabel {
  strokes: string[]
  role: StrokeRole
  value?: string
}

export interface StrokeScore {
  digits: number
  digitsOk: number
  nonValue: number
  nonValueOk: number
  /** 값 후보 전체가 정답 숫자 묶음과 정확히 같은가 (배열 판독의 전제) */
  rowOk: boolean
  errors: string[]
}

export function boardFrom(events: InkEvent[]) {
  const b = new Board()
  for (const e of events) b.apply(e)
  return b
}

export function scoreStrokes(b: Board, labels: StrokeLabel[]): StrokeScore {
  const ownerOf = (id: string) => b.objs.find((o) => o.strokes.some((s) => s.id === id))
  const values = new Set(b.values().map((o) => o.id))
  const s: StrokeScore = { digits: 0, digitsOk: 0, nonValue: 0, nonValueOk: 0, rowOk: true, errors: [] }
  const digitObjs = new Set<string>()
  for (const l of labels) {
    if (l.role === 'digit') {
      s.digits++
      const o = ownerOf(l.strokes[0])
      const exact = o && o.strokes.length === l.strokes.length && l.strokes.every((id) => o.strokes.some((st) => st.id === id))
      if (exact && values.has(o.id)) {
        s.digitsOk++
        digitObjs.add(o.id)
      } else {
        s.errors.push(`숫자 ${l.value ?? '?'}(${l.strokes.join('+')}) → ${o ? `${o.id} ${o.kind} [${o.strokes.map((st) => st.id).join('+')}]${values.has(o.id) ? '' : ' 값 아님'}` : '없음'}`)
      }
    } else if (l.role !== 'other') {
      for (const id of l.strokes) {
        s.nonValue++
        const o = ownerOf(id)
        if (!o || !values.has(o.id)) s.nonValueOk++
        else s.errors.push(`${l.role} ${id} → 값 후보 ${o.id} ${o.kind}`)
      }
    }
  }
  // 'other' 획만 든 값 후보는 판단 보류이므로 행 판정에서 뺀다
  const other = new Set(labels.filter((l) => l.role === 'other').flatMap((l) => l.strokes))
  const stray = b.values().filter((o) => !digitObjs.has(o.id) && !o.strokes.every((st) => other.has(st.id)))
  s.rowOk = s.digitsOk === s.digits && !stray.length
  return s
}
