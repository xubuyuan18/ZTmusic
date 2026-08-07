/**
 * PlayerState — 播放器核心状态管理
 *
 * 职责：整合各子模块（engine、queue、url-resolver、prefetch、history、native-media），
 * 提供统一的播放控制 API。
 *
 * 用法：
 *   import { player } from './player.svelte.js'
 *   player.playTrack(track, 0)
 *   player.next()
 *   player.pause()
 */

import { engine } from '../player/engine.js'
import { getStorage, getStorageJson, removeStorage, setStorage } from '../utils/storage.js'
import { normalizeImageUrl, coverUrl } from '../utils/image.js'
import { dbCache } from '../db/cache.js'
import { getPlayableUrls, fillFallbackUrls } from '../player/url-resolver.js'
import { getTrialPlaybackMessage } from '../player/trial-message.js'
import { compactTrack, compactQueue, getNextIndex, getPrevIndex } from '../player/queue.js'
import { dbHistory } from '../db/history.js'
import { initNativeMedia, syncNativeMedia, destroyNativeMedia, shouldUseWebMediaSession } from '../player/native-media.js'
import { createPrefetchManager } from '../player/prefetch.js'
import { PLAYBACK, QUALITY_ORDER, ERROR_MESSAGES, STORAGE_KEYS, FALLBACK_URL_TEMPLATE } from '../utils/constants.js'
import { ERROR_KIND, createErrorSnapshot, debugLog, swallowError } from '../utils/error.js'
import { getBooleanSetting, getSetting, setSetting } from '../utils/settings.js'
import { createFallbackController } from '../player/fallback.js'
import { abortAllRequests } from '../utils/request.js'
import { toast } from './toast.svelte.js'

class PlayerState {
  // ===== 当前歌曲 =====
  id = $state(0)
  title = $state('')
  artist = $state('')
  cover = $state('')
  duration = $state(0)
  currentTrack = $state(null)

  // ===== 播放状态 =====
  playing = $state(false)
  loading = $state(false)
  currentTime = $state(0)
  error = $state('')

  // ===== 设置 =====
  volume = $state(0.8)
  mode = $state('list') // 'list' | 'shuffle' | 'repeat'
  preferredLevel = $state('standard')

  // ===== 队列 =====
  queue = $state([])
  queueIndex = $state(-1)

  // ===== 内部状态（非响应式） =====
  /** 恢复播放时是否需要 seek */
  _restoreSeeking = false
  /** 加载后是否自动播放 */
  _shouldAutoPlay = false
  /** 保存进度的定时器 */
  _saveTimer = null
  /** loading 超时保护 */
  _loadingTimer = null
  /** 上次 error 的 reqId（防重复） */
  _lastErrorReqId = 0
  /** 播放请求 ID（用于竞态控制） */
  _playRequestId = 0
  /** 首条 URL 的音质等级 */
  _firstUrlLevel = ''
  /** 自动切歌锁 */
  _advanceLock = false
  /** 自动切歌定时器引用 —— destroy 时清理 */
  _advanceTimer = null
  /** 媒体会话是否已初始化 */
  _mediaSessionInited = false
  /** fallback URL 遍历控制器 */
  _fallback = createFallbackController([])
  /** 等待 fillFallback 完成 */
  _waitingForFill = false
  /** 预取管理器 */
  _prefetchManager = createPrefetchManager()
  /** 预取缓存 Map<id, url[]> */
  _prefetchCache = this._prefetchManager.cache
  /** auth 提供者（依赖注入，用于解耦） */
  _authProvider = {
    isLoggedIn: () => false,
    getVipInfo: () => null,
    isVip: () => false,
    checkLoginStatus: () => Promise.resolve(true),
  }
  /** 当前播放请求的中止控制器 */
  _abortController = new AbortController()
  /** 洗牌状态：保存当前队列的 Fisher-Yates 顺序 */
  shuffleState = { order: [], position: -1 }

