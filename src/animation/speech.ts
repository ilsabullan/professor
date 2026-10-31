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
  onDiagnostic?: (event: string, detail: Record<string, unknown>) => void
}

export class SpeechInput {
  private rec: Recognition | null = null
  private wantOn = false
  private lastInterimAt = 0
  private restartTimer: ReturnType<typeof setTimeout> | undefined
  private retries = 0

  constructor(private h: SpeechHandlers) {}

  static supported() {
    return !!getCtor()
  }

  start() {
    if (this.wantOn && this.rec) return
    clearTimeout(this.restartTimer)
    this.retries = 0
    this.wantOn = true
    this.connect()
  }

  private connect() {
    const Ctor = getCtor()
    if (!Ctor) {
      this.wantOn = false
      this.h.onState('unsupported', '이 브라우저는 음성 인식을 지원하지 않아요')
      return
    }
    const rec = new Ctor()
    this.lastInterimAt = 0
    rec.lang = 'ko-KR'
    rec.continuous = true
    rec.interimResults = true
    rec.onresult = (e) => {
      if (!this.wantOn || this.rec !== rec) return
      this.retries = 0
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
      if (this.rec !== rec) return
      this.h.onDiagnostic?.('error', { error: e.error })
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed' || e.error === 'audio-capture') {
        this.wantOn = false
        this.rec = null
        this.h.onState('blocked', `음성 인식이 막혔어요 (${e.error})`)
      } else if (e.error === 'network') {
        this.restart(rec, 'network')
      }
    }
    rec.onend = () => {
      this.h.onDiagnostic?.('end', { expected: !this.wantOn })
      if (this.wantOn && this.rec === rec) this.restart(rec, 'end')
    }
    this.rec = rec
    try {
      rec.start()
      this.h.onDiagnostic?.('start', { retry: this.retries })
      this.h.onState('on')
    } catch {
      this.restart(rec, 'start-failed')
    }
  }

  private restart(rec: Recognition, reason: string) {
    if (!this.wantOn || this.rec !== rec) return
    this.rec = null
    try { rec.stop() } catch { /* 이미 끝남 */ }
    if (++this.retries > 3) {
      this.wantOn = false
      this.h.onState('blocked', '음성 인식 재연결에 실패했어요. 마이크를 다시 켜 주세요.')
      return
    }
    const delay = 250 * 2 ** (this.retries - 1)
    this.h.onDiagnostic?.('restart', { reason, attempt: this.retries, delay })
    this.h.onState('on', '음성 인식을 다시 연결하는 중이에요')
    this.restartTimer = setTimeout(() => { if (this.wantOn) this.connect() }, delay)
  }

  stop() {
    this.wantOn = false
    clearTimeout(this.restartTimer)
    this.lastInterimAt = 0
    this.h.onDiagnostic?.('stop', {})
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
