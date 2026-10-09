/**
 * 行为域 DOM 侧采集（M7，ADR-8 + 增补细则）
 *
 * 覆盖：首次 PV / 路由 PV（handleHistoryEvent 调 trackPageView）/ 停留时长
 * （visibilitychange 累计可见时长，离场 flush）/ 声明式埋点（data-track 点击、
 * form submit、data-expose 曝光）/ 白屏检测（load 后视口采样）。
 *
 * 纪律（ADR-8 增补）：曝光需 500ms 有效停留 + 同 selector 1s 节流 + 每 view 去重；
 * PV 同 URL 连续合并；监听均为 addEventListener（不与 ADR-3 的原生包装冲突）。
 */
import type { MonitorClient } from '@simple-monitor/core'

/** 曝光停留定时器的元素挂载标记 */
interface ExposeElement extends HTMLElement {
  __exposeTimer?: ReturnType<typeof setTimeout>
}

let lastPvUrl = ''
/** 曝光去重：viewId + 埋点名 */
const exposed = new Set<string>()
/** 曝光节流：selector → 上次触发时间 */
const exposeThrottle = new Map<string, number>()
let dwellStart = 0
let dwellAccumulated = 0
let initialized = false

function pageUrl(): string {
  try {
    return `${location.pathname}${location.search}`
  } catch {
    return '/'
  }
}

function loadType(): 'navigate' | 'reload' | 'back_forward' {
  try {
    const nav = performance.getEntriesByType('navigation')[0] as
      | PerformanceNavigationTiming
      | undefined
    if (nav) return nav.type as 'navigate' | 'reload' | 'back_forward'
  } catch {
    /* 旧浏览器退化 */
  }
  return 'navigate'
}

/** PV（首次加载由 setupBehaviors 调；路由变化由 handleHistoryEvent 调） */
export function trackPageView(
  client: MonitorClient,
  forcedLoadType?: 'navigate' | 'reload' | 'back_forward'
): void {
  const url = pageUrl()
  // 同 URL 连续 PV 合并（防 replaceState 刷 URL 重复上报——ADR-8 增补 1）
  if (url === lastPvUrl) return
  lastPvUrl = url
  client.behavior.sendBehavior({
    behaviorType: 'page_view',
    url,
    loadType: forcedLoadType,
  })
}

/** 停留时长：visibilitychange 累计可见时间；hidden 时结算上报（不含后台时间） */
function setupDwell(client: MonitorClient): void {
  dwellStart = Date.now()
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      const now = Date.now()
      const activeMs = dwellAccumulated + (now - dwellStart)
      dwellAccumulated = 0
      dwellStart = now
      if (activeMs >= 1000) {
        client.behavior.sendBehavior({
          behaviorType: 'page_dwell',
          activeMs,
          startTime: now - activeMs,
          endTime: now,
        })
      }
    } else {
      dwellStart = Date.now()
    }
  })
  window.addEventListener('pagehide', () => {
    const now = Date.now()
    const activeMs = dwellAccumulated + (now - dwellStart)
    if (activeMs >= 1000) {
      client.behavior.sendBehavior({
        behaviorType: 'page_dwell',
        activeMs,
        startTime: now - activeMs,
        endTime: now,
      })
    }
  })
}

/** 声明式埋点：data-track（点击）/ form data-track（提交）/ data-expose（曝光） */
function setupDeclarative(client: MonitorClient): void {
  // 点击委托（capture 阶段，含 data-track 的最近祖先）
  document.addEventListener(
    'click',
    (e) => {
      const target = (e.target as HTMLElement | null)?.closest?.(
        '[data-track]'
      ) as HTMLElement | null
      if (!target) return
      const name = target.getAttribute('data-track')
      if (!name) return
      let props: Record<string, unknown> | undefined
      const raw = target.getAttribute('data-track-props')
      if (raw) {
        try {
          props = JSON.parse(raw)
        } catch {
          /* 非法 JSON：忽略 props */
        }
      }
      client.behavior.sendBehavior({
        behaviorType: 'track',
        name,
        props,
        from: 'declarative',
      })
    },
    { capture: true }
  )

  // 表单提交（capture 阶段；data-track 挂在 form 上）
  document.addEventListener(
    'submit',
    (e) => {
      const form = e.target as HTMLFormElement
      const name = form.getAttribute('data-track')
      if (!name) return
      client.behavior.sendBehavior({ behaviorType: 'track', name, from: 'declarative' })
    },
    { capture: true }
  )

  // 曝光：data-expose 元素进入视口且停留 ≥500ms 才算有效（ADR-8 增补 3）
  if (typeof IntersectionObserver === 'undefined') return
  const dwellMs = 500
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const el = entry.target as ExposeElement
        const name = el.getAttribute('data-expose')
        if (!name) continue
        const selector = `[data-expose="${name}"]`
        if (entry.isIntersecting) {
          const key = `${client.viewId}:${name}`
          if (exposed.has(key)) continue // 每 view 去重
          const last = exposeThrottle.get(selector) ?? 0
          if (Date.now() - last < 1000) continue // 同 selector 1s 节流
          el.__exposeTimer = setTimeout(() => {
            if (!exposed.has(key)) {
              exposed.add(key)
              exposeThrottle.set(selector, Date.now())
              client.behavior.sendBehavior({
                behaviorType: 'expose',
                name,
                selector,
                dwellMs,
              })
            }
          }, dwellMs)
        } else if (el.__exposeTimer) {
          clearTimeout(el.__exposeTimer)
          el.__exposeTimer = undefined
        }
      }
    },
    { threshold: 0.5 }
  )
  // 动态 DOM：轮询扫描（演示级实现；MutationObserver 增强留演进）
  const scan = (): void => {
    document.querySelectorAll('[data-expose]:not([data-expose-done])').forEach((el) => {
      el.setAttribute('data-expose-done', '1')
      observer.observe(el)
    })
  }
  scan()
  window.addEventListener('load', scan)
}

/** 白屏检测：load 后 2s 对视口 4×4 采样点做 elementsFromPoint，全部无内容判定白屏 */
function setupWhiteScreen(client: MonitorClient): void {
  window.addEventListener('load', () => {
    setTimeout(() => {
      try {
        const w = window.innerWidth
        const h = window.innerHeight
        let empty = 0
        const total = 16
        for (let i = 1; i <= 4; i++) {
          for (let j = 1; j <= 4; j++) {
            const els = document.elementsFromPoint((w * i) / 5, (h * j) / 5)
            const top = els.find((el) => el !== document.documentElement && el !== document.body)
            if (!top) empty += 1
          }
        }
        if (empty === total) {
          // 白屏：走错误主通道（错误 100% 采样），type 开放枚举
          void client.transport.send({
            type: 'WHITE_SCREEN',
            message: 'blank screen detected (16 sampled points empty)',
          } as unknown as Parameters<typeof client.transport.send>[0])
        }
      } catch {
        /* 检测失败不影响宿主 */
      }
    }, 2000)
  })
}

/** 装配全部行为采集器（setupReplace 末尾调用一次；幂等） */
export function setupBehaviors(client: MonitorClient): void {
  if (initialized || typeof window === 'undefined' || typeof document === 'undefined') return
  initialized = true
  trackPageView(client, loadType())
  setupDwell(client)
  setupDeclarative(client)
  setupWhiteScreen(client)
}
