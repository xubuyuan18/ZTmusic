import {
  clearApiCache,
  createApiCacheKey,
  getApiCacheStats,
  getApiCacheTtl,
  isCacheableResponse,
  readApiCache,
  writeApiCache,
} from './cache-policy.js'
import { apiSession, DEFAULT_API_BASE, DEV_PROXY_API_BASE } from './session.js'
import { normalizeError } from '../utils/error-core.js'

export { DEFAULT_API_BASE }

let tauriInvokePromise

function isBrowserDevRuntime() {
  if (typeof window === 'undefined') return false
  const h = window.location?.hostname
  return (h === '127.0.0.1' || h === 'localhost') && !isTauriRuntime()
}

function getRequestBase(base) {
  return isBrowserDevRuntime() && base === DEFAULT_API_BASE ? DEV_PROXY_API_BASE : base
}

const DEFAULT_TIMEOUT = 15000

function isTauriRuntime() {
  return typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__
}

async function getTauriInvoke() {
  if (!isTauriRuntime()) return null
  if (!tauriInvokePromise) {
    tauriInvokePromise = import('@tauri-apps/api/core')
      .then(mod => mod.invoke)
      .catch(() => {
        // ponytail: 动态导入失败时直接从 __TAURI_INTERNALS__ 拿 invoke
        if (typeof window !== 'undefined' && window.__TAURI_INTERNALS__) {
          const invokeFn = window.__TAURI_INTERNALS__.invoke
          if (typeof invokeFn === 'function') return invokeFn
        }
        return null
      })
  }
  return tauriInvokePromise
}

async function fetchWithTimeout(url, opts = {}, timeout = DEFAULT_TIMEOUT, signal) {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeout)
  const onAbort = () => controller.abort(signal?.reason)
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  try {
    return await fetch(url, { ...opts, signal: controller.signal })
  } catch (err) {
    if (err?.name === 'AbortError' && timedOut) throw new Error('API request timeout')
    throw err
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}

export { fetchWithTimeout }

function isProxyBadGateway(err, status) {
  if (status === 502 || status === 503 || status === 504) return true
  const m = (err?.message || '').toLowerCase()
  return m.includes('502') || m.includes('bad gateway') || m.includes('econnreset') || m.includes('socket hang up')
}

