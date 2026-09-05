import { useEffect, useRef, useState } from 'react'
import { invoke, inTauri, listen } from './lib/tauri'
import type { LyricsPayload, PlaybackProgress, TrackMeta } from './types'

// 事件桥可用（Electron 环境）；纯浏览器预览时为 false
export { inTauri }

export function useNowPlaying() {
  const [meta, setMeta] = useState<TrackMeta | null>(null)
  const [progress, setProgress] = useState<PlaybackProgress | null>(null)
  const [lyrics, setLyrics] = useState<LyricsPayload | null>(null)
  const [lyricsState, setLyricsState] = useState<'idle' | 'loading' | 'done'>('idle')
  const songKeyRef = useRef('')
  const metaRef = useRef<TrackMeta | null>(null)
  // 校准单调保护：同首歌播放中，位置不应明显回跳
  const expectRef = useRef({ pos: 0, at: 0, playing: false })

  useEffect(() => {
    if (!inTauri) return

    const unlistenMeta = listen<TrackMeta>('now-playing', (e) => {
      metaRef.current = e.payload
      expectRef.current = { pos: 0, at: performance.now(), playing: e.payload.playing }
      setMeta(e.payload)
    })
    const unlistenProgress = listen<PlaybackProgress>('playback-progress', (e) => {
      const p = e.payload
      // 切歌瞬间：旧歌的进度事件对新歌歌词无意义，丢弃
      const cur = metaRef.current
      if (cur && p.title !== cur.title) return
      // 播放中回跳超过 0.6s：视为源切换抖动，丢弃本次校准
      const exp = expectRef.current
      const expected = exp.playing ? exp.pos + (performance.now() - exp.at) / 1000 : exp.pos
      if (p.playing && p.positionSec < expected - 0.6) return
      expectRef.current = { pos: p.positionSec, at: performance.now(), playing: p.playing }
      setProgress(p)
    })
    const unlistenStopped = listen('now-playing-stopped', () => {
      metaRef.current = null
      expectRef.current = { pos: 0, at: 0, playing: false }
      setMeta(null)
      setProgress(null)
    })

    return () => {
      unlistenMeta.then((f) => f())
      unlistenProgress.then((f) => f())
      unlistenStopped.then((f) => f())
    }
  }, [])

  // 歌名/歌手变化时拉取歌词
  useEffect(() => {
    if (!meta || !inTauri) return
    const key = `${meta.artist}|${meta.title}`
    if (key === songKeyRef.current) return
    songKeyRef.current = key
    setLyrics(null)
    setLyricsState('loading')
    invoke<LyricsPayload>('fetch_lyrics', { title: meta.title, artist: meta.artist })
      .then((payload) => {
        setLyrics(payload)
        // 同步给 Rust 端，供 OCR 自动对齐匹配
        if (payload.found && payload.synced) {
          invoke('set_lyric_lines', { lines: payload.lines }).catch(() => {})
        } else {
          invoke('set_lyric_lines', { lines: [] }).catch(() => {})
        }
      })
      .catch(() => setLyrics(null))
      .finally(() => setLyricsState('done'))
  }, [meta])

  return { meta, progress, lyrics, lyricsState }
}
