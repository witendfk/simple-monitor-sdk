/**
 * Simple Monitor SDK - 共享模块
 *
 * 仅包含 SDK 基础常量。历史上此包还导出 messages/device/config/defaults
 * 四个文件（~900 行），全部为无引用死代码，M1 已清理（总纲 §3.5）。
 * 截断上限等协议常量已迁移至 @simple-monitor/protocol 的 LIMITS。
 *
 * @module @simple-monitor/shared
 */

export * from './constants'
