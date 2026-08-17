/**
 * 预取管理
 *
 * 职责：后台预取下一首歌的 URL 和音频，实现切歌零等待。
 * 独立于播放状态管理，接收必要的上下文参数。
 */

import { ncm } from '../api/client.js'
import { getNextIndex } from './queue.js'
import { dbCache } from '../db/cache.js'
import { LIMITS } from '../utils/constants.js'
import { debugLog, swallowError } from '../utils/error.js'

function uniqueLevels(levels) {
  return [...new Set(levels.filter(Boolean))]
}

function normalizePlayUrl(url) {
  if (!url || typeof url !== 'string') return ''
  return url.trim().replace(/^http:\/\/([^/?#]+\.music\.126\.net)([/?#]|$)/i, 'https://$1$2')
}
/**
 * 创建预取缓存管理器
 * @returns {{ cache: Map, clear: Function, prefetchNextTrackUrl: Function }}
 */
export function createPrefetchManager() {
  const prefetchCache = new Map()
  let activePrefetchId = 0
  let lastPrefetch = null

  function trimCache() {
    while (prefetchCache.size > LIMITS.MAX_PREFETCH) {
      const firstKey = prefetchCache.keys().next().value
      prefetchCache.delete(firstKey)
    }
  }

  function setCachedUrls(id, urls, meta = {}) {
    if (!id || !Array.isArray(urls) || urls.length === 0) return null
    const normalizedUrls = [...new Set(urls.map(normalizePlayUrl).filter(Boolean))]
    if (normalizedUrls.length === 0) return null
    prefetchCache.set(id, normalizedUrls)
    trimCache()
    lastPrefetch = {
      id,
      urls: normalizedUrls,
      time: Date.now(),
      ...meta,
    }
    return normalizedUrls
  }

  function clear() {
    activePrefetchId += 1
    prefetchCache.clear()
    lastPrefetch = null
  }

  async function preloadCachedUrl(nextTrack, preload) {
    const cachedUrls = await dbCache.urlGet(nextTrack.id).catch(() => null)
    const firstUrl = Array.isArray(cachedUrls) ? normalizePlayUrl(cachedUrls[0]) : ''
    if (!firstUrl) return null
    const urls = setCachedUrls(nextTrack.id, cachedUrls, { source: 'db-cache' })
    debugLog('prefetch', 'cache-hit', { id: nextTrack.id, urlCount: urls.length })
    preload?.(firstUrl)
    return { id: nextTrack.id, urls, source: 'db-cache' }
  }

  /**
   * 后台预取下一首歌的 URL + 音频
   * @param {object} options
   * @param {Array} options.queue - 当前队列
   * @param {number} options.queueIndex - 当前索引
   * @param {string} options.mode - 播放模式
   * @param {string} options.preferredLevel - 用户偏好音质
   * @param {number} options.reqId - 请求 ID
   * @param {Function} options.isStale - () => boolean
   * @param {Function} options.preload - engine.preload(url)
   */
  async function prefetchNextTrackUrl(options = {}) {
    const {
      queue = [],
      queueIndex = -1,
      mode = 'list',
      preferredLevel = 'standard',
      reqId = 0,
      isStale = () => false,
      preload,
      shuffleState,
    } = options

    const prefetchId = ++activePrefetchId
    if (queue.length < 2 || queueIndex < 0 || isStale()) return null

    // peek 而已：不推进洗牌指针，切歌由 player.next() 负责 commit
    const nextIdx = getNextIndex({ currentIndex: queueIndex, queueLength: queue.length, mode, shuffleState })
    if (nextIdx < 0 || nextIdx === queueIndex) return null
    const nextTrack = queue[nextIdx]
    if (!nextTrack?.id) return null

    const memoryUrls = prefetchCache.get(nextTrack.id)
    if (memoryUrls?.[0]) {
      debugLog('prefetch', 'memory-hit', { id: nextTrack.id, nextIdx })
      preload?.(memoryUrls[0])
      return
    }

    debugLog('prefetch', 'start', { id: nextTrack.id, nextIdx, mode, preferredLevel, reqId })

    const cachedResult = await preloadCachedUrl(nextTrack, preload)
    if (cachedResult || isStale() || prefetchId !== activePrefetchId) return

    const tiers = uniqueLevels(['standard', 'higher', preferredLevel])
    for (const level of tiers) {
      if (isStale() || prefetchId !== activePrefetchId) return null
      try {
        const res = await ncm.songUrl(nextTrack.id, level, false)
        const item = res?.data?.[0]
        const urlStr = normalizePlayUrl(item?.url)
        if (!urlStr) continue
        // 复检：await 期间用户可能切歌，避免把过期的下一首预加载到 engine
        if (isStale() || prefetchId !== activePrefetchId) return null

        const urls = setCachedUrls(nextTrack.id, [urlStr], { source: 'network', level })
        debugLog('prefetch', 'network-cached', { id: nextTrack.id, level, url: urlStr })
        dbCache.urlSet(nextTrack.id, urls).catch((err) => swallowError('Prefetch.urlSet', err))
        preload?.(urlStr)
        return
      } catch (err) {
        debugLog('prefetch', 'level-failed', { id: nextTrack.id, level, message: err?.message || String(err) })
      }
    }

    debugLog('prefetch', 'miss', { id: nextTrack.id, reqId })
    return null
  }

  return {
    cache: prefetchCache,
    prefetchNextTrackUrl,
  }
}
