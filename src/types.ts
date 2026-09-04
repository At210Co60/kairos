export interface TrackMeta {
  title: string
  artist: string
  album: string
  playing: boolean
  coverBase64: string | null
}

export interface QqSong {
  songmid: string
  name: string
  singer: string
  albumMid: string
  durationSec: number
}

export interface QqLogin {
  uin: string
  musicKey: string
}

export interface PlaybackProgress {
  title: string
  artist: string
  playing: boolean
  positionSec: number
  durationSec: number
}

export interface LyricLine {
  time: number
  text: string
}

export interface LyricsPayload {
  found: boolean
  synced: boolean
  instrumental: boolean
  plain: string | null
  lines: LyricLine[]
}
