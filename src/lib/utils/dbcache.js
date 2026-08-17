/**
 * IndexedDB 缓存层
 * - API 缓存: 带 TTL 的 HTTP 响应缓存（替代 localStorage）
 * - URL 缓存: 持久化歌曲播放 URL（跨会话，LRU 淘汰）
 *
 * 自动降级: IndexedDB 不可用时（隐私模式等）静默失败，
 * 调用方应回退到 localStorage。
 */

const DB_NAME = 'zheting_cache'
const DB_VERSION = 3
const STORE_API = 'api_cache'
const STORE_URL = 'song_urls'
const DB_TIMEOUT = 3000 // 3s timeout for IndexedDB operations
const URL_CACHE_TTL = 12 * 60 * 60 * 1000  // 歌曲 URL 过期时间：12 小时
let _idbFailed = false // fast-failure flag

function openDB() {
  if (_idbFailed) return Promise.reject(new Error('indexedDB previously failed'))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('indexedDB timeout')), DB_TIMEOUT)
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = (e) => {
        const db = e.target.result
        if (!db.objectStoreNames.contains(STORE_API)) {
          const s = db.createObjectStore(STORE_API, { keyPath: 'key' })
          s.createIndex('expiresAt', 'expiresAt', { unique: false })
        } else {
          // 升级旧 store
          const tx = e.target.transaction
          const store = tx.objectStore(STORE_API)
          if (!store.indexNames.contains('expiresAt')) {
            store.createIndex('expiresAt', 'expiresAt', { unique: false })
          }
        }
        if (!db.objectStoreNames.contains(STORE_URL)) {
          const s = db.createObjectStore(STORE_URL, { keyPath: 'id' })
          s.createIndex('savedAt', 'savedAt', { unique: false })
        }
      }
      req.onsuccess = (e) => { clearTimeout(timer); resolve(e.target.result) }
      req.onerror = () => { clearTimeout(timer); _idbFailed = true; reject(req.error) }
    } catch (err) {
      clearTimeout(timer)
      _idbFailed = true
      reject(err instanceof Error ? err : new Error('indexedDB not available'))
    }
  })
}

// ===== API 缓存 =====

export async function dbApiRead(key) {
  let db
  try { db = await openDB() } catch { return null }
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_API, 'readonly')
      const req = tx.objectStore(STORE_API).get(key)
      req.onsuccess = () => {
        const entry = req.result
        if (!entry) return resolve(null)
        if (entry.expiresAt < Date.now()) {
          // 过期：dbCleanExpired() 统一清理，此处不再开 readwrite 事务
          return resolve(null)
        }
        resolve(entry.value)
      }
      req.onerror = () => resolve(null)
    } catch { resolve(null) }
  })
}

export async function dbApiWrite(key, value, ttl) {
  if (!ttl || ttl <= 0) return
  let db
  try { db = await openDB() } catch { return }
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_API, 'readwrite')
      tx.objectStore(STORE_API).put({ key, value, expiresAt: Date.now() + ttl, savedAt: Date.now() })
      tx.oncomplete = resolve
      tx.onerror = () => resolve()
    } catch { resolve() }
  })
}

export async function dbApiClear() {
  let db
  try { db = await openDB() } catch { return }
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_API, 'readwrite')
      tx.objectStore(STORE_API).clear()
      tx.oncomplete = resolve
      tx.onerror = () => resolve()
    } catch { resolve() }
  })
}

// ===== 歌曲 URL 缓存（持久化） =====

export async function dbUrlGet(id) {
  let db
  try { db = await openDB() } catch { return null }
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_URL, 'readonly')
      const req = tx.objectStore(STORE_URL).get(String(id))
      req.onsuccess = () => {
        if (!req.result?.urls) {
          resolve(null)
          return
        }
        // 新格式有 expiresAt，优先检查
        if (typeof req.result.expiresAt === 'number') {
          if (req.result.expiresAt < Date.now()) {
            resolve(null)
          } else {
            resolve(req.result.urls)
          }
          return
        }
        // 兼容旧格式用 savedAt
        if (req.result.savedAt && Date.now() - req.result.savedAt < URL_CACHE_TTL) {
          resolve(req.result.urls)
        } else {
          // 过期了，返回 null 让它重新请求
          resolve(null)
        }
      }
      req.onerror = () => resolve(null)
    } catch { resolve(null) }
  })
}

// ===== 统计 & 管理 =====

export async function dbGetStats() {
  let db
  try { db = await openDB() } catch { return { apiCache: 0, urlCache: 0, available: false } }
  try {
    const apiCount = await new Promise((r) => { const c = db.transaction(STORE_API).objectStore(STORE_API).count(); c.onsuccess = () => r(c.result); c.onerror = () => r(0) })
    const urlCount = await new Promise((r) => { const c = db.transaction(STORE_URL).objectStore(STORE_URL).count(); c.onsuccess = () => r(c.result); c.onerror = () => r(0) })
    return { apiCache: apiCount, urlCache: urlCount, available: true }
  } catch { return { apiCache: 0, urlCache: 0, available: false } }
}

export async function dbClearAll() {
  let db
  try { db = await openDB() } catch { return }
  try {
    await Promise.all([
      new Promise((r) => { const t = db.transaction(STORE_API, 'readwrite'); t.objectStore(STORE_API).clear(); t.oncomplete = r; t.onerror = r }),
      new Promise((r) => { const t = db.transaction(STORE_URL, 'readwrite'); t.objectStore(STORE_URL).clear(); t.oncomplete = r; t.onerror = r }),
    ])
  } catch {}
}

export async function dbCleanExpired() {
  let db
  try { db = await openDB() } catch { return }
  try {
    const tx = db.transaction(STORE_API, 'readwrite')
    const idx = tx.objectStore(STORE_API).index('expiresAt')
    idx.openCursor(IDBKeyRange.upperBound(Date.now())).onsuccess = (e) => {
      const cursor = e.target.result
      if (cursor) { cursor.delete(); cursor.continue() }
    }
  } catch {}
}
