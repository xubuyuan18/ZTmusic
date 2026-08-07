import { createLyricsLoader } from './lyrics-loader.js'

let passed = 0
let failed = 0

function assertEqual(actual, expected, message) {
  if (actual === expected) passed++
  else {
    console.error(`FAIL: ${message} - expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    failed++
  }
}

let resolveFetch
let calls = 0
const loader = createLyricsLoader(() => {
  calls++
  return new Promise((resolve) => { resolveFetch = resolve })
}, 2)

const first = loader.load(1)
const duplicate = loader.load(1)
assertEqual(first, duplicate, 'shares the in-flight request for the same track')
assertEqual(calls, 1, 'fetches the same track once while pending')

resolveFetch({ lrc: { lyric: '[00:01.00] First line' }, tlyric: { lyric: '[00:01.00] 第一行' } })
const lines = await first
assertEqual(lines.length, 1, 'parses lyric response into display lines')
assertEqual(lines[0].text, 'First line', 'normalizes the lyric text')
assertEqual(lines[0].translation, '第一行', 'keeps translated text')

const cached = await loader.load(1)
assertEqual(cached, lines, 'returns the cached array for repeat consumers')
assertEqual(calls, 1, 'does not refetch a cached track')

let emptyCalls = 0
const emptyLoader = createLyricsLoader(() => {
  emptyCalls++
  return Promise.resolve({ lrc: { lyric: '' } })
}, 2)

const firstEmpty = await emptyLoader.load(2)
const secondEmpty = await emptyLoader.load(2)
assertEqual(firstEmpty.length, 0, 'returns an empty array when no lyric is available')
assertEqual(secondEmpty.length, 0, 'keeps an empty response safe for callers')
assertEqual(emptyCalls, 2, 'does not cache an empty lyric response')

let baseCalls = 0
let fallbackCalls = 0
const fallbackLoader = createLyricsLoader(
  () => {
    baseCalls++
    return Promise.resolve({ lrc: { lyric: '' } })
  },
  2,
  () => {
    fallbackCalls++
    return Promise.resolve({
      yrc: { lyric: '[1000,2000](1000,500,0)Fallback (1500,500,0)line' },
    })
  },
)

const fallbackLines = await fallbackLoader.load(3)
assertEqual(fallbackLines.length, 1, 'falls back to yrc when the regular lyric is empty')
assertEqual(fallbackLines[0].text, 'Fallback line', 'converts yrc words into display text')
assertEqual(baseCalls, 1, 'tries the regular lyric endpoint first')
assertEqual(fallbackCalls, 1, 'requests the new lyric endpoint only as fallback')

const cachedFallback = await fallbackLoader.load(3)
assertEqual(cachedFallback, fallbackLines, 'caches a successful yrc fallback')
assertEqual(baseCalls, 1, 'does not refetch the regular endpoint after fallback is cached')
assertEqual(fallbackCalls, 1, 'does not refetch the fallback endpoint after success')

console.log(`\n${passed} passed, ${failed} failed${failed ? ' - FAIL' : ' - all good'}`)
process.exit(failed ? 1 : 0)
