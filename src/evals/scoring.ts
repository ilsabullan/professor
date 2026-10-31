export interface Check {
  after: number
  order?: string
  flows?: string[]
  noFlow?: boolean
  unchanged?: boolean
  forbiddenMoved?: string[]
  note?: string
}
export interface Frame {
  order: string
  before: string
  overlap: string[]
  flows: string[]
  moved: string[]
}
export function passes(k: Check, s: Frame) {
  if (s.overlap.length) return false
  if (k.order && !k.order.split('|').map((x) => x.trim()).includes(s.order)) return false
  if (k.flows && (s.flows.length !== k.flows.length || !k.flows.every((id) => s.flows.includes(id)))) return false
  if (k.noFlow && s.flows.length) return false
  if (k.unchanged && (s.order !== s.before || s.moved.length)) return false
  if (k.forbiddenMoved?.some((id) => s.moved.includes(id))) return false
  return true
}
