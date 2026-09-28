/**
 * 性能指标名枚举
 *
 * 注意：INP 取代了 encode 的 FID（FID 已于 2024-03-12 被 INP 取代为 Core Web Vital）。
 */
export enum metricsName {
  /* performance metrics */
  NT = 'navigation-timing',
  FP = 'first-paint',
  FCP = 'first-contentful-paint',
  LCP = 'largest-contentful-paint',
  CCP = 'custom-contentful-paint',
  INP = 'interaction-to-next-paint',
  RL = 'resource-flow',
  RT = 'resource-timing',
  CLS = 'cumulative-layout-shift',
  FPS = 'fps',
  LONG_TASK = 'long-task',
  ACT = 'api-complete-time',
  /* information */
  DI = 'device-information',
  NI = 'network-information',
  PI = 'page-information',
}
