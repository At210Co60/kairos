import { useEffect, useId, useState, type ReactNode } from 'react'
import { invoke } from '../lib/tauri'

/**
 * 系统监控模块（1s 刷新）
 * 视觉：占用水位类指标（CPU/内存/显卡占用、磁盘容量）= 玻璃水箱，
 * 箱内水面是两层滚动的物理水波，水位高度 = 占用比例；
 * 频率/温度/转速/网速类指标 = 仪表盘（弧线 + 指针随值摆动）。
 * 分组：CPU / 内存 / 磁盘 / 显卡 / 网络 各一张卡片；磁盘一张卡片内为整盘水位 + 各分区水位。
 */

/** 指标配色（沿用各传感器的既有色系） */
const COLOR = {
  cpu: '#60a5fa',
  freq: '#a78bfa',
  temp: '#fbbf24',
  fan: '#4ade80',
  mem: '#c084fc',
  disk: '#f472b6',
  gpuUtil: '#34d399',
  vram: '#a78bfa',
  memClock: '#22d3ee',
  coreClock: '#60a5fa',
  netDown: '#38bdf8',
  netUp: '#a78bfa',
}

/** 速率量程档位：仪表盘按会话峰值自动落到合适档（只有增长，不做衰减） */
const SPEED_STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000]

function speedMax(peak: number): number {
  return SPEED_STEPS.find((v) => v >= peak * 1.1) ?? Math.ceil(peak / 100) * 100
}

/** 周期性波浪：每 len 个单位一个完整波，横向平移 len 即可无缝循环 */
function waveD(amp: number, len: number, width: number): string {
  let d = `M${-width},0`
  for (let x = -width; x < width; x += len) {
    d += ` q${len / 4},${-amp} ${len / 2},0 q${len / 4},${amp} ${len / 2},0`
  }
  return `${d} L${width},130 L${-width},130 Z`
}

const WAVE_BACK = waveD(4.2, 44, 140)
const WAVE_FRONT = waveD(3, 32, 140)

/** 水位箱：ratio 为 0..100 的占用比例，null 表示无数据（空箱） */
function Tank({ ratio, color, width = 32 }: { ratio: number | null; color: string; width?: number }) {
  const gid = useId().replace(/:/g, '')
  const pct = ratio == null ? 0 : Math.min(100, Math.max(0, ratio))
  // 水面从箱顶（11）降到箱底（69）
  const surfaceY = 69 - (pct / 100) * 58
  return (
    <svg
      className="tank"
      viewBox="0 0 60 76"
      style={{ width, height: (width * 76) / 60 }}
      aria-hidden="true"
    >
      <defs>
        <clipPath id={`tc${gid}`}>
          <rect x="5" y="8" width="50" height="64" rx="5" />
        </clipPath>
        <linearGradient id={`tg${gid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.92" />
          <stop offset="100%" stopColor={color} stopOpacity="0.45" />
        </linearGradient>
      </defs>

      {/* 箱内：空箱底色 + 水（裁剪进箱体） + 竖向玻璃高光 */}
      <g clipPath={`url(#tc${gid})`}>
        <rect x="0" y="0" width="60" height="76" fill="rgba(255,255,255,0.04)" />
        {ratio != null && (
          <g transform={`translate(0 ${surfaceY.toFixed(2)})`}>
            <g className="water-lift">
              <path className="wave wave-back" d={WAVE_BACK} fill={`url(#tg${gid})`} opacity="0.55" />
              <path
                className="wave wave-front"
                d={WAVE_FRONT}
                fill={`url(#tg${gid})`}
                stroke={color}
                strokeWidth="0.9"
              />
            </g>
          </g>
        )}
        <rect x="9" y="12" width="3.5" height="56" rx="1.75" fill="rgba(255,255,255,0.13)" />
      </g>

      {/* 箱体轮廓 */}
      <rect x="5" y="8" width="50" height="64" rx="5" className="tank-body" />
    </svg>
  )
}

function polar(cx: number, cy: number, r: number, deg: number) {
  const rad = (deg * Math.PI) / 180
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) }
}

/** 顺时针弧（270° 扫角，从左上 135° 到右下 405°） */
function arcPath(cx: number, cy: number, r: number) {
  const s = polar(cx, cy, r, 135)
  const e = polar(cx, cy, r, 405)
  return `M${s.x.toFixed(2)},${s.y.toFixed(2)} A${r},${r} 0 1 1 ${e.x.toFixed(2)},${e.y.toFixed(2)}`
}

const G_CX = 30
const G_CY = 32
const G_R = 21
const G_LEN = 2 * Math.PI * G_R * 0.75 // 270° 弧长

