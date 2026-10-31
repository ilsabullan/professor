import type { InkEvent } from '../shared/ink'
import type { InkBus } from '../shared/bus'
import type { Pipeline } from '../animation/pipeline'

export interface RecordedInput {
  n: number
  at: number
  type: 'ink' | 'interim' | 'final'
  event?: InkEvent
  text?: string
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
    } else if (input.type === 'final') {
      p.onFinal(input.text ?? '', lastInterim ?? now)
      lastInterim = undefined
    }
    afterInput(input)
  }
}
