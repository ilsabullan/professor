import { clamp } from './geometry'

/** AI(와 즉시 반응 규칙)가 쓰는 기본 동작 */
export type Op =
  | { v: 'flow'; along: string; n: number; speed: number; color: string; rev: boolean }
  | { v: 'stop'; along: string }
  | {
      v: 'spawn'
      id: string
      shape: 'dot' | 'circle' | 'box' | 'label'
      at?: [number, number]
      on?: string
      text: string
      color: string
      r: number
      w: number
      h: number
      /** 이 시간(ms)이 지나면 흐려지며 사라짐 (즉시 반응 효과용) */
      life?: number
    }
  | { v: 'move'; id: string; to?: [number, number] | string; along?: string; dur: number }
  | { v: 'swap'; a: string; b: string; dur: number }
  /** 표/배열의 칸1부터 순서대로 객체를 놓는다 (교환·정렬 결과를 정확히 보여줄 때) */
  | { v: 'arrange'; grid: string; order: string[]; dur: number }
  | { v: 'color'; id: string; color: string }
  | { v: 'scale'; id: string; k: number; dur: number }
  | { v: 'pulse'; id: string }
  | { v: 'fade'; id: string; to: number; dur: number }
  | { v: 'label'; id: string; text: string }

export const COLORS: Record<string, string> = {
  red: '#ff5a46',
  blue: '#6ea8ff',
  green: '#7be596',
  amber: '#ffc65a',
  cyan: '#5ec8e6',
  white: '#eef0e6',
  gray: '#93a39b',
}

const PARTICLE = '#cdf0ff'

const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : null)
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const xy = (v: unknown): [number, number] | null =>
  Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number' && Number.isFinite(n))
    ? [v[0] as number, v[1] as number]
    : null
const color = (v: unknown, d: string) => {
  if (typeof v !== 'string') return d
  if (COLORS[v]) return COLORS[v]
  return /^#[0-9a-f]{3,8}$/i.test(v) ? v : d
}
const dur = (v: unknown) => clamp(num(v, 700), 150, 3000)

/** 모델 출력처럼 믿을 수 없는 값을 안전한 Op로 바꾼다. 쓸 수 없으면 null */
export function sanitizeOp(raw: unknown): Op | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  switch (o.v) {
    case 'flow': {
      const along = str(o.along)
      if (!along) return null
      return {
        v: 'flow',
        along,
        n: Math.round(clamp(num(o.n, 8), 1, 30)),
        speed: clamp(num(o.speed, 1), 0.2, 4),
        color: color(o.color, PARTICLE),
        rev: o.rev === true,
      }
    }
    case 'stop': {
      const along = str(o.along)
      return along ? { v: 'stop', along } : null
    }
    case 'spawn': {
      const id = str(o.id)
      if (!id) return null
      const shape = o.shape === 'circle' || o.shape === 'box' || o.shape === 'label' ? o.shape : 'dot'
      return {
        v: 'spawn',
        id,
        shape,
        at: xy(o.at) ?? undefined,
        on: str(o.on) ?? undefined,
        text: typeof o.text === 'string' ? o.text.slice(0, 24) : '',
        color: color(o.color, PARTICLE),
        r: clamp(num(o.r, 8), 2, 80),
        w: clamp(num(o.w, 60), 8, 400),
        h: clamp(num(o.h, 40), 8, 400),
      }
    }
    case 'move': {
      const id = str(o.id)
      if (!id) return null
      const to = xy(o.to) ?? str(o.to) ?? undefined
      const along = str(o.along) ?? undefined
      if (!to && !along) return null
      return { v: 'move', id, to, along, dur: dur(o.dur) }
    }
    case 'swap': {
      const a = str(o.a)
      const b = str(o.b)
      return a && b ? { v: 'swap', a, b, dur: dur(o.dur) } : null
    }
    case 'arrange': {
      const grid = str(o.grid)
      const order = Array.isArray(o.order) ? o.order.filter((x): x is string => typeof x === 'string') : []
      return grid && order.length ? { v: 'arrange', grid, order, dur: dur(o.dur) } : null
    }
    case 'color': {
      const id = str(o.id)
      return id ? { v: 'color', id, color: color(o.color, COLORS.amber) } : null
    }
    case 'scale': {
      const id = str(o.id)
      return id ? { v: 'scale', id, k: clamp(num(o.k, 1.3), 0.2, 4), dur: dur(o.dur) } : null
    }
    case 'pulse': {
      const id = str(o.id)
      return id ? { v: 'pulse', id } : null
    }
    case 'fade': {
      const id = str(o.id)
      return id ? { v: 'fade', id, to: clamp(num(o.to, 0.2), 0, 1), dur: dur(o.dur) } : null
    }
    case 'label': {
      const id = str(o.id)
      return id ? { v: 'label', id, text: typeof o.text === 'string' ? o.text.slice(0, 14) : '' } : null
    }
  }
  return null
}
