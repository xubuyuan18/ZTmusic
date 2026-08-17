import { coverUrl } from '../utils/image.js'

const SONG_DETAIL_BATCH_SIZE = 500
const INITIAL_PLAYLIST_DETAIL_LIMIT = 500

async function loadSongsByIds(ncm, ids) {
  const uniqueIds = [...new Set(ids.filter(Boolean))]
  if (!uniqueIds.length) return []
  const chunks = []
  for (let index = 0; index < uniqueIds.length; index += SONG_DETAIL_BATCH_SIZE) {
    chunks.push(uniqueIds.slice(index, index + SONG_DETAIL_BATCH_SIZE))
  }
  const results = await Promise.all(chunks.map(chunk => ncm.songDetail(chunk).catch(() => ({ songs: [] }))))
  const songMap = new Map(results.flatMap(result => result?.songs || []).map(song => [song.id, song]))
  return uniqueIds.map(id => songMap.get(id)).filter(Boolean)
}

export async function loadPlaylistDetail(ncm, extractColor, id, onProgress) {
  const response = await ncm.playlistDetail(id)
  const detail = response?.playlist || null
  if (detail?.trackIds?.length) {
    const fallbackMap = new Map((detail.tracks || []).map(track => [track.id, track]))
    const shouldDeferFullLoad = detail.trackIds.length > INITIAL_PLAYLIST_DETAIL_LIMIT
    const idsToLoad = shouldDeferFullLoad
      ? detail.trackIds.slice(0, INITIAL_PLAYLIST_DETAIL_LIMIT).map(track => track.id)
      : detail.trackIds.map(track => track.id)

    async function buildTracks(songMap) {
      return detail.trackIds.map((track, index) => {
        const detailTrack = songMap.get(track.id) || fallbackMap.get(track.id) || (shouldDeferFullLoad ? { id: track.id, name: `歌曲 ${track.id}`, ar: [], al: {}, dt: 0 } : null)
        if (!detailTrack) return null
        return {
          ...detailTrack,
          addTime: track.at || track.addTime || track.time || detailTrack.addTime || 0,
          playlistIndex: index,
        }
      }).filter(Boolean)
    }

    const firstBatch = idsToLoad.slice(0, 10)
    const [firstSongs, heroColor] = await Promise.all([
      firstBatch.length ? loadSongsByIds(ncm, firstBatch) : Promise.resolve([]),
      extractHeroColor(extractColor, detail?.coverImgUrl),
    ])
    const songMap = new Map(firstSongs.map(song => [song.id, song]))
    let tracks = await buildTracks(songMap)
    if (tracks.length) detail.tracks = tracks
    if (onProgress) onProgress({ detail, heroColor })

    const remainingIds = idsToLoad.slice(10)
    for (let i = 0; i < remainingIds.length; i += 50) {
      const batch = remainingIds.slice(i, i + 50)
      if (!batch.length) continue
      const songs = await loadSongsByIds(ncm, batch)
      for (const song of songs) songMap.set(song.id, song)
      tracks = await buildTracks(songMap)
      if (tracks.length) detail.tracks = tracks
      if (onProgress) onProgress({ detail, heroColor })
    }

    detail.tracksPartial = shouldDeferFullLoad
    return { detail, heroColor }
  }
  const heroColor = await extractHeroColor(extractColor, detail?.coverImgUrl)
  return { detail, heroColor }
}

export async function loadAlbumDetail(ncm, extractColor, id) {
  const response = await ncm.album(id)
  const album = response?.album || {}
  const songs = response?.songs || album?.songs || []
  const artistName = album.artist?.name || album.artists?.map(artist => artist.name).join(' / ') || ''
  const detail = {
    id: album.id || id,
    name: album.name || '未知专辑',
    coverImgUrl: album.picUrl,
    picUrl: album.picUrl,
    creator: { nickname: artistName },
    trackCount: album.size || songs.length,
    description: album.description || album.alias?.join(' / ') || '',
    tracks: songs,
  }
  const heroColor = await extractHeroColor(extractColor, detail.coverImgUrl)
  return { detail, heroColor }
}

export async function loadArtistDetail(ncm, id) {
  try {
    const [detailRes, songsRes, albumsRes] = await Promise.all([
      ncm.artistDetail(id).catch(() => null),
      ncm.artistSongs(id, 50).catch(() => ({ songs: [] })),
      ncm.artistAlbums(id, 30).catch(() => ({ hotAlbums: [] })),
    ])
    const baseArtist = detailRes?.data?.artist || detailRes?.artist || albumsRes?.artist || {}
    const artist = {
      id: baseArtist.id || id,
      name: baseArtist.name || '未知歌手',
      cover: baseArtist.cover || baseArtist.picUrl || '',
      avatar: baseArtist.avatar || baseArtist.img1v1Url || baseArtist.picUrl || '',
      picUrl: baseArtist.picUrl || baseArtist.cover || baseArtist.avatar || '',
      alias: baseArtist.alias || baseArtist.transNames || [],
      identities: baseArtist.identities || detailRes?.data?.identify?.imageDesc?.split('、') || [],
      briefDesc: baseArtist.briefDesc || '',
      musicSize: baseArtist.musicSize || 0,
      albumSize: baseArtist.albumSize || 0,
      followed: Boolean(baseArtist.followed || detailRes?.data?.user?.followed),
    }
    const songs = (songsRes?.songs || songsRes?.data?.songs || []).map(song => ({
      ...song,
      picUrl: song.picUrl || song.al?.picUrl || song.album?.picUrl || '',
    }))
    const albums = albumsRes?.hotAlbums || albumsRes?.albums || []
    return { artist, songs, albums }
  } catch {
    return { artist: null, songs: [], albums: [] }
  }
}

async function extractHeroColor(extractColor, imageUrl) {
  if (!imageUrl) return '#141414'
  try {
    const color = await extractColor(coverUrl(imageUrl, 100))
    return color || '#141414'
  } catch {
    return '#141414'
  }
}