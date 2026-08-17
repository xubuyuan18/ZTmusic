// ===== 播放器常量 =====

export const PLAYBACK = {
  /** 快速出声超时 (ms) */
  FAST_TIMEOUT: 3500,
  /** Fallback URL 获取超时 (ms) */
  FALLBACK_TIMEOUT: 5000,
  /** 播放进度保存间隔 (ms) */
  SAVE_INTERVAL: 3000,
  /** 恢复播放时 seek 延迟 (ms) */
  RESTORE_DELAY: 80,
  /** 自动切歌延迟 (ms) */
  ADVANCE_DELAY: 80,
  /** 等待 fallback 填充的超时 (ms) */
  FALLBACK_WAIT_TIMEOUT: 3000,
  /** 原生媒体位置同步阈值 (s):SMTC/MPRIS 时间轴,0.5s 供逐字歌词同步 */
  NATIVE_POSITION_THRESHOLD: 0.5,
  /** MPRIS 媒体键轮询间隔 (ms) */
  NATIVE_POLL_INTERVAL: 500,
}

export const LIMITS = {
  /** 队列最大容量 */
  MAX_QUEUE: 500,
  /** 播放历史最大条数 */
  MAX_HISTORY: 200,
  /** 预取缓存最大条目 */
  MAX_PREFETCH: 10,
}

/** 音质优先级（索引越小音质越好） */
export const QUALITY_ORDER = ['lossless', 'exhigh', 'higher', 'standard']

export const ERROR_MESSAGES = {
  NO_URL: '当前歌曲暂无可用音源',
  PLAY_FAILED: '播放失败，请重试',
  NETWORK_ERROR: '网络连接失败',
  VIP_TRIAL: '当前歌曲为 VIP 专享，播放的是试听片段',
  VIP_TRIAL_SYNCING: '当前歌曲只能试听，会员状态同步后可再试一次',
  VIP_TRIAL_ACCOUNT: '当前账号未开通 VIP，正在播放试听片段',
  VIP_TRIAL_LIMITED: '会员账号仍只获取到试听片段，可能是版权或接口限制',
  COOKIE_EXPIRED: '登录已过期，请重新登录后播放完整歌曲',
}

/** localStorage 键名 */
export const STORAGE_KEYS = {
  PLAYER_ID: 'player_id',
  PLAYER_TITLE: 'player_title',
  PLAYER_ARTIST: 'player_artist',
  PLAYER_COVER: 'player_cover',
  PLAYER_DURATION: 'player_duration',
  PLAYER_TIME: 'player_time',
  PLAYER_QI: 'player_qi',
  PLAYER_QUEUE: 'player_queue',
  VOLUME: 'volume',
  MODE: 'mode',
  PREFERRED_QUALITY: 'preferred_quality',
  RESTORE_SESSION: 'restore_session',
  LOCAL_HISTORY: 'local_history',
}

/** 网易云音乐官方 fallback URL 模板 */
export const FALLBACK_URL_TEMPLATE = (id) =>
  `https://music.163.com/song/media/outer/url?id=${id}.mp3`
