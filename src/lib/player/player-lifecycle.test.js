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

const nativeMetadataSection = source.match(/getMetadata: \(\) => \(\{[\s\S]*?\}\),/)?.[0] || ''
assert.match(nativeMetadataSection, /album: this\.currentTrack\?\.al\?\.name \|\| ''/, 'native metadata should include album name for Android/Linux')

const nativeButtonSection = source.match(/_handleMediaButton\(action\) \{[\s\S]*?\n  \}/)?.[0] || ''
assert.match(nativeButtonSection, /action\.startsWith\('seek:'\)/, 'native media actions should support seek requests')
assert.match(nativeButtonSection, /this\.seek\(seconds\)/, 'native seek requests should use PlayerState.seek')

assert.match(source, /navigator\.mediaSession\.metadata = new MediaMetadata\(/, 'Web Media Session should publish track metadata on Windows/browser platforms')
assert.match(source, /album: this\.currentTrack\?\.al\?\.name \|\| ''/, 'Web Media Session metadata should include album name')
assert.match(source, /artwork: \[\{ src: coverUrl\(this\.cover, 512\)/, 'Web Media Session metadata should publish 512px artwork')
assert.match(source, /navigator\.mediaSession\.setPositionState\(/, 'Web Media Session should publish playback timeline')
assert.match(source, /this\._setMediaActionHandler\('seekto'/, 'Web Media Session should handle timeline seeks')
assert.match(source, /this\._setMediaActionHandler\('nexttrack'/, 'Web Media Session should handle next track')
assert.match(source, /this\._setMediaActionHandler\('previoustrack'/, 'Web Media Session should handle previous track')

console.log('player lifecycle and media session source regression tests passed')
