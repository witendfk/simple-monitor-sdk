import type { IReportHandler } from '../types'
import { metricsName } from '../constants'
import type MetricsStore from '../lib/store'
import calculateFps from '../lib/calculateFps'

const getFPS = (logFpsCount: number): Promise<number> => {
  return calculateFps(logFpsCount)
}

export const initFPS = (
  store: MetricsStore,
  report: IReportHandler,
  logFpsCount: number,
  immediately = true
): void => {
  getFPS(logFpsCount)
    .then((fps: number) => {
      const metrics = { name: metricsName.FPS, value: fps }
      store.set(metricsName.FPS, metrics)
      if (immediately) {
        report(metrics)
      }
    })
    .catch(() => {
      /* 采样异常静默：监控自身不允许产生 unhandled rejection */
    })
}
