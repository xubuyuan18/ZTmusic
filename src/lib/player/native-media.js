/**
 * 原生媒体会话管理
 * - Android 通知栏（通过 Tauri Kotlin Plugin）
 * - Linux 桌面 MPRIS（通过 Tauri Rust 后端）
 * - Windows 桌面使用 WebView2 / Web Media Session，避免额外创建第二个 SMTC session
 * - 浏览器/macOS 使用 Web Media Session API（由 PlayerState 直接维护）
 *
 * 职责：仅处理需要原生桥接的平台媒体控件双向同步，不涉及播放逻辑。
 */

import { PLAYBACK } from '../utils/constants.js'
import { debugLog, swallowError } from '../utils/error.js'

let _tauriInvoke = null
let _nativeMediaPollTimer = null
let _lastNativeMeta = ''
let _lastNativePosition = 0
let _lastNativePlaying = null
// 外部回调：由 PlayerState 注入
let _getMetadata = () => ({})
let _getPlaybackState = () => ({})
let _onMediaButton = null

function isTauriRuntime() {
  return typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__
}

function isTauriAndroid() {
  return isTauriRuntime() && typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent)
}

function isTauriLinux() {
  if (!isTauriRuntime() || typeof navigator === 'undefined') return false
  const platform = navigator.userAgentData?.platform || navigator.platform || navigator.userAgent
  return /Linux/i.test(platform) && !/Android/i.test(navigator.userAgent)
}

function isTauriWindows() {
  if (!isTauriRuntime() || typeof navigator === 'undefined') return false
  const platform = navigator.userAgentData?.platform || navigator.platform || navigator.userAgent
  return /Win/i.test(platform)
}

/** Tauri 中仍需要原生媒体桥接的平台。Windows 直接复用 WebView2 自带的 SMTC。 */
export function shouldUseNativeBridge() {
  return isTauriAndroid() || isTauriLinux()
}

/** Windows/browser/macOS 使用 Web Media Session；Android/Linux 由 native bridge 接管。 */
export function shouldUseWebMediaSession() {
  return !shouldUseNativeBridge()
}

function invokeNative(command, payload, context) {
  if (!_tauriInvoke) return Promise.resolve(null)
  return _tauriInvoke(command, payload).catch((err) => {
    swallowError(`NativeMedia.${context || command}`, err)
    return null
  })
}

/**
 * 初始化原生媒体会话
 * @param {object} options
 * @param {Function} options.getMetadata - () => ({ title, artist, album, cover, duration })
 * @param {Function} options.getPlaybackState - () => ({ playing, position, duration })
 * @param {Function} options.onMediaButton - (action) => void，seek 使用 `seek:<seconds>`
 */
export async function initNativeMedia(options = {}) {
  _getMetadata = options.getMetadata || _getMetadata
  _getPlaybackState = options.getPlaybackState || _getPlaybackState
  _onMediaButton = options.onMediaButton || _onMediaButton

  debugLog('native-media', 'init', { runtime: isTauriRuntime(), android: isTauriAndroid(), linux: isTauriLinux(), windows: isTauriWindows(), nativeBridge: shouldUseNativeBridge(), webMediaSession: shouldUseWebMediaSession() })
  if (!isTauriRuntime() || typeof window === 'undefined') return
  // Windows deliberately stays on Web Media Session. Do not import/invoke the
  // Rust media bridge there, so a future native command cannot recreate a second SMTC session.
  if (!shouldUseNativeBridge()) return

  try {
    const { invoke } = await import('@tauri-apps/api/core')
    _tauriInvoke = invoke
  } catch (err) {
    swallowError('NativeMedia.importInvoke', err)
  }

  // Android: 监听通知栏按钮事件
  if (isTauriAndroid() && _tauriInvoke) {
    try {
      const { addPluginListener } = await import('@tauri-apps/api/core')
      await addPluginListener('nativeMedia', 'media_button', (event) => {
        const action = event?.payload?.action
        debugLog('native-media', 'plugin-event-action', { action })
        if (action && _onMediaButton) {
          _onMediaButton(action)
        }
      })
    } catch (err) {
      swallowError('NativeMedia.addPluginListener', err)
    }
  }

  // Android 轮询作为通知栏按钮兜底；Linux 轮询原生媒体键回调。
  if (shouldUseNativeBridge() && _tauriInvoke && !_nativeMediaPollTimer) {
    const interval = isTauriAndroid() ? PLAYBACK.NATIVE_ANDROID_POLL_INTERVAL : PLAYBACK.NATIVE_POLL_INTERVAL
    _nativeMediaPollTimer = setInterval(() => {
      pollNativeAction()
    }, interval)
    debugLog('native-media', 'poll-started', { interval })
  }
}

