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

class AudioEngine {
  constructor() {
    this.audio = createAudioElement()
    this.currentUrl = ''
    // 隐藏预加载器：用于后台加载下一首歌的音频
    this.preloadAudio = createAudioElement()
    this.preloadedUrl = ''
    this._onTimeUpdate = null
    this._onEnded = null
    this._onLoadStart = null
    this._onCanPlay = null
    this._onError = null
    this._onPlay = null
    this._onPause = null

    this._handlers = {
      timeupdate: () => {
        if (this._onTimeUpdate) this._onTimeUpdate(this.audio.currentTime)
      },
      ended: () => {
        if (this._onEnded) this._onEnded(this.getState())
      },
      loadstart: () => {
        if (this._onLoadStart) this._onLoadStart(this.getState())
      },
      canplay: () => {
        if (this._onCanPlay) this._onCanPlay(this.getState())
      },
      error: (event) => {
        if (this._onError) this._onError(this.getErrorState(event))
      },
      play: () => {
        if (this._onPlay) this._onPlay(this.getState())
      },
      pause: () => {
        if (this._onPause) this._onPause(this.getState())
      },
    }

    this._bindActiveAudio(this.audio)
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

  // ponytail: 每个事件只有一个回调槽 —— 重复调用 onX 会静默覆盖前一个。
  // 目前唯一的消费者是 PlayerState，够用。如果将来有第二个模块要监听
  // engine 事件，改成数组订阅 + _emit()，别在两处各调一次 onX。
  // ponytail: 每个事件只有一个回调槽，重复调用 onXxx 会静默覆盖前一个。
  // 已知上限：只允许单一消费者（目前是 PlayerState）。若将来有第二个模块要监听
  // 播放事件，必须先把这些槽改成订阅者数组 + _emit，否则又会出现覆盖 bug。
  onTimeUpdate(fn) { this._onTimeUpdate = fn }
  onEnded(fn) { this._onEnded = fn }
  onLoadStart(fn) { this._onLoadStart = fn }
  onCanPlay(fn) { this._onCanPlay = fn }
  onError(fn) { this._onError = fn }
  onPlay(fn) { this._onPlay = fn }
  onPause(fn) { this._onPause = fn }

  destroy() {
    this.pause()
    this.cancelPreload()
    this._unbindActiveAudio(this.audio)
    this._resetAudio(this.audio)
    this.currentUrl = ''
    this._onTimeUpdate = null
    this._onEnded = null
    this._onLoadStart = null
    this._onCanPlay = null
    this._onError = null
    this._onPlay = null
    this._onPause = null
  }
}

export const engine = new AudioEngine()
