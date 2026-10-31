import { getDevAccessCode } from './server/accessCode.ts'
import { resolve } from 'node:path'
import { createLogStore } from './server/logStore.ts'
import { networkInterfaces } from 'node:os'
import type { ClientRequest, IncomingMessage } from 'node:http'
import { defineConfig, loadEnv, type Plugin, type ProxyOptions } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'

const isLocal = (ip: string) => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'

function lanAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => n!.address)
}

/** 이 Mac 자신이거나 접속 코드 쿠키가 있는 요청 */
function hasAccess(req: IncomingMessage, code: string) {
  const cookie = /(?:^|;\s*)lb_code=([^;]+)/.exec(req.headers.cookie ?? '')?.[1]
  return isLocal(req.socket.remoteAddress ?? '') || cookie === code
}

/**
 * 실시간 받아쓰기 WebSocket 프록시. 브라우저는 /api/stt/<업체>로 연결하고 서버가 키를 붙여 넘긴다.
 * WebSocket 업그레이드는 미들웨어를 거치지 않으므로 접속 코드는 bypass에서 따로 확인한다.
 */
function sttProxy(code: string, env: Record<string, string>): Record<string, ProxyOptions> {
  const guard = (req: IncomingMessage) => (hasAccess(req, code) ? undefined : false)
  const strip = (proxyReq: ClientRequest) => {
    proxyReq.removeHeader('origin')
    proxyReq.removeHeader('cookie')
  }
  return {
    '/api/stt/openai': {
      target: 'wss://api.openai.com',
      ws: true,
      changeOrigin: true,
      bypass: guard,
      rewrite: () => '/v1/realtime?intent=transcription',
      configure: (proxy) => {
        proxy.on('proxyReqWs', (proxyReq) => {
          strip(proxyReq)
          proxyReq.setHeader('authorization', `Bearer ${env.OPENAI_API_KEY ?? ''}`)
        })
      },
    },
    '/api/stt/gemini': {
      target: 'wss://generativelanguage.googleapis.com',
      ws: true,
      changeOrigin: true,
      bypass: guard,
      rewrite: () => '/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent',
      configure: (proxy) => {
        proxy.on('proxyReqWs', (proxyReq) => {
          strip(proxyReq)
          proxyReq.setHeader('x-goog-api-key', env.GEMINI_API_KEY ?? '')
        })
      },
    },
  }
}

/**
 * 내부망에 열 때 API 키를 지키는 접속 코드.
 * 프로세스 시작 시 코드를 만들고(설정 자동 재시작에는 유지), ?k=코드 로 한 번 연 기기에만 쿠키를 준다.
 * /api/* (Anthropic 프록시 포함)는 이 Mac 자신이거나 쿠키가 있어야 쓸 수 있다.
 */
function accessCode(code: string): Plugin {
  return {
    name: 'lan-access-code',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? '/', 'https://local')
        if (url.searchParams.get('k') === code) {
          res.setHeader('set-cookie', `lb_code=${code}; Path=/; SameSite=Strict; Secure; HttpOnly; Max-Age=86400`)
          return next()
        }
        if (!url.pathname.startsWith('/api/')) return next()
        if (hasAccess(req, code)) return next()
        res.statusCode = 403
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ error: 'access_code_required' }))
      })
      server.httpServer?.once('listening', () => {
        const addr = server.httpServer?.address()
        const port = typeof addr === 'object' && addr ? addr.port : server.config.server.port
        const urls = lanAddresses().map((ip) => `https://${ip}:${port}/?k=${code}`)
        server.config.logger.info(`\n  다른 기기에서 접속(같은 와이파이): ${urls.join('  ')}\n`)
      })
    },
  }
}

/**
 * 테스트 기록: 브라우저가 보낸 이벤트를 logs/<세션>.jsonl 에 한 줄씩 쌓는다.
 * imageB64 필드는 logs/<세션>/<종류>-<번호>.jpg 파일로 빼고 경로만 남긴다.
 */
function testLog(): Plugin {
  const store = createLogStore(resolve('logs'))
  return {
    name: 'test-log',
    configureServer(server) {
      server.middlewares.use('/api/log', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          return res.end()
        }
        const chunks: Buffer[] = []
        let size = 0
        req.on('data', (c: Buffer) => {
          size += c.length
          if (size > 20e6) req.destroy()
          else chunks.push(c)
        })
        req.on('end', () => {
          try {
            const result = store(JSON.parse(Buffer.concat(chunks).toString('utf8')))
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify(result))
          } catch (err) {
            res.statusCode = 400
            res.end(String(err))
          }
        })
      })
    },
  }
}

/**
 * 개발 서버 전용 Anthropic 프록시.
 * 브라우저는 /api/anthropic/* 로 보내고, 여기서 .env의 ANTHROPIC_API_KEY를 붙여 넘긴다.
 * 키는 서버(Node)에서만 읽으므로 브라우저 번들에 들어가지 않는다.
 */
function statusPlugin(hasKey: boolean): Plugin {
  return {
    name: 'ai-status',
    configureServer(server) {
      server.middlewares.use('/api/status', (_req, res) => {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ anthropic: hasKey }))
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  // 세 번째 인자 '' = VITE_ 접두사 없는 변수도 읽음 (서버 쪽에서만 사용)
  const env = loadEnv(mode, process.cwd(), '')
  const key = env.ANTHROPIC_API_KEY ?? ''
  const code = getDevAccessCode(env)
  // DEV_HTTP=1 이면 HTTPS 없이 (이 Mac에서 http://localhost 로만 확인할 때)
  const https = process.env.DEV_HTTP !== '1'
  return {
    // 접속 코드 검사가 다른 미들웨어(프록시 포함)보다 먼저 돌도록 맨 앞에 둔다
    plugins: [accessCode(code), ...(https ? [basicSsl()] : []), react(), statusPlugin(!!key), testLog()],
    server: {
      // 같은 와이파이의 다른 기기에서 접속 가능. 마이크·음성 인식 때문에 HTTPS(자체 인증서)
      host: true,
      proxy: {
        ...sttProxy(code, env),
        '/api/anthropic': {
          target: 'https://api.anthropic.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/anthropic/, ''),
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              proxyReq.setHeader('x-api-key', key)
              proxyReq.removeHeader('anthropic-dangerous-direct-browser-access')
              proxyReq.removeHeader('origin')
              proxyReq.removeHeader('cookie')
            })
          },
        },
      },
    },
  }
})