function handleMediaButtonAction(action) {
  debugLog('native-media', 'button-action', { action })
  if (_onMediaButton) {
    _onMediaButton(action)
  }
}

async function pollNativeAction() {
  if (!_tauriInvoke) return
  const result = await invokeNative('pollPendingAction', undefined, 'pollPendingAction')
  if (result?.action) handleMediaButtonAction(result.action)
}

/**
 * 同步播放状态到原生平台
 * 由 PlayerState 在 timeupdate / 切歌时调用
 */
let _pendingSyncTimer = null
let _pendingSyncPayload = null

export function syncNativeMedia() {
  if (!isTauriRuntime()) return

  const meta = _getMetadata()
  const state = _getPlaybackState()
  const dur = state.duration || 0
  const pos = state.position || 0
  const playing = !!state.playing
  const metaKey = `${meta.title}|${meta.artist}|${meta.album || ''}|${meta.cover}|${dur}`

  if (!shouldUseNativeBridge() || !_tauriInvoke) return

  const metaChanged = metaKey !== _lastNativeMeta
  const stateChanged = playing !== _lastNativePlaying ||
    Math.abs(pos - _lastNativePosition) >= (
      isTauriAndroid() ? PLAYBACK.NATIVE_ANDROID_POSITION_THRESHOLD : PLAYBACK.NATIVE_POSITION_THRESHOLD
    )

  if (metaChanged || stateChanged) {
    _pendingSyncPayload = { metaChanged, playing, position: pos, duration: dur, meta }
    if (metaChanged) {
      // 元数据变化立即同步
      _doSyncNative()
    } else if (!_pendingSyncTimer) {
      // 播放状态变化防抖 500ms
      _pendingSyncTimer = setTimeout(() => _doSyncNative(), 500)
    }
  }
}

function _doSyncNative() {
  if (_pendingSyncTimer) {
    clearTimeout(_pendingSyncTimer)
    _pendingSyncTimer = null
  }
  const payload = _pendingSyncPayload
  if (!payload) return
  const { metaChanged, playing, position, duration, meta } = payload

  if (metaChanged) {
    _lastNativeMeta = `${meta.title}|${meta.artist}|${meta.album || ''}|${meta.cover}|${duration}`
    debugLog('native-media', 'metadata', { title: meta.title, artist: meta.artist, album: meta.album, duration })
    invokeNative('updateMetadata', {
      title: meta.title || '',
      artist: meta.artist || '',
      album: meta.album || '',
      coverUrl: meta.cover || '',
      duration,
    }, 'updateMetadata')
  }
  _lastNativePosition = position
  _lastNativePlaying = playing
  invokeNative('updatePlaybackState', { playing, position, duration }, 'updatePlaybackState')
  _pendingSyncPayload = null
}

/** 清理资源 */
export function destroyNativeMedia() {
  if (_nativeMediaPollTimer) {
    clearInterval(_nativeMediaPollTimer)
    _nativeMediaPollTimer = null
  }
  if (_pendingSyncTimer) {
    clearTimeout(_pendingSyncTimer)
    _pendingSyncTimer = null
  }
  _pendingSyncPayload = null
  _tauriInvoke = null
  _lastNativeMeta = ''
  _lastNativePosition = 0
  _lastNativePlaying = null
  debugLog('native-media', 'destroy')
}
