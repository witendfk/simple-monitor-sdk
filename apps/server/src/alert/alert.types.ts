/**
 * 告警域类型与契约（M6）：
 *  - 两类规则：error_spike（错误突增）/ perf_threshold（性能分位超阈）
 *  - 静默：冷却窗口内不重复投递（防轰炸）
 *  - 投递：WebhookSender 接口（fetch 实现 + 测试 mock）
 */

export type AlertRuleType = 'error_spike' | 'perf_threshold'

/** 突增规则参数 */
export interface ErrorSpikeConfig {
  /** 突增观测窗口（分钟，默认 15） */
  windowMinutes: number
  /** 基线窗口（分钟，默认 360 = 前 6 小时） */
  baselineMinutes: number
  /** 最小次数兜底（低流量项目不误报，默认 20） */
  minCount: number
  /** 相对基线均值倍数（默认 3） */
  multiplier: number
}

/** 阈值规则参数 */
export interface PerfThresholdConfig {
  /** 指标名（如 largest-contentful-paint） */
  metric: string
  /** P75 阈值（指标原生单位：ms / ratio / count） */
  threshold: number
  /** 观测窗口（分钟，默认 60） */
  windowMinutes: number
}

export interface AlertRule {
  id: string
  apikey: string
  type: AlertRuleType
  name: string
  /** 飞书/钉钉/通用 webhook 地址 */
  webhookUrl: string
  /** 冷却分钟数（默认 15：触发后该窗口内不重复投递） */
  cooldownMinutes: number
  enabled: boolean
  config: ErrorSpikeConfig | PerfThresholdConfig
}

/** 一次触发记录 */
export interface AlertFire {
  id: string
  ruleId: string
  ruleName: string
  apikey: string
  firedAt: string
  /** 触发时的可读摘要 */
  message: string
  /** 触发时上下文（投递 payload 与看板共用） */
  context: Record<string, unknown>
}

/** 评估所需的存储视图（复用 IEventStorage，不新增接口） */
export interface AlertEvaluationInput {
  /** 窗口内错误数 */
  recentErrorCount: number
  /** 基线窗口内平均每 windowMinutes 的错误数 */
  baselineAvgPerWindow: number
}

/** 纯函数：突增判定（低流量兜底 + 相对倍数） */
export function isSpike(input: AlertEvaluationInput, config: ErrorSpikeConfig): boolean {
  const threshold = Math.max(config.minCount, input.baselineAvgPerWindow * config.multiplier)
  return input.recentErrorCount > threshold
}

/** 纯函数：分位阈值判定 */
export function isThresholdBreached(p75: number | null, config: PerfThresholdConfig): boolean {
  return p75 !== null && p75 >= config.threshold
}