  constructor() {
    // 从 localStorage 恢复初始状态
    this._restoreInitialState()

    // 设置 engine 事件监听
    this._setupEngineListeners()

    // 初始化原生媒体会话
    initNativeMedia({
      getMetadata: () => ({
        title: this.title,
        artist: this.artist,
        cover: this.cover,
        duration: this.duration > 0 ? this.duration : 0,
      }),
      getPlaybackState: () => ({
        playing: this.playing,
        position: this.currentTime,
        duration: this.duration > 0 ? this.duration : 0,
      }),
      onMediaButton: (action) => this._handleMediaButton(action),
    })

    // 浏览器/macOS 使用 Web Media Session；Tauri 原生平台由 native-media 接管
    this._initMediaSession()
  }

  /** 设置 auth 提供者（依赖注入）—— 在 App 初始化时调用一次 */
  setAuthProvider(provider) {
    this._authProvider = { ...this._authProvider, ...provider }
  }

  // ==========================================
  // 内部方法
  // ==========================================

  _restoreInitialState() {
    this.id = parseInt(getStorage(STORAGE_KEYS.PLAYER_ID, '0')) || 0
    this.title = getStorage(STORAGE_KEYS.PLAYER_TITLE, '')
    this.artist = getStorage(STORAGE_KEYS.PLAYER_ARTIST, '')
    this.cover = getStorage(STORAGE_KEYS.PLAYER_COVER, '')
    this.duration = parseInt(getStorage(STORAGE_KEYS.PLAYER_DURATION, '0')) || 0
    this.currentTime = parseFloat(getStorage(STORAGE_KEYS.PLAYER_TIME, '0'))
    this.volume = parseFloat(getSetting(STORAGE_KEYS.VOLUME, '0.8'))
    this.mode = getSetting(STORAGE_KEYS.MODE, 'list')
    this.preferredLevel = getSetting(STORAGE_KEYS.PREFERRED_QUALITY, 'standard')
    this.queue = getStorageJson(STORAGE_KEYS.PLAYER_QUEUE, [])
    this.queueIndex = parseInt(getStorage(STORAGE_KEYS.PLAYER_QI, '-1'))

    engine.setVolume(this.volume)
  }

  _setupEngineListeners() {
    engine.onTimeUpdate((t) => {
      this.currentTime = t
      this._debouncedSaveTime(t)
      this._syncWebMediaPosition()
      syncNativeMedia()
    })

    engine.onEnded((state) => {
      this.playing = false
      this._handleEnded(state)
    })

    engine.onLoadStart(() => {
      this.loading = true
    })

    engine.onCanPlay((state) => {
      this.loading = false
      this._clearLoadingTimer()
      this.duration = engine.duration
      this.playing = this._shouldAutoPlay && !engine.paused
      // 恢复播放时 seek
      if (this._restoreSeeking && this.currentTime > 0) {
        engine.seek(this.currentTime)
        this._restoreSeeking = false
      }
      this._syncWebMediaPosition()
      syncNativeMedia()
    })

    engine.onError((state) => {
      if (this._playRequestId !== this._lastErrorReqId) {
        this._lastErrorReqId = this._playRequestId
      }
      this._setPlayerError('EngineError', state, ERROR_MESSAGES.PLAY_FAILED)
      this._fallbackNext('EngineErrorNoFallback')
    })

    engine.onPlay(() => {
      this.playing = true
      syncNativeMedia()
    })

    engine.onPause(() => {
      if (!this.loading || !this._shouldAutoPlay) this.playing = false
      syncNativeMedia()
    })
  }

  _initMediaSession() {
    if (!shouldUseWebMediaSession()) return
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return
    if (this._mediaSessionInited) return
    this._mediaSessionInited = true

    const setPlaybackState = (state) => {
      try { navigator.mediaSession.playbackState = state } catch { /* ignore */ }
    }

    engine.onPlay(() => setPlaybackState('playing'))
    engine.onPause(() => setPlaybackState('paused'))

    this._setMediaActionHandler('play', () => { engine.play().catch((err) => swallowError('MediaSession.play', err)) })
    this._setMediaActionHandler('pause', () => { engine.pause() })
    this._setMediaActionHandler('stop', () => { engine.pause(); engine.seek(0) })
    this._setMediaActionHandler('nexttrack', () => this.next())
    this._setMediaActionHandler('previoustrack', () => this.prev())
    this._setMediaActionHandler('seekbackward', (details) => {
      const offset = details?.seekOffset || 10
      this.seek(Math.max(0, this.currentTime - offset))
    })
    this._setMediaActionHandler('seekforward', (details) => {
      const offset = details?.seekOffset || 10
      const duration = this.duration > 0 ? this.duration : Number.POSITIVE_INFINITY
      this.seek(Math.min(duration, this.currentTime + offset))
    })
    this._setMediaActionHandler('seekto', (details) => {
      if (Number.isFinite(details?.seekTime)) this.seek(details.seekTime)
    })
  }

