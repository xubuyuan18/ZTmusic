/**
 * 原生媒体会话管理
 * - Linux 桌面 MPRIS（通过 Tauri Rust 后端）
 * - Windows/macOS 桌面系统媒体控件（Web Media Session API，由 PlayerState 直接维护）
 *
 * 职责：仅处理原生平台媒体控件的双向同步，不涉及播放逻辑。
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

function isTauriLinux() {
  if (!isTauriRuntime()) return false
  const platform = navigator.userAgentData?.platform || navigator.platform || navigator.userAgent
  return /Linux/i.test(platform)
}

function isTauriWindows() {
  if (!isTauriRuntime()) return false
  const platform = navigator.userAgentData?.platform || navigator.platform || navigator.userAgent
  return /Win/i.test(platform)
}

function shouldUseNativeBridge() {
  return isTauriLinux()
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
 * @param {Function} options.getMetadata - () => ({ title, artist, cover, duration })
 * @param {Function} options.getPlaybackState - () => ({ playing, position, duration })
 * @param {Function} options.onMediaButton - (action) => void
 */
export async function initNativeMedia(options = {}) {
  _getMetadata = options.getMetadata || _getMetadata
  _getPlaybackState = options.getPlaybackState || _getPlaybackState
  _onMediaButton = options.onMediaButton || _onMediaButton

  debugLog('native-media', 'init', { runtime: isTauriRuntime(), linux: isTauriLinux(), windows: isTauriWindows() })
  if (!isTauriRuntime() || typeof window === 'undefined') return

  try {
    const { invoke } = await import('@tauri-apps/api/core')
    _tauriInvoke = invoke
  } catch (err) {
    swallowError('NativeMedia.importInvoke', err)
  }

  // Linux 轮询 MPRIS 媒体键回调。
  // Windows/macOS 使用 Web Media Session API，不走 Tauri 原生桥，避免双注册媒体会话。
  if (shouldUseNativeBridge() && _tauriInvoke && !_nativeMediaPollTimer) {
    const interval = PLAYBACK.NATIVE_POLL_INTERVAL
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
  const metaKey = `${meta.title}|${meta.artist}|${meta.cover}|${dur}`

  if (!shouldUseNativeBridge() || !_tauriInvoke) return

  const metaChanged = metaKey !== _lastNativeMeta
  const stateChanged = playing !== _lastNativePlaying ||
    Math.abs(pos - _lastNativePosition) >= PLAYBACK.NATIVE_POSITION_THRESHOLD

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
  // Windows/macOS: navigator.mediaSession（Web Media Session API）由 PlayerState 直接处理。
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
    _lastNativeMeta = `${meta.title}|${meta.artist}|${meta.cover}|${duration}`
    debugLog('native-media', 'metadata', { title: meta.title, artist: meta.artist, duration: duration })
    invokeNative('updateMetadata', {
      title: meta.title || '',
      artist: meta.artist || '',
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
