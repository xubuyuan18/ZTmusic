/**
 * 缓存存储（SQLite）
 * 替代 localStorage cache + IndexedDB dbcache
 *
 * 两个缓存表：
 *   - api_cache:  API 响应缓存（带 TTL）
 *   - song_urls:  歌曲 URL 缓存（持久化）
 *
 * 用法：
 *   import { dbCache } from '../db/cache.js'
 *   await dbCache.apiGet(key)
 *   await dbCache.apiSet(key, value, ttl)
 *   await dbCache.urlGet(songId)
 *   await dbCache.urlSet(songId, urls)
 */

import { getDB, isReady, initDB } from './init.js'
import { getStorage, setStorage } from '../utils/storage.js'
import { debugLog } from '../utils/logging.js'
import {
  clearCache as clearLegacyApiCache,
  createCacheKey,
  getCacheStats as getLegacyApiCacheStats,
  readCache,
  writeCache,
} from '../utils/cache.js'
import { dbApiClear, dbApiRead, dbApiWrite, dbClearAll, dbGetStats, dbUrlGet } from '../utils/dbcache.js'

// ==== 降级前缀 ====
const URL_CACHE_PREFIX = 'db_fallback_url_'  // localStorage fallback for song URLs

function isAvailable() {
  return isReady() && getDB()
}

let _ensureDBPromise = null
function ensureDB() {
  if (isReady()) return Promise.resolve(true)
  if (!_ensureDBPromise) {
    _ensureDBPromise = initDB().catch((err) => {
      debugLog('db', 'ensureDB failed', { message: err?.message || String(err) })
      return false
    })
  }
  return _ensureDBPromise
}

