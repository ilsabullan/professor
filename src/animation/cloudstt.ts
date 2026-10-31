/**
 * 외부 실시간 받아쓰기(OpenAI / Gemini). 마이크 PCM을 개발 서버의 WebSocket 프록시로 보낸다.
 * 키는 서버(vite.config.ts)가 붙이고 브라우저로 내려오지 않는다.
 * 결과는 브라우저 인식과 같은 onInterim / onFinal 로 넘긴다.
 */
import type { SpeechHandlers } from './speech'

export type CloudProvider = 'openai' | 'gemini'

export interface Hints {
  /** 상황 설명 (OpenAI prompt) */
  prompt: string
  /** 잘 알아들어야 할 용어 */
  keywords: string[]
}

const RATE: Record<CloudProvider, number> = { openai: 24000, gemini: 16000 }
const CHUNK_MS = 100
/** 이만큼 조용하면 한 발화를 닫는다 (OpenAI는 서버 VAD가 없어 직접 판단) */
// 실측: 700ms에서는 "3" / "1이에요"처럼 문장이 잘게 쪼개져 같은 지시가 두 번 들어왔다
const END_SILENCE_MS = 900
/** 쉬지 않고 이어 말해도 이 길이마다 확정해 AI가 너무 늦게 반응하지 않게 */
const MAX_TURN_MS = 12000
/** Gemini: 받아쓰기 조각이 이만큼 끊기면 확정 */
const GEMINI_IDLE_MS = 800

/** 브라우저 오디오 처리(자동 음량·잡음 제거)를 끈 원본. 녹음(AudioLog)도 같은 설정이라 장치를 같은 모드로 연다 */
export const RAW_AUDIO: MediaTrackConstraints = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 }

const PROMPT_BASE = '대학 강의 녹음. 교수자가 강의 자료 위에 필기하며 설명한다. 숫자는 아라비아 숫자로 적는다.'

