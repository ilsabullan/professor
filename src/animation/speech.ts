/** 음성 입력. 기본은 브라우저 음성 인식(Web Speech API), 고르면 외부 받아쓰기(cloudstt). 말하는 중(interim)과 확정(final)을 나눠 알려준다 */
import { CloudSpeech, type Hints, hintsFromPage } from './cloudstt'

export type SttProvider = 'browser' | 'openai' | 'gemini'

interface RecognitionAlternative {
  transcript: string
  confidence?: number
}

interface RecognitionResult {
  isFinal: boolean
  length?: number
  [i: number]: RecognitionAlternative
}

interface RecognitionEvent {
  resultIndex: number
  results: { length: number; [i: number]: RecognitionResult }
}

interface Recognition {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives?: number
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

/** 이보다 오래 버틴 세션은 정상 종료로 본다 (침묵·네트워크로 끊긴 것도 재연결 실패가 아님) */
const HEALTHY_MS = 2000
/** 연달아 바로 실패하면(세션이 시작 직후 끝남) 이만큼 시도한 뒤 멈춘다 */
const MAX_FAST_FAILS = 5

export class SpeechInput {
  private rec: Recognition | null = null
  private wantOn = false
  private lastInterimAt = 0
  private restartTimer: ReturnType<typeof setTimeout> | undefined
  /** 연속으로 '바로 실패'한 횟수. 정상적으로 듣던 세션이 끝나면 0으로 돌아간다 */
  private retries = 0
  private startedAt = 0
  /** 이번 세션에서 인식 결과를 한 번이라도 받음 */
  private heard = false

  private provider: SttProvider = 'browser'
  private cloud: CloudSpeech | null = null
  private hints: Hints = hintsFromPage('')

  constructor(private h: SpeechHandlers) {}

  static supported() {
    return !!getCtor()
  }

  /** 받아쓰기 방식을 바꾼다. 켜져 있었으면 새 방식으로 다시 켠다 */
  setProvider(p: SttProvider) {
    if (p === this.provider) return
    const on = this.wantOn || !!this.cloud
    if (on) this.stop()
    this.provider = p
    if (on) this.start()
  }

  /** 페이지가 바뀌면 강의 자료 글자로 용어 힌트를 갱신 (외부 받아쓰기만 사용) */
  setPageText(text: string | undefined) {
    this.hints = hintsFromPage(text)
    this.cloud?.setHints(this.hints)
  }

  start() {
    if (this.provider !== 'browser') {
      // 막혔거나 끊긴 이전 연결이 남아 있으면 정리하고 새로 연다
      this.cloud?.stop()
      this.cloud = new CloudSpeech(this.provider, this.h, (event, detail) => this.h.onDiagnostic?.(event, detail))
      this.cloud.setHints(this.hints)
      void this.cloud.start()
      return
    }
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
    // 지원하는 브라우저만 후보를 여러 개 준다 (실측 기록 비교용)
    rec.maxAlternatives = 5
    rec.onresult = (e) => {
      if (!this.wantOn || this.rec !== rec) return
      this.heard = true
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]
        const text = r[0].transcript
        const now = performance.now()
        if (r.isFinal) {
          const alts: { text: string; conf?: number }[] = []
          for (let k = 0; k < (r.length ?? 1); k++) {
            const a = r[k]
            if (a) alts.push({ text: a.transcript, ...(typeof a.confidence === 'number' && a.confidence > 0 ? { conf: Math.round(a.confidence * 1000) / 1000 } : {}) })
          }
          if (alts.length > 1 || alts[0]?.conf != null) this.h.onDiagnostic?.('alternatives', { alts })
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
        // Edge는 수십 초 듣다가 network 오류로 세션을 끊는다. 일시적이므로 다시 연결한다
        this.restart(rec, 'network')
      }
      // no-speech·aborted 등은 곧 onend가 오므로 거기서 다시 연결한다
    }
    rec.onend = () => {
      this.h.onDiagnostic?.('end', { expected: !this.wantOn })
      if (this.wantOn && this.rec === rec) this.restart(rec, 'end')
    }
    this.rec = rec
    this.startedAt = performance.now()
    this.heard = false
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
    const lived = performance.now() - this.startedAt
    // 브라우저는 침묵이 이어지거나 일정 시간이 지나면 세션을 스스로 끝낸다.
    // 그동안 잘 듣고 있었다면 실패가 아니므로 횟수를 쌓지 않는다. 시작 직후 끝나는 경우만 센다.
    const fast = reason === 'start-failed' || (!this.heard && lived < HEALTHY_MS)
    this.retries = fast ? this.retries + 1 : 0
    if (this.retries > MAX_FAST_FAILS) {
      this.wantOn = false
      this.h.onState('blocked', '음성 인식 재연결에 실패했어요. 마이크를 다시 켜 주세요.')
      return
    }
    const delay = this.retries ? Math.min(250 * 2 ** (this.retries - 1), 4000) : 50
    this.h.onDiagnostic?.('restart', { reason, attempt: this.retries, delay, lived: Math.round(lived), heard: this.heard })
    if (this.retries) this.h.onState('on', '음성 인식을 다시 연결하는 중이에요')
    this.restartTimer = setTimeout(() => { if (this.wantOn) this.connect() }, delay)
  }

  stop() {
    if (this.cloud) {
      const c = this.cloud
      this.cloud = null
      c.stop()
      return
    }
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
