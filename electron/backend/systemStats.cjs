// 系统监控后端：CPU/内存/网络 + CPU 频率/温度/风扇 + GPU + 按物理盘分组的磁盘
//
// - CPU 占用/内存/网络/磁盘卷容量：systeminformation
// - CPU 实际频率：性能计数器 % Processor Performance × 基础频率
//   （WMI CurrentClockSpeed 只报基础频率，锁在 2.5G；性能计数器反映睿频）
// - CPU 温度：si.cpuTemperature（WMI，部分主板无效）→ LibreHardwareMonitor 流兜底 → null
// - 风扇：仅 LHM WMI（systeminformation 不支持风扇）
// - GPU：nvidia-smi 常驻进程 1s 刷新（利用率/温度/显存占用/显存频率/核心频率，NVIDIA）
// - 磁盘：按物理盘分组（Win32 分区关联映射），每组 = 卷容量合计 + 忙碌%
//   （PerfDisk 计数器）+ 温度（Get-StorageReliabilityCounter，需管理员权限，失败返回 null）
// - 性能数据源：perf.cjs 常驻 PowerShell 守护，每 ~1s 输出一行 JSON

const si = require('systeminformation')
const { spawn, execFile } = require('node:child_process')
const perf = require('./perf.cjs')

const GB = 1024 ** 3
const MB = 1024 ** 2
const r1 = (v) => Math.round(v * 10) / 10

let inited = false
let initPromise = null
let gpuStatic = null // { name, vram }
let cpuBaseMHz = null // 基础频率（睿频换算的分母）
let cpuClockTick = 0
let cpuClockFallback = null // WMI CurrentClockSpeed（MHz）
let diskGroups = [] // [{ index, model, letters: ['C','D'], sizeGB }]
let diskGroupsAt = 0
let diskTemps = {} // { '0': 42 } 按物理盘 Index
let diskTempProbed = false

// ---------- nvidia-smi 常驻 GPU 监控 ----------

let nvidiaProc = null
let nvidiaLatest = null
let nvidiaGotData = false
let nvidiaAttempt = 0

const NVIDIA_QUERY =
  '--query-gpu=utilization.gpu,temperature.gpu,memory.used,memory.total,clocks.mem,clocks.gr --format=csv,noheader,nounits -l 1'

function startNvidia(attempt = 1) {
  if (nvidiaProc || attempt > 4) return
  // 前两次标准 spawn（终端 PATH 通常可用）；失败后降级 shell 解析
  const p =
    attempt <= 2
      ? spawn('nvidia-smi', queryArgs(), { windowsHide: true })
      : spawn(`nvidia-smi ${queryArgs().join(' ')}`, { shell: true, windowsHide: true })
  nvidiaProc = p

  const revive = () => {
    nvidiaLatest = null
    if (nvidiaProc === p) nvidiaProc = null
    if (!nvidiaGotData && attempt < 4) setTimeout(() => startNvidia(attempt + 1), 4000)
  }
  p.on('error', revive)
  p.on('exit', () => {
    if (!nvidiaGotData) revive()
  })

  let buf = ''
  p.stdout.on('data', (chunk) => {
    nvidiaGotData = true
    buf += chunk.toString()
    const lines = buf.split(/\r?\n/)
    buf = lines.pop() || ''
    for (const line of lines.reverse()) {
      if (!line.trim()) continue
      const parts = line.split(',').map((v) => parseFloat(v.trim()))
      if (parts.length >= 6 && parts.every((v) => !Number.isNaN(v))) {
        nvidiaLatest = {
          util: parts[0],
          temp: parts[1],
          memUsed: parts[2],
          memTotal: parts[3],
          memClock: parts[4],
          coreClock: parts[5],
        }
        break
      }
    }
  })
}

function queryArgs() {
  return [
    '--query-gpu=utilization.gpu,temperature.gpu,memory.used,memory.total,clocks.mem,clocks.gr',
    '--format=csv,noheader,nounits',
    '-l',
    '1',
  ]
}

// ---------- LibreHardwareMonitor 流（风扇 / CPU 温度兜底，未装则输出 null 行） ----------

let lhmProc = null
let lhmLatest = { fanCpu: null, fanGpu: null, cpuTemp: null }

