import { normalizeLocalHistorySong, normalizePlaylist } from '../utils/normalize.js'
import { formatPlayCount } from '../format.js'
import { handleErrorWithToast } from '../utils/error.js'
import { toast } from '../stores/toast.svelte.js'

function settledValue(result, fallback = null) {
  return result.status === 'fulfilled' ? result.value : fallback
}

function withPlayCountText(playlist) {
  if (!playlist) return null
  return { ...playlist, playCountText: playlist.playCount ? `${formatPlayCount(playlist.playCount)} 次播放` : '歌单' }
}

export async function loadLibraryData(ncm, user) {
  const uid = user?.userId || user?.id
  if (!uid) return []
  try {
    const plRes = await ncm.userPlaylist(uid).catch(() => ({ playlist: [] }))
    const allPlaylists = (plRes.playlist || []).slice(0, 100)
    return allPlaylists.filter(playlist => playlist.creator?.userId !== uid && playlist.specialType !== 5).map(normalizePlaylist).filter(Boolean)
  } catch {
    return []
  }
}

export async function loadMobileLibraryData(ncm, user, options = {}) {
  const uid = user?.userId || user?.id
  if (!uid) return { profile: null, stats: [], createdPlaylists: [], savedPlaylists: [], likedPlaylist: null }

  const [playlistResult, detailResult, subcountResult, likedResult, levelResult] = await Promise.allSettled([
    ncm.userPlaylist(uid, options),
    ncm.userDetail(uid),
    ncm.userSubcount(),
    ncm.likelist(uid),
    ncm.userLevel?.(),
  ])

  const playlists = (settledValue(playlistResult, {})?.playlist || []).slice(0, 100)
  const normalizedPlaylists = playlists.map(normalizePlaylist).filter(Boolean).map(withPlayCountText)
  const savedPlaylists = playlists
    .filter(playlist => playlist.creator?.userId !== uid && playlist.specialType !== 5)
    .map(normalizePlaylist)
    .filter(Boolean)
    .map(withPlayCountText)
  const createdPlaylists = playlists
    .filter(playlist => playlist.creator?.userId === uid && playlist.specialType !== 5)
    .map(normalizePlaylist)
    .filter(Boolean)
    .map(withPlayCountText)
  const likedPlaylist = withPlayCountText(normalizePlaylist(playlists.find(playlist => playlist.creator?.userId === uid && playlist.specialType === 5)))

  const detail = settledValue(detailResult, {}) || {}
  const detailData = detail.data || detail
  const profile = detailData.profile || detail.profile || user
  const subcount = settledValue(subcountResult, {})?.data || settledValue(subcountResult, {}) || {}
  const likedIds = settledValue(likedResult, {})?.ids || settledValue(likedResult, {})?.data?.ids || []
  const levelData = settledValue(levelResult, {})?.data || settledValue(levelResult, {}) || {}

  return {
    profile: {
      nickname: profile?.nickname || user?.nickname || '用户',
      avatarUrl: profile?.avatarUrl || user?.avatarUrl || '',
      level: levelData.level || detailData.level || profile?.level || 0,
      listenSongs: detailData.listenSongs || profile?.listenSongs || levelData.nowPlayCount || 0,
    },
    stats: [
      { label: '听歌', value: formatPlayCount(detailData.listenSongs || profile?.listenSongs || levelData.nowPlayCount || 0) || '0' },
      { label: '喜欢', value: formatPlayCount(likedIds.length || likedPlaylist?.trackCount || 0) || '0' },
      { label: '歌单', value: formatPlayCount(subcount.createdPlaylistCount + subcount.subPlaylistCount || normalizedPlaylists.length) || '0' },
      { label: '关注', value: formatPlayCount(subcount.artistCount || subcount.followCount || 0) || '0' },
    ],
    createdPlaylists,
    savedPlaylists,
    likedPlaylist,
  }
}

export async function loadHomeData(ncm, user) {
  const uid = user?.userId || user?.id
  if (!uid) {
    return {
      userPlaylists: [],
      likedPlaylist: null,
      weeklyPlaylist: null,
      recentTracks: [],
      recommendPlaylists: [],
      subcountPromise: null,
      weeklyPromise: null,
      recommendPromise: null,
    }
  }

  const plRes = await ncm.userPlaylist(uid).catch((err) => {
    handleErrorWithToast('歌单加载失败', err, toast)
    return { playlist: [] }
  })
  const allPlaylists = (plRes.playlist || []).slice(0, 50)
  const userPlaylists = allPlaylists.filter(playlist => playlist.creator?.userId !== uid && playlist.specialType !== 5).map(normalizePlaylist).filter(Boolean)

  const liked = allPlaylists.find(playlist => playlist.creator?.userId === uid && playlist.specialType === 5)
  const likedPlaylist = normalizePlaylist(liked)

  const initialWeeklyPlaylist = {
    id: 0,
    name: '听歌排行',
    picUrl: user?.avatarUrl || '',
    trackCount: 0,
    playCount: 0,
    topSongName: '',
  }

  const subcountPromise = ncm.userSubcount()
    .then(subRes => subRes?.data || subRes)
    .catch(() => null)

  const weeklyPromise = ncm.userRecordWeek(uid)
    .then(weeklyRecordRes => {
      const weeklyList = weeklyRecordRes?.weekData || weeklyRecordRes?.data?.weekData || weeklyRecordRes?.data?.list || weeklyRecordRes?.list || []
      const weeklyTracks = Array.isArray(weeklyList)
        ? weeklyList.map(normalizeRecordSong).filter(Boolean)
        : []
      const topSong = weeklyTracks[0] || null
      return {
        weeklyPlaylist: {
          id: 0,
          name: '听歌排行',
          picUrl: topSong?.picUrl || user?.avatarUrl || '',
          trackCount: weeklyTracks.length,
          playCount: topSong?.playCount || 0,
          topSongName: topSong?.name || '',
        },
        recentTracks: weeklyTracks,
      }
    })
    .catch(() => ({ weeklyPlaylist: initialWeeklyPlaylist, recentTracks: [] }))

  const recommendPromise = ncm.recommendResource()
    .then(recommendRes => {
      const recList = recommendRes?.recommend || recommendRes?.playlists || []
      return (Array.isArray(recList) ? recList : []).slice(0, 6).map(normalizePlaylist).filter(Boolean)
    })
    .catch(() => [])

  return {
    userPlaylists,
    likedPlaylist,
    weeklyPlaylist: initialWeeklyPlaylist,
    recentTracks: [],
    recommendPlaylists: [],
    subcountPromise,
    weeklyPromise,
    recommendPromise,
  }
}

export async function loadRecentData(ncm, user, getLocalHistory) {
  const uid = user?.userId || user?.id
  let recentTracks = []
  if (uid) {
    try {
      const res = await ncm.userRecord(uid, 1)
      const list = res?.weekData || res?.data?.weekData || res?.data?.list || res?.list || []
      recentTracks = Array.isArray(list)
        ? list.map(normalizeRecordSong).filter(Boolean)
        : []
    } catch {
      recentTracks = []
    }
  }
  if (recentTracks.length === 0) {
    recentTracks = getLocalHistory().map(normalizeLocalHistorySong)
  }
  return recentTracks
}

export async function loadToplistsData(ncm) {
  try {
    const res = await ncm.toplist()
    return res?.list || res?.data?.list || []
  } catch {
    return []
  }
}
