/**
 * useLyrics — shared lyrics state & fetching for player views
 *
 * Keep the player-view path intentionally direct. The previous shared loader
 * abstraction made the in-app lyrics state harder to reason about in the
 * Tauri runtime; the original two-phase flow was already proven in production:
 * show regular LRC first, then enrich with /lyric/new word timing when present.
 */
import { player } from '../stores/player.svelte.js'
import { ncm } from '../api/client.js'
import { parseLyricResponse, parseYrc } from '../utils/lyrics.js'
import { debugLog } from '../utils/error.js'

function splitWords(text = '') {
  return (text || '').trim().split(/\s+/).map(w => w.trim()).filter(Boolean)
}

export function useLyrics() {
  let lyrics = $state([])
  let yrcLines = $state([])
  let loading = $state(false)
  let requestId = 0

  let highlightIndex = $derived.by(() => {
    if (lyrics.length === 0) return -1
    const now = player.currentTime
    for (let i = lyrics.length - 1; i >= 0; i--) if (now >= lyrics[i].time) return i
    return -1
  })

  async function refresh() {
    const id = player.id
    if (!id) { lyrics = []; yrcLines = []; loading = false; return }
    const reqId = ++requestId
    loading = true

    // Phase 1: regular LRC. Publish it immediately so /lyric/new latency or
    // absence of YRC never leaves the player view stuck on “暂无歌词”.
    try {
      const res = await ncm.lyric(id)
      if (reqId !== requestId || player.id !== id) return
      const base = parseLyricResponse(res || {})
      lyrics = base.lines.map(l => ({
        time: l.time,
        text: l.content || l.translation || l.roman || '',
        translation: l.translation || '',
        words: l.content ? splitWords(l.content) : [],
      })).filter(line => line.text)
    } catch (err) {
      if (reqId !== requestId || player.id !== id) return
      lyrics = []
      debugLog('useLyrics', 'fetch-error', { id, error: err?.message || String(err) })
    }

    if (reqId === requestId) loading = false

    // Phase 2: word-timed lyrics are an enhancement only. Do not keep the
    // basic lyrics UI loading while waiting for this endpoint.
    try {
      const newRes = await ncm.lyricNew(id)
      if (reqId !== requestId || player.id !== id) return
      if (newRes?.yrc?.lyric) {
        const yrc = parseYrc(newRes.yrc.lyric)
        if (yrc.length > 0) yrcLines = yrc
      }
    } catch (err) {
      debugLog('useLyrics', 'yrc-fetch-error', { id, error: err?.message || String(err) })
    }
  }

  function clear() {
    requestId++
    lyrics = []
    yrcLines = []
    loading = false
  }

  // Auto-fetch when the playing track changes.
  $effect(() => {
    const id = player.id
    if (!id) { clear(); return }
    lyrics = []
    yrcLines = []
    refresh()
  })

  return {
    get lyrics() { return lyrics },
    get yrcLines() { return yrcLines },
    get loading() { return loading },
    get highlightIndex() { return highlightIndex },
    refresh,
    clear,
  }
}
