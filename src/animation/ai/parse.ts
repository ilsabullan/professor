/**
 * 모델이 스트리밍으로 보내는 NDJSON(한 줄에 단계 하나)을 지금까지 받은 글자만으로 해석한다.
 * 마지막 줄이 아직 끝나지 않았어도 "ops" 배열 안에서 완성된 동작 객체는 바로 꺼낸다.
 * 그래야 첫 동작이 줄 전체를 기다리지 않고 재생된다.
 *
 * 줄 형식: {"conf":0.8,"ops":[{...},{...}],"cap":"자막"}   또는   {"none":true}
 */

export interface ParsedStep {
  ops: unknown[]
  cap: string
  conf?: number
  /** 줄이 끝까지 도착함 */
  closed: boolean
}

export interface ParseResult {
  steps: ParsedStep[]
  none: boolean
}

const CAP_RE = /"cap"\s*:\s*"((?:[^"\\]|\\.)*)"/
const CONF_RE = /"conf"\s*:\s*(-?\d+(?:\.\d+)?)/
const NONE_RE = /"none"\s*:\s*true/

/** "ops":[ 뒤에서 완성된 {...} 객체만 꺼낸다 */
export function scanOps(line: string): unknown[] {
  const at = line.indexOf('"ops"')
  if (at < 0) return []
  const lb = line.indexOf('[', at)
  if (lb < 0) return []
  const out: unknown[] = []
  let depth = 0
  let start = -1
  let inStr = false
  let esc = false
  for (let i = lb + 1; i < line.length; i++) {
    const ch = line[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') {
      if (depth === 0) start = i
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0 && start >= 0) {
        try {
          out.push(JSON.parse(line.slice(start, i + 1)))
        } catch {
          // 깨진 객체는 건너뜀
        }
        start = -1
      }
    } else if (ch === ']' && depth === 0) break
  }
  return out
}

function unescape(s: string) {
  try {
    return JSON.parse(`"${s}"`) as string
  } catch {
    return s
  }
}

function partialStep(line: string, closed: boolean): ParsedStep {
  const cap = line.match(CAP_RE)
  const conf = line.match(CONF_RE)
  return {
    ops: scanOps(line),
    cap: cap ? unescape(cap[1]) : '',
    conf: conf ? Number(conf[1]) : undefined,
    closed,
  }
}

export function parseProgress(text: string): ParseResult {
  const lines = text.split('\n')
  const endsClean = text.endsWith('\n')
  const steps: ParsedStep[] = []
  let none = false
  lines.forEach((raw, i) => {
    const closed = i < lines.length - 1 || endsClean
    const line = raw.trim().replace(/^```(?:json)?/, '').replace(/```$/, '').trim()
    if (!line.startsWith('{')) return
    if (NONE_RE.test(line)) {
      none = true
      return
    }
    if (closed) {
      try {
        const j = JSON.parse(line) as Record<string, unknown>
        if (j.none === true) {
          none = true
          return
        }
        steps.push({
          ops: Array.isArray(j.ops) ? j.ops : [],
          cap: typeof j.cap === 'string' ? j.cap : '',
          conf: typeof j.conf === 'number' ? j.conf : undefined,
          closed: true,
        })
        return
      } catch {
        // 한 줄이 JSON으로 안 읽히면 부분 해석으로 살릴 수 있는 만큼 살린다
      }
    }
    steps.push(partialStep(line, closed))
  })
  return { steps, none }
}