  _setMediaActionHandler(action, handler) {
    try {
      navigator.mediaSession.setActionHandler(action, handler)
    } catch {
      // Some platforms do not support every media action.
    }
  }

  _syncWebMediaPosition() {
    if (!shouldUseWebMediaSession()) return
    if (typeof navigator === 'undefined' || !navigator.mediaSession?.setPositionState) return
    const duration = this.duration > 0 ? this.duration : 0
    if (!duration) return
    try {
      navigator.mediaSession.setPositionState({
        duration,
        playbackRate: 1,
        position: Math.min(Math.max(this.currentTime || 0, 0), duration),
      })
    } catch {
      // Ignore invalid or unsupported position state.
    }
  }

  _debouncedSaveTime(t) {
    if (this._saveTimer) return
    this._saveTimer = setTimeout(() => {
      setStorage(STORAGE_KEYS.PLAYER_TIME, t)
      this._saveTimer = null
    }, PLAYBACK.SAVE_INTERVAL)
  }

  /** loading 超时保护：15 秒后自动解除 loading */
  _startLoadingTimeout() {
    this._clearLoadingTimer()
    this._loadingTimer = setTimeout(() => {
      if (this.loading) {
        this.loading = false
        this._setPlayerError('LoadingTimeout', { kind: ERROR_KIND.TIMEOUT, message: '播放加载超时' }, ERROR_MESSAGES.PLAY_FAILED)
      }
    }, 15000)
  }

  _clearLoadingTimer() {
    if (this._loadingTimer) {
      clearTimeout(this._loadingTimer)
      this._loadingTimer = null
    }
  }

  _clearError() {
    this.error = ''
  }

  _setPlayerError(context, err, userMessage, extra = {}) {
    const fbState = this._fallback.getState()
    const snapshot = createErrorSnapshot(context, err, {
      trackId: this.id,
      title: this.title,
      queueIndex: this.queueIndex,
      playRequestId: this._playRequestId,
      currentUrlIndex: fbState.index,
      urlCount: fbState.total,
      ...extra,
    })
    this.error = userMessage || ERROR_MESSAGES.PLAY_FAILED
    debugLog('player', 'error', snapshot)
    // 用户可见错误显示 toast（silent 标记的跳过，如后台填充失败）
    if (!extra?.silent) toast.error(this.error)
  }

  _setNoUrlError(context = 'PlayerNoUrl', extra = {}) {
    this._setPlayerError(
      context,
      { kind: ERROR_KIND.NO_URL, message: ERROR_MESSAGES.NO_URL },
      ERROR_MESSAGES.NO_URL,
      extra,
    )
  }

  _persistState() {
    setStorage(STORAGE_KEYS.PLAYER_ID, this.id)
    setStorage(STORAGE_KEYS.PLAYER_TITLE, this.title)
    setStorage(STORAGE_KEYS.PLAYER_ARTIST, this.artist)
    setStorage(STORAGE_KEYS.PLAYER_COVER, this.cover)
    setStorage(STORAGE_KEYS.PLAYER_DURATION, this.duration)
    setStorage(STORAGE_KEYS.PLAYER_QI, this.queueIndex)
  }

  _handleEnded(state) {
    if (this._advanceLock || this.queue.length === 0) return
    this._advanceLock = true
    this._shouldAutoPlay = true
    this._advanceTimer = setTimeout(() => {
      if (!this._advanceLock) return
      this._advanceLock = false
      this._advanceTimer = null
      this.next()
    }, PLAYBACK.ADVANCE_DELAY)
  }

  _handleMediaButton(action) {
    if (action === 'play') { engine.play().catch((err) => swallowError('NativeMedia.play', err)) }
    else if (action === 'pause') { engine.pause() }
    else if (action === 'next') { this.next() }
    else if (action === 'prev') { this.prev() }
  }

