/**
 * 队列管理
 *
 * 职责：管理播放队列的增删改查、排序模式（列表循环/随机/单曲循环）。
 * 纯函数式逻辑，不涉及播放状态。
 */

import { normalizeImageUrl } from '../utils/image.js'
import { LIMITS } from '../utils/constants.js'

/**
 * 精简曲目对象，仅保留必要字段
 * @param {object} track - 原始曲目对象
 * @returns {object|null}
 */
export function compactTrack(track) {
  if (!track) return null
  const album = track.al || track.album || {}
  const picUrl = normalizeImageUrl(album.picUrl || album.blurPicUrl || track.coverImgUrl || track.picUrl || '')
  return {
    id: track.id,
    name: track.name || '',
    ar: (track.ar || track.artists || []).map(compactArtist).filter(Boolean),
    al: {
      id: album.id,
      name: album.name || '',
      picUrl,
    },
    dt: track.dt || track.duration || 0,
    picUrl,
  }
}

function compactArtist(artist) {
  if (!artist) return null
  return {
    id: artist.id,
    name: artist.name || '',
  }
}

/**
 * 精简队列（限制最大长度）
 * @param {Array} tracks
 * @returns {Array}
 */
export function compactQueue(tracks) {
  return (Array.isArray(tracks) ? tracks : [])
    .slice(0, LIMITS.MAX_QUEUE)
    .map(compactTrack)
    .filter(Boolean)
}

/**
 * 计算下一首的索引（幂等查询，不推进洗牌指针）
 *
 * shuffle 模式下重复调用返回同一个索引，预取只需 peek；
 * 真正切歌时必须紧接着调 commitNextIndex 推进指针，否则会一直停在同一首。
 *
 * @param {object} options
 * @param {number} options.currentIndex - 当前索引
 * @param {number} options.queueLength - 队列长度
 * @param {string} options.mode - 播放模式: 'list' | 'shuffle' | 'repeat'
 * @returns {number}
 */
export function getNextIndex({ currentIndex, queueLength, mode, shuffleState }) {
  if (queueLength === 0) return -1
  if (mode === 'repeat') {
    return currentIndex
  }
  if (mode === 'shuffle') {
    return peekShuffleIndex(queueLength, currentIndex, shuffleState)
  }
  return (currentIndex + 1) % queueLength
}

/**
 * 确认切歌，推进洗牌指针。只由真正的切歌路径调用（预取不要调）。
 * @param {object} options
 * @param {string} options.mode
 * @param {object} options.shuffleState
 */
export function commitNextIndex({ mode, shuffleState }) {
  if (mode !== 'shuffle' || !shuffleState || !Array.isArray(shuffleState.order)) return
  const pos = shuffleState.position ?? -1
  if (pos < shuffleState.order.length - 1) shuffleState.position = pos + 1
}

function peekShuffleIndex(queueLength, currentIndex, shuffleState) {
  if (queueLength <= 1) return 0
  if (!shuffleState) return Math.floor(Math.random() * queueLength)
  const pos = shuffleState.position ?? -1
  // 顺序缺失 / 队列长度变了 / 已走完一轮 → 重新洗牌。
  // 这是唯一会写 shuffleState 的分支，且结果被记住，所以 peek 仍然幂等。
  if (!Array.isArray(shuffleState.order) || shuffleState.order.length !== queueLength || pos >= queueLength - 1) {
    reshuffle(queueLength, currentIndex, shuffleState)
  }
  return shuffleState.order[(shuffleState.position ?? -1) + 1]
}

function reshuffle(queueLength, currentIndex, shuffleState) {
  const arr = Array.from({ length: queueLength }, (_, i) => i)
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  // 新一轮的第一首不要撞上正在播的这首
  if (arr[0] === currentIndex && queueLength > 1) {
    const swapIdx = 1 + Math.floor(Math.random() * (queueLength - 1))
    ;[arr[0], arr[swapIdx]] = [arr[swapIdx], arr[0]]
  }
  shuffleState.order = arr
  shuffleState.position = -1
}

/**
 * 计算上一首的索引
 * @param {object} options
 * @param {number} options.currentIndex
 * @param {number} options.queueLength
 * @returns {number}
 */
export function getPrevIndex({ currentIndex, queueLength }) {
  if (queueLength === 0) return -1
  return currentIndex <= 0 ? queueLength - 1 : currentIndex - 1
}


