// Kairos — Electron 主进程
// 职责：透明无边框窗口、IPC 路由（命令名与原 Tauri 命令一一对应，前端零逻辑改动）
const { app, BrowserWindow, ipcMain, Notification, screen } = require('electron')
const path = require('node:path')
const { spawn, execSync } = require('node:child_process')

const weather = require('./backend/weather.cjs')
const systemStats = require('./backend/systemStats.cjs')
const lyrics = require('./backend/lyrics.cjs')
const music = require('./backend/music.cjs')

let mainWindow = null
let lhmLaunchedByUs = false

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
 * 提权通道（LLT 同款体验）：
 * - 首次打开：UAC 提权重启（UAC 设为「从不通知」的机器零弹窗），成功后注册
 *   计划任务 Kairos\ElevatedLaunch（最高权限、无触发器 → 仅供按需拉起，不会开机自启）；
 * - 之后每次打开：通过计划任务静默拉起提权实例，零弹窗；
 * - dev 模式不参与提权（提权重启会打断 vite/concurrently 链路导致白屏）。
 */
const TASK_PATH = 'Kairos'
const TASK_NAME = 'ElevatedLaunch'

function taskExists() {
  try {
    execSync(`schtasks /query /tn "${TASK_PATH}\\${TASK_NAME}"`, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** 注册（或覆盖）仅按需运行的提权计划任务；exe 路径变化时由提权实例自动更新 */
function registerLaunchTask(exePath, args, workingDir) {
  const ps = [
    `$action = New-ScheduledTaskAction -Execute '${exePath}' -Argument '${args}' -WorkingDirectory '${workingDir}'`,
    `$principal = New-ScheduledTaskPrincipal -UserId '${process.env.USERDOMAIN}\\${process.env.USERNAME}' -LogonType Interactive -RunLevel Highest`,
    // 笔记本电池下也要能启动/常驻；ExecutionTimeLimit 0 取消默认 72h 到点杀进程
    `$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)`,
    `Register-ScheduledTask -TaskPath '\\${TASK_PATH}\\' -TaskName '${TASK_NAME}' -Action $action -Principal $principal -Settings $settings -Force | Out-Null`,
  ].join('; ')
  const b64 = Buffer.from(ps, 'utf16le').toString('base64')
  execSync(`powershell -NoProfile -EncodedCommand ${b64}`, { stdio: 'ignore', timeout: 15000 })
}

function ensureElevation() {
  // dev 不自动提权：提权重启会杀掉 vite/concurrently 链路导致白屏
  if (process.env.VITE_DEV_SERVER_URL) return true

  // 提权进程（UAC / 计划任务）默认落在 System32，必须显式带回项目根，
  // 否则相对路径的 app 参数（electron . 的 "."）解析不到应用
  const projectRoot = path.join(__dirname, '..')

  if (isElevated()) {
    // 提权实例：注册/刷新计划任务，供以后免 UAC 启动
    try {
      registerLaunchTask(process.execPath, process.argv.slice(1).map((a) => `"${a}"`).join(' '), projectRoot)
    } catch (err) {
      console.error('register launch task failed:', err)
      try {
        // TODO: 临时调试,定位注册失败原因后移除
        require('node:fs').writeFileSync(path.join(__dirname, '../task-reg-debug.txt'), String((err && err.stack) || err))
      } catch {}
    }
    return true
  }

  if (taskExists()) {
    // 已有通道：计划任务静默拉起提权实例，零弹窗。
    // 同步等待 /run 提交完成再退出，避免极端情况下子进程还没来得及触发调度
    try {
      execSync(`schtasks /run /tn "${TASK_PATH}\\${TASK_NAME}"`, { stdio: 'ignore', timeout: 10000 })
    } catch (err) {
      console.error('schtasks run failed:', err)
    }
    app.quit()
    return false
  }

  // 首次：UAC 提权重启（提权成功后由新实例注册计划任务）
  const exe = process.execPath
  const args = process.argv.slice(1).map((a) => `"${a}"`).join(' ')
  const dbg = path.join(__dirname, '../uac-debug.txt')
  try {
    // TODO: 临时调试,定位 UAC 分支问题后移除
    require('node:fs').appendFileSync(dbg, `UAC branch entered, exe=${exe}, args=${args}\n`)
  } catch {}
  spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `try { Start-Process -FilePath '${exe}' -ArgumentList '${args}' -WorkingDirectory '${projectRoot}' -Verb RunAs -ErrorAction Stop; 'SPAWN OK' | Out-File '${dbg}' -Append } catch { ('SPAWN FAIL: ' + $_.Exception.Message) | Out-File '${dbg}' -Append }`,
    ],
    { stdio: 'ignore', windowsHide: true },
  )
  app.quit()
  return false
}

/**
 * 确保捆绑的 LibreHardwareMonitor 在运行（温度/风扇数据源，MIT License）。
 * 已提权 → 直接拉起；未提权（dev 模式）→ RunAs 提权拉起（弹一次 UAC）。
 * WMI 命名空间已有传感器 → 跳过。
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
  const exe = path.join(__dirname, 'vendor', 'LibreHardwareMonitor', 'LibreHardwareMonitor.exe')
  try {
    if (isElevated()) {
      spawn(exe, ['/minimized'], { cwd: path.dirname(exe), stdio: 'ignore', detached: true }).unref()
      lhmLaunchedByUs = true
    } else {
      // dev 模式：提权拉起（弹一次 UAC）。实例权限高于本进程，退出时不强杀。
      spawn(
        'powershell.exe',
        ['-NoProfile', '-Command', `Start-Process -FilePath '${exe}' -ArgumentList '/minimized' -Verb RunAs`],
        { stdio: 'ignore', windowsHide: true },
      )
    }
  } catch (err) {
    console.error('LHM launch failed:', err)
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    // 窗口不透明：背景由页面里的 WebGL 层负责画"桌面 + 折射玻璃"（见 src/lib/desktopGlass.ts）
    transparent: false,
    frame: false,
    resizable: true,
    center: true,
    show: false,
    backgroundColor: '#0a0f1e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // 后台（最小化/被遮挡）时不节流计时器：番茄钟到点、监控轮询都要照常走
      backgroundThrottling: false,
    },
  })

  mainWindow.once('ready-to-show', () => mainWindow && mainWindow.show())

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
    // 渲染器控制台转发到主进程 stdout（dev 排障用；由重启脚本重定向到日志文件）
    mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`)
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

  // 窗口移动/缩放时同步屏幕位置（背景壁纸要跟着换采样区域）
  mainWindow.on('move', pushWinBounds)
  mainWindow.on('resize', pushWinBounds)

  // 加载失败兜底：dev server 未启动时窗口会一直卡在 show:false 后面（进程在跑却看不到界面），
  // 这里改为显示一个错误页，让失败原因可见
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return // -3 = 正常导航取消
    console.error(`[window] load failed: ${desc} (${code}) ${url}`)
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.loadURL(
      'data:text/html;charset=utf-8,' +
        encodeURIComponent(
          `<body style="margin:0;padding:28px;font:14px/1.7 system-ui;color:#e8e8ee;background:#17171c">` +
            `<b style="font-size:16px">Kairos 页面加载失败</b>` +
            `<p>${desc} (${code})</p><p style="color:#9a9aa8">${url}</p>` +
            `<p style="color:#9a9aa8">dev 模式：先运行 npm run dev 启动 vite，再重启 Electron。</p>` +
            `</body>`,
        ),
    )
    mainWindow.show()
  })
}

function send(event, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(`kairos:event:${event}`, payload)
  }
}

/**
 * 窗口几何（物理像素）：屏幕尺寸 + 窗口在屏幕上的位置。
 * 折射层用它把背景壁纸按"窗口在屏幕上的那一块"来采样——这样窗口里的背景
 * 与桌面上的壁纸严丝合缝，不会在窗口边缘出现断层。
 */
function winGeometry() {
  const d = screen.getPrimaryDisplay()
  const s = d.scaleFactor || 1
  const b = mainWindow && !mainWindow.isDestroyed() ? mainWindow.getBounds() : { x: 0, y: 0 }
  return {
    screen: { width: Math.round(d.size.width * s), height: Math.round(d.size.height * s) },
    bounds: { x: Math.round(b.x * s), y: Math.round(b.y * s) },
  }
}

function pushWinBounds() {
  const g = winGeometry()
  send('win-bounds', g.bounds)
}

// ---------- IPC 路由 ----------
ipcMain.handle('kairos:invoke', async (_e, cmd, args = {}) => {
  switch (cmd) {
    case 'system_stats':
      return systemStats.getStats()
    case 'win_geometry':
      return winGeometry()
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
  // Windows：自动提权通道（首次 UAC 一次，之后计划任务静默提权；dev 不参与）
  if (process.platform === 'win32' && !ensureElevation()) {
    return // 非提权实例已退出/正在提权重启
  }
  // Windows 通知归属
  if (process.platform === 'win32') app.setAppUserModelId('com.kairos.app')
  // 温度/风扇数据源（捆绑的 LHM；提权实例直接拉起）
  if (process.platform === 'win32') ensureLhm()
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
  // 温度数据源随应用退出（仅结束由我们拉起的实例）
  if (lhmLaunchedByUs) {
    try {
      execSync('taskkill /IM LibreHardwareMonitor.exe /F', { stdio: 'ignore' })
    } catch {}
  }
})