  /**
   * 尝试 fallback 链中的下一个 URL。
   * 由 engine.onError 和 engine.play().catch 调用。
   * @param {string} exhaustedContext - URL 全部耗尽时的错误上下文
   */
  _fallbackNext(exhaustedContext = 'FallbackNoUrl') {
    const result = this._fallback.next()

    if (result.status === 'playing') {
      this._waitingForFill = false
      this.loading = true
      this._clearError()
      // 切换 URL 前保留 currentTime：fallback 触发时多半播到中途，切完让 onCanPlay 里的 seek 恢复进度
      if (this.currentTime > 0) this._restoreSeeking = true
      engine.load(result.url)
      engine.play().catch(() => {
        this._setPlayerError('FallbackPlayFailed', { message: 'fallback play failed' }, ERROR_MESSAGES.PLAY_FAILED)
        this._fallbackNext(exhaustedContext)
      })
    } else if (result.status === 'waiting') {
      this._waitingForFill = true
    } else {
      // exhausted — 全部 URL 已尝试完毕
      this._waitingForFill = false
      this._clearLoadingTimer()
      this.loading = false
      this.playing = false
      this._shouldAutoPlay = false
      this._setNoUrlError(exhaustedContext)
    }
  }

  // ==========================================
  // 播放控制
  // ==========================================

