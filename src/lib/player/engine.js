function createAudioElement() {
  const audio = new Audio()
  audio.preload = 'auto'
  return audio
}

function getCodecSupport(audio) {
  return {
    mp3: audio.canPlayType('audio/mpeg'),
    aac: audio.canPlayType('audio/aac'),
    mp4: audio.canPlayType('audio/mp4; codecs="mp4a.40.2"'),
    flac: audio.canPlayType('audio/flac'),
  }
}

const ENGINE_EVENTS = ['timeupdate', 'ended', 'loadstart', 'canplay', 'error', 'play', 'pause']

class AudioEngine {
  constructor() {
    this.audio = createAudioElement()
    this.currentUrl = ''
    // 隐藏预加载器：用于后台加载下一首歌的音频
    this.preloadAudio = createAudioElement()
    this.preloadedUrl = ''
    this._listeners = Object.fromEntries(ENGINE_EVENTS.map(event => [event, new Set()]))

    this._handlers = {
      timeupdate: () => {
        this._emit('timeupdate', this.audio.currentTime)
      },
      ended: () => {
        this._emit('ended', this.getState())
      },
      loadstart: () => {
        this._emit('loadstart', this.getState())
      },
      canplay: () => {
        this._emit('canplay', this.getState())
      },
      error: (event) => {
        this._emit('error', this.getErrorState(event))
      },
      play: () => {
        this._emit('play', this.getState())
      },
      pause: () => {
        this._emit('pause', this.getState())
      },
    }

    this._bindActiveAudio(this.audio)
  }

  _emit(event, payload) {
    const listeners = this._listeners[event]
    if (!listeners) return
    for (const listener of [...listeners]) listener(payload)
  }

  _addListener(event, fn) {
    if (typeof fn !== 'function') return () => {}
    const listeners = this._listeners[event]
    listeners.add(fn)
    return () => listeners.delete(fn)
  }

  _bindActiveAudio(audio) {
    Object.entries(this._handlers).forEach(([event, handler]) => {
      audio.addEventListener(event, handler)
    })
  }

  _unbindActiveAudio(audio) {
    Object.entries(this._handlers).forEach(([event, handler]) => {
      audio.removeEventListener(event, handler)
    })
  }

  _resetAudio(audio) {
    audio.pause()
    audio.removeAttribute('src')
    audio.load()
  }

  /** 后台预加载一首歌的音频到隐藏元素（不播放） */
  preload(url) {
    if (!url) return
    const u = String(url).trim()
    if (!u || u === this.preloadedUrl || u === this.currentUrl) return
    this.cancelPreload()
    this.preloadedUrl = u
    this.preloadAudio.src = u
    this.preloadAudio.load()
  }

  /** 取消预加载并释放资源 */
  cancelPreload() {
    this.preloadedUrl = ''
    this._resetAudio(this.preloadAudio)
  }

  /** 交换主播放器与预加载器：预加载的音频变为当前播放 */
  swapToPreloaded() {
    if (!this.preloadedUrl) return false
    const oldAudio = this.audio

    this._unbindActiveAudio(oldAudio)
    this.audio = this.preloadAudio
    this.currentUrl = this.preloadedUrl
    this.preloadAudio = oldAudio
    this.preloadedUrl = ''
    this._bindActiveAudio(this.audio)

    // 清理旧主播放器，让它成为新的隐藏预加载器
    this._resetAudio(this.preloadAudio)
    return true
  }

  /** 预加载的 URL（用于 playTrack 判断命中） */
  get preloadedSrc() { return this.preloadedUrl }

  getState() {
    return {
      src: this.audio.currentSrc || this.audio.src || this.currentUrl,
      currentTime: this.audio.currentTime,
      duration: this.audio.duration || 0,
      ended: this.audio.ended,
      networkState: this.audio.networkState,
      readyState: this.audio.readyState,
      paused: this.audio.paused,
    }
  }

  getErrorState(event) {
    const error = this.audio.error
    return {
      ...this.getState(),
      event,
      code: error?.code || 0,
      message: error?.message || '',
      codecSupport: getCodecSupport(this.audio),
    }
  }

  load(url) {
    if (!url) return
    const nextUrl = String(url).trim()
    if (!nextUrl) return
    // 重复下发同一 URL：直接返回，避免打断当前播放
    if (nextUrl === this.currentUrl) return
    // 如果是预加载命中，直接 swap（swap 前会检查健康状态）
    if (this.preloadedUrl && this.preloadedUrl === nextUrl) {
      if (this._isPreloadHealthy()) {
        this.swapToPreloaded()
        return
      }
      // 预加载损坏：丢弃预加载，走普通 load
      this.cancelPreload()
    }
    if (this.currentUrl && this.currentUrl !== nextUrl) {
      this._resetAudio(this.audio)
    }
    // 加载新 URL 时清理过期的预加载，避免后续 load 命中失效的 preloadedUrl
    if (this.preloadedUrl && this.preloadedUrl !== nextUrl) {
      this.cancelPreload()
    }
    this.currentUrl = nextUrl
    this.audio.src = nextUrl
    this.audio.load()
  }

  /** 判断预加载元素是否可用于 swap（无 error、metadata 已加载） */
  _isPreloadHealthy() {
    // HAVE_METADATA=1；error 非空表示加载已失败
    return !this.preloadAudio.error && this.preloadAudio.readyState >= 1
  }

  play() {
    return this.audio.play()
  }

  pause() {
    this.audio.pause()
  }

  toggle() {
    if (this.audio.paused) return this.play()
    this.pause()
  }

  seek(time) {
    if (!Number.isFinite(time)) return
    this.audio.currentTime = Math.max(0, time)
  }

  setVolume(v) {
    this.audio.volume = Math.max(0, Math.min(1, v))
  }

  get volume() { return this.audio.volume }
  get currentTime() { return this.audio.currentTime }
  get duration() { return this.audio.duration || 0 }
  get paused() { return this.audio.paused }
  get src() { return this.audio.src }

  onTimeUpdate(fn) { return this._addListener('timeupdate', fn) }
  onEnded(fn) { return this._addListener('ended', fn) }
  onLoadStart(fn) { return this._addListener('loadstart', fn) }
  onCanPlay(fn) { return this._addListener('canplay', fn) }
  onError(fn) { return this._addListener('error', fn) }
  onPlay(fn) { return this._addListener('play', fn) }
  onPause(fn) { return this._addListener('pause', fn) }

  destroy() {
    this.pause()
    this.cancelPreload()
    this._unbindActiveAudio(this.audio)
    this._resetAudio(this.audio)
    this.currentUrl = ''
    for (const listeners of Object.values(this._listeners)) listeners.clear()
  }
}

export const engine = new AudioEngine()
