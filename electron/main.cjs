// Kairos — Electron 主进程
// 职责：透明无边框窗口、IPC 路由（命令名与原 Tauri 命令一一对应，前端零逻辑改动）
const { app, BrowserWindow, ipcMain, Notification } = require('electron')
const path = require('node:path')
const { spawn, execSync } = require('node:child_process')

const weather = require('./backend/weather.cjs')
const systemStats = require('./backend/systemStats.cjs')
const lyrics = require('./backend/lyrics.cjs')
const music = require('./backend/music.cjs')

let mainWindow = null

/** 管理员权限检测（net session 仅管理员可执行） */
function isElevated() {
  try {
    execSync('net session', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * 确保捆绑的 LibreHardwareMonitor 在运行（温度/风扇数据源，MIT License）。
 * WMI 命名空间已有传感器 → 无需操作；否则静默拉起 vendor 目录下的便携版。
 * 仅提权（或本机已装 LHM）时有效；未提权实例里静默跳过。
 */
function ensureLhm() {
  try {
    const check = execSync(
      'powershell -NoProfile -Command "(Get-CimInstance -Namespace root/LibreHardwareMonitor -ClassName Sensor -ErrorAction Stop | Measure-Object).Count"',
      { timeout: 8000, encoding: 'utf8' },
    )
    if (parseInt(check.trim(), 10) > 0) return
  } catch {
    // WMI 命名空间不存在 → 未运行
  }
  try {
    const exe = path.join(__dirname, 'vendor', 'LibreHardwareMonitor', 'LibreHardwareMonitor.exe')
    spawn(exe, ['/minimized'], { cwd: path.dirname(exe), stdio: 'ignore', windowsHide: false, detached: true }).unref()
  } catch (err) {
    console.error('LHM launch failed:', err)
  }
}

/** 非提权实例：以管理员身份重启自身（等 LLT/GamePP 的自动 UAC 行为） */
function relaunchElevated() {
  const exe = process.execPath
  const args = process.argv.slice(1).map((a) => `"${a}"`).join(' ')
  spawn(
    'powershell.exe',
    ['-NoProfile', '-Command', `Start-Process -FilePath '${exe}' -ArgumentList '${args}' -Verb RunAs`],
    { stdio: 'ignore', windowsHide: true },
  )
  app.quit()
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    transparent: true,
    frame: false,
    resizable: true,
    center: true,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.once('ready-to-show', () => mainWindow && mainWindow.show())

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
    // 渲染器控制台转发到主进程 stdout（dev 排障用）
    mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      if (level >= 2) console.error(`[renderer] ${message} (${sourceId}:${line})`)
    })
    // 开发期刷新快捷键（Electron 默认不带 F5/Ctrl+R）
    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && (input.key === 'F5' || (input.control && input.key.toLowerCase() === 'r'))) {
        mainWindow.webContents.reload()
        event.preventDefault()
      }
    })
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function send(event, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(`kairos:event:${event}`, payload)
  }
}

// ---------- IPC 路由 ----------
ipcMain.handle('kairos:invoke', async (_e, cmd, args = {}) => {
  switch (cmd) {
    case 'system_stats':
      return systemStats.getStats()
    case 'weather_geocode':
      return weather.geocode(String(args.city || ''))
    case 'weather_forecast':
      return weather.forecast(Number(args.latitude), Number(args.longitude))
    case 'weather_air_quality':
      return weather.airQuality(Number(args.latitude), Number(args.longitude))
    case 'weather_ip_locate':
      return weather.ipLocate()
    case 'fetch_lyrics':
      return lyrics.fetchLyrics(String(args.title || ''), String(args.artist || ''))
    case 'set_lyric_lines':
      lyrics.setLyricLines(Array.isArray(args.lines) ? args.lines : [])
      return null
    case 'qq_search_songs':
      return music.searchSongs(String(args.keyword || ''))
    case 'qq_song_url':
      return music.songUrl(String(args.songmid || ''))
    case 'qq_save_login':
      return music.saveLogin(String(args.cookie || ''))
    case 'qq_login_status':
      return music.loginStatus()
    case 'qq_logout':
      music.logout()
      return null
    case 'qq_login_qr_start':
      return music.loginQrStart()
    case 'qq_login_qr_check':
      return music.loginQrCheck()
    default:
      throw new Error(`未知命令：${cmd}`)
  }
})

ipcMain.on('kairos:win', (_e, action) => {
  if (!mainWindow) return
  if (action === 'minimize') mainWindow.minimize()
  if (action === 'close') mainWindow.close()
})

// 天气提醒等系统通知
ipcMain.on('kairos:notify', (_e, payload) => {
  try {
    const { title = 'Kairos', body = '' } = payload || {}
    if (Notification.isSupported()) {
      new Notification({ title, body, icon: path.join(__dirname, '../src-tauri/icons/icon.png') }).show()
    }
  } catch (err) {
    console.error('notify failed:', err)
  }
})

app.whenReady().then(() => {
  // 生产构建：非提权实例自动以管理员重启（Lenovo GameZone 传感器需要）。
  // dev 模式跳过提权——concurrently -k 会杀掉 vite，提权后的实例会白屏。
  const isDev = !!process.env.VITE_DEV_SERVER_URL
  if (process.platform === 'win32' && !isDev && !isElevated()) {
    relaunchElevated()
    return
  }
  // Windows 通知归属
  if (process.platform === 'win32') app.setAppUserModelId('com.kairos.app')
  // 温度/风扇数据源（捆绑的 LHM；需管理员权限，生产模式已提权）
  if (process.platform === 'win32' && isElevated()) ensureLhm()
  music.init(app.getPath('userData'))
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  systemStats.shutdown()
})