/** 강의 자료 글자에서 용어 힌트를 뽑는다 (한 줄, 꺾쇠 없음) */
export function hintsFromPage(text: string | undefined): Hints {
  const page = (text ?? '').replace(/[<>\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()
  const words = page.match(/[가-힣A-Za-z][가-힣A-Za-z0-9]{1,15}/g) ?? []
  const stop = /^(이다|있다|한다|된다|그리고|그러면|하면|에서|으로|하는|이후|다음|때문)$/
  const keywords = [...new Set(words.map((w) => w.replace(/(은|는|이|가|을|를|의|에|로|으로|와|과|도|만)$/, '')).filter((w) => w.length >= 2 && !stop.test(w)))].slice(0, 60)
  // 실측: "오랑 삼"→"뒤에 파랑 3", "팔이"→"파리"처럼 숫자를 한국어 발음으로 잘못 받아썼다
  const nums = [...new Set(page.match(/\d+(?:\.\d+)?/g) ?? [])].slice(0, 12)
  const numHint = nums.length ? ` 자료의 숫자 ${nums.join(', ')}을(를) 말로 읽으면 일·이·삼·사·오·육·칠·팔·구로 들린다. 숫자로 적는다.` : ''
  return { prompt: page ? `${PROMPT_BASE}${numHint} 강의 자료: ${page.slice(0, 400)}` : PROMPT_BASE, keywords }
}

export function floatToPcm16(f: Float32Array): Int16Array {
  const out = new Int16Array(f.length)
  for (let i = 0; i < f.length; i++) {
    const s = Math.max(-1, Math.min(1, f[i]))
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return out
}

export function pcmToB64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

export function rms(pcm: Int16Array) {
  let sum = 0
  for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i]
  return Math.sqrt(sum / (pcm.length || 1))
}

/**
 * 간단한 에너지 VAD. 배경 소음 수준을 따라가며 그보다 충분히 크면 말소리로 본다.
 * push()가 'end'를 돌려주면 한 발화를 닫는다.
 */
export class Vad {
  floor = 300
  private speaking = false
  private silentMs = 0
  private turnMs = 0
  /** 마지막으로 말소리가 있던 시각 */
  lastVoiceAt = 0

  push(level: number, now: number, ms = CHUNK_MS): 'voice' | 'silence' | 'end' {
    const voice = level > Math.max(this.floor * 2.5, 500)
    if (!voice) this.floor = this.floor * 0.97 + level * 0.03
    if (voice) {
      this.speaking = true
      this.silentMs = 0
      this.lastVoiceAt = now
    } else if (this.speaking) this.silentMs += ms
    if (this.speaking) this.turnMs += ms
    if (this.speaking && (this.silentMs >= END_SILENCE_MS || this.turnMs >= MAX_TURN_MS)) {
      this.speaking = false
      this.silentMs = 0
      this.turnMs = 0
      return 'end'
    }
    return voice ? 'voice' : 'silence'
  }
}

/** AudioWorklet: 입력 프레임을 그대로 메인 스레드로 넘긴다 */
const WORKLET = `class P extends AudioWorkletProcessor{process(i){const c=i[0]&&i[0][0];if(c)this.port.postMessage(c.slice(0));return true}}registerProcessor('pcm-tap',P)`

type Diag = (event: string, detail: Record<string, unknown>) => void

export class CloudSpeech {
  private ws: WebSocket | null = null
  private ctx: AudioContext | null = null
  private stream: MediaStream | null = null
  private wantOn = false
  private buf: Float32Array[] = []
  private bufLen = 0
  private vad = new Vad()
  private hints: Hints = hintsFromPage('')
  private retries = 0
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private openedAt = 0
  // OpenAI: 닫은 발화의 말 끝 시각을 순서대로, 발화(item)별 중간 글자
  private commits: number[] = []
  private itemEnd = new Map<string, number>()
  private itemText = new Map<string, string>()
  /** 설정이 받아들여져 오디오를 보내도 됨 */
  private ready = false
  // Gemini: 받는 중인 글자와 마지막 조각 시각
  private gemText = ''
  private gemTimer: ReturnType<typeof setTimeout> | undefined

  constructor(private provider: CloudProvider, private h: SpeechHandlers, private diag: Diag) {}

  setHints(hints: Hints) {
    this.hints = hints
    if (this.ws?.readyState === WebSocket.OPEN) this.sendSetup(true)
  }

  async start() {
    if (this.wantOn) return
    this.wantOn = true
    this.retries = 0
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: RAW_AUDIO })
    } catch (err) {
      this.wantOn = false
      this.h.onState('blocked', `마이크를 쓸 수 없어요 (${err instanceof Error ? err.name : String(err)})`)
      return
    }
    if (!this.wantOn) return this.release()
    const ctx = new AudioContext({ sampleRate: RATE[this.provider] })
    this.ctx = ctx
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }))
    await ctx.audioWorklet.addModule(url)
    URL.revokeObjectURL(url)
    if (!this.wantOn) return this.release()
    const src = ctx.createMediaStreamSource(this.stream)
    const tap = new AudioWorkletNode(ctx, 'pcm-tap')
    tap.port.onmessage = (e: MessageEvent<Float32Array>) => this.onFrames(e.data)
    src.connect(tap)
    this.diag('cloud-start', { provider: this.provider, rate: ctx.sampleRate, track: this.stream.getAudioTracks()[0]?.getSettings?.() ?? null })
    this.connect()
  }

  stop() {
    this.wantOn = false
    clearTimeout(this.retryTimer)
    this.flushGemini()
    this.ws?.close()
    this.ws = null
    this.release()
    this.diag('stop', { provider: this.provider })
    this.h.onState('off')
  }

  private release() {
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    void this.ctx?.close()
    this.ctx = null
    this.buf = []
    this.bufLen = 0
  }

  private connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${proto}//${location.host}/api/stt/${this.provider}`)
    this.ws = ws
    this.openedAt = performance.now()
    this.ready = false
    this.commits = []
    this.itemEnd.clear()
    this.itemText.clear()
    ws.onopen = () => this.sendSetup(false)
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return
      void (typeof ev.data === 'string' ? Promise.resolve(ev.data) : (ev.data as Blob).text()).then((raw) => {
        try {
          this.onMessage(JSON.parse(raw) as Record<string, unknown>)
        } catch {
          // 알 수 없는 메시지는 무시
        }
      })
    }
    ws.onclose = (ev) => {
      if (this.ws !== ws) return
      this.ws = null
      this.flushGemini()
      this.diag('close', { provider: this.provider, code: ev.code, reason: ev.reason.slice(0, 200) })
      if (!this.wantOn) return
      // 오래 잘 쓰던 연결(세션 시간 제한 등)은 바로, 곧장 끊기면 점점 늦게 다시 연결
      const lived = performance.now() - this.openedAt
      this.retries = lived > 5000 ? 0 : this.retries + 1
      if (this.retries > 5) {
        this.wantOn = false
        this.release()
        this.h.onState('blocked', `${this.provider} 연결에 실패했어요 (${ev.code} ${ev.reason.slice(0, 80)})`)
        return
      }
      const delay = this.retries ? Math.min(500 * 2 ** (this.retries - 1), 5000) : 100
      this.h.onState('on', '받아쓰기를 다시 연결하는 중이에요')
      this.retryTimer = setTimeout(() => { if (this.wantOn) this.connect() }, delay)
    }
  }

  private send(o: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(o))
  }

  private sendSetup(update: boolean) {
    const { prompt, keywords } = this.hints
    if (this.provider === 'openai') {
      this.send({
        type: 'session.update',
        session: {
          type: 'transcription',
          audio: {
            input: {
              format: { type: 'audio/pcm', rate: RATE.openai },
              transcription: { model: 'gpt-live-transcribe', languages: ['ko'], prompt, keywords, delay: 'low' },
              turn_detection: null,
            },
          },
        },
      })
    } else if (!update) {
      // Gemini는 연결 첫 메시지로만 설정한다. 페이지 힌트는 다음 연결부터 반영
      this.send({
        setup: {
          model: 'models/gemini-3.8-live',
          generationConfig: { responseModalities: ['AUDIO'] },
          systemInstruction: { parts: [{ text: '너는 받아쓰기용으로 연결되어 있다. 듣기만 하고 대답하지 않는다.' }] },
          inputAudioTranscription: keywords.length ? { customVocabulary: keywords } : {},
        },
      })
    }
    this.diag('cloud-setup', { provider: this.provider, update, keywords: keywords.length })
  }

  private onFrames(f: Float32Array) {
    if (!this.wantOn) return
    this.buf.push(f)
    this.bufLen += f.length
    const need = (RATE[this.provider] * CHUNK_MS) / 1000
    if (this.bufLen < need) return
    const all = new Float32Array(this.bufLen)
    let o = 0
    for (const b of this.buf) {
      all.set(b, o)
      o += b.length
    }
    this.buf = []
    this.bufLen = 0
    const pcm = floatToPcm16(all)
    if (!this.ready) return
    const now = performance.now()
    if (this.provider === 'openai') {
      this.send({ type: 'input_audio_buffer.append', audio: pcmToB64(pcm) })
      if (this.vad.push(rms(pcm), now, (pcm.length / RATE.openai) * 1000) === 'end') {
        this.commits.push(this.vad.lastVoiceAt || now)
        this.send({ type: 'input_audio_buffer.commit' })
      }
    } else {
      this.send({ realtimeInput: { audio: { data: pcmToB64(pcm), mimeType: `audio/pcm;rate=${RATE.gemini}` } } })
    }
  }

  private onMessage(m: Record<string, unknown>) {
    if (this.provider === 'openai') this.onOpenAi(m)
    else this.onGemini(m)
  }

  private onOpenAi(m: Record<string, unknown>) {
    const id = typeof m.item_id === 'string' ? m.item_id : ''
    switch (m.type) {
      case 'session.updated':
        if (!this.ready) this.h.onState('on')
        this.ready = true
        this.retries = 0
        break
      case 'input_audio_buffer.committed':
        if (id) this.itemEnd.set(id, this.commits.shift() ?? performance.now())
        break
      case 'conversation.item.input_audio_transcription.delta': {
        const text = (this.itemText.get(id) ?? '') + String(m.delta ?? '')
        this.itemText.set(id, text)
        this.h.onInterim(text, performance.now())
        break
      }
      case 'conversation.item.input_audio_transcription.completed': {
        const text = String(m.transcript ?? '').trim()
        const t = this.itemEnd.get(id) ?? performance.now()
        this.itemText.delete(id)
        this.itemEnd.delete(id)
        this.diag('cloud-final', { provider: 'openai', item: id, text, lagMs: Math.round(performance.now() - t) })
        if (text) this.h.onFinal(text, t)
        break
      }
      case 'conversation.item.input_audio_transcription.failed':
      case 'error':
        this.diag('cloud-error', { provider: 'openai', type: m.type, error: m.error ?? null })
        break
    }
  }

  private onGemini(m: Record<string, unknown>) {
    if (m.setupComplete) {
      if (!this.ready) this.h.onState('on')
      this.ready = true
      this.retries = 0
      return
    }
    if (m.goAway) this.diag('cloud-goaway', { provider: 'gemini', goAway: m.goAway })
    const sc = m.serverContent as { inputTranscription?: { text?: string }; turnComplete?: boolean; interrupted?: boolean } | undefined
    const piece = sc?.inputTranscription?.text
    if (piece) {
      this.gemText += piece
      this.vad.lastVoiceAt = performance.now()
      this.h.onInterim(this.gemText.trim(), this.vad.lastVoiceAt)
      clearTimeout(this.gemTimer)
      this.gemTimer = setTimeout(() => this.flushGemini(), GEMINI_IDLE_MS)
    }
  }

  private flushGemini() {
    clearTimeout(this.gemTimer)
    const text = this.gemText.trim()
    this.gemText = ''
    if (!text) return
    this.diag('cloud-final', { provider: 'gemini', text })
    this.h.onFinal(text, this.vad.lastVoiceAt || performance.now())
  }
}
