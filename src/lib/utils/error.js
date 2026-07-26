/**
 * 统一错误处理工具
 *
 * 用法：
 *   import { AppError, handleError } from '../utils/error.js'
 *
 *   catch (err) {
 *     return handleError('Player', err, '操作失败')
 *   }
 */

/**
 * 统一应用错误类
 * 标准化 Tauri 字符串错误 和 浏览器 Error 对象
 */
export class AppError extends Error {
  constructor(message, options = {}) {
    super(message)
    this.name = 'AppError'
    this.kind = options.kind || ERROR_KIND.UNKNOWN
    this.code = options.code || 0
    this.retryable = options.retryable !== false
    this.detail = options.detail || ''
    this.context = options.context || ''

    // 保持原始堆栈
    if (options.cause instanceof Error) {
      this.cause = options.cause
      this.stack = options.cause.stack
    }
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      kind: this.kind,
      code: this.code,
      retryable: this.retryable,
      detail: this.detail,
      context: this.context,
    }
  }
}

/**
 * 将任意错误转换为标准化 AppError
 * @param {unknown} err - Error 对象 / 字符串 / 数字
 * @param {string} context - 错误上下文
 * @param {string} [defaultMessage] - 默认消息
 */
export function normalizeError(err, context = '', defaultMessage = '未知错误') {
  if (err instanceof AppError) {
    if (!err.context) err.context = context
    return err
  }

  if (err instanceof Error) {
    return new AppError(err.message, {
      cause: err,
      kind: classifyError(err),
      context,
    })
  }

  // Tauri 返回的字符串错误
  if (typeof err === 'string') {
    return new AppError(err, {
      kind: classifyError({ message: err }),
      detail: err,
      context,
    })
  }

  return new AppError(defaultMessage, {
    kind: classifyError(err),
    detail: String(err),
    context,
  })
}

export const ERROR_KIND = {
  UNKNOWN: 'unknown',
  NO_URL: 'no_url',
  NETWORK: 'network',
  TIMEOUT: 'timeout',
  AUTH: 'auth',
  TRIAL: 'trial',
  MEDIA_NOT_SUPPORTED: 'media_not_supported',
  MEDIA_ABORTED: 'media_aborted',
  PLAYBACK: 'playback',
}

const MEDIA_ERROR_KIND = {
  1: ERROR_KIND.MEDIA_ABORTED,
  2: ERROR_KIND.NETWORK,
  3: ERROR_KIND.PLAYBACK,
  4: ERROR_KIND.MEDIA_NOT_SUPPORTED,
}

function isTimeoutError(err) {
  const text = `${err?.name || ''} ${err?.code || ''} ${err?.message || ''}`.toLowerCase()
  return text.includes('timeout') || text.includes('timed out') || text.includes('aborterror')
}

function isNetworkError(err) {
  const text = `${err?.name || ''} ${err?.code || ''} ${err?.message || ''}`.toLowerCase()
  return text.includes('network') || text.includes('fetch') || text.includes('failed to fetch')
}

/**
 * 归类播放/请求错误，供 UI 提示和调试日志使用。
 * @param {unknown} err
 * @returns {string}
 */
export function classifyError(err) {
  if (!err) return ERROR_KIND.UNKNOWN
  if (err.kind && Object.values(ERROR_KIND).includes(err.kind)) return err.kind
  if (typeof err.code === 'number' && MEDIA_ERROR_KIND[err.code]) return MEDIA_ERROR_KIND[err.code]
  if (isTimeoutError(err)) return ERROR_KIND.TIMEOUT
  if (isNetworkError(err)) return ERROR_KIND.NETWORK
  return ERROR_KIND.UNKNOWN
}

/**
 * 创建最近错误快照，避免散落 console 难以追踪。
 * @param {string} context
 * @param {unknown} err
 * @param {object} extra
 * @returns {{ context: string, kind: string, message: string, time: number } & object}
 */
export function createErrorSnapshot(context, err, extra = {}) {
  return {
    context,
    kind: classifyError(err),
    message: err?.message || String(err || '未知错误'),
    time: Date.now(),
    ...extra,
  }
}

/**
 * 调试日志开关：开发环境或 localStorage.debug_playback=true 时输出。
 * @param {string} scope
 * @param {string} type
 * @param {object} payload
 */
export function debugLog(scope, type, payload = {}) {
  const enabled =
    (typeof import.meta !== 'undefined' && import.meta.env?.DEV) ||
    (typeof localStorage !== 'undefined' && localStorage.getItem('debug_playback') === 'true')
  if (!enabled || typeof console === 'undefined') return
  console.debug(`[${scope}:${type}]`, payload)
}

/**
 * 统一处理错误并返回标准错误对象
 * @param {string} context - 错误上下文标识，如 'Player' / 'URLResolver'
 * @param {Error|unknown} err - 原始错误
 * @param {string} [userMessage] - 面向用户的错误消息
 * @returns {{ error: true, message: string, detail: string, kind: string }}
 */
export function handleError(context, err, userMessage) {
  const detail = err?.message || String(err || '未知错误')
  const kind = classifyError(err)
  console.error(`[${context}]`, err)
  return {
    error: true,
    kind,
    message: userMessage || detail || '未知错误',
    detail,
  }
}

/**
 * 静默处理错误（仅打印日志，不返回）
 * @param {string} context
 * @param {unknown} err
 */
export function swallowError(context, err) {
  if (err) {
    console.warn(`[${context}] (swallowed)`, err?.message || String(err))
  }
}

/**
 * 分类错误并显示对应 toast。
 */
export function handleErrorWithToast(fallbackMessage, err, toast) {
  const kind = classifyError(err)
  const msg = err?.message || fallbackMessage
  if (!toast) {
    console.error('[error]', err)
    return
  }
  switch (kind) {
    case ERROR_KIND.NETWORK:
      toast.error('网络连接失败，请检查网络')
      break
    case ERROR_KIND.TIMEOUT:
      toast.warning('请求超时，请重试')
      break
    case ERROR_KIND.AUTH:
      toast.warning('登录已过期，请重新登录')
      break
    case ERROR_KIND.TRIAL:
      toast.warning('该歌曲需要 VIP')
      break
    case ERROR_KIND.NO_URL:
      toast.error('无法获取播放地址')
      break
    default:
      toast.error(msg || fallbackMessage)
  }
}