/** 仪表盘：弧线按比例点亮，指针随之摆动 */
function Gauge({
  value,
  min,
  max,
  color,
  width = 38,
}: {
  value: number | null
  min: number
  max: number
  color: string
  width?: number
}) {
  const pct = value == null ? 0 : Math.min(1, Math.max(0, (value - min) / (max - min)))
  const ang = 135 + pct * 270 // 0% 指左上，100% 指右下
  const d = arcPath(G_CX, G_CY, G_R)
  const tip = polar(G_CX, G_CY, G_R * 0.78, ang)
  return (
    <svg className="gauge" viewBox="0 0 60 60" style={{ width, height: width }} aria-hidden="true">
      <path className="gauge-track" d={d} />
      <path
        className="gauge-arc"
        d={d}
        stroke={color}
        strokeDasharray={G_LEN}
        strokeDashoffset={G_LEN * (1 - pct)}
        style={{ filter: `drop-shadow(0 0 3px ${color})` }}
      />
      <line
        className="gauge-needle"
        x1={G_CX}
        y1={G_CY}
        x2={tip.x}
        y2={tip.y}
        stroke={color}
        style={{ filter: `drop-shadow(0 0 2px ${color})` }}
      />
      <circle cx={G_CX} cy={G_CY} r="2.2" fill={color} />
    </svg>
  )
}

/** 指标瓦片：图 + 数值 + 名称 */
function Tile({ label, text, art }: { label: string; text: string; art: ReactNode }) {
  return (
    <div className="sysmon-tile">
      <div className="sysmon-tile-art">{art}</div>
      <span className="sysmon-tile-value">{text}</span>
      <span className="sysmon-tile-label">{label}</span>
    </div>
  )
}

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
  cpuName: string | null
  memInfo: string | null
  cpuFreqGHz: number | null
  cpuTemp: number | null
  fanCpu: number | null
  maxFanCpu: number | null
  memUsed: number
  memTotal: number
  disks: Array<{
    model: string
    letters: string
    sizeGB: number
    usedGB: number
    totalGB: number
    volumes: Array<{ letter: string; usedGB: number; totalGB: number }>
    busyPct: number | null
    temp: number | null
  }>
  netDown: number
  netUp: number
  gpu: GpuInfo | null
}

function shortGpuName(name: string | null): string {
  if (!name) return 'GPU'
  return name.replace(/NVIDIA\s*/i, '').replace(/AMD\s*/i, '').replace(/GeForce\s*/i, '').trim() || name
}

