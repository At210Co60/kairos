import { useEffect, useState } from 'react'
import { invoke } from '../lib/tauri'

/**
 * 系统监控模块（1s 刷新）
 * 每项传感器一根进度条：
 * CPU（占用/频率/温度/风扇）→ 内存 → 磁盘 → GPU（占用/温度/风扇/显存占用/显存频率/核心频率）→ 网络
 * 传感器不可用时进度条空置、数值显示 —
 */

interface GpuInfo {
  name: string | null
  util: number | null
  temp: number | null
  memUsed: number | null // MB
  memTotal: number | null // MB
  memClock: number | null // MHz
  coreClock: number | null // MHz
  fan: number | null
  maxFan: number | null // 联想 WMI 报告的风扇上限 RPM
  vramStatic: string | null
}

interface Stats {
  cpu: number
  cpuFreqGHz: number | null
  cpuTemp: number | null
  fanCpu: number | null
  maxFanCpu: number | null // 联想 WMI 报告的风扇上限 RPM（无则用 3500 标尺）
  memUsed: number
  memTotal: number
  disks: Array<{
    model: string
    letters: string
    sizeGB: number
    usedGB: number
    totalGB: number
    busyPct: number | null
    temp: number | null
  }>
  netDown: number
  netUp: number
  gpu: GpuInfo | null
}

function Bar({ value, color }: { value: number; color: string }) {
  return (
    <div className="sysmon-bar">
      <div className="sysmon-bar-fill" style={{ width: `${Math.min(100, Math.max(0, value))}%`, background: color }} />
    </div>
  )
}

/** 单传感器进度条（value/max 决定填充，text 为右侧数值文本） */
function Metric({
  label,
  value,
  max,
  color,
  text,
}: {
  label: string
  value: number | null
  max: number
  color: string
  text: string
}) {
  const pct = value == null ? 0 : Math.min(100, (value / max) * 100)
  return (
    <div className="sysmon-metric">
      <div className="sysmon-label-row">
        <span>{label}</span>
        <span className="sysmon-value">{text}</span>
      </div>
      <Bar value={pct} color={color} />
    </div>
  )
}

function shortGpuName(name: string | null): string {
  if (!name) return 'GPU'
  return name.replace(/NVIDIA\s*/i, '').replace(/AMD\s*/i, '').replace(/GeForce\s*/i, '').trim() || name
}

export default function SystemPanel() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [err, setErr] = useState(false)

  useEffect(() => {
    let alive = true
    const poll = () =>
      invoke<Stats>('system_stats')
        .then((s) => {
          if (alive) {
            setStats(s)
            setErr(false)
          }
        })
        .catch(() => alive && setErr(true))
    poll()
    const t = setInterval(poll, 1000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])

  if (err || !stats) {
    return (
      <div className="panel-stack">
        <p className="panel-note">系统数据获取中…（首次采集需要几秒）</p>
      </div>
    )
  }

  const memPct = stats.memTotal > 0 ? (stats.memUsed / stats.memTotal) * 100 : 0
  const gpu = stats.gpu
  const vramPct =
    gpu?.memUsed != null && gpu?.memTotal != null && gpu.memTotal > 0 ? (gpu.memUsed / gpu.memTotal) * 100 : null
  const gpuMemTxt =
    gpu?.memUsed != null && gpu?.memTotal != null
      ? `${(gpu.memUsed / 1024).toFixed(1)} / ${(gpu.memTotal / 1024).toFixed(1)} GB`
      : gpu?.vramStatic
        ? `${gpu.vramStatic} MB`
        : '—'

  return (
    <div className="panel-stack sysmon">
      <Metric
        label="CPU 占用"
        value={stats.cpu}
        max={100}
        color="linear-gradient(90deg,#3b82f6,#60a5fa)"
        text={`${stats.cpu.toFixed(0)}%`}
      />
      <Metric
        label="CPU 频率"
        value={stats.cpuFreqGHz}
        max={5.5}
        color="linear-gradient(90deg,#6366f1,#a78bfa)"
        text={stats.cpuFreqGHz != null ? `${stats.cpuFreqGHz.toFixed(2)} GHz` : '—'}
      />
      <Metric
        label="CPU 温度"
        value={stats.cpuTemp}
        max={100}
        color="linear-gradient(90deg,#f59e0b,#ef4444)"
        text={stats.cpuTemp != null ? `${stats.cpuTemp}°C` : '—'}
      />
      <Metric
        label="CPU 风扇"
        value={stats.fanCpu}
        max={stats.maxFanCpu ?? 3500}
        color="linear-gradient(90deg,#10b981,#4ade80)"
        text={stats.fanCpu != null ? `${stats.fanCpu} RPM` : '—'}
      />

      <Metric
        label="内存占用"
        value={memPct}
        max={100}
        color="linear-gradient(90deg,#8b5cf6,#c084fc)"
        text={`${stats.memUsed.toFixed(1)} / ${stats.memTotal.toFixed(1)} GB`}
      />
      {/* 磁盘：按物理盘分组（同盘的分区合一条），忙碌% 为进度条，温度随盘 */}
      {(stats.disks || []).map((d) => (
        <Metric
          key={d.letters}
          label={`磁盘 ${d.model} (${d.letters})`}
          value={d.busyPct}
          max={100}
          color="linear-gradient(90deg,#ec4899,#f472b6)"
          text={`${d.usedGB} / ${d.totalGB} GB${d.temp != null ? ` · ${d.temp}°C` : ''}`}
        />
      ))}

      {gpu && (
        <>
          <Metric
            label={`GPU 占用 · ${shortGpuName(gpu.name)}`}
            value={gpu.util}
            max={100}
            color="linear-gradient(90deg,#22d3ee,#34d399)"
            text={gpu.util != null ? `${gpu.util}%` : '—'}
          />
          <Metric
            label="GPU 温度"
            value={gpu.temp}
            max={100}
            color="linear-gradient(90deg,#f59e0b,#ef4444)"
            text={gpu.temp != null ? `${gpu.temp}°C` : '—'}
          />
          <Metric
            label="GPU 风扇"
            value={gpu.fan}
            max={gpu.maxFan ?? 3500}
            color="linear-gradient(90deg,#10b981,#4ade80)"
            text={gpu.fan != null ? `${gpu.fan} RPM` : '—'}
          />
          <Metric
            label="显存占用"
            value={vramPct}
            max={100}
            color="linear-gradient(90deg,#a78bfa,#c084fc)"
            text={gpuMemTxt}
          />
          <Metric
            label="显存频率"
            value={gpu.memClock}
            max={8000}
            color="linear-gradient(90deg,#22d3ee,#67e8f9)"
            text={gpu.memClock != null ? `${gpu.memClock} MHz` : '—'}
          />
          <Metric
            label="核心频率"
            value={gpu.coreClock}
            max={3000}
            color="linear-gradient(90deg,#60a5fa,#a78bfa)"
            text={gpu.coreClock != null ? `${gpu.coreClock} MHz` : '—'}
          />
        </>
      )}

      <div className="sysmon-net">
        <div className="sysmon-label-row">
          <span>网络</span>
          <span className="sysmon-value">
            ↓ {stats.netDown.toFixed(1)} MB/s · ↑ {stats.netUp.toFixed(1)} MB/s
          </span>
        </div>
      </div>
    </div>
  )
}
