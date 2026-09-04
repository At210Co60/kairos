import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

/**
 * 系统监控模块：真实数据（Rust sysinfo，2s 轮询）
 */

interface Stats {
  cpu: number
  memUsed: number
  memTotal: number
  diskUsed: number
  diskTotal: number
  netDown: number
  netUp: number
}

function Bar({ value, color }: { value: number; color: string }) {
  return (
    <div className="sysmon-bar">
      <div className="sysmon-bar-fill" style={{ width: `${Math.min(100, value)}%`, background: color }} />
    </div>
  )
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
    const t = setInterval(poll, 2000)
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
  const diskPct = stats.diskTotal > 0 ? (stats.diskUsed / stats.diskTotal) * 100 : 0

  return (
    <div className="panel-stack sysmon">
      <div className="sysmon-row">
        <div className="sysmon-label-row">
          <span>CPU 占用</span>
          <span className="sysmon-value">
            {stats.cpu.toFixed(0)}% <small>实时</small>
          </span>
        </div>
        <Bar value={stats.cpu} color="linear-gradient(90deg,#3b82f6,#60a5fa)" />
      </div>
      <div className="sysmon-row">
        <div className="sysmon-label-row">
          <span>内存占用</span>
          <span className="sysmon-value">
            {memPct.toFixed(0)}% <small>{stats.memUsed.toFixed(1)} / {stats.memTotal.toFixed(1)} GB</small>
          </span>
        </div>
        <Bar value={memPct} color="linear-gradient(90deg,#8b5cf6,#c084fc)" />
      </div>
      <div className="sysmon-row">
        <div className="sysmon-label-row">
          <span>磁盘占用</span>
          <span className="sysmon-value">
            {diskPct.toFixed(0)}% <small>{stats.diskUsed.toFixed(0)} / {stats.diskTotal.toFixed(0)} GB</small>
          </span>
        </div>
        <Bar value={diskPct} color="linear-gradient(90deg,#ec4899,#f472b6)" />
      </div>
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
