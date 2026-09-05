// 音乐模块后端（Electron 重写框架）
// 已就绪：搜索、播放地址（vkey，免登录可播免费歌曲）、登录凭证文件化存取
// 预留扩展点：扫码登录（ptlogin2 流程）、歌词、SMTC 系统播放跟随
//
// 搜索/播放接口参考社区通用实现：c.y.qq.com 搜索 + musicu.fcg vkey.GetVkeyServer

const fs = require('node:fs')
const path = require('node:path')

const QQ_SEARCH = 'https://c.y.qq.com/soso/fcgi-bin/client_search_cp'
const QQ_MUSICU = 'https://u.y.qq.com/cgi-bin/musicu.fcg'
const CLIENT = { headers: { 'User-Agent': 'Kairos/0.2 (electron)' } }

let appDataDir = null
let login = null // { uin, musicKey } | null

function init(dir) {
  appDataDir = dir
  try {
    login = JSON.parse(fs.readFileSync(path.join(dir, 'qq_login.json'), 'utf8'))
  } catch {
    login = null
  }
}

function loginFile() {
  return path.join(appDataDir || '.', 'qq_login.json')
}

function persist(l) {
  const p = loginFile()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(l))
}

// 从 cookie 字符串解析 uin + qm_keyst（兼容 qqmusic_key、微信 wxuin/wxskey）
function parseCookieString(raw) {
  let uin = ''
  let key = ''
  for (const part of String(raw).split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    const k = part.slice(0, idx).trim().toLowerCase()
    const v = part.slice(idx + 1).trim().replace(/^"|"$/g, '')
    if (['uin', 'qqmusic_uin', 'wxuin', 'p_uin'].includes(k) && !uin) {
      const digits = v.replace(/\D/g, '')
      uin = digits || v
    }
    if (['qm_keyst', 'qqmusic_key', 'music_key'].includes(k) && !key) {
      key = v
    }
  }
  if (!uin || !key) return null
  return { uin, musicKey: key }
}

async function getJson(url, params, headers = {}, timeoutMs = 8000) {
  const qs = new URLSearchParams(params)
  const resp = await fetch(`${url}?${qs}`, {
    headers: { ...CLIENT.headers, ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  })
  return resp.json()
}

async function searchSongs(keyword) {
  const kw = String(keyword || '').trim()
  if (!kw) return []
  const json = await getJson(QQ_SEARCH, { w: kw, format: 'json', n: '20' }, { Referer: 'https://y.qq.com/' })
  const list = json?.data?.song?.list || []
  return list
    .filter((s) => s.songmid && s.songname)
    .map((s) => ({
      songmid: s.songmid,
      name: s.songname,
      singer: (s.singer || []).map((x) => x.name).join('/'),
      albumMid: s.albummid || '',
      durationSec: s.interval || 0,
    }))
}

// 播放地址：vkey.GetVkeyServer（未登录可播免费歌曲；带 musickey 解锁 VIP）
async function songUrl(songmid) {
  const uin = login ? login.uin : '0'
  const comm = { uin, format: 'json', ct: 24, cv: 0 }
  if (login) comm.authst = login.musicKey
  const guid = String(10000000 + Math.floor(Math.random() * 90000000))
  const body = {
    comm,
    req_0: {
      module: 'vkey.GetVkeyServer',
      method: 'CgiGetVkey',
      param: {
        guid,
        songmid: [songmid],
        songtype: [0],
        uin,
        loginflag: 1,
        platform: '20',
        filename: [`M500${songmid}.mp3`],
      },
    },
  }
  const headers = { Referer: 'https://y.qq.com/' }
  if (login) headers.Cookie = `uin=${login.uin}; qm_keyst=${login.musicKey}`
  const resp = await fetch(QQ_MUSICU, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { ...headers, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(8000),
  })
  const json = await resp.json()
  const purl = json?.req_0?.data?.midurlinfo?.[0]?.purl || ''
  if (!purl) {
    throw new Error(
      login
        ? '该歌曲拿不到音源（可能需要更高等级会员或区域限制）'
        : 'NO_URL：该歌曲可能需要 QQ 音乐 VIP——登录 QQ 音乐账号后可播',
    )
  }
  const sip = json?.req_0?.data?.sip?.[0] || 'https://ws.stream.qqmusic.qq.com/'
  return `${sip.replace(/\/$/, '')}${purl}`
}

// ---------- 登录（框架版：仅凭证文件化存取；扫码登录为预留扩展点） ----------

function saveLogin(cookie) {
  const l = parseCookieString(cookie)
  if (!l) throw new Error('未能从粘贴内容中解析出 uin 和 qm_keyst——请复制完整的 y.qq.com cookie')
  login = l
  persist(l)
  return l
}

function loginStatus() {
  return login
}

function logout() {
  login = null
  try {
    fs.unlinkSync(loginFile())
  } catch {
    // 文件不存在视为已登出
  }
}

// 预留扩展点：扫码登录（ptlogin2 协议：ptqrshow → ptqrlogin → check_sig → OAuth → QQLogin）
async function loginQrStart() {
  throw new Error('框架版暂未实现扫码登录')
}
async function loginQrCheck() {
  return { status: 'idle' }
}

module.exports = { init, searchSongs, songUrl, saveLogin, loginStatus, logout, loginQrStart, loginQrCheck }