async function request(endpoint, params = {}, method = 'GET', body = null, options = {}) {
  const invoke = await getTauriInvoke()
  const apiBase = apiSession.getBase()
  const cookie = options.noCookie ? '' : apiSession.getCookie()
  const withRandomCNIP = options.randomCNIP !== false
  const requestParams = withRandomCNIP ? { randomCNIP: true, ...params } : params
  const requestBody = body ? (withRandomCNIP ? { randomCNIP: true, ...body } : body) : body
  const cacheTtl = getApiCacheTtl(endpoint, method, options)
  const cacheKey = createApiCacheKey({
    base: apiBase,
    endpoint,
    params: requestParams,
    body: requestBody,
    cookie,
    ttl: cacheTtl,
  })
  if (cacheKey && !options.refresh) {
    const cached = await readApiCache(cacheKey).catch(() => null)
    if (cached) return cached
  }
  if (invoke) {
    let attempt = 0
    const maxTauriRetries = 2
    while (attempt <= maxTauriRetries) {
      try {
        const result = await invoke('ncm_request', {
          request: {
            base: apiBase,
            endpoint,
            params: requestParams,
            method,
            body: requestBody,
            cookie,
            allowErrorBody: !!options.allowErrorBody,
          },
        })
        if (options.saveCookie !== false) apiSession.saveCookieFromResponse(result.data, result.cookie)
        if (isCacheableResponse(result.data)) writeApiCache(cacheKey, result.data, cacheTtl).catch(() => {})
        return result.data
      } catch (error) {
        if (attempt < maxTauriRetries && isProxyBadGateway(error)) {
          attempt++
          await new Promise(r => setTimeout(r, 200 * attempt))
          continue
        }
        const stale = cacheKey ? await readApiCache(cacheKey, { allowExpired: true }).catch(() => null) : null
        if (stale) return stale
        throw normalizeError(error, 'ncm_request')
      }
    }
  }

  const requestBase = getRequestBase(apiBase)
  const url = requestBase.startsWith('http')
    ? new URL(`${requestBase}${endpoint}`)
    : new URL(`${requestBase}${endpoint}`, window.location.origin)
  if (method === 'GET') {
    Object.entries(requestParams).forEach(([k, v]) => {
      if (v !== undefined && v !== null) url.searchParams.set(k, v)
    })
    if (cookie) url.searchParams.set('cookie', cookie)
  }
  const opts = { method, credentials: options.browserCredentials || 'same-origin' }
  if (requestBody) {
    opts.headers = { 'Content-Type': 'application/x-www-form-urlencoded' }
    const formBody = { ...requestBody }
    if (cookie) formBody.cookie = cookie
    opts.body = new URLSearchParams(formBody).toString()
  }

  // 从 invoke 路径透传 signal：在 options 里取 signal，让 withCancel 的 abort 能中止底层 fetch
  const signal = options.signal

  let attempt = 0
  const maxFetchRetries = 2
  while (attempt <= maxFetchRetries) {
    try {
      const res = await fetchWithTimeout(url, opts, DEFAULT_TIMEOUT, signal)
      if (!res.ok && !options.allowErrorBody) throw new Error(`API error: ${res.status}`)
      // JSON 解析失败：用 code:-1 显式标记非法响应，避免 res.ok=true 时用 code:200 掩盖解析失败
      const data = await res.json().catch(() => ({
        code: res.ok ? -1 : res.status,
        message: res.ok ? `API response not JSON: ${res.status}` : `API error: ${res.status}`,
      }))
      if (options.saveCookie !== false) apiSession.saveCookieFromResponse(data)
      if (isCacheableResponse(data)) writeApiCache(cacheKey, data, cacheTtl).catch(() => {})
      return data
    } catch (error) {
      if (attempt < maxFetchRetries && isProxyBadGateway(error)) {
        attempt++
        await new Promise(r => setTimeout(r, 200 * attempt))
        continue
      }
      const stale = cacheKey ? await readApiCache(cacheKey, { allowExpired: true }).catch(() => null) : null
      if (stale) return stale
      throw normalizeError(error, 'fetch')
    }
  }
}

