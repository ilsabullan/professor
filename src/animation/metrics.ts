/** 요청 하나의 지연 기록 (모든 시각은 performance.now() ms) */
export interface ReqRecord {
  id: number
  kind: string
  desc: string
  /** 교수자 행동 시각 (획을 뗀 순간, 말을 멈춘 순간 등) */
  t0: number
  /** 미리 시작한 요청이 나중에 확정된 말과 같았을 때, 말을 멈춘 시각 */
  tSpeechEnd?: number
  quickMs?: number
  tSend?: number
  tFirst?: number
  tFirstOp?: number
  tFirstMove?: number
  actionId?: string
  rejected?: number
  /** 성공·오류·중단을 포함한 요청 종료 시각 */
  tEnd?: number
  /** 요청 시작 시점의 전체 설정 */
  settings?: Record<string, unknown>
  /** API가 반환한 실제 모델 */
  model?: string
  tDone?: number
  status: string
  cap: string
  conf?: number
  cfg: string
  /** 사용자 ✓/✗ */
  feedback?: 'ok' | 'bad'
  /** 필기 이미지를 같이 보냈는지 */
  image?: boolean
  cacheRead?: number
  inputTokens?: number
  outputTokens?: number
}

/** 사용자가 느끼는 지연: 행동(말이면 말을 멈춘 순간)부터 AI 첫 동작까지 */
export function latency(r: ReqRecord): number | null {
  if (r.tFirstOp == null) return null
  return r.tFirstOp - (r.tSpeechEnd ?? r.t0)
}

export function pct(values: number[], p: number): number | null {
  if (!values.length) return null
  const s = [...values].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]
}

export interface Summary {
  cfg: string
  count: number
  played: number
  aborted: number
  errors: number
  noMovement: number
  pending: number
  held: number
  p50: number | null
  p90: number | null
  under1s: number | null
  quickP50: number | null
}

/** "말 중" 요청은 확정된 말과 이어진 경우만 센다 (그 외에는 기준 시각이 의미 없음) */
const counts = (r: ReqRecord) => r.kind !== '말 중'

export function summarize(reqs: ReqRecord[]): Summary[] {
  const groups = new Map<string, ReqRecord[]>()
  for (const r of reqs) {
    if (!counts(r)) continue
    const g = groups.get(r.cfg) ?? []
    g.push(r)
    groups.set(r.cfg, g)
  }
  return [...groups.entries()].map(([cfg, g]) => {
    const lat = g.map(latency).filter((v): v is number => v != null)
    const quick = g.map((r) => r.quickMs).filter((v): v is number => v != null)
    return {
      cfg,
      count: g.length,
      played: lat.length,
      aborted: g.filter((r) => r.status.startsWith('중단')).length,
      errors: g.filter((r) => r.status.startsWith('오류') || r.status === '형식 오류').length,
      noMovement: g.filter((r) => r.status === '새 움직임 없음').length,
      pending: g.filter((r) => r.status === '진행 중').length,
      held: g.filter((r) => r.status.startsWith('확신 낮음') || r.status.startsWith('보류')).length,
      p50: pct(lat, 0.5),
      p90: pct(lat, 0.9),
      under1s: lat.length ? lat.filter((v) => v <= 1000).length / lat.length : null,
      quickP50: pct(quick, 0.5),
    }
  })
}

export function toCsv(reqs: ReqRecord[]): string {
  const sec = (a?: number, b?: number) => (a != null && b != null ? ((a - b) / 1000).toFixed(3) : '')
  const head = '번호,설정,계기,즉시반응ms,전송s,첫토큰s,첫동작s,체감지연s,이미지,상태,확신,캐시읽음,입력토큰,출력토큰,자막,내용,종료s,피드백,실제모델,전체설정,첫이동s,실행단위,거부횟수'
  const rows = reqs.map((r) => {
    const lat = latency(r)
    return [
      r.id,
      r.cfg,
      r.kind,
      r.quickMs != null ? Math.round(r.quickMs) : '',
      sec(r.tSend, r.t0),
      sec(r.tFirst, r.t0),
      sec(r.tFirstOp, r.t0),
      lat != null ? (lat / 1000).toFixed(3) : '',
      r.image ? 'O' : '',
      r.status,
      r.conf ?? '',
      r.cacheRead ?? '',
      r.inputTokens ?? '',
      r.outputTokens ?? '',
      r.cap,
      r.desc,
      sec(r.tEnd, r.t0),
      r.feedback ?? '',
      r.model ?? '',
      r.settings ? JSON.stringify(r.settings) : '',
      sec(r.tFirstMove, r.t0),
      r.actionId ?? '',
      r.rejected ?? '',
    ]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`)
      .join(',')
  })
  return [head, ...rows].join('\n')
}
