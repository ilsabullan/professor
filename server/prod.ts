/**
 * 배포용 서버. 개발 서버(vite.config.ts)가 하던 일 중 운영에 필요한 것만 한다.
 * - dist/ 정적 파일
 * - /healthz
 * - 접속 코드: ?k=<코드>로 한 번 연 기기에만 쿠키를 주고, /api/* 는 쿠키가 있어야 쓴다 (키 보호)
 * - /api/status, /api/anthropic/* 프록시, /api/stt/<업체> WebSocket 프록시
 * 키와 접속 코드는 환경 변수로만 받는다. 의존성 없이 Node 내장 모듈만 쓴다.
 */
import { createReadStream, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname, join, normalize, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { connect } from 'node:tls'
import type { Duplex } from 'node:stream'
import { hasCodeCookie, isAccessCode } from './accessCode.ts'

const PORT = Number(process.env.PORT ?? 8080)
const HOST = process.env.HOST ?? '0.0.0.0'
const DIST = resolve(process.env.DIST_DIR ?? 'dist')
const CODE = process.env.ILSABULLAN_ACCESS_CODE ?? ''
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? ''
const MAX_BODY = 20e6

if (!isAccessCode(CODE)) {
  console.error('ILSABULLAN_ACCESS_CODE가 없거나 형식이 틀립니다 (16진수 8~64자)')
  process.exit(1)
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf',
}

/** 받아쓰기 업체별 연결 대상과 키 헤더 */
const STT: Record<string, { host: string; path: string; header: [string, string] }> = {
  openai: {
    host: 'api.openai.com',
    path: '/v1/realtime?intent=transcription',
    header: ['authorization', `Bearer ${process.env.OPENAI_API_KEY ?? ''}`],
  },
  gemini: {
    host: 'generativelanguage.googleapis.com',
    path: '/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent',
    header: ['x-goog-api-key', process.env.GEMINI_API_KEY ?? ''],
  },
}

/** 업스트림으로 넘기지 않는 요청 헤더 */
const DROP_REQ = new Set(['host', 'origin', 'cookie', 'referer', 'connection', 'content-length', 'accept-encoding', 'anthropic-dangerous-direct-browser-access', 'x-api-key', 'authorization'])
/** 그대로 돌려주지 않는 응답 헤더 (fetch가 이미 압축을 풀었다) */
const DROP_RES = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection'])

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        fail(new Error('too_large'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => ok(Buffer.concat(chunks)))
    req.on('error', fail)
  })
}

async function proxyAnthropic(req: IncomingMessage, res: ServerResponse, path: string) {
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) if (!DROP_REQ.has(k) && typeof v === 'string') headers.set(k, v)
  headers.set('x-api-key', ANTHROPIC_KEY)
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req)
  const ac = new AbortController()
  res.on('close', () => ac.abort())
  const up = await fetch(`https://api.anthropic.com${path}`, { method: req.method, headers, body, signal: ac.signal })
  const out: Record<string, string> = {}
  up.headers.forEach((v, k) => {
    if (!DROP_RES.has(k)) out[k] = v
  })
  res.writeHead(up.status, out)
  if (!up.body) return res.end()
  Readable.fromWeb(up.body as import('node:stream/web').ReadableStream).pipe(res)
}

function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string) {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '')
  let file = join(DIST, rel)
  if (!file.startsWith(DIST)) return json(res, 400, { error: 'bad_path' })
  let st = statSync(file, { throwIfNoEntry: false })
  if (!st || st.isDirectory()) {
    // 화면 이동은 해시(#/l/…)로 하므로 그 밖의 경로는 첫 화면으로
    file = join(DIST, 'index.html')
    st = statSync(file, { throwIfNoEntry: false })
    if (!st) return json(res, 404, { error: 'not_found' })
  }
  const immutable = rel.startsWith('assets/')
  res.writeHead(200, {
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    'content-length': st.size,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff',
  })
  if (req.method === 'HEAD') return res.end()
  createReadStream(file).pipe(res)
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://local')
  const { pathname } = url
  if (pathname === '/healthz') return json(res, 200, { ok: true })

  if (url.searchParams.get('k') === CODE) {
    res.setHeader('set-cookie', `lb_code=${CODE}; Path=/; SameSite=Strict; Secure; HttpOnly; Max-Age=2592000`)
  }

  if (pathname.startsWith('/api/')) {
    if (!hasCodeCookie(req.headers.cookie, CODE) && url.searchParams.get('k') !== CODE) return json(res, 403, { error: 'access_code_required' })
    if (pathname === '/api/status') return json(res, 200, { anthropic: !!ANTHROPIC_KEY })
    if (pathname.startsWith('/api/anthropic/')) {
      proxyAnthropic(req, res, pathname.slice('/api/anthropic'.length) + url.search).catch((err) => {
        if (res.headersSent) return res.destroy()
        json(res, err instanceof Error && err.message === 'too_large' ? 413 : 502, { error: 'upstream_failed' })
      })
      return
    }
    return json(res, 404, { error: 'not_found' })
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method_not_allowed' })
  serveStatic(req, res, pathname)
})

/** WebSocket 업그레이드를 업체로 그대로 잇는다. 키는 여기서 붙이고 쿠키·origin은 떼어 낸다 */
server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
  const url = new URL(req.url ?? '/', 'http://local')
  const provider = /^\/api\/stt\/(\w+)$/.exec(url.pathname)?.[1]
  const target = provider ? STT[provider] : undefined
  if (!target || !hasCodeCookie(req.headers.cookie, CODE)) {
    socket.end('HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n')
    return
  }
  const up = connect({ host: target.host, port: 443, servername: target.host }, () => {
    const lines = [`GET ${target.path} HTTP/1.1`, `host: ${target.host}`, `${target.header[0]}: ${target.header[1]}`]
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i]
      if (!DROP_REQ.has(k.toLowerCase())) lines.push(`${k}: ${req.rawHeaders[i + 1]}`)
    }
    lines.push('connection: Upgrade')
    up.write(lines.join('\r\n') + '\r\n\r\n')
    if (head.length) up.write(head)
    up.pipe(socket)
    socket.pipe(up)
  })
  const close = () => {
    up.destroy()
    socket.destroy()
  }
  up.on('error', close)
  socket.on('error', close)
  up.on('close', close)
  socket.on('close', close)
})

server.listen(PORT, HOST, () => console.log(`listening on ${HOST}:${PORT}`))

const stop = () => {
  server.close(() => process.exit(0))
  server.closeAllConnections()
  setTimeout(() => process.exit(0), 5000).unref()
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
