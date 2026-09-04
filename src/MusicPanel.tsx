import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type {
  LyricsPayload,
  LyricLine,
  PlaybackProgress,
  QqLogin,
  QqSong,
  TrackMeta,
} from './types'

function currentLineIndex(lines: LyricLine[], pos: number): number {
  let lo = 0
  let hi = lines.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (lines[mid].time <= pos) {
      ans = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return ans
}

function fmt(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function SyncedLyrics({
  lines,
  positionSec,
  playing,
}: {
  lines: LyricLine[]
  positionSec: number
  playing: boolean
}) {
  const activeRef = useRef<HTMLParagraphElement>(null)
  // 歌词滚动容器：手动 scrollTo 居中（不用 scrollIntoView，见历史 bug）
  const lyricsBoxRef = useRef<HTMLDivElement>(null)

  // progress 事件 1~3Hz，本地 200ms 时钟平滑外推播放位置
  const posRef = useRef({ pos: positionSec, at: performance.now(), playing })
  posRef.current = { pos: positionSec, at: performance.now(), playing }

  const [activeIdx, setActiveIdx] = useState(() => currentLineIndex(lines, positionSec))
  const lastIdxRef = useRef(activeIdx)

  useEffect(() => {
    const { pos, at, playing: isPlaying } = posRef.current
    const idx = currentLineIndex(lines, pos + (isPlaying ? (performance.now() - at) / 1000 : 0))
    lastIdxRef.current = idx
    setActiveIdx(idx)
  }, [lines, positionSec, playing])

  useEffect(() => {
    const timer = setInterval(() => {
      const { pos, at, playing: isPlaying } = posRef.current
      const cur = pos + (isPlaying ? (performance.now() - at) / 1000 : 0)
      const idx = currentLineIndex(lines, cur)
      if (idx !== lastIdxRef.current) {
        lastIdxRef.current = idx
        setActiveIdx(idx)
      }
    }, 200)
    return () => clearInterval(timer)
  }, [lines])

  useEffect(() => {
    const box = lyricsBoxRef.current
    const el = activeRef.current
    if (!box || !el) return
    const target = el.offsetTop - box.clientHeight / 2 + el.clientHeight / 2
    box.scrollTo({ top: Math.max(0, target), behavior: 'smooth' })
  }, [activeIdx])

  return (
    <div className="music-lyrics" ref={lyricsBoxRef}>
      {lines.map((l, i) =>
        i === activeIdx ? (
          <p key={i} ref={activeRef} className="lyric-line active">
            {l.text || '···'}
          </p>
        ) : (
          <p key={i} className="lyric-line">
            {l.text || '···'}
          </p>
        ),
      )}
    </div>
  )
}

function LyricsView({
  lyrics,
  lyricsState,
  positionSec,
  playing,
}: {
  lyrics: LyricsPayload | null
  lyricsState: 'idle' | 'loading' | 'done'
  positionSec: number
  playing: boolean
}) {
  if (lyricsState === 'loading') {
    return <div className="music-hint">正在找歌词…</div>
  }
  if (!lyrics || !lyrics.found) {
    return (
      <div className="music-hint">
        {lyrics?.instrumental ? '纯音乐 · 请欣赏' : '未找到歌词'}
      </div>
    )
  }
  if (!lyrics.synced) {
    return <div className="music-plain">{lyrics.plain}</div>
  }
  return (
    <SyncedLyrics
      lines={lyrics.lines}
      positionSec={positionSec}
      playing={playing}
    />
  )
}

export default function MusicPanel({
  meta,
  progress,
  lyrics,
  lyricsState,
  audioRef,
}: {
  meta: TrackMeta | null
  progress: PlaybackProgress | null
  lyrics: LyricsPayload | null
  lyricsState: 'idle' | 'loading' | 'done'
  audioRef: React.RefObject<HTMLAudioElement | null>
}) {
  const [results, setResults] = useState<QqSong[]>([])
  const [searching, setSearching] = useState(false)
  const [current, setCurrent] = useState<QqSong | null>(null)
  const [playLyrics, setPlayLyrics] = useState<LyricsPayload | null>(null)
  const [playLyricsState, setPlayLyricsState] = useState<'idle' | 'loading' | 'done'>('idle')
  const [audioPos, setAudioPos] = useState(0)
  const [audioPlaying, setAudioPlaying] = useState(false)
  const [error, setError] = useState('')
  const playMode = current !== null
  // 非受控搜索框：UIA 自动化（AXSetValue）写入的值也能被读取
  const searchRef = useRef<HTMLInputElement>(null)
  // QQ 音乐账号（官方网页登录，自动提取凭证）
  const [login, setLogin] = useState<QqLogin | null>(null)
  const [loginBusy, setLoginBusy] = useState(false)
  const [qrImg, setQrImg] = useState('')
  const [qrStatus, setQrStatus] = useState('')

  useEffect(() => {
    invoke<QqLogin | null>('qq_login_status')
      .then(setLogin)
      .catch(() => {})
    const un = listen<QqLogin>('qq-login-ok', (e) => {
      setLogin(e.payload)
      setQrImg('')
      setQrStatus('')
      setError('')
    })
    return () => {
      un.then((f) => f())
    }
  }, [])

  async function openLogin() {
    setLoginBusy(true)
    setError('')
    try {
      const img = await invoke<string>('qq_login_qr_start')
      setQrImg(img)
      setQrStatus('请用手机 QQ 扫描二维码')
    } catch (e) {
      setError(String(e))
    } finally {
      setLoginBusy(false)
    }
  }

  // 二维码就绪后轮询扫码状态
  useEffect(() => {
    if (!qrImg) return
    const timer = setInterval(async () => {
      try {
        const r = await invoke<{ status: string; uin?: string }>('qq_login_qr_check')
        if (r.status === 'scanned') setQrStatus('已扫码，请在手机上确认')
        else if (r.status === 'ok') {
          const l = await invoke<QqLogin | null>('qq_login_status')
          setLogin(l)
          setQrImg('')
          setQrStatus('')
          setError('')
        } else if (r.status === 'expired') {
          setQrStatus('二维码已过期，请重新点击登录')
          setQrImg('')
        }
      } catch {
        /* 静默重试 */
      }
    }, 1500)
    return () => clearInterval(timer)
  }, [qrImg])

  async function logout() {
    await invoke('qq_logout').catch(() => {})
    setLogin(null)
  }

  async function doSearch() {
    const q = (searchRef.current?.value ?? '').trim()
    if (!q) return
    setSearching(true)
    try {
      const r = await invoke<QqSong[]>('qq_search_songs', { keyword: q })
      setResults(r)
      if (r.length === 0) setError('没搜到相关歌曲')
    } catch (e) {
      setError(String(e))
    } finally {
      setSearching(false)
    }
  }

  async function playSong(song: QqSong) {
    setError('')
    try {
      const url = await invoke<string>('qq_song_url', { songmid: song.songmid })
      const a = audioRef.current
      if (!a) return
      a.src = url
      await a.play()
      setCurrent(song)
      setPlayLyrics(null)
      setPlayLyricsState('loading')
      const payload = await invoke<LyricsPayload>('fetch_lyrics', {
        title: song.name,
        artist: song.singer,
      })
      setPlayLyrics(payload)
      setPlayLyricsState('done')
      if (payload.found && payload.synced) {
        invoke('set_lyric_lines', { lines: payload.lines }).catch(() => {})
      } else {
        invoke('set_lyric_lines', { lines: [] }).catch(() => {})
      }
    } catch (e) {
      setError(String(e))
    }
  }

  function togglePlay() {
    const a = audioRef.current
    if (!a) return
    if (a.paused) a.play().catch(() => {})
    else a.pause()
  }

  // audio 元素状态 → 200ms tick 同步到 React
  useEffect(() => {
    const timer = setInterval(() => {
      const a = audioRef.current
      if (!a) return
      setAudioPos(a.currentTime)
      setAudioPlaying(!a.paused && !a.ended)
    }, 200)
    return () => clearInterval(timer)
  }, [audioRef])

  // 双模式数据源：Kairos 自播 → audio.currentTime（毫秒级）；
  // 未自播 → QQ 客户端监听（SMTC + 秒表 + OCR 对齐）
  const displayLyrics = playMode ? playLyrics : lyrics
  const displayState = playMode ? playLyricsState : lyricsState
  const displayPos = playMode ? audioPos : (progress?.positionSec ?? 0)
  const displayPlaying = playMode ? audioPlaying : (progress?.playing ?? false)
  const displayName = playMode ? current!.name : (meta?.title ?? '')
  const displayArtist = playMode ? current!.singer : (meta?.artist ?? '')
  const displayCover = playMode
    ? current!.albumMid
      ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${current!.albumMid}.jpg`
      : ''
    : (meta?.coverBase64 ?? '')

  return (
    <div className="music-panel">
      <form
        className="music-search"
        onSubmit={(e) => {
          e.preventDefault()
          doSearch()
        }}
      >
        <input
          ref={searchRef}
          defaultValue=""
          placeholder="搜索 QQ 音乐曲库…"
        />
        <button type="submit">{searching ? '…' : '搜'}</button>
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
        {login ? (
          <>
            <span className="account-badge">已登录 · {login.uin}</span>
            <button className="account-link" onClick={logout}>
              退出
            </button>
          </>
        ) : (
          <button className="account-link login-cta" onClick={openLogin} disabled={loginBusy}>
            {loginBusy ? '打开中…' : '登录 QQ 音乐'}
          </button>
        )}
      </div>

      {playMode && current ? (
        <>
          <div className="music-hero">
            <div className="music-cover">
              {displayCover ? (
                <img src={displayCover} alt="" />
              ) : (
                <div className="music-cover-fallback">♪</div>
              )}
            </div>
            <div className="music-info">
              <p className="music-title" title={displayName}>
                {displayName}
              </p>
              <p className="music-artist" title={displayArtist}>
                {displayArtist}
              </p>
            </div>
            <div className="music-transport">
              <button
                onClick={() => {
                  audioRef.current?.play().catch(() => {})
                }}
                title="播放"
              >
                ▶
              </button>
              <button onClick={togglePlay} title="暂停/继续" className="transport-main">
                {audioPlaying ? '❚❚' : '▶'}
              </button>
              <button
                onClick={() => {
                  audioRef.current?.pause()
                }}
                title="停止"
              >
                ■
              </button>
              <span className="music-time">{fmt(audioPos)}</span>
            </div>
          </div>
          <LyricsView
            lyrics={displayLyrics}
            lyricsState={displayState}
            positionSec={displayPos}
            playing={displayPlaying}
          />
        </>
      ) : results.length > 0 ? (
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
        <>
          {!meta ? (
            <div className="music-panel music-empty">
              <div className="music-empty-icon">♪</div>
              <p>搜索一首歌直接在这里播放</p>
              <p className="music-empty-sub">歌词毫秒级同步 · 或打开 QQ 音乐自动跟随</p>
            </div>
          ) : (
            <>
              <div className="music-hero">
                <div className="music-cover">
                  {displayCover ? (
                    <img src={displayCover} alt="" />
                  ) : (
                    <div className="music-cover-fallback">♪</div>
                  )}
                </div>
                <div className="music-info">
                  <p className="music-title" title={displayName}>
                    {displayName}
                  </p>
                  <p className="music-artist" title={displayArtist}>
                    {displayArtist}
                  </p>
                </div>
              </div>
              <LyricsView
                lyrics={displayLyrics}
                lyricsState={displayState}
                positionSec={displayPos}
                playing={displayPlaying}
              />
            </>
          )}
        </>
      )}

      {qrImg ? (
        <div className="login-box">
          <img className="login-qr" src={`data:image/png;base64,${qrImg}`} alt="QQ 登录二维码" />
          <p className="login-status">{qrStatus}</p>
        </div>
      ) : null}

      {error && <p className="music-error">{error}</p>}
    </div>
  )
}
