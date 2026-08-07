import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('./url-resolver.js', import.meta.url), 'utf8')
const phase2Start = source.indexOf('// Phase 2: unblock')
const boundedMatch = source.indexOf('Math.min(PLAYBACK.FAST_TIMEOUT, 800)', phase2Start)
const phase3 = source.indexOf('// Phase 3: 官方 match')

assert.ok(phase2Start >= 0, 'unblock phase should exist')
assert.ok(boundedMatch > phase2Start, 'trial path should give match only a bounded foreground opportunity')
assert.ok(phase3 > boundedMatch, 'bounded trial/match decision should happen before normal match/old fallbacks')

const phase2 = source.slice(phase2Start, boundedMatch)
assert.match(
  phase2,
  /if \(result\.isTrial\)[\s\S]*?firstUrlLevel = level \+ '\+unblock'[\s\S]*?break/,
  'first unblock trial should stop further foreground quality probing',
)

const boundedSection = source.slice(boundedMatch, phase3)
assert.match(boundedSection, /if \(matched\?\.url\)/, 'fast matched full URL should still win over trial')
assert.match(boundedSection, /trialCandidates\.forEach/, 'trial URL should be promoted when bounded match is unavailable')

console.log('url resolver bounded match/trial regression test passed')
