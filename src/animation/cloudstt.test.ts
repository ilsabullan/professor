import { afterEach, describe, expect, it, vi } from 'vitest'
import { CloudSpeech, floatToPcm16, hintsFromPage, rms, Vad } from './cloudstt'
import type { SpeechHandlers } from './speech'

function handlers() {
  const out = { interim: [] as string[], final: [] as { text: string; t: number }[] }
  const h: SpeechHandlers = {
    onInterim: (text) => out.interim.push(text),
    onFinal: (text, t) => out.final.push({ text, t }),
    onState: () => {},
  }
  return { h, out }
}

const feed = (c: CloudSpeech, m: Record<string, unknown>) => (c as unknown as { onMessage(m: unknown): void }).onMessage(m)

afterEach(() => vi.useRealTimers())

describe('hintsFromPage', () => {
  it('강의 자료에서 조사를 뗀 용어를 뽑고 꺾쇠·줄바꿈을 없앤다', () => {
    const h = hintsFromPage('버블 정렬은 인접한 두 값을 비교해\n<교환>한다')
    expect(h.keywords).toEqual(expect.arrayContaining(['버블', '정렬', '인접한', '비교해', '교환']))
    expect(h.keywords.every((k) => !/[<>\r\n]/.test(k))).toBe(true)
    expect(h.prompt).toContain('버블 정렬')
  })

  it('자료가 없으면 기본 설명만', () => {
    expect(hintsFromPage(undefined)).toEqual({ prompt: expect.stringContaining('대학 강의'), keywords: [] })
  })
})

describe('오디오 변환', () => {
  it('float를 16비트로 자르고 바꾼다', () => {
    expect([...floatToPcm16(new Float32Array([0, 1, -1, 2]))]).toEqual([0, 32767, -32768, 32767])
    expect(rms(new Int16Array([3, -3]))).toBe(3)
  })
})

describe('Vad', () => {
  it('말한 뒤 900ms 조용하면 한 발화를 닫는다', () => {
    const v = new Vad()
    const marks: string[] = []
    let t = 0
    for (let i = 0; i < 5; i++) marks.push(v.push(3000, (t += 100)))
    for (let i = 0; i < 9; i++) marks.push(v.push(100, (t += 100)))
    expect(marks.filter((m) => m === 'end')).toHaveLength(1)
    expect(marks.at(-1)).toBe('end')
    expect(v.lastVoiceAt).toBe(500)
  })

  it('조용하기만 하면 닫지 않는다', () => {
    const v = new Vad()
    for (let i = 0; i < 30; i++) expect(v.push(100, i * 100)).toBe('silence')
  })

  it('쉬지 않고 길게 말해도 12초마다 확정한다', () => {
    const v = new Vad()
    const ends = Array.from({ length: 130 }, (_, i) => v.push(3000, i * 100)).filter((m) => m === 'end')
    expect(ends).toHaveLength(1)
  })
})

describe('OpenAI 메시지', () => {
  it('중간 글자를 이어 붙이고, 확정은 말 끝 시각으로 넘긴다', () => {
    const { h, out } = handlers()
    const c = new CloudSpeech('openai', h, () => {})
    ;(c as unknown as { commits: number[] }).commits.push(1234)
    feed(c, { type: 'input_audio_buffer.committed', item_id: 'a' })
    feed(c, { type: 'conversation.item.input_audio_transcription.delta', item_id: 'a', delta: '5랑 ' })
    feed(c, { type: 'conversation.item.input_audio_transcription.delta', item_id: 'a', delta: '3을' })
    feed(c, { type: 'conversation.item.input_audio_transcription.completed', item_id: 'a', transcript: ' 5랑 3을 비교 ' })
    expect(out.interim).toEqual(['5랑 ', '5랑 3을'])
    expect(out.final).toEqual([{ text: '5랑 3을 비교', t: 1234 }])
  })

  it('빈 확정은 넘기지 않는다', () => {
    const { h, out } = handlers()
    const c = new CloudSpeech('openai', h, () => {})
    feed(c, { type: 'conversation.item.input_audio_transcription.completed', item_id: 'b', transcript: '  ' })
    expect(out.final).toEqual([])
  })
})

describe('Gemini 메시지', () => {
  it('받아쓰기 조각이 800ms 끊기면 한 문장으로 확정한다', () => {
    vi.useFakeTimers()
    const { h, out } = handlers()
    const c = new CloudSpeech('gemini', h, () => {})
    feed(c, { serverContent: { inputTranscription: { text: '오랑 ' } } })
    feed(c, { serverContent: { inputTranscription: { text: '삼을 비교' } } })
    expect(out.final).toEqual([])
    vi.advanceTimersByTime(800)
    expect(out.interim).toEqual(['오랑', '오랑 삼을 비교'])
    expect(out.final.map((f) => f.text)).toEqual(['오랑 삼을 비교'])
  })
})
