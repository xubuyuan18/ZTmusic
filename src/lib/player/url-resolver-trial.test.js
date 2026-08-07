import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('./url-resolver.js', import.meta.url), 'utf8')
const phase2Start = source.indexOf('// Phase 2: unblock')
const promotion = source.indexOf('// Phase 2.5: unblock')
const phase3 = source.indexOf('// Phase 3: 官方 match')

assert.ok(phase2Start >= 0, 'unblock phase should exist')
assert.ok(promotion > phase2Start, 'trial promotion should happen after unblock lookup')
assert.ok(phase3 > promotion, 'trial URL should be promoted before match/old fallbacks')

const phase2 = source.slice(phase2Start, promotion)
assert.match(
  phase2,
  /if \(result\.isTrial\)[\s\S]*?firstUrlLevel = level \+ '\+unblock'[\s\S]*?break/,
  'first unblock trial should stop further foreground URL probing',
)

console.log('url resolver immediate trial fallback regression test passed')