const LHM_PS = `
while ($true) {
  try {
    $s = Get-CimInstance -Namespace root/LibreHardwareMonitor -ClassName Sensor -ErrorAction Stop |
      Where-Object { ($_.SensorType -eq 'Fan' -or $_.SensorType -eq 'Temperature') -and $_.Value -gt 0 }
    $fanCpu = $null; $fanGpu = $null; $cpuTemp = $null
    foreach ($x in $s) {
      if ($x.SensorType -eq 'Fan') {
        if ($null -eq $fanGpu -and $x.Name -match 'gpu') { $fanGpu = [math]::Round($x.Value) }
        if ($null -eq $fanCpu -and $x.Name -notmatch 'gpu') { $fanCpu = [math]::Round($x.Value) }
      }
      if ($x.SensorType -eq 'Temperature') {
        # AMD 命名如 "CCD1 (Tdie)"，Intel 命名如 "CPU Package"；
        # 优先 Tdie/CCD/Package，退而求其次任意含 Core 的
        if ($null -eq $cpuTemp -and $x.Name -match 'cpu|package|ccd|tdie') { $cpuTemp = [math]::Round($x.Value, 1) }
      }
    }
    [PSCustomObject]@{ fanCpu = $fanCpu; fanGpu = $fanGpu; cpuTemp = $cpuTemp } | ConvertTo-Json -Compress
  } catch { '{"fanCpu": null, "fanGpu": null, "cpuTemp": null}' }
  Start-Sleep -Milliseconds 1500
}
`

function startLhm() {
  if (lhmProc) return
  try {
    lhmProc = spawn('powershell.exe', ['-NoProfile', '-Command', LHM_PS], { windowsHide: true })
    let buf = ''
    lhmProc.stdout.on('data', (chunk) => {
      buf += chunk.toString()
      let idx
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line.startsWith('{')) continue
        try {
          const j = JSON.parse(line)
          if (j.fanCpu != null || j.fanGpu != null || j.cpuTemp != null) {
            lhmLatest = { fanCpu: j.fanCpu ?? null, fanGpu: j.fanGpu ?? null, cpuTemp: j.cpuTemp ?? null }
          }
        } catch {}
      }
    })
    lhmProc.on('exit', () => {
      lhmProc = null
    })
  } catch {
    lhmProc = null
  }
}

// ---------- 一次性 WMI 探针 ----------

function queryCpuBase() {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-Command', '(Get-CimInstance Win32_Processor).MaxClockSpeed'],
      { windowsHide: true, timeout: 3000 },
      (err, stdout) => {
        if (err) return resolve(null)
        const v = parseInt(String(stdout).trim(), 10)
        resolve(Number.isNaN(v) ? null : v) // MHz
      },
    )
  })
}

function queryGpuNames() {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-Command', '(Get-CimInstance Win32_VideoController).Name'],
      { windowsHide: true, timeout: 3000 },
      (err, stdout) => {
        if (err) return resolve([])
        resolve(
          String(stdout)
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean),
        )
      },
    )
  })
}

/** 物理盘 → 盘符分组（WMI 分区关联映射），GROUP| 每行一个 JSON 对象流式输出 */
function queryDiskGroups() {
  const PS = `
Get-CimInstance Win32_DiskDrive | ForEach-Object {
  $disk = $_
  $letters = @()
  $parts = Get-CimAssociatedInstance -InputObject $disk -ResultClassName Win32_DiskPartition
  foreach ($p in $parts) {
    $ls = Get-CimAssociatedInstance -InputObject $p -ResultClassName Win32_LogicalDisk
    foreach ($l in $ls) { $letters += ($l.DeviceID -replace '\\\\', '') }
  }
  if ($letters.Count -gt 0) {
    $obj = [PSCustomObject]@{ index = $disk.Index; model = $disk.Model.Trim(); sizeGB = [math]::Round($disk.Size / 1GB); letters = $letters }
    Write-Output ('GROUP|' + (ConvertTo-Json -Compress $obj))
  }
}
`
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-Command', PS], { windowsHide: true, timeout: 15000 }, (err, stdout) => {
      const groups = []
      if (!err) {
        for (const line of String(stdout).split(/\r?\n/)) {
          if (!line.startsWith('GROUP|')) continue
          try {
            const j = JSON.parse(line.slice(6))
            if (j.letters && j.letters.length) {
              groups.push({ index: j.index, model: j.model, sizeGB: j.sizeGB, letters: j.letters })
            }
          } catch {}
        }
      }
      resolve(groups)
    })
  })
}

