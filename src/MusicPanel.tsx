import { useEffect, useState } from 'react'
import { invoke } from './lib/tauri'
import type { QqSong } from './types'

/**
 * 音乐模块（Electron 重写框架）
 *
 * 已就绪：搜索 → QQ 音乐公开接口 → 点选播放（audio 由 App 全局持有，切模块不打断）
 * 预留扩展点（后端 IPC 已留桩）：
 *  - 多平台 provider（网易云/汽水）
 *  - 登录体系（qq_save_login / qq_login_status / qq_login_qr_*）
 *  - 歌词视图（fetch_lyrics 后端已可用）
 *  - 系统播放跟随（kairos:event:* 事件通道已就绪）
 */

interface Props {
  audioRef: React.RefObject<HTMLAudioElement | null>
  // 预留：SMTC 系统播放跟随接入后启用
  meta?: unknown
  progress?: unknown
  lyrics?: unknown
  lyricsState?: unknown
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

export default function MusicPanel({ audioRef }: Props) {
  const [keyword, setKeyword] = useState('')
  const [results, setResults] = useState<QqSong[]>([])
  const [searching, setSearching] = useState(false)
  const [current, setCurrent] = useState<QqSong | null>(null)
  const [playing, setPlaying] = useState(false)
  const [pos, setPos] = useState(0)
  const [error, setError] = useState('')

  const search = async () => {
    const kw = keyword.trim()
    if (!kw || searching) return
    setSearching(true)
    setError('')
    try {
      const songs = await invoke<QqSong[]>('qq_search_songs', { keyword: kw })
      setResults(songs)
      if (!songs.length) setError('没有找到相关歌曲')
    } catch (e) {
      setError(String(e))
    } finally {
      setSearching(false)
    }
  }

  const playSong = async (song: QqSong) => {
    setError('')
    try {
      const url = await invoke<string>('qq_song_url', { songmid: song.songmid })
      const audio = audioRef.current
      if (!audio) return
      audio.src = url
      await audio.play()
      setCurrent(song)
      setPlaying(true)
    } catch (e) {
      setError(String(e))
    }
  }

  const togglePlay = () => {
    const audio = audioRef.current
    if (!audio || !current) return
    if (audio.paused) {
      audio.play().catch(() => {})
      setPlaying(true)
    } else {
      audio.pause()
      setPlaying(false)
    }
  }

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    const onTime = () => setPos(audio.currentTime)
    const onEnd = () => setPlaying(false)
    audio.addEventListener('timeupdate', onTime)
    audio.addEventListener('ended', onEnd)
    return () => {
      audio.removeEventListener('timeupdate', onTime)
      audio.removeEventListener('ended', onEnd)
    }
  }, [audioRef])

  return (
    <div className="music-panel">
      <form
        className="music-search"
        onSubmit={(e) => {
          e.preventDefault()
          search()
        }}
      >
        <input
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="搜索 QQ 音乐曲库…"
          aria-label="搜索 QQ 音乐曲库"
        />
        <button type="submit" disabled={searching}>
          {searching ? '…' : '搜'}
        </button>
      </form>

      <div className="music-providers">
        <button className="provider active">QQ音乐</button>
        <button className="provider disabled" title="即将接入">
          网易云
        </button>
        <button className="provider disabled" title="即将接入">
          汽水
        </button>
        <span className="provider-spacer" />
      </div>

      {error && <p className="music-error">{error}</p>}

      {results.length > 0 ? (
        <div className="music-results">
          {results.map((song) => (
            <button key={song.songmid} className="music-result" onClick={() => playSong(song)}>
              <span className="result-name" title={song.name}>
                {song.name}
              </span>
              <span className="result-singer" title={song.singer}>
                {song.singer}
              </span>
              <span className="result-duration">{fmt(song.durationSec)}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="music-panel music-empty">
          <div className="music-empty-icon">♪</div>
          <p className="music-empty-main">{current ? current.name : '搜索一首歌直接在这里播放'}</p>
          <p className="music-empty-sub">框架版 · 歌词/登录/系统播放跟随为预留扩展点</p>
        </div>
      )}

      {current && (
        <div className="music-hero">
          <div className="music-info">
            <p className="music-title" title={current.name}>
              {current.name}
            </p>
            <p className="music-artist">{current.singer}</p>
          </div>
          <div className="music-transport">
            <button onClick={togglePlay} title="暂停/继续" className="transport-main">
              {playing ? '⏸' : '▶'}
            </button>
          </div>
          <span className="music-time">{fmt(pos)}</span>
        </div>
      )}
    </div>
  )
}
