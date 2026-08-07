import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('./useLyrics.svelte.js', import.meta.url), 'utf8')
const baseFetch = source.indexOf('await ncm.lyric(id)')
const publish = source.indexOf('lyrics = base.lines.map', baseFetch)
const loadingDone = source.indexOf('loading = false', publish)
const yrcFetch = source.indexOf('await ncm.lyricNew(id)', loadingDone)

assert.ok(baseFetch >= 0, 'player lyrics should fetch /lyric directly')
assert.ok(publish > baseFetch, 'regular LRC should be published into player state')
assert.ok(loadingDone > publish, 'basic lyric loading should finish after regular LRC is published')
assert.ok(yrcFetch > loadingDone, '/lyric/new must be an enhancement and must not gate basic lyric display')
assert.match(source, /parseLyricResponse\(res \|\| \{\}\)/, 'regular lyric response should use the existing parser')

console.log('direct in-player lyrics regression test passed')
