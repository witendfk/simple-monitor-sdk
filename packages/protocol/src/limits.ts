/**
 * 字段截断上限（总纲 §四 4.2 / §五 规格）。
 *
 * 约定：
 *  - 数组类上限（maxBreadcrumbs / maxStackFrames / maxEventsPerEnvelope / maxMetricsPerEvent）
 *    属于**结构约束**，写进 zod schema——超限即协议违规，接收端拒绝；
 *  - 字符串类上限（message / httpBody / breadcrumbData）属于**语义约束**，只作为常量导出，
 *    不写进 schema——超限载荷由 SDK 发送端截断、服务端 ingest 兜底截断，而不是被拒绝丢数据
 *    （旧版本 SDK / 边缘场景的超限数据比"收不到"更有价值）。
 *  - 长度单位为 UTF-16 字符数（JSON 序列化后的近似体积上限，x2 即可估算 UTF-8 字节）。
 */
export const LIMITS = {
  /** 错误 message / 日志正文单条上限 */
  message: 1024,
  /** HTTP 请求体 / 响应体单条上限 */
  httpBody: 2048,
  /** 单条面包屑 data 序列化后上限 */
  breadcrumbData: 512,
  /** 堆栈帧数上限（超出截尾，保留靠前的调用帧） */
  maxStackFrames: 50,
  /** 信封内面包屑条数上限（对齐 SDK maxBreadcrumbs 环形栈容量） */
  maxBreadcrumbs: 50,
  /** 单个 perf 事件携带的指标数上限（批量 flush 的合理上界） */
  maxMetricsPerEvent: 200,
  /** 单信封事件数上限 */
  maxEventsPerEnvelope: 100,
} as const
