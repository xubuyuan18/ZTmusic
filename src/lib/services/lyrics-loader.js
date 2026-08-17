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

export function createLyricsLoader(fetchLyrics, maxEntries = DEFAULT_CACHE_SIZE) {
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
      .then((response) => parseLyricResponse(response || {}).lines
        .map(normalizeLyricLine)
        .filter((line) => line.text))
      .then((lines) => set(id, lines))
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

const sharedLyricsLoader = createLyricsLoader((id) => ncm.lyric(id))

export const loadLyrics = (id, options) => sharedLyricsLoader.load(id, options)
export const getCachedLyrics = (id) => sharedLyricsLoader.get(id)