/** 磁盘温度：Get-StorageReliabilityCounter（NVMe/SMART，多需管理员权限） */
function queryDiskTemps() {
  const PS = `
try {
  Get-PhysicalDisk -ErrorAction Stop | ForEach-Object {
    $d = $_
    try {
      $rc = $d | Get-StorageReliabilityCounter -ErrorAction Stop
      if ($rc -and $rc.Temperature) {
        ConvertTo-Json -Compress ([PSCustomObject]@{ id = $d.DeviceId; temp = [math]::Round($rc.Temperature) })
      }
    } catch {}
  }
} catch {}
`
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-Command', PS], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
      const map = {}
      if (!err) {
        for (const line of String(stdout).split(/\r?\n/)) {
          if (!line.trim().startsWith('{')) continue
          try {
            const j = JSON.parse(line)
            map[String(j.id)] = j.temp
          } catch {}
        }
      }
      resolve(map)
    })
  })
}

// ---------- 联想 GameZone 风扇守护（拯救者 EC 风扇，需管理员权限） ----------

let lenovoProc = null
let lenovoFans = { fanCpu: null, fanGpu: null }

const LENOVO_PS = `
while ($true) {
  try {
    $gz = Get-WmiObject -Namespace root/WMI -Class LENOVO_GAMEZONE_DATA
    $f1 = [int]$gz.GetFan1Speed(0)
    $f2 = [int]$gz.GetFan2Speed(0)
    [PSCustomObject]@{ fan1 = $f1; fan2 = $f2 } | ConvertTo-Json -Compress
  } catch { '{"fan1": 0, "fan2": 0}' }
  Start-Sleep -Milliseconds 1000
}
`

function startLenovo() {
  if (lenovoProc) return
  try {
    lenovoProc = spawn('powershell.exe', ['-NoProfile', '-Command', LENOVO_PS], { windowsHide: true })
    let buf = ''
    lenovoProc.stdout.on('data', (chunk) => {
      buf += chunk.toString()
      let idx
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line.startsWith('{')) continue
        try {
          const j = JSON.parse(line)
          // 拯救者双风扇：CPU 扇 + GPU 扇；转速 0 视为停转（保留数值，前端照实显示）
          lenovoFans = { fanCpu: j.fan1 || 0, fanGpu: j.fan2 || 0 }
        } catch {}
      }
    })
    lenovoProc.on('exit', () => {
      lenovoProc = null
    })
  } catch {
    lenovoProc = null
  }
}

function stopLenovo() {
  if (lenovoProc) {
    lenovoProc.kill()
    lenovoProc = null
  }
}

// ---------- 初始化（一次性） ----------

async function init() {
  // CPU 基础频率（睿频换算分母）
  try {
    const base = await queryCpuBase()
    if (base) cpuBaseMHz = base
  } catch {}

  // GPU 型号（WMI 名称优先，过滤虚拟适配器；si.graphics 补显存容量）
  try {
    const names = await queryGpuNames()
    const real =
      names.find((n) => /nvidia|geforce/i.test(n) && !/virtual/i.test(n)) ||
      names.find((n) => /radeon|amd|arc/i.test(n) && !/virtual/i.test(n)) ||
      names[0] ||
      null
    if (real) gpuStatic = { name: real, vram: null }
  } catch {}
  if (gpuStatic && !gpuStatic.vram) {
    try {
      const g = await si.graphics()
      const ctrl = (g.controllers || []).find(
        (x) => x.model && gpuStatic.name && x.model.includes(gpuStatic.name.split(' ')[0]),
      )
      if (ctrl?.vram) gpuStatic = { ...gpuStatic, vram: ctrl.vram }
    } catch {}
  }

  // 风扇/CPU 温度兜底：LHM 流（未装 LHM 时只有 null 行，开销≈0）
  startLhm()

  // 联想拯救者风扇守护（非拯救者机器输出 0，无害）
  startLenovo()

  // NVIDIA 常驻监控
  startNvidia()

  // 磁盘分组（首次 + 每 5 分钟刷新）
  const refreshGroups = async () => {
    const g = await queryDiskGroups()
    if (g.length) diskGroups = g
  }
  try {
    await refreshGroups()
    setInterval(() => refreshGroups(), 5 * 60 * 1000).unref()
  } catch {}

  // 磁盘温度探测（可用则 30s 一次）
  try {
    queryDiskTemps().then((map) => {
      if (Object.keys(map).length) {
        diskTemps = map
        diskTempProbed = true
        setInterval(async () => {
          diskTemps = await queryDiskTemps()
        }, 30 * 1000).unref()
      }
    })
  } catch {}
}

function ensureInit() {
  if (!initPromise) initPromise = init()
  return initPromise
}

// ---------- 汇总 ----------

