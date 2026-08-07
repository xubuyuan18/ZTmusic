/**
 * URL 获取与 Fallback 链
 *
 * 职责：获取歌曲的可播放 URL，支持多级音质、缓存、unblock 和 fallback。
 * 不涉及播放状态管理，只负责 URL 的获取和排序。
 *
 * URL 获取策略：
 *   1. 检查预取缓存（内存，当前歌单的下一首）
 *   2. 检查 IndexedDB 持久缓存（跨会话）
 *   3. Phase 1 — 快速出声（standard / higher / 用户偏好）
 *   4. Phase 2 — unblock 尝试
 *   5. 官方 fallback URL 兜底
 *   6. 后台填充更多音质（fillFallbackUrls）
 */

import { ncm } from '../api/client.js'
import { dbCache } from '../db/cache.js'
import { QUALITY_ORDER, PLAYBACK, FALLBACK_URL_TEMPLATE } from '../utils/constants.js'
import { swallowError } from '../utils/logging.js'

// ===== 日志工具 =====

const SHOULD_LOG_PLAY_URLS = typeof import.meta !== 'undefined' && import.meta.env?.DEV

function shouldDebugPlayback() {
  return SHOULD_LOG_PLAY_URLS || (typeof localStorage !== 'undefined' && localStorage.getItem('debug_playback') === 'true')
}

function logPlayUrlAttempt(type, payload) {
  if (!shouldDebugPlayback() || typeof console === 'undefined') return
  console.debug(`[play-url:${type}]`, payload)
}

function logPlayback(type, payload = {}) {
  if (!shouldDebugPlayback() || typeof console === 'undefined') return
  console.debug(`[playback:${type}]`, payload)
}

// ===== 工具函数 =====

