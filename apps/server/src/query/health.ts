/**
 * 健康度评分（M7.5 P5b）：确定性多域扣分模型——无 AI、无玄学，规则全部写死在此，
 * 同一份输入任何环境算出的分一致（可在单元测试锁定）。
 *
 * 满分 100，按域扣分（窗口 = 概览窗口，默认 1h）：
 *  - 错误域：0 条 0 分；>20 条 −15；>50 条 −25（≤20 条已有告警域兜底，轻扣 −8）
 *  - AJAX 域：HTTP_ERROR 计数 >0 每条 −3，上限 −15（接口异常直接影响用户）
 *  - 性能域：LCP P75 ≤2.5s 0 分；≤4s −10；>4s −20；无样本不扣
 *  - 资源域：失败 ≤5 条 −5；>5 条 −10；0 条不扣
 * 评分 = max(0, 100 − Σ扣分)；tone：≥90 健康 / ≥70 需关注 / <70 差
 */
import type { HealthDeduction, HealthScore } from '../storage/event-storage'

export interface HealthSnapshot {
  /** 窗口内错误总数（全部分类） */
  errorCount: number
  /** 窗口内 AJAX 请求异常数（HTTP_ERROR） */
  ajaxErrorCount: number
  /** 窗口内资源加载失败数 */
  resourceFailCount: number
  /** LCP P75（ms；无样本为 null 不扣分） */
  lcpP75: number | null
}

export function computeHealthScore(s: HealthSnapshot): HealthScore {
  const deductions: HealthDeduction[] = []

  if (s.errorCount > 50) {
    deductions.push({ domain: '错误', why: `错误 ${s.errorCount} 条（>50）`, pts: 25 })
  } else if (s.errorCount > 20) {
    deductions.push({ domain: '错误', why: `错误 ${s.errorCount} 条（>20）`, pts: 15 })
  } else if (s.errorCount > 0) {
    deductions.push({ domain: '错误', why: `错误 ${s.errorCount} 条`, pts: 8 })
  }

  if (s.ajaxErrorCount > 0) {
    deductions.push({
      domain: 'AJAX',
      why: `请求异常 ${s.ajaxErrorCount} 条`,
      pts: Math.min(15, s.ajaxErrorCount * 3),
    })
  }

  if (s.lcpP75 !== null) {
    if (s.lcpP75 > 4000) {
      deductions.push({ domain: '性能', why: `LCP P75 ${Math.round(s.lcpP75)}ms > 4s`, pts: 20 })
    } else if (s.lcpP75 > 2500) {
      deductions.push({ domain: '性能', why: `LCP P75 ${Math.round(s.lcpP75)}ms > 2.5s`, pts: 10 })
    }
  }

  if (s.resourceFailCount > 5) {
    deductions.push({ domain: '资源', why: `加载失败 ${s.resourceFailCount} 次（>5）`, pts: 10 })
  } else if (s.resourceFailCount > 0) {
    deductions.push({ domain: '资源', why: `加载失败 ${s.resourceFailCount} 次`, pts: 5 })
  }

  const score = Math.max(0, 100 - deductions.reduce((sum, d) => sum + d.pts, 0))
  const tone: HealthScore['tone'] = score >= 90 ? 'healthy' : score >= 70 ? 'watch' : 'poor'
  return { score, tone, deductions: deductions.sort((a, b) => b.pts - a.pts).slice(0, 3) }
}
