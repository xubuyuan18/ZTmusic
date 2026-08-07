import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../stores/player.svelte.js', import.meta.url), 'utf8')

const timeoutSection = source.match(/_startLoadingTimeout\([\s\S]*?\n  _clearLoadingTimer\(/)?.[0] || ''
assert.match(timeoutSection, /requestId !== this\._playRequestId/, 'loading timeout should ignore stale timers')
assert.match(timeoutSection, /this\._invalidatePlaybackRequest\(\)/, 'loading timeout should invalidate the active playback request')
assert.match(timeoutSection, /this\.loading = false/, 'loading timeout should clear loading state')
assert.match(timeoutSection, /this\.playing = false/, 'loading timeout should clear playing state')

const clearSection = source.match(/_clearCurrentTrack\(\) \{[\s\S]*?\n  \}\n\n  \/\/ ==========================================\n  \/\/ 状态持久化/)?.[0] || ''
assert.match(clearSection, /resetAudio: true/, 'clearing the last track should reset the audio engine')
assert.match(clearSection, /this\.currentTime = 0/, 'clearing the last track should reset playback position')
assert.match(clearSection, /navigator\.mediaSession\.metadata = null/, 'clearing the last track should clear Web Media Session metadata')
assert.match(clearSection, /syncNativeMedia\(\)/, 'clearing the last track should clear native media state too')

console.log('player lifecycle source regression tests passed')
