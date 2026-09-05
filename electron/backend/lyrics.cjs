// 歌词后端：两级来源（QQ 音乐同步 LRC → LRCLIB 兜底），带内存缓存
// 与原 lyrics.rs 一一对应

const QQ_SEARCH = 'https://c.y.qq.com/soso/fcgi-bin/client_search_cp'
const QQ_LYRIC = 'https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg'
const LRCLIB_API = 'https://lrclib.net/api/search'

const CLIENT = { headers: { 'User-Agent': 'Kairos/0.2 (electron)' } }
const cache = new Map()

// 供 OCR 对齐等场景回写歌词行（框架预留）
let lyricLines = []
function setLyricLines(lines) {
  lyricLines = lines
}

function parseTimeTag(tag) {
  const [m, s] = tag.split(':')
  const mm = parseFloat(m)
  const ss = parseFloat(s)
  if (Number.isNaN(mm) || Number.isNaN(ss)) return null
  return mm * 60 + ss
}

// 解析 LRC：支持一行多个时间戳；忽略 [ti:]/[ar:] 等元数据标签
function parseLrc(raw) {
  const out = []
  for (const line of raw.split('\n')) {
    let rest = line.trimStart()
    const times = []
    while (rest.startsWith('[')) {
      const end = rest.indexOf(']')
      if (end === -1) break
      const t = parseTimeTag(rest.slice(1, end))
      if (t == null) break
      times.push(t)
      rest = rest.slice(end + 1)
    }
    if (!times.length) continue
    const text = rest.trim()
    for (const time of times) out.push({ time, text })
  }
  out.sort((a, b) => a.time - b.time)
  return out
}

function b64ToText(b64) {
  return Buffer.from(b64, 'base64').toString('utf8')
}

async function getJson(url, params, timeoutMs = 8000) {
  const qs = new URLSearchParams(params)
  const resp = await fetch(`${url}?${qs}`, {
    headers: { ...CLIENT.headers, Referer: 'https://c.y.qq.com/' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  return resp.json()
}

// QQ 音乐：搜索关键词拿前几个 songmid，逐个取 LRC
async function queryQqMusic(title, artist) {
  const query = `${title} ${artist}`
  let resp
  try {
    resp = await getJson(QQ_SEARCH, { w: query, format: 'json', n: '3' }, 8000)
  } catch {
    return null
  }
  const songs = resp?.data?.song?.list
  if (!Array.isArray(songs)) return null

  const titleLc = title.toLowerCase()
  const candidates = songs
    .map((s) => ({ mid: s.songmid, name: s.songname }))
    .filter((s) => s.mid && s.name)
  // 相关性搜索可能错配：候选全都不含目标歌名关键词则弃用
  const topMatch =
    candidates.length > 0 &&
    (() => {
      const n = candidates[0].name.toLowerCase()
      return n.includes(titleLc) || titleLc.includes(n)
    })()
  if (!topMatch) return null

  for (const { mid } of candidates) {
    try {
      const json = await getJson(
        QQ_LYRIC,
        { songmid: mid, g_tk: '5381', format: 'json', nobase64: '0' },
        8000,
      )
      if (!json?.lyric) continue
      const lines = parseLrc(b64ToText(json.lyric))
      if (lines.length) return lines
    } catch {
      // 尝试下一个候选
    }
  }
  return null
}

async function queryLrclib(title, artist) {
  try {
    const qs = new URLSearchParams({ track_name: title, artist_name: artist })
    const resp = await fetch(`${LRCLIB_API}?${qs}`, {
      ...CLIENT,
      signal: AbortSignal.timeout(8000),
    })
    if (!resp.ok) return []
    return await resp.json()
  } catch {
    return []
  }
}

async function fetchLyrics(title, artist) {
  const key = `${artist}|${title}`
  const hit = cache.get(key)
  if (hit) return hit

  // 1. QQ 音乐同步 LRC
  const qqLines = await queryQqMusic(title, artist)
  if (qqLines && qqLines.length) {
    const payload = { found: true, synced: true, instrumental: false, plain: null, lines: qqLines }
    cache.set(key, payload)
    return payload
  }

  // 2. LRCLIB 兜底
  const hits = await queryLrclib(title, artist)
  const synced = hits.find((h) => h.synced_lyrics && h.synced_lyrics.trim())
  if (synced) {
    const payload = {
      found: true,
      synced: true,
      instrumental: false,
      plain: null,
      lines: parseLrc(synced.synced_lyrics),
    }
    cache.set(key, payload)
    return payload
  }
  const plain = hits.find((h) => !h.instrumental && h.plain_lyrics && h.plain_lyrics.trim())
  if (plain) {
    const payload = {
      found: true,
      synced: false,
      instrumental: false,
      plain: plain.plain_lyrics,
      lines: [],
    }
    cache.set(key, payload)
    return payload
  }
  const payload = { found: false, synced: false, instrumental: hits.some((h) => h.instrumental), plain: null, lines: [] }
  cache.set(key, payload)
  return payload
}

module.exports = { fetchLyrics, setLyricLines }
