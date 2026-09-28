/**
 * Simple Monitor SDK - React Platform Adapter
 *
 * 提供两种用法（路线图 3.3：超越 encode——不只给方法，还给开箱即用组件）：
 *  1. errorBoundaryReport(err, info) —— 用户在自己的 ErrorBoundary.componentDidCatch 里调
 *  2. <ErrorBoundary> —— 开箱即用组件（getDerivedStateFromError + componentDidCatch + fallback + onError + reset）
 *
 * react 为 peerDependency（用户项目已装）；本包 devDep 装 react/@types/react 仅用于编译。
 * 用命名导入 + .ts（无 JSX），避免 jsx 配置耦合。
 */

import { Component, type ReactNode, type ErrorInfo } from 'react'
import { ErrorTypes, BreadCrumbTypes, Severity } from '@simple-monitor/types'
import type { ReportDataType } from '@simple-monitor/types'
import { extractErrorStack } from '@simple-monitor/utils'
import { getDefaultMonitorClient } from '@simple-monitor/core'
import type { MonitorClient } from '@simple-monitor/core'

interface ComponentInfo {
  /** React 组件调用栈（componentDidCatch 第二参的 componentStack，@types/react 19 可能为 null） */
  componentStack?: string | null
}

/**
 * 从 React componentStack 提取最近的组件名（best-effort，拿不到记 anonymous）。
 * React 16/17 格式：`\n    in MyComponent\n    in div...`
 * React 18+ 格式：`\n    at MyComponent\n    at div...`（旧正则只匹配 in，18+ 恒 anonymous——已修复）
 */
function parseComponentStack(stack?: string | null): string {
  if (!stack) return 'anonymous'
  const m = stack.match(/(?:in|at)\s+([^\s(]+)/)
  return m ? m[1] : 'anonymous'
}

/**
 * 手动上报 React 错误。用户在自己的 ErrorBoundary 的 componentDidCatch 里调用：
 *   componentDidCatch(err, info) { errorBoundaryReport(err, info) }
 */
export function errorBoundaryReport(
  error: unknown,
  info: ComponentInfo = {},
  client: MonitorClient = getDefaultMonitorClient()
): void {
  const parsed = extractErrorStack(error as Error, Severity.Normal) as ReportDataType | null
  if (!parsed) return
  parsed.type = ErrorTypes.REACT_ERROR
  parsed.viewId = client.viewId || undefined
  ;(parsed as ReportDataType & { componentName?: string }).componentName = parseComponentStack(
    info.componentStack
  )

  client.breadcrumb.push({
    type: BreadCrumbTypes.REACT,
    category: client.breadcrumb.getCategory(BreadCrumbTypes.REACT),
    data: { message: parsed.message, componentStack: info.componentStack },
    level: Severity.Normal,
    time: parsed.time,
  })

  client.transport.send(parsed)
}

interface ErrorBoundaryProps {
  /** 出错时渲染的兜底 UI */
  fallback?: ReactNode
  /** 受监控的子树 */
  children?: ReactNode
  /** 捕获到错误时的额外回调（错误已自动上报，此回调用于业务侧打日志/上报等） */
  onError?: (error: Error, info: ErrorInfo) => void
  /** 目标监控实例（多实例场景），缺省默认 client */
  client?: MonitorClient
}

interface ErrorBoundaryState {
  hasError: boolean
}

/**
 * 开箱即用的错误边界组件。
 * 捕获子树渲染期错误 → 自动上报 REACT_ERROR → 渲染 fallback。
 * 重置：调用实例 reset()（配合 ref），或改变 key 让组件重新挂载。
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    try {
      errorBoundaryReport(error, { componentStack: info.componentStack }, this.props.client)
    } catch {
      /* 采集失败不影响错误边界本身的行为 */
    }
    this.props.onError?.(error, info)
  }

  /** 手动重置错误状态（配合 ref 调用，或改变组件 key 重新挂载） */
  reset(): void {
    this.setState({ hasError: false })
  }

  render(): ReactNode {
    return this.state.hasError ? (this.props.fallback ?? null) : this.props.children
  }
}
