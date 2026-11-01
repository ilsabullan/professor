export interface Check {
  after: number
  order?: string
  flows?: string[]
  noFlow?: boolean
  unchanged?: boolean
  forbiddenMoved?: string[]
  /** 이 말에서 보낸 데이터 패킷 수 순서 ("2 4", | 로 허용 답 여러 개, 빈 문자열 = 안 보냄) */
  sends?: string
  /** 버려지는 패킷이 있어야 함 */
  drop?: boolean
  /** 응답 패킷을 보내야 함 */
  ack?: boolean
  /** 흐름이나 보낸 패킷이 하나라도 있어야 함 */
  motion?: boolean
  note?: string
}
export interface Frame {
  order: string
  before: string
  overlap: string[]
  flows: string[]
  moved: string[]
  /** 보낸 묶음: "4" 데이터, "4x1" 1개 버려짐, "a4" 응답 */
  sends?: string[]
}
export function passes(k: Check, s: Frame) {
  if (s.overlap.length) return false
  if (k.order && !k.order.split('|').map((x) => x.trim()).includes(s.order)) return false
  if (k.flows && (s.flows.length !== k.flows.length || !k.flows.every((id) => s.flows.includes(id)))) return false
  if (k.noFlow && s.flows.length) return false
  if (k.unchanged && (s.order !== s.before || s.moved.length)) return false
  if (k.forbiddenMoved?.some((id) => s.moved.includes(id))) return false
  const sends = s.sends ?? []
  const data = sends.filter((x) => !x.startsWith('a')).map((x) => x.split('x')[0]).join(' ')
  if (k.sends != null) {
    const ok = k.sends.startsWith('/') ? new RegExp(k.sends.slice(1, -1)).test(data) : k.sends.split('|').map((x) => x.trim()).includes(data)
    if (!ok) return false
  }
  if (k.motion && !s.flows.length && !sends.length) return false
  if (k.drop && !sends.some((x) => x.includes('x'))) return false
  if (k.ack && !sends.some((x) => x.startsWith('a'))) return false
  return true
}