export default function SystemPanel() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [err, setErr] = useState(false)
  // 速率仪表盘量程：跟随会话峰值，起步 5 MB/s
  const [netPeak, setNetPeak] = useState({ down: 5, up: 5 })

  useEffect(() => {
    let alive = true
    const poll = () =>
      invoke<Stats>('system_stats')
        .then((s) => {
          if (!alive || !s) return
          setStats(s)
          setErr(false)
          setNetPeak((p) => ({
            down: Math.max(p.down, s.netDown),
            up: Math.max(p.up, s.netUp),
          }))
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

  const gpu = stats.gpu
  const memRatio = stats.memTotal > 0 ? (stats.memUsed / stats.memTotal) * 100 : null
  const vramTxt =
    gpu?.memUsed != null && gpu?.memTotal != null
      ? `${(gpu.memUsed / 1024).toFixed(1)} / ${(gpu.memTotal / 1024).toFixed(1)} GB`
      : gpu?.vramStatic
        ? `${gpu.vramStatic} MB`
        : '—'

  return (
    <div className="panel-stack sysmon">
      {/* 四个独立分组：CPU / 内存 / 磁盘 / 显卡，各自一张卡片 */}
      <div className="sysmon-card">
        <div className="sysmon-card-head">
          <span className="sysmon-card-title">CPU</span>
          {stats.cpuName && <span className="sysmon-card-meta">{stats.cpuName}</span>}
        </div>
        <div className="sysmon-grid">
          <Tile
            label="占用"
            text={`${stats.cpu.toFixed(0)}%`}
            art={<Tank ratio={stats.cpu} color={COLOR.cpu} />}
          />
          <Tile
            label="频率"
            text={stats.cpuFreqGHz != null ? `${stats.cpuFreqGHz.toFixed(2)} GHz` : '—'}
            art={<Gauge value={stats.cpuFreqGHz} min={0.8} max={5.5} color={COLOR.freq} />}
          />
          <Tile
            label="温度"
            text={stats.cpuTemp != null ? `${stats.cpuTemp}°C` : '—'}
            art={<Gauge value={stats.cpuTemp} min={20} max={100} color={COLOR.temp} />}
          />
          <Tile
            label="风扇"
            text={stats.fanCpu != null ? `${stats.fanCpu} RPM` : '—'}
            art={<Gauge value={stats.fanCpu} min={0} max={stats.maxFanCpu ?? 3500} color={COLOR.fan} />}
          />
        </div>
      </div>

      <div className="sysmon-card">
        <div className="sysmon-card-head">
          <span className="sysmon-card-title">内存</span>
          {stats.memInfo && <span className="sysmon-card-meta">{stats.memInfo}</span>}
        </div>
        <div className="sysmon-grid">
          <Tile
            label="占用"
            text={`${stats.memUsed.toFixed(1)} / ${stats.memTotal.toFixed(1)} GB`}
            art={<Tank ratio={memRatio} color={COLOR.mem} />}
          />
        </div>
      </div>

      {/* 磁盘：一盘一张卡片（整盘水位 + 各分区水位） */}
      {(stats.disks || []).map((d) => (
        <div className="sysmon-card" key={d.letters}>
          <div className="sysmon-card-head">
            <span className="sysmon-card-title">磁盘 {d.model}</span>
            <span className="sysmon-card-value">
              {d.usedGB} / {d.totalGB} GB{d.temp != null ? ` · ${d.temp}°C` : ''}
            </span>
          </div>
          <div className="sysmon-shelf-row">
            <div className="sysmon-slot">
              <Tank
                ratio={d.totalGB > 0 ? (d.usedGB / d.totalGB) * 100 : null}
                color={COLOR.disk}
                width={38}
              />
              <span className="sysmon-tile-value">
                {d.totalGB > 0 ? `${((d.usedGB / d.totalGB) * 100).toFixed(0)}%` : '—'}
              </span>
              <span className="sysmon-tile-label">整盘</span>
            </div>
            {(d.volumes || []).map((v) => (
              <div className="sysmon-slot" key={v.letter}>
                <Tank ratio={v.totalGB > 0 ? (v.usedGB / v.totalGB) * 100 : null} color={COLOR.disk} />
                <span className="sysmon-tile-value">
                  {v.totalGB > 0 ? `${v.usedGB} / ${v.totalGB} GB` : '—'}
                </span>
                <span className="sysmon-tile-label">{v.letter}盘</span>
              </div>
            ))}
          </div>
        </div>
      ))}

      {gpu && (
        <div className="sysmon-card">
          <div className="sysmon-card-head">
            <span className="sysmon-card-title">显卡</span>
            <span className="sysmon-card-meta">{shortGpuName(gpu.name)}</span>
          </div>
          <div className="sysmon-grid">
            <Tile
              label="占用"
              text={gpu.util != null ? `${gpu.util}%` : '—'}
              art={<Tank ratio={gpu.util} color={COLOR.gpuUtil} />}
            />
            <Tile
              label="温度"
              text={gpu.temp != null ? `${gpu.temp}°C` : '—'}
              art={<Gauge value={gpu.temp} min={20} max={100} color={COLOR.temp} />}
            />
            <Tile
              label="风扇"
              text={gpu.fan != null ? `${gpu.fan} RPM` : '—'}
              art={<Gauge value={gpu.fan} min={0} max={gpu.maxFan ?? 3500} color={COLOR.fan} />}
            />
            <Tile
              label="显存占用"
              text={vramTxt}
              art={
                <Tank
                  ratio={gpu.memTotal ? ((gpu.memUsed ?? 0) / gpu.memTotal) * 100 : null}
                  color={COLOR.vram}
                />
              }
            />
            <Tile
              label="显存频率"
              text={gpu.memClock != null ? `${gpu.memClock} MHz` : '—'}
              art={<Gauge value={gpu.memClock} min={0} max={9000} color={COLOR.memClock} />}
            />
            <Tile
              label="核心频率"
              text={gpu.coreClock != null ? `${gpu.coreClock} MHz` : '—'}
              art={<Gauge value={gpu.coreClock} min={0} max={3000} color={COLOR.coreClock} />}
            />
          </div>
        </div>
      )}

      <div className="sysmon-card">
        <div className="sysmon-card-head">
          <span className="sysmon-card-title">网络</span>
          <span className="sysmon-card-meta">量程 {speedMax(netPeak.down)} MB/s</span>
        </div>
        <div className="sysmon-grid">
          <Tile
            label="下载"
            text={`${stats.netDown.toFixed(1)} MB/s`}
            art={<Gauge value={stats.netDown} min={0} max={speedMax(netPeak.down)} color={COLOR.netDown} />}
          />
          <Tile
            label="上传"
            text={`${stats.netUp.toFixed(1)} MB/s`}
            art={<Gauge value={stats.netUp} min={0} max={speedMax(netPeak.up)} color={COLOR.netUp} />}
          />
        </div>
      </div>
    </div>
  )
}
