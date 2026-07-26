/**
 * API cache policy self-check.
 * Run: node src/lib/api/cache-policy.test.js
 */

import { getApiCacheTtl } from './cache-policy.js'

let passed = 0
let failed = 0

function assertEqual(actual, expected, message) {
  if (actual === expected) {
    passed++
  } else {
    console.error(`FAIL: ${message} - expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    failed++
  }
}

assertEqual(getApiCacheTtl('/song/url/v1', 'GET'), 0, 'does not cache song URL v1')
assertEqual(getApiCacheTtl('/song/url/match', 'GET'), 0, 'does not cache matched song URLs in API cache')
assertEqual(getApiCacheTtl('/vip/info', 'GET'), 0, 'does not cache VIP info')
assertEqual(getApiCacheTtl('/vip/info/v2', 'GET'), 0, 'does not cache VIP info v2')
assertEqual(getApiCacheTtl('/login/status', 'GET'), 0, 'does not cache login status')
assertEqual(getApiCacheTtl('/playlist/track/all', 'GET'), 30 * 60 * 1000, 'keeps playlist tracks cache TTL')
assertEqual(getApiCacheTtl('/playlist/track/all', 'POST'), 0, 'does not cache non-GET requests')
assertEqual(getApiCacheTtl('/playlist/track/all', 'GET', { cache: false }), 0, 'respects explicit cache=false')
assertEqual(getApiCacheTtl('/playlist/track/all', 'GET', { cacheTtl: 1234 }), 1234, 'respects a custom cache TTL')
assertEqual(getApiCacheTtl('/playlist/track/all', 'GET', { cacheTtl: 0 }), 0, 'allows a custom TTL to disable caching')
assertEqual(getApiCacheTtl('/unknown', 'GET'), 0, 'unknown endpoints are uncached')

console.log(`\n${passed} passed, ${failed} failed${failed ? ' - FAIL' : ' - all good'}`)
process.exit(failed ? 1 : 0)