export const ncm = {
  setBase(url) { apiSession.setBase(url) },
  getBase() { return apiSession.getBase() },
  setCookie(c) { apiSession.setCookie(c) },
  clearCookie() { apiSession.clearCookie() },
  clearCache() { return clearApiCache() },
  getCacheStats() { return getApiCacheStats() },
  searchSongs(keywords, limit = 30, offset = 0) {
    return request('/search', { keywords, limit, offset, type: 1 })
  },
  searchArtists(keywords, limit = 20, offset = 0) {
    return request('/search', { keywords, limit, offset, type: 100 })
  },
  searchPlaylists(keywords, limit = 20, offset = 0) {
    return request('/search', { keywords, limit, offset, type: 1000 })
  },
  cloudsearch(keywords, limit = 30, offset = 0) {
    return request('/cloudsearch', { keywords, limit, offset })
  },
  searchHot() {
    return request('/search/hot')
  },

  songUrl(id, level = 'lossless', unblock = false) {
    return request('/song/url/v1', { id, level, unblock: unblock ? 'true' : 'false' })
  },
  /** 老版 /song/url — 用 br 码率，作 fallback 兜底 */
  songUrlOld(id, br = 320000) {
    return request('/song/url', { id, br })
  },
  /** 直接获取灰色歌曲链接（UnblockNeteaseMusic） */
  songUrlMatch(id) {
    return request('/song/url/match', { id })
  },
  vipInfo() {
    return request('/vip/info')
  },
  vipInfoV2() {
    return request('/vip/info/v2')
  },
  lyric(id) {
    return request('/lyric', { id })
  },
  lyricNew(id) {
    return request('/lyric/new', { id })
  },
  songDetail(id) {
    const ids = Array.isArray(id) ? id.join(',') : id
    return request('/song/detail', { ids })
  },
  checkMusic(id) {
    return request('/check/music', { id })
  },

  playlistDetail(id) {
    return request('/playlist/detail', { id })
  },
  playlistTracks(id, limit = 100, offset = 0) {
    return request('/playlist/track/all', { id, limit, offset })
  },
  playlistAddTrack(id, tracks) {
    const trackIds = Array.isArray(tracks) ? tracks.join(',') : tracks
    return request('/playlist/tracks', { op: 'add', pid: id, tracks: trackIds, timestamp: Date.now() })
  },
  playlistRemoveTrack(id, tracks) {
    const trackIds = Array.isArray(tracks) ? tracks.join(',') : tracks
    return request('/playlist/tracks', { op: 'del', pid: id, tracks: trackIds, timestamp: Date.now() })
  },
  playlistCreate(name) {
    return request('/playlist/create', { name, timestamp: Date.now() }, 'GET', null, { cache: false, refresh: true, allowErrorBody: true })
  },
  playlistDelete(id) {
    return request('/playlist/delete', { id, timestamp: Date.now() }, 'GET', null, { cache: false, refresh: true, allowErrorBody: true })
  },
  playlistSubscribe(id, subscribe = true) {
    return request('/playlist/subscribe', { id, t: subscribe ? 1 : 2, timestamp: Date.now() }, 'GET', null, { cache: false, refresh: true, allowErrorBody: true })
  },
  userPlaylist(uid, options = {}) {
    return request('/user/playlist', { uid }, 'GET', null, options)
  },
  userDetail(uid) {
    return request('/user/detail', { uid })
  },
  userLevel() {
    return request('/user/level')
  },
  userAccount() {
    return request('/user/account', {}, 'POST', {})
  },
  userRecord(uid, type = 1) {
    return request('/user/record', { uid, type })
  },
  userRecordWeek(uid) {
    return request('/user/record', { uid, type: 1 })
  },
  userSubcount() {
    return request('/user/subcount')
  },
  userFollows(uid, limit = 30, offset = 0) {
    return request('/user/follows', { uid, limit, offset })
  },
  userFolloweds(uid, limit = 30, offset = 0) {
    return request('/user/followeds', { uid, limit, offset })
  },

  personalized(limit = 10) {
    return request('/personalized', { limit })
  },
  recommendResource() {
    return request('/recommend/resource')
  },
  banner() {
    return request('/banner')
  },
  recommendSongs(limit = 10) {
    return request('/recommend/songs', { limit })
  },
  personalizedNewSong(limit = 12) {
    return request('/personalized/newsong', { limit })
  },
  homepageBlockPage(refresh = false, cursor) {
    return request('/homepage/block/page', { refresh, cursor })
  },
  historyRecommendSongs() {
    return request('/history/recommend/songs')
  },
  historyRecommendSongsDetail(date) {
    return request('/history/recommend/songs/detail', { date })
  },
  simiSong(id) {
    return request('/simi/song', { id })
  },
  simiPlaylist(id) {
    return request('/simi/playlist', { id })
  },
  commentMusic(id, limit = 20, offset = 0, before) {
    return request('/comment/music', { id, limit, offset, before })
  },
  topAlbum(area = 'ALL', limit = 20, offset = 0, type = 'new', year, month) {
    return request('/top/album', { area, limit, offset, type, year, month })
  },
  albumNewest() {
    return request('/album/newest')
  },
  albumNew(area = 'ALL', limit = 20, offset = 0) {
    return request('/album/new', { area, limit, offset })
  },

  artistDetail(id) {
    return request('/artist/detail', { id })
  },
  artistSongs(id, limit = 50, offset = 0) {
    return request('/artist/songs', { id, limit, offset })
  },
  artistAlbums(id, limit = 50, offset = 0) {
    return request('/artist/album', { id, limit, offset })
  },
  artistSub(id, subscribe = true) {
    return request('/artist/sub', { id, t: subscribe ? 1 : 0 })
  },
  album(id) {
    return request('/album', { id })
  },

  toplist() {
    return request('/toplist')
  },
  toplistDetail(id, limit = 50) {
    return request('/top/list', { id, limit })
  },

  topPlaylist(cat = '全部', limit = 20, offset = 0) {
    return request('/top/playlist', { cat, limit, offset })
  },
  topSongs(type = 0) {
    return request('/top/song', { type })
  },

  loginQrKey() {
    return request('/login/qr/key', { timestamp: Date.now(), noCookie: true }, 'GET', null, { randomCNIP: false, noCookie: true, saveCookie: false, browserCredentials: 'omit' })
  },
  loginQrCreate(key, qrimg = true) {
    // 不传 platform=web，避免后端基于空 cookie 生成无效 chainId 污染 qrurl
    return request('/login/qr/create', { key, qrimg, timestamp: Date.now() }, 'GET', null, { randomCNIP: false, noCookie: true, saveCookie: false, browserCredentials: 'omit' })
  },
  loginQrCheck(key) {
    return request('/login/qr/check', { key, timestamp: Date.now(), noCookie: true }, 'GET', null, { noCookie: true, allowErrorBody: true, randomCNIP: false, saveCookie: false, browserCredentials: 'omit' })
  },
  loginCellphone(phone, password) {
    return request('/login/cellphone', {}, 'POST', { phone, password }, { randomCNIP: false })
  },
  loginEmail(email, password) {
    return request('/login', {}, 'POST', { email, password }, { randomCNIP: false })
  },
  logout() {
    return request('/logout', {}, 'POST', null, { randomCNIP: false })
  },
  loginStatus(cookie) {
    return request('/login/status', { timestamp: Date.now(), ua: 'pc' }, 'POST', cookie ? { cookie } : {}, { randomCNIP: false })
  },

  like(id, like = true, uid) {
    const timestamp = Date.now()
    if (uid) return request('/song/like', { id, uid, like, timestamp })
    return request('/like', { id, like, timestamp })
  },
  likelist(uid) {
    return request('/likelist', { uid })
  },
  songLikeCheck(ids) {
    const list = Array.isArray(ids) ? ids : [ids]
    return request('/song/like/check', { ids: JSON.stringify(list), timestamp: Date.now() }, 'GET', null, { cache: false })
  },

  // ===== 私信 & 通知 =====
  /** 获取私信列表 */
  msgPrivate(limit = 30, offset = 0) {
    return request('/msg/private', { limit, offset }, 'GET', null, { allowErrorBody: true })
  },
  /** 获取最近联系人 */
  msgRecentContact() {
    return request('/msg/recentcontact', {}, 'GET', null, { allowErrorBody: true })
  },
  /** 获取私信详情 */
  msgPrivateHistory(uid, limit = 30, before) {
    return request('/msg/private/history', { uid, limit, before })
  },
  /** 发送文字私信 */
  sendText(userIds, msg) {
    return request('/send/text', { user_ids: userIds, msg })
  },
  /** 发送歌曲私信 */
  sendSong(userIds, id, msg) {
    return request('/send/song', { user_ids: userIds, id, msg })
  },
  /** 发送专辑私信 */
  sendAlbum(userIds, id, msg) {
    return request('/send/album', { user_ids: userIds, id, msg })
  },
  /** 发送歌单私信 */
  sendPlaylist(userIds, playlist, msg) {
    return request('/send/playlist', { user_ids: userIds, playlist, msg })
  },
  /** 获取评论通知 */
  msgComments(uid, limit = 30, before) {
    return request('/msg/comments', { uid, limit, before })
  },
  /** 获取@我通知 */
  msgForwards(limit = 30, offset = 0) {
    return request('/msg/forwards', { limit, offset }, 'GET', null, { allowErrorBody: true })
  },
  /** 获取系统通知 */
  msgNotices(limit = 30, lasttime = -1) {
    return request('/msg/notices', { limit, lasttime }, 'GET', null, { allowErrorBody: true })
  },
}
