import { ncm } from '../api/client.js'
import { parseLyricResponse } from '../utils/lyrics.js'

const DEFAULT_CACHE_SIZE = 32

function normalizeLyricLine(line) {
  const text = line?.content?.trim() || line?.translation?.trim() || line?.roman?.trim() || ''
  return {
    time: line.time,
    text,
    translation: line?.translation?.trim() || '',
  }
}

function normalizeYrcLine(line) {
  const text = line?.text?.trim() || ''
  return {
    time: line.time,
    text,
    translation: '',
  }
}

function parseDisplayLines(response) {
  const parsed = parseLyricResponse(response || {})
  const lines = parsed.lines
    .map(normalizeLyricLine)
    .filter((line) => line.text)
  if (lines.length > 0) return lines

  return parsed.yrcLines
    .map(normalizeYrcLine)
    .filter((line) => line.text)
}

export function createLyricsLoader(fetchLyrics, maxEntries = DEFAULT_CACHE_SIZE, fetchLyricsNew = null) {
  const cache = new Map()
  const pending = new Map()

  function get(id) {
    const lines = cache.get(id)
    if (!lines) return null
    cache.delete(id)
    cache.set(id, lines)
    return lines
  }

  function set(id, lines) {
    cache.delete(id)
    cache.set(id, lines)
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value)
    return lines
  }

  function load(id, { force = false } = {}) {
    if (!id) return Promise.resolve([])
    if (!force) {
      const cached = get(id)
      if (cached) return Promise.resolve(cached)
      const active = pending.get(id)
      if (active) return active
    }

    const request = Promise.resolve(fetchLyrics(id))
      .then(parseDisplayLines)
      .then(async (lines) => {
        if (lines.length > 0 || !fetchLyricsNew) return lines
        const fallbackResponse = await fetchLyricsNew(id)
        return parseDisplayLines(fallbackResponse)
      })
      .then((lines) => {
        // Do not cache an empty result. A transient API response must not pin
        // the track to "暂无歌词" for the rest of the app session.
        if (lines.length > 0) set(id, lines)
        return lines
      })
      .finally(() => {
        if (pending.get(id) === request) pending.delete(id)
      })

    pending.set(id, request)
    return request
  }

  function clear(id) {
    if (id) cache.delete(id)
    else cache.clear()
  }

  return { load, get, clear }
}

const sharedLyricsLoader = createLyricsLoader(
  (id) => ncm.lyric(id),
  DEFAULT_CACHE_SIZE,
  (id) => ncm.lyricNew(id),
)

export const loadLyrics = (id, options) => sharedLyricsLoader.load(id, options)
export const getCachedLyrics = (id) => sharedLyricsLoader.get(id)
export const clearLyricsCache = (id) => sharedLyricsLoader.clear(id)
