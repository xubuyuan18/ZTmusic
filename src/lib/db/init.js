/**
 * SQLite 数据库初始化与 Schema 迁移
 *
 * 使用 sqlocal（SQLite WASM + OPFS）实现持久化存储。
 *
 * 兼容性策略（重要）：
 *   - 纯浏览器环境：OPFS 正常工作，数据持久化
 *   - Tauri 环境：WebView 不支持 OPFS/SharedArrayBuffer，跳过 SQLite
 *   - 任一失败：静默降级到 localStorage/IndexedDB
 */

let SQLocal = null
let _db = null
let _ready = false
let _errored = false
let _initPromise = null

function isTauriRuntime() {
  return typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__
}

async function loadSQLocal() {
  if (SQLocal) return SQLocal
  const mod = await import('sqlocal')
  SQLocal = mod.SQLocal || mod.default || mod
  return SQLocal
}

export async function initDB() {
  if (_ready) return true
  if (_errored) return false
  if (_initPromise) return _initPromise

  // Tauri: WebView 不支持 OPFS/SharedArrayBuffer，跳过 SQLite
  if (isTauriRuntime()) {
    console.debug('[DB] Tauri runtime detected, skipping SQLite')
    _errored = true
    try { setStorage('db_fallback_reason', 'tauri_runtime') } catch { /* ignore */ }
    return false
  }

  _initPromise = (async () => {
    try {
      const SQLocalClass = await loadSQLocal()
      _db = new SQLocalClass('zheting.db')

      await _db.sql(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
      await _db.sql(`CREATE TABLE IF NOT EXISTS play_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT, song_id INTEGER NOT NULL,
        name TEXT NOT NULL, artists TEXT, album TEXT, pic_url TEXT,
        duration INTEGER, played_at INTEGER NOT NULL
      )`)
      await _db.sql(`CREATE TABLE IF NOT EXISTS song_urls (
        song_id INTEGER PRIMARY KEY, urls TEXT NOT NULL,
        expires_at INTEGER NOT NULL DEFAULT 0, saved_at INTEGER NOT NULL
      )`)
      try {
        await _db.sql(`ALTER TABLE song_urls ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0`)
      } catch {
        // 列已存在时 ALTER 抛错，忽略
      }
      await _db.sql(`CREATE TABLE IF NOT EXISTS api_cache (
        key TEXT PRIMARY KEY, value TEXT NOT NULL,
        expires_at INTEGER NOT NULL, saved_at INTEGER NOT NULL
      )`)
      await _db.sql(`CREATE INDEX IF NOT EXISTS idx_history_played_at ON play_history(played_at DESC)`)
      await _db.sql(`CREATE INDEX IF NOT EXISTS idx_api_cache_expires ON api_cache(expires_at)`)

      _ready = true
      console.debug('[DB] SQLite initialized successfully')
      return true
    } catch (err) {
      const reason = err?.message || String(err)
      console.warn('[DB] SQLite initialization failed, falling back:', reason)
      _errored = true
      try { setStorage('db_fallback_reason', reason.slice(0, 200)) } catch { /* ignore */ }
      return false
    }
  })()

  return _initPromise
}

export function getDB() { return _ready ? _db : null }
export function isReady() { return _ready }
