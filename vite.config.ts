import { randomBytes } from 'node:crypto'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { networkInterfaces } from 'node:os'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'

const isLocal = (ip: string) => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'

function lanAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => n!.address)
}

/**
 * 내부망에 열 때 API 키를 지키는 접속 코드.
 * 서버를 켤 때마다 새 코드를 만들고, ?k=코드 로 한 번 연 기기에만 쿠키를 준다.
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
        const cookie = /(?:^|;\s*)lb_code=([^;]+)/.exec(req.headers.cookie ?? '')?.[1]
        if (isLocal(req.socket.remoteAddress ?? '') || cookie === code) return next()
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
  const dir = resolve('logs')
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
            const { session, entries } = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
              session: string
              entries: Record<string, unknown>[]
            }
            if (!/^[\w-]{6,64}$/.test(session) || !Array.isArray(entries)) throw new Error('bad payload')
            mkdirSync(join(dir, session), { recursive: true })
            const lines = entries.map((e) => {
              if (typeof e.imageB64 === 'string') {
                const name = `${String(e.type)}-${String(e.n)}.jpg`
                writeFileSync(join(dir, session, name), Buffer.from(e.imageB64, 'base64'))
                delete e.imageB64
                e.imageFile = `logs/${session}/${name}`
              }
              return JSON.stringify(e)
            })
            appendFileSync(join(dir, `${session}.jsonl`), lines.join('\n') + '\n')
            res.end('ok')
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
  const code = randomBytes(4).toString('hex')
  // DEV_HTTP=1 이면 HTTPS 없이 (이 Mac에서 http://localhost 로만 확인할 때)
  const https = process.env.DEV_HTTP !== '1'
  return {
    // 접속 코드 검사가 다른 미들웨어(프록시 포함)보다 먼저 돌도록 맨 앞에 둔다
    plugins: [accessCode(code), ...(https ? [basicSsl()] : []), react(), statusPlugin(!!key), testLog()],
    server: {
      // 같은 와이파이의 다른 기기에서 접속 가능. 마이크·음성 인식 때문에 HTTPS(자체 인증서)
      host: true,
      // cloudflared 임시 터널(*.trycloudflare.com)로 공유할 때 접속을 허용한다
      allowedHosts: ['.trycloudflare.com'],
      proxy: {
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