  /**
   * 播放指定曲目
   * @param {object} track - 原始曲目数据
   * @param {number} index - 在队列中的索引
   */
  playTrack(track, index) {
    if (!track) return
    const playableTrack = compactTrack(track)
    if (!playableTrack) return

    // 中止上次未完成的播放请求
    abortAllRequests()
    this._abortController.abort()
    this._abortController = new AbortController()
    const signal = this._abortController.signal

    // 取消挂起的自动切歌与预加载，避免与本次手动/自动切歌产生竞态（放错歌）
    this._advanceLock = false
    engine.cancelPreload()

    const requestId = ++this._playRequestId
    this._fallback.updateUrls([])
    this.id = playableTrack.id
    this.title = playableTrack.name
    this.artist = playableTrack.ar.map(a => a.name).join(' / ')
    this.currentTrack = playableTrack
    this.cover = normalizeImageUrl(playableTrack.picUrl || playableTrack.al.picUrl || '')
    // 网易云 dt 为毫秒,播放状态统一用秒(audio.duration 同单位)
    this.duration = (playableTrack.dt || 0) / 1000
    this.queueIndex = index >= 0 ? index : this.queueIndex
    this.loading = true
    this.playing = false
    this._shouldAutoPlay = true
    this._clearError()
    this._startLoadingTimeout()
    debugLog('player', 'play-track', { id: playableTrack.id, index, preferredLevel: this.preferredLevel })

    // 更新 Web Media Session 元数据（原生媒体会话平台由 syncNativeMedia 负责）
    if (shouldUseWebMediaSession() && typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: this.title,
        artist: this.artist,
        album: '',
        artwork: [{ src: coverUrl(this.cover, 512), sizes: '512x512', type: 'image/jpeg' }],
      })
    }

    this._persistState()
    dbHistory.add(playableTrack) // async, non-blocking; handles SQLite + localStorage fallback internally
    this._syncWebMediaPosition()
    syncNativeMedia()

    // 获取可播放 URL，传入 auth 状态供 url-resolver 使用（而非 url-resolver 直接 import auth）
    const authOpts = { isLoggedIn: this._authProvider.isLoggedIn(), checkLoginStatus: () => this._authProvider.checkLoginStatus() }
    getPlayableUrls(playableTrack.id, this.preferredLevel, this._prefetchCache, requestId, authOpts, signal)
      .then(({ urls, firstUrlLevel, isTrial }) => {
        if (requestId !== this._playRequestId) return
        this._firstUrlLevel = firstUrlLevel
        this._fallback.updateUrls(urls)

        if (urls.length > 0) {
          // 如果是试听片段且已登录，显示 VIP 提示（仍播放试听）
          if (isTrial && this._authProvider.isLoggedIn()) {
            const trialMessage = getTrialPlaybackMessage({ isLoggedIn: this._authProvider.isLoggedIn(), vipInfo: this._authProvider.getVipInfo(), isVip: this._authProvider.isVip() })
            this._setPlayerError(
              'TrialUrlDetected',
              { kind: ERROR_KIND.TRIAL, message: trialMessage },
              trialMessage,
              { silent: true },
            )
          }
          this._prefetchNextTrack(requestId)
          this._fillFallbackInBackground(playableTrack.id, requestId, signal)

          const first = this._fallback.next()
          if (first.status === 'playing') {
            engine.load(first.url)
            engine.play()
              .then(() => {
                if (requestId === this._playRequestId) this.playing = true
              })
              .catch((err) => {
                if (requestId !== this._playRequestId) return
                this._setPlayerError('InitialPlayFailed', err, ERROR_MESSAGES.PLAY_FAILED)
                this._fallbackNext('InitialPlayNoUrl')
              })
          }
        } else {
          this._clearLoadingTimer()
          this.loading = false
          this.playing = false
          this._shouldAutoPlay = false
          this._setNoUrlError('ResolveNoUrl')
        }
      })
      .catch((err) => {
        if (requestId !== this._playRequestId) return
        this.loading = false
        this.playing = false
        this._shouldAutoPlay = false
        this._setPlayerError('ResolvePlayableUrlsFailed', err, ERROR_MESSAGES.NO_URL)
      })
  }

  _prefetchNextTrack(reqId) {
    if (this.queue.length < 2 || this.queueIndex < 0) return
    this._prefetchManager.prefetchNextTrackUrl({
      queue: this.queue,
      queueIndex: this.queueIndex,
      mode: this.mode,
      preferredLevel: this.preferredLevel,
      reqId,
      isStale: () => reqId !== this._playRequestId,
      preload: (url) => engine.preload(url),
      shuffleState: this.shuffleState,
    }).catch((err) => swallowError('Player.prefetchNextTrack', err))
  }

  async _fillFallbackInBackground(id, reqId, signal) {
    this._fallback.setFillPending(true)
    try {
      const result = await fillFallbackUrls(id, reqId, {
        currentUrls: this._fallback.getUrls(),
        firstUrlLevel: this._firstUrlLevel,
        preferredLevel: this.preferredLevel,
        isPlaying: this.playing,
        currentTime: this.currentTime,
        authOpts: { isLoggedIn: this._authProvider.isLoggedIn(), checkLoginStatus: () => this._authProvider.checkLoginStatus() },
        onQualityUpgrade: ({ urls }) => {
          // ponytail: 仅更新 URL 列表，不中途切 URL —— 避免 pop/静音
          // 音质升级后的 URL 会在下次切歌或 fallback 链遍历时被使用
          if (reqId !== this._playRequestId) return
          this._fallback.updateUrls(urls)
        },
        isStale: () => reqId !== this._playRequestId,
        signal,
      })

      if (reqId === this._playRequestId) {
        this._fallback.updateUrls(result)
        if (this._waitingForFill) {
          this._waitingForFill = false
          this._fallbackNext()
        }
      }


      // 持久化最新 URL 到 IndexedDB
      if (result.length > 0 && result[0] !== FALLBACK_URL_TEMPLATE(id)) {
        dbCache.urlSet(id, result).catch((err) => swallowError('Player.cacheUrlSet', err))
      }
    } catch (err) {
      if (reqId === this._playRequestId) {
        this._setPlayerError('FillFallbackFailed', err, ERROR_MESSAGES.PLAY_FAILED, { silent: true })
      }
    } finally {
      this._fallback.setFillPending(false)
    }
  }

  /**
   * 播放队列
   * @param {Array} tracks - 曲目列表
   * @param {number} startIndex - 开始播放的索引
   */
  playQueue(tracks, startIndex = 0) {
    this.shuffleState = { order: [], position: -1 }
    this.queue = compactQueue(tracks)
    this.queueIndex = Math.min(Math.max(startIndex, 0), Math.max(this.queue.length - 1, 0))
    setStorage(STORAGE_KEYS.PLAYER_QUEUE, this.queue)
    setStorage(STORAGE_KEYS.PLAYER_QI, this.queueIndex)
    if (this.queue[this.queueIndex]) {
      this.playTrack(this.queue[this.queueIndex], this.queueIndex)
    }
  }

  /** 下一首 */
  next() {
    abortAllRequests()
    engine.cancelPreload()
    if (this.queue.length === 0) return

    if (this._advanceLock) {
      this._advanceLock = false
    }

    const idx = getNextIndex({
      currentIndex: this.queueIndex,
      queueLength: this.queue.length,
      mode: this.mode,
      shuffleState: this.shuffleState,
    })

    this.playTrack(this.queue[idx], idx)
  }

  /**
   * 插入到下一首播放（当前曲目之后）
   */
  playNext(track) {
    const tracks = Array.isArray(track) ? track : [track]
    if (tracks.length === 0) return
    const insertAt = this.queueIndex + 1
    this.queue = [
      ...this.queue.slice(0, insertAt),
      ...compactQueue(tracks),
      ...this.queue.slice(insertAt),
    ]
    setStorage(STORAGE_KEYS.PLAYER_QUEUE, this.queue)
  }

  /** 添加到队列末尾 */
  addToQueue(track) {
    const tracks = Array.isArray(track) ? track : [track]
    if (tracks.length === 0) return
    this.queue = [...this.queue, ...compactQueue(tracks)]
    if (this.queueIndex < 0 && this.queue.length > 0) this.queueIndex = 0
    setStorage(STORAGE_KEYS.PLAYER_QUEUE, this.queue)
  }

  /** 上一首 */
  prev() {
    abortAllRequests()
    engine.cancelPreload()
    if (this.queue.length === 0) return

    if (this._advanceLock) {
      this._advanceLock = false
    }

    const idx = getPrevIndex({
      currentIndex: this.queueIndex,
      queueLength: this.queue.length,
    })

    this.playTrack(this.queue[idx], idx)
  }

  /** 暂停 */
  pause() {
    engine.pause()
  }

  /** 切换播放/暂停 */
  togglePlay() {
    if (!this.id) return

    if (engine.paused) {
      engine.play()
        .then(() => {
          this.playing = true
          this._shouldAutoPlay = true
        })
        .catch((err) => {
          this._setPlayerError('TogglePlayFailed', err, ERROR_MESSAGES.PLAY_FAILED)
          this._fallbackNext('TogglePlayNoUrl')
        })
    } else {
      engine.pause()
      this.playing = false
    }
  }

  /** 跳转到指定时间 */
  seek(time) {
    engine.seek(time)
    this.currentTime = time
    setStorage(STORAGE_KEYS.PLAYER_TIME, time)
    this._syncWebMediaPosition()
    syncNativeMedia()
  }

  /** 设置音量 */
  setVolume(v) {
    this.volume = Number.parseFloat(setSetting(STORAGE_KEYS.VOLUME, v))
    engine.setVolume(this.volume)
  }

  /** 设置播放模式 */
  setMode(m) {
    this.mode = setSetting(STORAGE_KEYS.MODE, m)
  }

  /** 设置偏好音质 */
  setPreferredLevel(level) {
    if (QUALITY_ORDER.includes(level)) {
      this.preferredLevel = setSetting(STORAGE_KEYS.PREFERRED_QUALITY, level)
    }
  }

  // ==========================================
  // 队列控制
  // ==========================================

  /** 清空队列 */
  clearQueue() {
    abortAllRequests()
    this.queue = []
    this.queueIndex = -1
    removeStorage(STORAGE_KEYS.PLAYER_QUEUE)
    removeStorage(STORAGE_KEYS.PLAYER_QI)
  }

  /** 从队列移除指定索引 */
  removeFromQueue(index) {
    if (index < 0 || index >= this.queue.length) return

    const wasCurrent = index === this.queueIndex
    this.queue = this.queue.filter((_, i) => i !== index)

    if (wasCurrent) {
      this.queueIndex = Math.min(index, this.queue.length - 1)
      if (this.queue.length > 0 && this.queueIndex >= 0) {
        this.playTrack(this.queue[this.queueIndex], this.queueIndex)
      } else {
        this._clearCurrentTrack()
      }
    } else if (index < this.queueIndex) {
      this.queueIndex--
    }

    setStorage(STORAGE_KEYS.PLAYER_QUEUE, this.queue)
    setStorage(STORAGE_KEYS.PLAYER_QI, this.queueIndex)
  }

  _clearCurrentTrack() {
    this.id = 0
    this.title = ''
    this.artist = ''
    this.cover = ''
    this.duration = 0
    this.currentTrack = null
    this.playing = false
    this.queueIndex = -1
    this._clearError()
    this._persistState()
  }

  // ==========================================
  // 状态持久化
  // ==========================================

  /** 恢复播放状态（页面加载时调用） */
  restore() {
    if (!getBooleanSetting(STORAGE_KEYS.RESTORE_SESSION, 'true')) return

    const savedId = parseInt(getStorage(STORAGE_KEYS.PLAYER_ID, '0'))
    if (!savedId) return

    const savedQueue = compactQueue(getStorageJson(STORAGE_KEYS.PLAYER_QUEUE, []))
    const savedTime = parseFloat(getStorage(STORAGE_KEYS.PLAYER_TIME, '0'))
    const savedIndex = parseInt(getStorage(STORAGE_KEYS.PLAYER_QI, '-1'))
    const idx = savedIndex >= 0 ? savedIndex : 0

    this.queue = savedQueue
    this.queueIndex = idx
    this.id = savedId
    this.title = getStorage(STORAGE_KEYS.PLAYER_TITLE, '')
    this.artist = getStorage(STORAGE_KEYS.PLAYER_ARTIST, '')
    this.cover = getStorage(STORAGE_KEYS.PLAYER_COVER, '')
    this.duration = parseInt(getStorage(STORAGE_KEYS.PLAYER_DURATION, '0'))
    this.currentTime = savedTime
    this.currentTrack = savedQueue.find(track => track?.id === savedId) || savedQueue[idx] || null

    if (savedQueue.length > 0) {
      setStorage(STORAGE_KEYS.PLAYER_QUEUE, savedQueue)
    }

    const requestId = ++this._playRequestId
    this._restoreSeeking = savedTime > 0
    this._shouldAutoPlay = false
    this.playing = false
    this.loading = true
    this._clearError()
    this._startLoadingTimeout()

    abortAllRequests()
    this._abortController.abort()
    this._abortController = new AbortController()
    const signal = this._abortController.signal

    getPlayableUrls(savedId, this.preferredLevel, this._prefetchCache, requestId, {
      isLoggedIn: this._authProvider.isLoggedIn(),
      checkLoginStatus: () => this._authProvider.checkLoginStatus(),
    }, signal)
      .then(({ urls }) => {
        if (requestId !== this._playRequestId) {
          this._clearLoadingTimer()
          this.loading = false
          return
        }
        this._fallback.updateUrls(urls)
        if (urls.length > 0) {
          const first = this._fallback.next()
          if (first.status === 'playing') engine.load(first.url)
          // 后台填充更多 URL，避免恢复时第一条 URL 过期导致无 fallback
          this._fillFallbackInBackground(savedId, requestId, signal)
        } else {
          this._clearLoadingTimer()
          this.loading = false
          this._setNoUrlError('RestoreNoUrl')
        }
      })
      .catch((err) => {
        if (requestId !== this._playRequestId) {
          this._clearLoadingTimer()
          this.loading = false
          return
        }
        this._clearLoadingTimer()
        this.loading = false
        this._setPlayerError('RestorePlayableUrlsFailed', err, ERROR_MESSAGES.NO_URL)
      })
  }

  /** 保存当前状态到 localStorage */
  save() {
    this._persistState()
    setStorage(STORAGE_KEYS.PLAYER_QUEUE, this.queue)
    setStorage(STORAGE_KEYS.PLAYER_TIME, this.currentTime)
  }

  /** 销毁，释放资源 */
  destroy() {
    this._clearLoadingTimer()
    if (this._advanceTimer) {
      clearTimeout(this._advanceTimer)
      this._advanceTimer = null
    }
    if (this._saveTimer) {
      clearTimeout(this._saveTimer)
      this._saveTimer = null
    }
    destroyNativeMedia()
    engine.destroy()
  }
}

/** 全局单例 */
export const player = new PlayerState()

// ===== 历史记录 API 导出（保持向后兼容）=====
import { getLocalHistory, clearHistory } from '../player/history.js'
export { getLocalHistory, clearHistory }
