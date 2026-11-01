import { clamp } from './geometry'

/** AI(와 즉시 반응 규칙)가 쓰는 기본 동작 */
export type Op =
  | { v: 'flow'; along: string; n: number; speed: number; color: string; rev: boolean }
  /**
   * 경로를 따라 패킷 n개를 한 줄로 한 번만 보낸다 (계속 흐르는 flow와 달리 개수가 보인다).
   * drop: 뒤쪽 몇 개가 at(버퍼·라우터) 자리에서 버려짐. ack: 응답 패킷(작은 초록 점)
   */
  | { v: 'send'; along: string; n: number; color: string; rev: boolean; drop: number; at?: string; ack?: boolean }
  | { v: 'stop'; along?: string; id?: string }
  /**
   * 확산: 용기(상자) 안에서 입자 n개가 한 점(at, 없으면 용기 가운데)에서 퍼져 나간다.
   * spread 0~1: 0.1 막 떨어뜨린 방울, 0.5 사방으로 퍼지는 중, 1 용기 전체에 고르게. 같은 용기에 다시 쓰면 지금 퍼진 정도에서 이어서 퍼진다
   */
  | { v: 'diffuse'; in: string; spread: number; n: number; color: string; at?: [number, number]; dur: number }
  | {
      v: 'spawn'
      id: string
      shape: 'dot' | 'circle' | 'box' | 'label' | 'arrow'
      at?: [number, number]
      /** arrow: 시작·끝 (객체 id 또는 좌표) */
      from?: string | [number, number]
      to?: string | [number, number]
      on?: string
      text: string
      color: string
      r: number
      w: number
      h: number
      /** 이 시간(ms)이 지나면 흐려지며 사라짐 (즉시 반응 효과용) */
      life?: number
    }
  | { v: 'move'; id: string; to?: [number, number] | string; along?: string; by?: [number, number]; dur: number; loop?: boolean }
  /**
   * 기준점(about: 좌표 또는 객체 id, 없으면 자기 중심)을 축으로 돌림. deg는 도(시계 방향 +).
   * loop: |deg|<360이면 ±deg 왕복(진자), 360 이상이면 계속 회전(자전). stop id로 멈춘다
   * tilt: 진자를 비스듬히 그렸을 때 수직 아래에서 기운 각도(도, 시계 방향 +). 있으면 그려진 자리에서 수직선 건너 반대편까지 흔든다 (AI가 아니라 보정 단계에서 채움)
   */
  | { v: 'rotate'; id: string; deg: number; about?: [number, number] | string; dur: number; loop?: boolean; tilt?: number }
  /** 움직이거나 돌린 객체를 처음 자리로 되돌림 (id 없으면 전부) */
  | { v: 'restore'; id?: string; dur: number }
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
    case 'send': {
      const along = str(o.along)
      if (!along) return null
      const ack = o.ack === true
      const n = Math.round(clamp(num(o.n, 1), 1, 16))
      const at = str(o.at) ?? undefined
      return {
        v: 'send',
        along,
        n,
        color: color(o.color, ack ? COLORS.green : PARTICLE),
        rev: o.rev === true,
        drop: Math.round(clamp(num(o.drop, 0), 0, n)),
        ...(at ? { at } : {}),
        ...(ack ? { ack } : {}),
      }
    }
    case 'diffuse': {
      const box = str(o.in)
      if (!box) return null
      const at = xy(o.at) ?? undefined
      return {
        v: 'diffuse',
        in: box,
        spread: clamp(num(o.spread, 0.5), 0.03, 1),
        n: Math.round(clamp(num(o.n, 30), 6, 60)),
        color: color(o.color, COLORS.blue),
        ...(at ? { at } : {}),
        dur: clamp(num(o.dur, 2500), 300, 8000),
      }
    }
    case 'stop': {
      const along = str(o.along) ?? undefined
      const id = str(o.id) ?? undefined
      return along || id ? { v: 'stop', along, id } : null
    }
    case 'spawn': {
      const id = str(o.id)
      if (!id) return null
      const shape = o.shape === 'circle' || o.shape === 'box' || o.shape === 'label' || o.shape === 'arrow' ? o.shape : 'dot'
      const from = xy(o.from) ?? str(o.from) ?? undefined
      const to = xy(o.to) ?? str(o.to) ?? undefined
      if (shape === 'arrow' && (!from || !to)) return null
      return {
        v: 'spawn',
        id,
        shape,
        ...(shape === 'arrow' ? { from, to } : {}),
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
      const by = xy(o.by) ?? undefined
      if (!to && !along && !by) return null
      // 반복은 경로를 따라갈 때만. 한 바퀴는 조금 느리게
      const loop = o.loop === true && !!along
      return { v: 'move', id, to, along, by, dur: loop ? clamp(num(o.dur, 3000), 1200, 8000) : dur(o.dur), ...(loop ? { loop } : {}) }
    }
    case 'rotate': {
      const id = str(o.id)
      if (!id) return null
      const loop = o.loop === true
      const deg = clamp(num(o.deg, loop ? 30 : 90), -1080, 1080)
      if (Math.abs(deg) < 1) return null
      const about = xy(o.about) ?? str(o.about) ?? undefined
      return { v: 'rotate', id, deg, ...(about ? { about } : {}), dur: loop ? clamp(num(o.dur, 2000), 600, 8000) : dur(o.dur), ...(loop ? { loop } : {}) }
    }
    case 'restore': {
      const id = str(o.id) ?? undefined
      return { v: 'restore', ...(id ? { id } : {}), dur: dur(o.dur) }
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