export const dbCache = {
  // ========================
  // API 缓存 (api_cache)
  // ========================

  createKey(parts) {
    return createCacheKey(parts)
  },

  /**
   * 读取 API 缓存
   * @param {string} key
   * @param {{ allowExpired?: boolean }} options
   * @returns {Promise<*|null>}
   */
  async apiGet(key, options = {}) {
    if (!key) return null
    await ensureDB()
    const { allowExpired = false } = options
    if (!isAvailable()) {
      debugLog('db', 'apiGet SQLite unavailable, using fallback', { key: key?.slice(0, 32) })
      const idbCached = allowExpired ? null : await dbApiRead(key).catch(() => null)
      if (idbCached) return idbCached
      return readCache(key, { allowExpired }) ?? null
    }
    try {
      const db = getDB()
      const rows = await db.sql(
        allowExpired
          ? `SELECT value FROM api_cache WHERE key = ?`
          : `SELECT value FROM api_cache WHERE key = ? AND expires_at > ?`,
        allowExpired ? [key] : [key, Date.now()]
      )
      if (rows.length > 0 && rows[0].value) {
        return JSON.parse(rows[0].value)
      }
      if (!allowExpired) {
        await db.sql(`DELETE FROM api_cache WHERE key = ?`, [key]).catch(() => {})
      }
      return null
    } catch {
      return readCache(key, { allowExpired }) ?? null
    }
  },

  /**
   * 写入 API 缓存
   * @param {string} key
   * @param {*} value
   * @param {number} ttl - TTL in ms
   */
  async apiSet(key, value, ttl) {
    if (!key || !ttl || ttl <= 0) return
    await ensureDB()
    if (!isAvailable()) {
      writeCache(key, value, ttl)
      dbApiWrite(key, value, ttl).catch(() => {})
      return
    }
    try {
      const db = getDB()
      await db.sql(
        `INSERT INTO api_cache (key, value, expires_at, saved_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at, saved_at = excluded.saved_at`,
        [key, JSON.stringify(value), Date.now() + ttl, Date.now()]
      )
    } catch {
      writeCache(key, value, ttl)
      dbApiWrite(key, value, ttl).catch(() => {})
    }
  },

  /**
   * 删除过期 API 缓存
   */
  async apiCleanExpired() {
    if (!isAvailable()) return
    try {
      const db = getDB()
      await db.sql(`DELETE FROM api_cache WHERE expires_at <= ?`, [Date.now()])
    } catch { /* ignore */ }
  },

  /** 清空 API 缓存（包含旧 localStorage / IndexedDB fallback） */
  async apiClear() {
    clearLegacyApiCache()
    await dbApiClear().catch(() => {})
    if (!isAvailable()) return
    try {
      const db = getDB()
      await db.sql(`DELETE FROM api_cache`)
    } catch { /* ignore */ }
  },

  /** localStorage API 缓存统计（保持设置页同步展示兼容） */
  getLegacyApiStats() {
    return getLegacyApiStatsAsync()
  },
  async getLegacyApiStatsAsync() {
    if (isAvailable()) {
      try {
        const db = getDB()
        const rows = await db.sql(`SELECT COUNT(*) as cnt FROM api_cache`)
        return { entries: rows[0]?.cnt || 0, source: 'sqlite' }
      } catch { /* fall through */ }
    }
    const legacy = getLegacyApiCacheStats()
    return { ...legacy, source: 'localStorage' }
  },

  // ========================
  // 歌曲 URL 缓存 (song_urls)
  // ========================

  /**
   * 获取缓存的歌曲 URL
   * @param {number} songId
   * @returns {Promise<string[]|null>}
   */
  async urlGet(songId) {
    if (!songId) return null
    await ensureDB()
    const readLocalFallback = () => {
      const raw = getStorage(URL_CACHE_PREFIX + songId, '')
      if (!raw) return null
      try {
        const parsed = JSON.parse(raw)
        if (parsed && typeof parsed === 'object' && Array.isArray(parsed.urls)) {
          if (parsed.expiresAt && parsed.expiresAt < Date.now()) return null
          return parsed.urls
        }
        return Array.isArray(parsed) ? parsed : null
      } catch { return null }
    }

    if (!isAvailable()) {
      return readLocalFallback() || await dbUrlGet(songId).catch(() => null)
    }
    try {
      const db = getDB()
      const rows = await db.sql(`SELECT urls, expires_at FROM song_urls WHERE song_id = ?`, [songId])
      if (rows.length > 0 && rows[0].urls) {
        const expiresAt = rows[0].expires_at
        if (expiresAt && expiresAt > 0 && expiresAt < Date.now()) {
          debugLog('db', 'urlGet expired', { songId, expiresAt: new Date(expiresAt).toISOString() })
          return readLocalFallback() || await dbUrlGet(songId).catch(() => null)
        }
        return JSON.parse(rows[0].urls)
      }
      return readLocalFallback() || await dbUrlGet(songId).catch(() => null)
    } catch {
      return readLocalFallback() || await dbUrlGet(songId).catch(() => null)
    }
  },

  /**
   * 缓存歌曲 URL
   * @param {number} songId
   * @param {string[]} urls
   * @param {number} ttlMs 过期时间，默认 1 小时
   */
  async urlSet(songId, urls, ttlMs = 60 * 60 * 1000) {
    if (!songId || !urls || urls.length === 0) return
    await ensureDB()
    const expiresAt = Date.now() + Math.max(0, ttlMs)
    if (!isAvailable()) {
      setStorage(URL_CACHE_PREFIX + songId, JSON.stringify({ urls, expiresAt }))
      return
    }
    try {
      const db = getDB()
      await db.sql(
        `INSERT INTO song_urls (song_id, urls, expires_at, saved_at) VALUES (?, ?, ?, ?) ON CONFLICT(song_id) DO UPDATE SET urls = excluded.urls, expires_at = excluded.expires_at, saved_at = excluded.saved_at`,
        [songId, JSON.stringify(urls), expiresAt, Date.now()]
      )
    } catch {
      setStorage(URL_CACHE_PREFIX + songId, JSON.stringify({ urls, expiresAt }))
    }
  },

  /**
   * 获取缓存统计信息
   * @returns {Promise<{apiCache: number, urlCache: number}>
   */
  async getStats() {
    if (!isAvailable()) {
      return dbGetStats()
    }
    try {
      const db = getDB()
      const apiResult = await db.sql(`SELECT COUNT(*) as cnt FROM api_cache`)
      const urlResult = await db.sql(`SELECT COUNT(*) as cnt FROM song_urls`)
      return {
        apiCache: apiResult[0]?.cnt || 0,
        urlCache: urlResult[0]?.cnt || 0,
        available: true,
      }
    } catch {
      return dbGetStats()
    }
  },

  /**
   * 清空所有缓存
   */
  async clearAll() {
    clearLegacyApiCache()
    await dbClearAll().catch(() => {})
    if (!isAvailable()) return
    try {
      const db = getDB()
      await db.sql(`DELETE FROM api_cache`)
      await db.sql(`DELETE FROM song_urls`)
    } catch { /* ignore */ }
  },
}
