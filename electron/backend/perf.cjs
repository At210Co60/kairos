// 常驻性能守护：一个 PowerShell 进程每 ~1s 输出一行 JSON
// （CPU 实际性能百分比 → 换算睿频后频率；每物理盘忙碌%）。
// 语言无关：用的是 PerfFormattedData 计数器类，不受中文系统计数器名本地化影响。

const { spawn } = require('node:child_process')

const PERF_PS = `
while ($true) {
  try {
    $cpu = (Get-CimInstance -ClassName Win32_PerfFormattedData_Counters_ProcessorInformation -Filter "Name='_Total'" | Measure-Object -Property PercentProcessorPerformance -Average).Average
    $disks = Get-CimInstance -ClassName Win32_PerfFormattedData_PerfDisk_PhysicalDisk |
      Where-Object { $_.Name -ne '_Total' } |
      ForEach-Object { [PSCustomObject]@{ name = $_.Name; pct = [math]::Round($_.PercentDiskTime, 1) } }
    [PSCustomObject]@{ cpuPerf = [math]::Round($cpu, 1); disks = $disks } | ConvertTo-Json -Compress -Depth 3
  } catch {
    '{"cpuPerf": null, "disks": []}'
  }
  Start-Sleep -Milliseconds 900
}
`

let proc = null
let latest = { cpuPerf: null, diskBusy: {} } // diskBusy: { '0 C:': 12.3, ... }

function start() {
  if (proc) return
  try {
    proc = spawn('powershell.exe', ['-NoProfile', '-Command', PERF_PS], { windowsHide: true })
    let buf = ''
    proc.stdout.on('data', (chunk) => {
      buf += chunk.toString()
      let idx
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line.startsWith('{')) continue
        try {
          const j = JSON.parse(line)
          latest.cpuPerf = j.cpuPerf ?? null
          const list = Array.isArray(j.disks) ? j.disks : j.disks ? [j.disks] : []
          const map = {}
          for (const d of list) map[d.name] = d.pct
          latest.diskBusy = map
        } catch {
          // 忽略半行
        }
      }
    })
    proc.on('exit', () => {
      proc = null
    })
  } catch {
    proc = null
  }
}

function getPerf() {
  start()
  return latest
}

function stop() {
  if (proc) {
    proc.kill()
    proc = null
  }
}

module.exports = { getPerf, stop }