function normalizePlayUrl(url) {
  if (!url || typeof url !== 'string') return ''
  return url.trim().replace(/^http:\/\/([^/?#]+\.music\.126\.net)([/?#]|$)/i, 'https://$1$2')
}

function addUrl(urls, urlOrObj) {
  if (!urlOrObj) return
  const playableUrl = typeof urlOrObj === 'string' ? urlOrObj : urlOrObj.url
  if (playableUrl && !urls.includes(playableUrl)) urls.push(playableUrl)
}

function addCandidate(candidates, candidate) {
  if (!candidate?.url || candidates.some(item => item.url === candidate.url)) return
  candidates.push(candidate)
}

function withTimeout(promise, timeout, signal) {
  let timer = null
  let onAbort = null
  const cleanup = () => {
    if (timer !== null) { clearTimeout(timer); timer = null }
    if (onAbort && signal) { signal.removeEventListener('abort', onAbort); onAbort = null }
  }
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('play url timeout')), timeout)
    if (signal) {
      if (signal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'))
        return
      }
      onAbort = () => reject(new DOMException('Aborted', 'AbortError'))
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
  return Promise.race([promise, timeoutPromise]).finally(cleanup)
}

function uniqueLevels(levels) {
  return [...new Set(levels.filter(Boolean))]
}

// ===== 音质排序 =====

/**
 * 根据用户偏好排序音质优先级
 * @param {string} preferredLevel
 * @returns {string[]}
 */
function orderedPlayLevels(preferredLevel) {
  const levels = [...QUALITY_ORDER]
  const prefIdx = levels.indexOf(preferredLevel)
  if (prefIdx > 0) {
    levels.splice(prefIdx, 1)
    levels.unshift(preferredLevel)
  }
  return levels
}

/**
 * 检查 level 是否比 baseLevel 音质更好
 * @param {string} level
 * @param {string} baseLevel
 * @returns {boolean}
 */
function isBetterThanLevel(level, baseLevel) {
  if (!baseLevel) return true
  const cleanBase = baseLevel.replace('+unblock', '')
  const idx1 = QUALITY_ORDER.indexOf(level)
  const idx2 = QUALITY_ORDER.indexOf(cleanBase)
  if (idx1 === -1 || idx2 === -1) return false
  return idx1 < idx2 // 索引越小音质越好
}

// ===== 核心 API =====

async function fetchSongUrl(id, level, unblock, timeout, authOpts = {}, signal) {
  try {
    const res = await withTimeout(ncm.songUrl(id, level, unblock), timeout, signal)
    const item = res?.data?.[0]
    logPlayUrlAttempt('result', {
      id,
      level,
      unblock,
      code: item?.code ?? res?.code,
      hasUrl: Boolean(item?.url),
      freeTrial: Boolean(item?.freeTrialInfo),
      message: item?.message || res?.message || res?.msg || '',
    })
    if (!item?.url) {
      // 已登录但无音源 → cookie 可能已过期，等待检查结果
      if (authOpts.isLoggedIn) {
        const stillValid = await authOpts.checkLoginStatus?.()
        if (!stillValid) {
          // cookie 已过期并被清除，返回 null 让调用方走 fallback
          logPlayback('auth-cleared-on-no-url', { id, level })
        }
      }
      return null
    }
    if (item.freeTrialInfo && authOpts.isLoggedIn) {
      logPlayback('vip-trial', { id, level, url: item.url?.slice(0, 50) })
    }
    return {
      url: normalizePlayUrl(item.url),
      isTrial: Boolean(item?.freeTrialInfo),
      source: unblock ? 'official-unblock' : 'official',
      level,
      cacheable: !item?.freeTrialInfo,
    }
  } catch (error) {
    logPlayUrlAttempt('error', {
      id,
      level,
      unblock,
      message: error?.message || 'play url request failed',
    })
    return null
  }
}

async function fetchMatchedSongUrl(id, timeout, signal) {
  try {
    const res = await withTimeout(ncm.songUrlMatch(id), timeout, signal)
    const url = res?.data?.[0]?.url || res?.data?.url || res?.url || ''
    if (!url) return null
    const normalized = normalizePlayUrl(url)
    logPlayback('match-url', { id, url: normalized })
    return normalized ? { url: normalized, source: 'match', cacheable: true } : null
  } catch (error) {
    logPlayUrlAttempt('match-error', {
      id,
      message: error?.message || 'match url request failed',
    })
    return null
  }
}

async function fetchOldSongUrl(id, timeout, signal) {
  try {
    const res = await withTimeout(ncm.songUrlOld(id, 320000), timeout, signal)
    const url = res?.data?.[0]?.url || ''
    if (!url) return null
    const normalized = normalizePlayUrl(url)
    logPlayback('old-api-fallback', { id, url: normalized })
    return normalized ? { url: normalized, source: 'old-api', cacheable: false } : null
  } catch { /* swallow */ }
  return null
}

// ===== 后台刷新/填充 =====

/**
 * 后台刷新 IndexedDB 中的 URL 缓存（不阻塞播放）
 * @param {number} id
 * @param {string} preferredLevel
 */
export async function refreshSongUrlsBg(id, preferredLevel) {
  const fastTiers = uniqueLevels(['standard', 'higher', preferredLevel])
  for (const level of fastTiers) {
    const result = await fetchSongUrl(id, level, false, PLAYBACK.FAST_TIMEOUT, {})
    if (result?.url && !result.isTrial) {
      dbCache.urlSet(id, [result.url]).catch(swallowError)
      return
    }
  }
  for (const level of fastTiers) {
    const result = await fetchSongUrl(id, level, true, PLAYBACK.FAST_TIMEOUT, {})
    if (result?.url) {
      dbCache.urlSet(id, [result.url]).catch(swallowError)
      return
    }
  }
}

/**
 * 后台填充更多 fallback URL
 * @param {number} id
 * @param {number} reqId - 请求 ID，用于判断是否过期
 * @param {object} options
 * @param {string[]} options.currentUrls - 已有 URL 列表
 * @param {string} options.firstUrlLevel - 首条 URL 的音质等级
 * @param {string} options.preferredLevel - 用户偏好音质
 * @param {boolean} options.isPlaying - 当前是否正在播放
 * @param {number} options.currentTime - 当前播放位置
 * @param {Function} options.onQualityUpgrade - 音质升级回调
 * @param {Function} options.isStale - () => boolean 判断请求是否过期
 * @param {AbortSignal} options.signal - 中止信号
 */
export async function fillFallbackUrls(id, reqId, options = {}) {
  const {
    currentUrls = [],
    firstUrlLevel = '',
    preferredLevel = 'standard',
    isPlaying = false,
    currentTime = 0,
    onQualityUpgrade,
    isStale = () => false,
    authOpts = {},
    signal,
  } = options

  const urls = [...currentUrls]
  const allLevels = orderedPlayLevels(preferredLevel)
  let upgraded = false

  // 用于判断请求是否仍有效
  const isActive = () => !isStale()

  // Step 1: 后台获取偏好音质
  for (const level of allLevels) {
    if (!isActive()) return urls
    const result = await fetchSongUrl(id, level, false, PLAYBACK.FALLBACK_TIMEOUT, authOpts, signal)
    if (!result || urls.includes(result.url)) continue

    if (!upgraded && urls.length > 0 && isBetterThanLevel(level, firstUrlLevel)) {
      // 升级到更优音质：仅当未在播放中才无缝切换，否则仅入队
      urls.unshift(result.url)
      upgraded = true
      logPlayback('quality-upgrade', { level, firstUrlLevel, url: result.url })
      if (isPlaying && isActive() && currentTime > 30) {
        // 播放超过 30s 后不再中途切 URL，避免 pop/静音
        logPlayback('quality-upgrade-deferred', { level, currentTime })
      } else if (isPlaying && isActive()) {
        onQualityUpgrade?.({
          url: result.url,
          currentTime,
          urls,
          level,
        })
      }
    } else {
      urls.push(result.url)
    }
  }

  // Step 2: unblock 版本
  for (const level of allLevels) {
    if (!isActive()) return urls
    const result = await fetchSongUrl(id, level, true, PLAYBACK.FALLBACK_TIMEOUT, authOpts, signal)
    if (result && !urls.includes(result.url)) urls.push(result.url)
  }

  // Step 3: UnblockNeteaseMusic 直接解灰
  if (isActive() && urls.length <= 2) {
    const matched = await fetchMatchedSongUrl(id, PLAYBACK.FALLBACK_TIMEOUT, signal)
    if (matched?.url && !urls.includes(matched.url)) urls.push(matched.url)
  }

  // Step 4: 老版 /song/url 兜底
  if (isActive() && urls.length <= 2) {
    const old = await fetchOldSongUrl(id, PLAYBACK.FALLBACK_TIMEOUT, signal)
    if (old?.url && !urls.includes(old.url)) urls.push(old.url)
  }

  // Step 5: 网易官方 fallback
  if (isActive()) {
    const fbUrl = normalizePlayUrl(FALLBACK_URL_TEMPLATE(id))
    if (fbUrl && !urls.includes(fbUrl)) {
      urls.push(fbUrl)
    }
  }

  logPlayback('fallback-urls-filled', { totalUrls: urls.length, id, upgraded })
  return urls
}

/**
 * 获取歌曲的可播放 URL 列表（核心入口）
 *
 * @param {number} id - 歌曲 ID
 * @param {string} preferredLevel - 用户偏好音质
 * @param {Map} prefetchCache - 预取缓存 Map
 * @param {number} reqId - 当前请求 ID（用于竞态控制）
 * @returns {Promise<{urls: string[], firstUrlLevel: string, isTrial: boolean}>}
 */
export async function getPlayableUrls(id, preferredLevel, prefetchCache, reqId, authOpts = {}, signal) {
  // 0. 检查预取缓存
  const cached = prefetchCache?.get(id)
  if (cached) {
    prefetchCache?.delete(id)
    logPlayback('prefetch-hit', { id, urls: cached })
    return { urls: cached, firstUrlLevel: 'prefetch', isTrial: false }
  }

  // 1. 检查 SQLite / IndexedDB 持久缓存
  try {
    const persisted = await dbCache.urlGet(id)
    if (persisted && Array.isArray(persisted) && persisted.length > 0) {
      logPlayback('url-cache-hit', { id })
      // 后台刷新，不阻塞播放
      refreshSongUrlsBg(id, preferredLevel)
      return { urls: persisted, firstUrlLevel: 'cache', isTrial: false }
    }
  } catch { /* swallow */ }

  const fallbackUrl = FALLBACK_URL_TEMPLATE(id)
  const candidates = []
  const trialCandidates = []
  let firstUrlLevel = ''

  // Phase 1: 快速出声
  const fastTiers = uniqueLevels(['standard', 'higher', preferredLevel])
  for (const level of fastTiers) {
    const result = await fetchSongUrl(id, level, false, PLAYBACK.FAST_TIMEOUT, authOpts, signal)
    if (!result) continue
    if (result.isTrial) {
      addCandidate(trialCandidates, result)
    } else {
      addCandidate(candidates, result)
      firstUrlLevel = level
      break
    }
  }

  // Phase 2: unblock 尝试（仍快速）
  if (candidates.length === 0) {
    for (const level of fastTiers) {
      const result = await fetchSongUrl(id, level, true, PLAYBACK.FAST_TIMEOUT, authOpts, signal)
      if (!result) continue
      if (result.isTrial) {
        addCandidate(trialCandidates, result)
        // Enhanced API 可能在普通请求返回 code=404 时，unblock=true 已经给出可读试听 URL。
        // 拿到第一条就停止前台探测，避免继续等待 match/旧接口撞上 15s loading timeout。
        firstUrlLevel = level + '+unblock'
        break
      } else {
        addCandidate(candidates, result)
        firstUrlLevel = level + '+unblock'
        break
      }
    }
  }

  // Phase 2.5: 已有可播放试听 URL 时，只给 match 一个很短的完整音源机会。
  // 快速 match 成功则保留原有“完整音源优先”；否则立即使用试听，避免撞上 15s loading timeout。
  if (candidates.length === 0 && trialCandidates.length > 0) {
    const matched = await fetchMatchedSongUrl(id, Math.min(PLAYBACK.FAST_TIMEOUT, 800), signal)
    if (matched?.url) {
      addCandidate(candidates, matched)
      firstUrlLevel = 'match'
    } else {
      trialCandidates.forEach(candidate => addCandidate(candidates, { ...candidate, cacheable: false }))
    }
  }
  // Phase 3: 官方 match 解灰
  if (candidates.length === 0) {
    const matched = await fetchMatchedSongUrl(id, PLAYBACK.FAST_TIMEOUT, signal)
    if (matched?.url) {
      addCandidate(candidates, matched)
      firstUrlLevel = 'match'
    }
  }

  // Phase 4: 老版 /song/url 兜底
  if (candidates.length === 0) {
    const old = await fetchOldSongUrl(id, PLAYBACK.FAST_TIMEOUT, signal)
    if (old?.url) {
      addCandidate(candidates, old)
      firstUrlLevel = 'old-api'
    }
  }

  // Phase 5: 试听片段
  if (candidates.length === 0 && trialCandidates.length > 0) {
    trialCandidates.forEach(candidate => addCandidate(candidates, { ...candidate, cacheable: false }))
  }

  // Phase 6: 官方 fallback 兜底
  if (candidates.length === 0) {
    addCandidate(candidates, { url: fallbackUrl, source: 'template-fallback', cacheable: false })
  }

  const urls = candidates.map(candidate => candidate.url)

  // 判断是否为试听：所有 URL 都是试听片段或 fallback
  const isTrial = candidates.length > 0 && candidates.every(candidate => candidate.isTrial || candidate.source === 'template-fallback')

  const cacheableUrls = candidates.filter(candidate => candidate.cacheable).map(candidate => candidate.url)
  if (cacheableUrls.length > 0) {
    const ttl = isTrial ? 10 * 60 * 1000 : 60 * 60 * 1000
    dbCache.urlSet(id, cacheableUrls, ttl).catch(swallowError)
  }

  return { urls, firstUrlLevel, isTrial }
}
