import Anthropic from '@anthropic-ai/sdk'
import { SYSTEM_PROMPT } from './prompt'

export type ModelId = 'claude-haiku-5-5' | 'claude-sonnet-5-5'
export type ThinkingMode = 'off' | 'adaptive'

export interface AiOptions {
  model: ModelId
  thinking: ThinkingMode
}

export interface StreamResult {
  model: string
  cacheRead: number
  inputTokens: number
  outputTokens: number
}

let client: Anthropic | null = null

/**
 * 브라우저는 같은 출처의 /api/anthropic 으로만 보내고,
 * Vite 개발 서버 프록시가 .env의 키를 붙여 Anthropic으로 넘긴다. 진짜 키는 브라우저에 오지 않는다.
 */
const nodeEnv = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env

function getClient() {
  // 브라우저 밖(채점 스크립트)에서는 .env 키로 직접 호출
  if (typeof window === 'undefined') {
    client ??= new Anthropic({ apiKey: nodeEnv?.ANTHROPIC_API_KEY, maxRetries: 2 })
    return client
  }
  client ??= new Anthropic({
    apiKey: 'set-by-dev-proxy',
    baseURL: `${window.location.origin}/api/anthropic`,
    dangerouslyAllowBrowser: true,
    // 1초 예산 안에서 재시도는 의미가 없다. 새 입력이 오면 새로 요청한다
    maxRetries: 0,
  })
  return client
}

function thinkingParams(o: AiOptions): { thinking: Anthropic.ThinkingConfigParam; output_config: Anthropic.OutputConfig } {
  if (o.thinking === 'adaptive') return { thinking: { type: 'adaptive' }, output_config: { effort: 'low' } }
  // 속도 우선: 생각 끄기. Haiku 5.5는 disabled(effort high 이하), Sonnet 5.5는 between_tools로 끈다
  if (o.model === 'claude-sonnet-5-5') return { thinking: { type: 'between_tools' }, output_config: { effort: 'low' } }
  return { thinking: { type: 'disabled' }, output_config: { effort: 'low' } }
}

const system: Anthropic.TextBlockParam[] = [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }]

export async function streamSteps(
  o: AiOptions,
  content: Anthropic.ContentBlockParam[],
  signal: AbortSignal,
  onText: (full: string) => void,
): Promise<StreamResult> {
  const stream = getClient().messages.stream(
    { model: o.model, max_tokens: 2048, system, messages: [{ role: 'user', content }], ...thinkingParams(o) },
    { signal },
  )
  let full = ''
  for await (const ev of stream) {
    if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
      full += ev.delta.text
      onText(full)
    }
  }
  const msg = await stream.finalMessage()
  return {
    model: msg.model,
    cacheRead: msg.usage.cache_read_input_tokens ?? 0,
    inputTokens: msg.usage.input_tokens,
    outputTokens: msg.usage.output_tokens,
  }
}

/** 시스템 프롬프트 캐시와 연결을 미리 데운다 (출력 없이 캐시만 씀) */
export async function prewarm(o: AiOptions) {
  await getClient().messages.create({
    model: o.model,
    max_tokens: 0,
    system,
    messages: [{ role: 'user', content: '준비' }],
    ...thinkingParams(o),
  })
}

export async function proxyStatus(): Promise<{ anthropic: boolean; locked?: boolean }> {
  const res = await fetch('/api/status')
  // 내부망 기기가 접속 코드 없이 열었음
  if (res.status === 403) return { anthropic: false, locked: true }
  if (!res.ok) throw new Error(`status ${res.status}`)
  return res.json()
}

export function describeError(err: unknown): { text: string; noKey: boolean; aborted: boolean } {
  if (err instanceof Anthropic.APIUserAbortError) return { text: '중단', noKey: false, aborted: true }
  if (err instanceof Anthropic.AuthenticationError) return { text: 'API 키가 없거나 틀림', noKey: true, aborted: false }
  if (err instanceof Anthropic.RateLimitError) return { text: '속도 제한(429)', noKey: false, aborted: false }
  if (err instanceof Anthropic.BadRequestError) return { text: `잘못된 요청: ${err.message}`, noKey: false, aborted: false }
  if (err instanceof Anthropic.APIError) return { text: `API 오류 ${err.status ?? ''}: ${err.message}`, noKey: false, aborted: false }
  return { text: err instanceof Error ? err.message : String(err), noKey: false, aborted: false }
}
