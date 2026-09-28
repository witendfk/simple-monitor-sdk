/**
 * Simple Monitor SDK - Vue Platform Adapter
 *
 * MonitorVue 插件：install 时重写 app.config.errorHandler（Vue3）/ Vue.config.errorHandler（Vue2），
 * 捕获组件 render / setup / 生命周期错误，封装为 VUE_ERROR 上报。
 *
 * 设计要点：
 *  - Vue2 + Vue3 双兼容（errorHandler 赋值方式一致，无需版本分支）
 *  - 组件名 best-effort：`<script setup>` 匿名导出拿不到 → 记 anonymous
 *  - 受 silentVue 开关控制；保留用户既有的 errorHandler，不吞错
 *  - M1：接收可选 client（多实例支持），缺省默认 client；错误来源记 errorInfo 字段
 */

import { ErrorTypes, EventTypes, BreadCrumbTypes, Severity } from '@simple-monitor/types'
import type { ReportDataType } from '@simple-monitor/types'
import { extractErrorStack } from '@simple-monitor/utils'
import { getDefaultMonitorClient } from '@simple-monitor/core'
import type { MonitorClient } from '@simple-monitor/core'

/** Vue app / 构造器的最小形状（兼容 Vue2 Vue.config 与 Vue3 app.config） */
interface VueApp {
  config?: {
    errorHandler?: (err: unknown, instance: unknown, info: string) => unknown
  }
  version?: string
}

/** best-effort 提取组件名：拿不到记 anonymous */
function getComponentName(instance: unknown): string {
  if (!instance) return 'anonymous'
  const opts = (instance as { $options?: { name?: string; _componentTag?: string } })?.$options
  return opts?.name || opts?._componentTag || 'anonymous'
}

/** 把 Vue 错误封装为 VUE_ERROR 并上报 + 进面包屑 */
function reportVueError(
  err: unknown,
  instance: unknown,
  info: string,
  client: MonitorClient
): void {
  if (client.isSilent(EventTypes.VUE)) return // silentVue
  const parsed = extractErrorStack(err as Error, Severity.Normal) as ReportDataType | null
  if (!parsed) return
  parsed.type = ErrorTypes.VUE_ERROR
  parsed.viewId = client.viewId || undefined
  ;(parsed as ReportDataType & { componentName?: string; errorInfo?: string }).componentName =
    getComponentName(instance)
  // 错误来源标记（render / setup hook / lifecycle hook 等），旧字段名 propsData 语义错位已废弃
  ;(parsed as ReportDataType & { errorInfo?: string }).errorInfo = info

  client.breadcrumb.push({
    type: BreadCrumbTypes.VUE,
    category: client.breadcrumb.getCategory(BreadCrumbTypes.VUE),
    data: { message: parsed.message, componentName: getComponentName(instance), info },
    level: Severity.Normal,
    time: parsed.time,
  })

  client.transport.send(parsed)
}

export const MonitorVue = {
  install(app: VueApp, client: MonitorClient = getDefaultMonitorClient()): void {
    const config = app?.config
    if (!config) return
    const prev = config.errorHandler

    config.errorHandler = (err: unknown, instance: unknown, info: string): unknown => {
      // 采集失败不影响用户既有错误处理
      try {
        reportVueError(err, instance, info, client)
      } catch {
        /* noop */
      }
      // 保留用户自定义 errorHandler
      if (typeof prev === 'function') {
        return prev(err, instance, info)
      }
      // 无自定义：保持错误可见性（不吞错）
      console.error('[Vue error]', err)
      return undefined
    }
  },
}

export default MonitorVue
