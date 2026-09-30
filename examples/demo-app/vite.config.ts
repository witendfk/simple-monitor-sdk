import { defineConfig } from 'vite'
import { resolve } from 'path'
import type { Plugin, Connect } from 'vite'
import type { ServerResponse } from 'node:http'

// 演示应用（订单管理台）：SDK 接入示例 + demo:full 链路入口。
// 通过 alias 直接引入各包源码（无需预先 build），改 SDK 代码即时生效。

// 注意：本目录相对仓库根只有两层（examples/demo-app），比旧 vanilla 少一层
const pkgs = (name: string) => resolve(__dirname, `../../packages/${name}/src/index.ts`)

/** 业务内存态（重启重置；演示级） */
interface Order {
  id: string
  no: string
  item: string
  amount: number
  status: 'pending' | 'paid' | 'cancelled'
  createdAt: string
}
const orders: Order[] = [
  {
    id: 'o1',
    no: 'SO-20260930-001',
    item: '企业版许可证 ×2',
    amount: 3980,
    status: 'paid',
    createdAt: '2026-09-30T09:12:00Z',
  },
  {
    id: 'o2',
    no: 'SO-20260930-002',
    item: '技术支持包（季度）',
    amount: 1500,
    status: 'pending',
    createdAt: '2026-09-30T10:05:00Z',
  },
  {
    id: 'o3',
    no: 'SO-20260929-018',
    item: '定制开发 40 人时',
    amount: 12800,
    status: 'cancelled',
    createdAt: '2026-09-29T16:40:00Z',
  },
]
let seq = 3
let faultOn = false

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}
function readBody(req: Connect.IncomingMessage): Promise<string> {
  return new Promise((r) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => r(body))
  })
}

/** 业务 mock API（vite 中间件内聚，demo:full 单进程即可演示完整链路） */
function mockApi(): Plugin {
  return {
    name: 'demo-mock-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = (req.url ?? '').split('?')[0]

        if (req.method === 'POST' && url === '/__fault') {
          faultOn = JSON.parse((await readBody(req)) || '{}').on === true
          console.log(
            `[demo] 故障注入 ${faultOn ? '开启' : '关闭'}（支付 500 + 脏数据 + 商品图 404）`
          )
          return json(res, 200, { on: faultOn })
        }
        if (req.method === 'GET' && url === '/api/orders') {
          // 故障注入：混入一条 amount 为字符串的脏订单——前端渲染 toFixed 自然抛 TypeError，
          // 是「真实应用脏数据 bug」的形态，被 SDK 作为 JS 异常采集
          const list: unknown[] = faultOn
            ? [
                {
                  id: 'bad',
                  no: 'SO-DIRTY-000',
                  item: '脏数据样例',
                  amount: 'not-a-number',
                  status: 'pending',
                  createdAt: new Date().toISOString(),
                },
                ...orders,
              ]
            : orders
          return json(res, 200, list)
        }
        if (req.method === 'POST' && url === '/api/orders') {
          const body = JSON.parse((await readBody(req)) || '{}')
          const amount = Number(body.amount)
          if (!body.item || !Number.isFinite(amount) || amount <= 0) {
            return json(res, 422, { error: '商品名与正数金额必填' })
          }
          seq += 1
          const order: Order = {
            id: `o${seq}`,
            no: `SO-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${String(seq).padStart(3, '0')}`,
            item: String(body.item),
            amount,
            status: 'pending',
            createdAt: new Date().toISOString(),
          }
          orders.unshift(order)
          return json(res, 201, order)
        }
        const pay = url.match(/^\/api\/orders\/([\w-]+)\/pay$/)
        if (pay && req.method === 'POST') {
          const order = orders.find((o) => o.id === pay[1])
          if (!order) return json(res, 404, { error: '订单不存在' })
          if (faultOn)
            return json(res, 500, { error: 'payment gateway unavailable (injected fault)' })
          order.status = 'paid'
          return json(res, 200, order)
        }
        const cancel = url.match(/^\/api\/orders\/([\w-]+)\/cancel$/)
        if (cancel && req.method === 'POST') {
          const order = orders.find((o) => o.id === cancel[1])
          if (!order) return json(res, 404, { error: '订单不存在' })
          order.status = 'cancelled'
          return json(res, 200, order)
        }
        if (url === '/img/product-banner.svg') {
          // 故障注入：商品图 404（资源加载错误采集）
          if (faultOn) {
            res.writeHead(404).end('not found')
            return
          }
          res.writeHead(200, { 'Content-Type': 'image/svg+xml' })
          res.end(
            '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="120"><rect width="100%" height="100%" rx="10" fill="#eef4fb"/><text x="50%" y="58%" text-anchor="middle" fill="#4a7dbd" font-family="sans-serif" font-size="22">Acme Order Console — 企业订单中心</text></svg>'
          )
          return
        }
        next()
      })
    },
  }
}

export default defineConfig({
  root: __dirname,
  plugins: [mockApi()],
  resolve: {
    alias: {
      '@simple-monitor/web': pkgs('web'),
      '@simple-monitor/browser': pkgs('browser'),
      '@simple-monitor/web-performance': pkgs('web-performance'),
      '@simple-monitor/vue': pkgs('vue'),
      '@simple-monitor/react': pkgs('react'),
      '@simple-monitor/core': pkgs('core'),
      '@simple-monitor/shared': pkgs('shared'),
      '@simple-monitor/utils': pkgs('utils'),
      '@simple-monitor/types': pkgs('types'),
    },
  },
  server: {
    port: 5180,
    host: true,
    proxy: {
      // 完整链路演示：SDK dsn 用相对路径 /report/batch，代理到服务端
      // （DEMO_TARGET 可指向任意实例；默认 apps/server 内存形态）
      '/report': {
        target: process.env.DEMO_TARGET || 'http://localhost:3000',
        // 诊断日志：非 204（校验失败/限流）时打印服务端返回的问题清单
        configure(proxy) {
          proxy.on('proxyRes', (proxyRes) => {
            if (proxyRes.statusCode !== 204) {
              let body = ''
              proxyRes.on('data', (c) => (body += c))
              proxyRes.on('end', () =>
                console.log(`[demo-proxy] ${proxyRes.statusCode} ${body.slice(0, 600)}`)
              )
            }
          })
        },
      },
    },
  },
})
