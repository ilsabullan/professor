import type { InkEvent } from '../shared/ink'
import type { InkBus } from '../shared/bus'
import type { Pipeline } from '../animation/pipeline'
import type { Board, SceneResult } from '../animation/board'
import { parseScene } from '../animation/scene'

export interface RecordedInput {
  n: number
  at: number
  type: 'ink' | 'interim' | 'final' | 'scene'
  event?: InkEvent
  text?: string
  /** 장면 해석 응답 원문과, 요청 당시 객체 번호별 획 */
  raw?: string
  ids?: Record<string, string[]>
}

/** 실측 당시 객체 번호 → 같은 획을 가진 지금 칠판의 객체 번호. Board 휴리스틱이 바뀌어 번호가 밀려도 맞춘다 */
export const idMap = (b: Board, ids: Record<string, string[]> = {}) => (id: string) => {
  const sid = ids[id]?.[0]
  return (sid && b.objs.find((o) => o.strokes.some((s) => s.id === sid))?.id) || id
}

export const remapScene = (r: SceneResult, f: (id: string) => string): SceneResult => ({
  objs: Object.fromEntries(Object.entries(r.objs).map(([id, s]) => [f(id), { ...s, from: s.from && f(s.from), to: s.to && f(s.to) }])),
  merge: r.merge.map((g) => [...new Set(g.map(f))]).filter((g) => g.length >= 2),
  split: Object.fromEntries(Object.entries(r.split).map(([id, g]) => [f(id), g])),
})

/**
 * 실측에서 반영된 장면 해석(화살표의 출발·도착, 이름표)을 그대로 다시 반영한다.
 * 채점에서는 장면 해석 모델을 부르지 않으므로, 이것이 없으면 실측과 다른 칠판을 보고 답한다.
 */
export function applyRecordedScene(p: Pipeline, input: RecordedInput) {
  const parsed = input.raw ? parseScene(input.raw) : null
  if (!parsed) return
  const { removed } = p.board.applyScene(remapScene(parsed, idMap(p.board, input.ids)), (id) => p.engine.isTakenOver(id))
  if (removed.length) p.engine.forget(removed)
}

/** 점 사이 시간은 보존하고 마지막 점을 현재 이벤트 시간에 맞춘다. */
export function rebaseInk(e: InkEvent, now: number): InkEvent {
  if (e.type === 'stroke' || e.type === 'point') {
    const points = e.type === 'stroke' ? e.stroke.points : e.points
    const delta = now - (points.at(-1)?.t ?? now)
    const rebased = points.map((p) => ({ ...p, t: p.t + delta }))
    return e.type === 'stroke' ? { ...e, stroke: { ...e.stroke, points: rebased } } : { ...e, points: rebased }
  }
  return 't' in e ? { ...e, t: now } : e
}

/** 입력 간격과 수정되는 중간 음성을 재현한다. 발화마다 AI 완료를 기다리지 않는다. */
export async function replayInputs(
  p: Pipeline, bus: InkBus, inputs: RecordedInput[],
  advance: (ms: number) => Promise<void>,
  afterInput: (input: RecordedInput) => void = () => {},
) {
  let previous = 0
  let lastInterim: number | undefined
  for (const input of [...inputs].sort((a, b) => a.n - b.n)) {
    await advance(Math.max(0, input.at - previous))
    previous = Math.max(previous, input.at)
    const now = performance.now()
    if (input.type === 'ink' && input.event) {
      bus.emit(rebaseInk(input.event, now))
      if (input.event.type === 'page' || input.event.type === 'clear') lastInterim = undefined
    } else if (input.type === 'interim') {
      p.onInterim(input.text ?? '', now)
      lastInterim = now
    } else if (input.type === 'scene') {
      applyRecordedScene(p, input)
    } else if (input.type === 'final') {
      p.onFinal(input.text ?? '', lastInterim ?? now)
      lastInterim = undefined
    }
    afterInput(input)
  }
}
