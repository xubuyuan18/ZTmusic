/**
 * API 缓存策略自检
 * Run: node src/lib/api/cache-ttl.test.js
 */

import assert from 'node:assert/strict'
import { getApiCacheTtl, isCacheableResponse } from './cache-ttl.js'

let passed = 0
function check(name, fn) {
  try {
    fn()
    passed++
  } catch (err) {
    console.error(`FAIL ${name}: ${err.message}`)
    process.exitCode = 1
  }
}

check('GET 已配置的端点拿到 TTL', () => {
  assert.ok(getApiCacheTtl('/lyric', 'GET') > 0)
})

check('POST 不缓存', () => {
  assert.equal(getApiCacheTtl('/lyric', 'POST'), 0)
})

check('cache:false 不缓存', () => {
  assert.equal(getApiCacheTtl('/lyric', 'GET', { cache: false }), 0)
})

check('未配置的端点不缓存', () => {
  assert.equal(getApiCacheTtl('/not/configured', 'GET'), 0)
})

// 这条是本文件存在的理由：失败响应曾被当成成功结果缓存，
// /lyric 的 TTL 是 7 天，一次 502 会造成一周看不到歌词。
check('code 200 可缓存', () => {
  assert.equal(isCacheableResponse({ code: 200, lrc: { lyric: '[00:01.00]hi' } }), true)
})

check('非 JSON 兜底对象不可缓存', () => {
  assert.equal(isCacheableResponse({ code: -1, message: 'API response not JSON: 200' }), false)
})

check('HTTP 错误兜底对象不可缓存', () => {
  assert.equal(isCacheableResponse({ code: 502, message: 'API error: 502' }), false)
})

check('业务错误码不可缓存', () => {
  assert.equal(isCacheableResponse({ code: 400 }), false)
})

check('无 code 字段保持原行为（可缓存）', () => {
  assert.equal(isCacheableResponse({ data: [1, 2, 3] }), true)
  assert.equal(isCacheableResponse([1, 2, 3]), true)
})

check('null / 非对象不可缓存', () => {
  assert.equal(isCacheableResponse(null), false)
  assert.equal(isCacheableResponse(undefined), false)
  assert.equal(isCacheableResponse('oops'), false)
})

console.log(`cache-ttl: ${passed} passed${process.exitCode ? ', 有失败' : ', 0 failed'}`)
