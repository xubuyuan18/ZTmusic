const MINUTE = 60 * 1000

const CACHE_TTL = {
  '/song/url/v1': 0,
  '/song/url': 0,
  '/song/url/match': 0,
  '/vip/info': 0,
  '/vip/info/v2': 0,
  '/login/status': 0,
  // Lyrics previously used a 7-day persistent API cache. A transient empty
  // response could therefore keep the in-app player stuck on “暂无歌词” across
  // app restarts/upgrades even after the backend recovered. Lyrics have their
  // own higher-level successful-result cache, so keep the transport layer live.
  '/lyric': 0,
  '/lyric/new': 0,
  '/song/detail': 24 * 60 * MINUTE,
  '/playlist/detail': 30 * MINUTE,
  '/playlist/track/all': 30 * MINUTE,
  '/album': 6 * 60 * MINUTE,
  '/artist/detail': 12 * 60 * MINUTE,
  '/artist/songs': 2 * 60 * MINUTE,
  '/artist/album': 12 * 60 * MINUTE,
  '/banner': 30 * MINUTE,
  '/personalized': 30 * MINUTE,
  '/top/playlist': 30 * MINUTE,
  '/personalized/newsong': 30 * MINUTE,
  '/recommend/songs': 10 * MINUTE,
  '/album/newest': 2 * 60 * MINUTE,
  '/homepage/block/page': 20 * MINUTE,
  '/recommend/resource': 15 * MINUTE,
  '/user/playlist': 5 * MINUTE,
  '/user/record': 5 * MINUTE,
  '/user/subcount': 5 * MINUTE,
  '/toplist': 60 * MINUTE,
  '/toplist/detail': 30 * MINUTE,
  '/top/list': 30 * MINUTE,
  '/history/recommend/songs': 15 * MINUTE,
  '/history/recommend/songs/detail': 15 * MINUTE,
}

export function getApiCacheTtl(endpoint, method, options = {}) {
  if (method !== 'GET' || options.cache === false) return 0
  return options.cacheTtl ?? CACHE_TTL[endpoint] ?? 0
}
