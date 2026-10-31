/**
 * 개발용 실측 음성 원본 기록. 마이크를 켜 둔 동안 녹음해 일정 간격의 조각으로 로그 서버에 보낸다.
 * 서버는 같은 녹음(rec)의 조각을 순서대로 logs/<세션>/audio-<rec>.<확장자> 한 파일에 이어 붙인다.
 * 조각마다 t0~t1(performance.now 기준, final·interim 기록의 t와 같은 시계)을 남기므로
 * 발화 시각 - 녹음 시작 시각(audio-start의 t0)으로 파일 안 위치를 찾을 수 있다.
 */
import { RAW_AUDIO } from '../animation/cloudstt'

type Log = (type: string, data: Record<string, unknown>) => void

const PART_MS = 5000
const MIMES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/mp4']

function pickMime() {
  if (typeof MediaRecorder === 'undefined') return null
  return MIMES.find((m) => MediaRecorder.isTypeSupported(m)) ?? null
}

function toB64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(blob)
  })
}

export class AudioLog {
  private recSeq = 0
  private active: { rec: number; recorder: MediaRecorder; stream: MediaStream } | null = null
  private starting = false
  /** 시작(권한 대기) 중에 마이크가 꺼짐 */
  private wantOff = false
  /** 이번에 켠 동안 녹음을 못 함 (마이크를 다시 켤 때까지 재시도하지 않음) */
  private failed = false
  /** 조각 인코딩이 끝나는 순서를 보장 (FileReader는 비동기) */
  private chain: Promise<void> = Promise.resolve()

  constructor(private log: Log) {}

  /** 마이크 상태에 맞춰 녹음을 켜고 끈다 */
  sync(micOn: boolean) {
    if (micOn) void this.start()
    else {
      this.failed = false
      this.stop()
    }
  }

  private async start() {
    if (this.starting) this.wantOff = false
    if (this.active || this.starting || this.failed) return
    const mime = pickMime()
    if (!mime || !navigator.mediaDevices?.getUserMedia) {
      this.failed = true
      this.log('audio-error', { reason: 'unsupported' })
      return
    }
    this.starting = true
    let stream: MediaStream
    try {
      // 받아쓰기(cloudstt)와 같은 원본 설정으로 열어야 장치가 다른 처리 모드로 바뀌지 않는다
      stream = await navigator.mediaDevices.getUserMedia({ audio: RAW_AUDIO })
    } catch (err) {
      this.starting = false
      this.failed = true
      this.wantOff = false
      this.log('audio-error', { reason: err instanceof Error ? err.name : String(err) })
      return
    }
    this.starting = false
    const rec = ++this.recSeq
    const recorder = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 32000 })
    const t0 = performance.now()
    let last = t0
    let part = 0
    recorder.ondataavailable = (ev) => {
      const now = performance.now()
      const from = last
      last = now
      if (!ev.data.size) return
      const index = ++part
      this.chain = this.chain
        .then(() => toB64(ev.data))
        .then((audioB64) => { this.log('audio', { rec, part: index, mime: recorder.mimeType || mime, t0: from, t1: now, audioB64 }) })
        .catch((err) => { this.log('audio-error', { rec, part: index, reason: String(err) }) })
    }
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop())
      this.chain = this.chain.then(() => { this.log('audio-stop', { rec, t1: performance.now(), parts: part }) })
    }
    this.active = { rec, recorder, stream }
    recorder.start(PART_MS)
    const track = stream.getAudioTracks()[0]
    this.log('audio-start', { rec, t0, mime: recorder.mimeType || mime, partMs: PART_MS, settings: track?.getSettings?.() ?? null })
    // 시작을 기다리는 동안 마이크가 꺼졌으면 바로 정리
    if (this.wantOff) {
      this.wantOff = false
      this.stop()
    }
  }

  stop() {
    if (this.starting) {
      this.wantOff = true
      return
    }
    const a = this.active
    if (!a) return
    this.active = null
    if (a.recorder.state !== 'inactive') a.recorder.stop()
    else a.stream.getTracks().forEach((t) => t.stop())
  }
}
