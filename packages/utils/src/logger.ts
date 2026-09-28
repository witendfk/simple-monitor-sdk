/**
 * 日志系统
 * 提供分级日志输出功能
 */

const PREFIX = 'Monitor Logger'

/**
 * 日志级别枚举
 */
export enum LogLevel {
  /** 调试级别 - 最详细的日志 */
  DEBUG = 0,
  /** 信息级别 */
  INFO = 1,
  /** 警告级别 */
  WARN = 2,
  /** 错误级别 */
  ERROR = 3,
  /** 静默级别 - 不输出任何日志 */
  SILENT = 4,
}

/**
 * Logger 类
 * 提供分级日志输出功能
 */
export class Logger {
  private enabled = false
  private level: LogLevel = LogLevel.WARN
  private _console: Console = {} as Console

  constructor() {
    this.initConsole()
  }

  private initConsole(): void {
    if (typeof console !== 'undefined') {
      const logType = ['log', 'debug', 'info', 'warn', 'error', 'assert'] as const
      logType.forEach((level) => {
        if (!(level in console)) return
        this._console[level] = console[level]
      })
    }
  }

  /**
   * 禁用日志输出
   */
  disable(): void {
    this.enabled = false
  }

  /**
   * 启用日志输出
   */
  enable(): void {
    this.enabled = true
  }

  /**
   * 绑定配置选项
   * @param debug 是否启用调试模式
   * @param level 日志级别
   */
  bindOptions(debug: boolean = false, level: LogLevel = LogLevel.WARN): void {
    this.enabled = debug
    this.level = level
  }

  /**
   * 设置日志级别
   * @param level 日志级别
   */
  setLevel(level: LogLevel): void {
    this.level = level
  }

  /**
   * 获取当前日志级别
   */
  getLevel(): LogLevel {
    return this.level
  }

  /**
   * 获取启用状态
   */
  getEnableStatus(): boolean {
    return this.enabled
  }

  private shouldLog(messageLevel: LogLevel): boolean {
    return this.enabled && messageLevel >= this.level
  }

  log(...args: any[]): void {
    if (this.shouldLog(LogLevel.DEBUG)) {
      this._console.log(`${PREFIX}[Log]:`, ...args)
    }
  }

  debug(...args: any[]): void {
    if (this.shouldLog(LogLevel.DEBUG)) {
      this._console.debug(`${PREFIX}[Debug]:`, ...args)
    }
  }

  info(...args: any[]): void {
    if (this.shouldLog(LogLevel.INFO)) {
      this._console.info(`${PREFIX}[Info]:`, ...args)
    }
  }

  warn(...args: any[]): void {
    if (this.shouldLog(LogLevel.WARN)) {
      this._console.warn(`${PREFIX}[Warn]:`, ...args)
    }
  }

  error(...args: any[]): void {
    if (this.shouldLog(LogLevel.ERROR)) {
      this._console.error(`${PREFIX}[Error]:`, ...args)
    }
  }
}

/**
 * 全局 Logger 单例
 */
let _logger: Logger | null = null

export function getLogger(): Logger {
  return _logger || (_logger = new Logger())
}

/**
 * 导出默认 logger 实例
 */
export const logger = getLogger()

/**
 * 静默控制台作用域：callback 执行期间临时关闭 logger 输出。
 * 用途：SDK 内部执行用户钩子（如 beforePushBreadcrumb）时，
 * 防止钩子内日志被 console 采集器再采集形成自环。
 * 异常不吞——由上层错误隔离机制处理。
 */
export function silentConsoleScope<T>(callback: () => T): T {
  const prevStatus = logger.getEnableStatus()
  logger.disable()
  try {
    return callback()
  } finally {
    if (prevStatus) {
      logger.enable()
    }
  }
}
