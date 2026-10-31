/** 브라우저 음성 인식(Web Speech API) 감싸기. 말하는 중(interim)과 확정(final)을 나눠 알려준다 */

interface RecognitionResult {
  isFinal: boolean
  0: { transcript: string }
}

interface RecognitionEvent {
  resultIndex: number
  results: { length: number; [i: number]: RecognitionResult }
}

interface Recognition {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((e: RecognitionEvent) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
}

type RecognitionCtor = new () => Recognition

function getCtor(): RecognitionCtor | null {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export type MicState = 'off' | 'on' | 'unsupported' | 'blocked'

export interface SpeechHandlers {
  onInterim: (text: string, t: number) => void
  /** t: 말을 멈춘 것으로 보이는 시각(마지막 interim 시각) */
  onFinal: (text: string, t: number) => void
  onState: (state: MicState, note?: string) => void
}

export class SpeechInput {
  private rec: Recognition | null = null
  private wantOn = false
  private lastInterimAt = 0

  constructor(private h: SpeechHandlers) {}

  static supported() {
    return !!getCtor()
  }

  start() {
    const Ctor = getCtor()
    if (!Ctor) {
      this.h.onState('unsupported', '이 브라우저는 음성 인식을 지원하지 않아요')
      return
    }
    const rec = new Ctor()
    rec.lang = 'ko-KR'
    rec.continuous = true
    rec.interimResults = true
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]
        const text = r[0].transcript
        const now = performance.now()
        if (r.isFinal) {
          this.h.onFinal(text, this.lastInterimAt || now)
          this.lastInterimAt = 0
        } else {
          this.lastInterimAt = now
          this.h.onInterim(text, now)
        }
      }
    }
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed' || e.error === 'audio-capture' || e.error === 'network') {
        this.wantOn = false
        this.rec = null
        this.h.onState('blocked', `음성 인식이 막혔어요 (${e.error})`)
      }
    }
    rec.onend = () => {
      // 계속 듣기: 브라우저가 중간에 끊으면 다시 시작
      if (this.wantOn && this.rec === rec) {
        try {
          rec.start()
        } catch {
          // 이미 시작됨
        }
      }
    }
    this.rec = rec
    this.wantOn = true
    try {
      rec.start()
      this.h.onState('on')
    } catch {
      this.wantOn = false
      this.h.onState('blocked', '음성 인식을 시작하지 못했어요')
    }
  }

  stop() {
    this.wantOn = false
    const r = this.rec
    this.rec = null
    try {
      r?.stop()
    } catch {
      // 이미 멈춤
    }
    this.h.onState('off')
  }
}