async function getStats() {
  await ensureInit()
  const snapshot = perf.getPerf()
  const [load, speed, temp, mem, fsSize, net] = await Promise.all([
    si.currentLoad(),
    si.cpuCurrentSpeed(),
    si.cpuTemperature(),
    si.mem(),
    si.fsSize(),
    si.networkStats(),
  ])

  let rxSec = 0
  let txSec = 0
  for (const n of net) {
    rxSec += n.rx_sec || 0
    txSec += n.tx_sec || 0
  }
  const diskTotalAll = fsSize.reduce((a, f) => a + (f.size || 0), 0)
  const diskUsedAll = fsSize.reduce((a, f) => a + (f.used || 0), 0)

  // CPU 实际频率 = 基础频率 × % Processor Performance（si 的 avg 锁在基础频率）
  let cpuFreqGHz = null
  if (snapshot.cpuPerf > 0 && cpuBaseMHz) {
    const baseGHz = cpuBaseMHz / 1000
    const ghz = (cpuBaseMHz * snapshot.cpuPerf) / 100 / 1000
    // 冷启动首样可能异常（如 1600%），钳制到 [0.8×基础, 2.6×基础]
    if (ghz >= baseGHz * 0.8 && ghz <= baseGHz * 2.6) {
      cpuFreqGHz = Math.round(ghz * 100) / 100
    }
  }
  if (cpuFreqGHz == null && speed && speed.avg) {
    cpuFreqGHz = Math.round(speed.avg * 100) / 100
  }

  // CPU 温度：si 优先，无效时用 LHM 流
  let cpuTemp = temp && temp.main > 0 ? Math.round(temp.main) : null
  if (cpuTemp == null && lhmLatest.cpuTemp != null) cpuTemp = lhmLatest.cpuTemp

  // 风扇：联想 GameZone 优先（拯救者 EC），LHM 兜底
  let fanCpu = lhmLatest.fanCpu
  let fanGpu = lhmLatest.fanGpu
  if (lenovoFans.fanCpu > 0) fanCpu = lenovoFans.fanCpu
  if (lenovoFans.fanGpu > 0) fanGpu = lenovoFans.fanGpu

  // 按物理盘分组：卷容量合计 + 忙碌% + 温度
  const letterUsage = {}
  for (const f of fsSize) {
    const m = f.mount.match(/^([A-Za-z]):/)
    if (m) letterUsage[m[1].toUpperCase()] = { used: f.used, total: f.size }
  }
  const disks = diskGroups.map((g) => {
    let used = 0
    let total = 0
    for (const letterWithColon of g.letters) {
      const u = letterUsage[letterWithColon.replace(':', '').toUpperCase()]
      if (u) {
        used += u.used
        total += u.total
      }
    }
    const busyKey = Object.keys(snapshot.diskBusy).find((k) => k.startsWith(g.index + ' '))
    return {
      model: g.model,
      letters: g.letters.join(', '),
      sizeGB: g.sizeGB,
      usedGB: r1(used / GB),
      totalGB: r1(total / GB),
      busyPct: busyKey != null ? Math.min(100, snapshot.diskBusy[busyKey]) : null,
      temp: diskTempProbed ? (diskTemps[String(g.index)] ?? null) : null,
    }
  })

  let gpu = null
  if (gpuStatic || nvidiaLatest) {
    gpu = {
      name: gpuStatic?.name ?? null,
      util: nvidiaLatest ? nvidiaLatest.util : null,
      temp: nvidiaLatest ? nvidiaLatest.temp : null,
      memUsed: nvidiaLatest ? nvidiaLatest.memUsed : null,
      memTotal: nvidiaLatest ? nvidiaLatest.memTotal : null,
      memClock: nvidiaLatest ? nvidiaLatest.memClock : null,
      coreClock: nvidiaLatest ? nvidiaLatest.coreClock : null,
      fan: fanGpu,
      vramStatic: gpuStatic?.vram ?? null,
    }
  }

  return {
    cpu: r1(load.currentLoad),
    cpuFreqGHz,
    cpuBaseGHz: cpuBaseMHz ? Math.round((cpuBaseMHz / 100) * 100) / 1000 : null,
    cpuTemp,
    fanCpu,
    memUsed: r1(mem.used / GB),
    memTotal: r1(mem.total / GB),
    disks,
    diskUsedAll: r1(diskUsedAll / GB),
    diskTotalAll: r1(diskTotalAll / GB),
    netDown: r1(rxSec / MB),
    netUp: r1(txSec / MB),
    gpu,
  }
}

function shutdown() {
  if (nvidiaProc) {
    nvidiaProc.kill()
    nvidiaProc = null
  }
  perf.stop()
}

module.exports = { getStats, shutdown }
