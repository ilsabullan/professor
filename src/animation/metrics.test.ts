import { describe, expect, it } from 'vitest'
import { latency, summarize, toCsv, type ReqRecord } from './metrics'

const rec = (id: number, patch: Partial<ReqRecord> = {}): ReqRecord => ({
  id, kind: '말', desc: '발화', t0: 1000, status: '재생', cap: '', cfg: 'same', ...patch,
})

describe('measurement summary', () => {
  it('shows outcomes without treating intentionally silent or cancelled requests as latency samples', () => {
    const [g] = summarize([
      rec(1, { tFirstOp: 1500 }), rec(2, { tFirstOp: 2500 }),
      rec(3, { status: '중단(새 입력)', tEnd: 1100 }),
      rec(4, { status: '새 움직임 없음' }), rec(5, { status: '오류: network' }),
      rec(6, { status: '형식 오류' }), rec(7, { status: '보류(1)' }),
      rec(8, { status: '진행 중' }), rec(9, { status: '확신 낮음(0.1)' }),
      rec(10, { kind: '말 중', status: '중단(확정 발화)' }),
    ])
    expect(g).toMatchObject({ count: 9, played: 2, aborted: 1, noMovement: 1, errors: 2, held: 2, pending: 1, p50: 500, p90: 1500, under1s: 0.5 })
  })

  it('has no latency percentage if no response was observed', () => {
    expect(summarize([rec(1, { status: '새 움직임 없음' })])[0]).toMatchObject({ played: 0, p50: null, p90: null, under1s: null })
  })

  it('keeps confirmed early responses and their speech-end reference', () => {
    const r = rec(1, { kind: '말(미리)', tSpeechEnd: 1800, tFirstOp: 1600 })
    expect(latency(r)).toBe(-200)
    expect(summarize([r])[0]).toMatchObject({ count: 1, p50: -200 })
  })

  it('exports full settings, outcome, model and feedback with valid CSV escaping', () => {
    const csv = toCsv([rec(1, { desc: 'say "hello", now', tEnd: 2700, feedback: 'bad', model: 'actual-model', settings: { thr: 0.3, quick: false }, tFirstMove: 2100, actionId: 'a1', rejected: 1 })])
    expect(csv.split('\n')[0]).toContain('종료s,피드백,실제모델,전체설정')
    expect(csv).toContain('"say ""hello"", now"')
    expect(csv).toContain('"1.700","bad","actual-model","{""thr"":0.3,""quick"":false}"')
    expect(csv).toContain('"1.100","a1","1"')
  })
})
