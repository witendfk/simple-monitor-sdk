/**
 * k6 压测脚本（M4 验收：接入层 5k events/s 单机稳定）
 *
 * 运行：k6 run -e TARGET=http://localhost:3000 apps/server/k6/report.js
 * 场景：恒定到达速率（constant-arrival-rate），每迭代 1 个合法信封（2 事件）
 * 断言：p95 < 50ms（接入层只入队，毫秒级返回）、错误率 < 1%
 */
import http from 'k6/http'
import { check } from 'k6'

const TARGET = __ENV.TARGET || 'http://localhost:3000'
const RATE = Number(__ENV.RATE || 5000) // 每秒迭代数

export const options = {
  scenarios: {
    constant: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: '30s',
      preAllocatedVUs: 200,
      maxVUs: 1000,
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{name:report}': ['p(95)<50'],
  },
}

function makeEnvelope(i) {
  return {
    protocolVersion: 1,
    sentAt: Date.now(),
    auth: { apiKey: 'demo-key', release: 'v1.0.0', sdk: { name: 'web', version: '0.0.1' } },
    session: { sessionId: `k6-sess-${__VU}`, trackerId: `k6-track-${__VU}` },
    context: { page: 'http://load.test/checkout' },
    events: [
      {
        kind: 'error',
        error: {
          type: 'JAVASCRIPT_ERROR',
          message: `load-test error #${i}`,
          name: 'TypeError',
          viewId: '/checkout',
          stackFrames: [{ url: 'http://load.test/app.js', func: 'submit', line: i % 1000, column: 7 }],
        },
      },
      { kind: 'perf', metrics: [{ name: 'largest-contentful-paint', value: 1000 + (i % 3000) }] },
    ],
  }
}

export default function () {
  const res = http.post(`${TARGET}/report/batch`, JSON.stringify(makeEnvelope(__ITER)), {
    tags: { name: 'report' },
    headers: { 'Content-Type': 'application/json' },
  })
  check(res, { 'status 2xx/4xx(限流)': (r) => r.status === 204 || r.status === 429 })
}
