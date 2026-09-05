import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import gsap from 'gsap'
import { invoke } from '../lib/tauri'
// 动画天气图标：@meteocons/svg（MIT License）© Bas Milius
// https://github.com/basmilius/meteocons
import iconClearDay from '@meteocons/svg/fill/clear-day.svg?url'
import iconClearNight from '@meteocons/svg/fill/clear-night.svg?url'
import iconPartlyDay from '@meteocons/svg/fill/partly-cloudy-day.svg?url'
import iconPartlyNight from '@meteocons/svg/fill/partly-cloudy-night.svg?url'
import iconOvercastDay from '@meteocons/svg/fill/overcast-day.svg?url'
import iconOvercastNight from '@meteocons/svg/fill/overcast-night.svg?url'
import iconFogDay from '@meteocons/svg/fill/fog-day.svg?url'
import iconFogNight from '@meteocons/svg/fill/fog-night.svg?url'
import iconRain from '@meteocons/svg/fill/rain.svg?url'
import iconSnow from '@meteocons/svg/fill/snow.svg?url'
import iconThunderDay from '@meteocons/svg/fill/thunderstorms-day-rain.svg?url'
import iconThunderNight from '@meteocons/svg/fill/thunderstorms-night-rain.svg?url'

/**
 * 天气模块：真实数据（Rust 侧调 Open-Meteo，免费无需 key）。
 * 紧凑视图：实况 + 未来 3 天预报；展开视图（expanded）追加详情：
 * 穿衣建议 / 紫外线 / 风向风级 / 空气质量（中国 AQI）/ 未来 24h 云量。
 * 城市输入回车 → 地理编码 → 实况 + 预报；每 30 分钟自动刷新。
 */

export interface GeoPlace {
  name: string
  admin1: string | null
  country: string | null
  latitude: number
  longitude: number
  timezone: string | null
}

interface CurrentWeather {
  time: string
  temperature: number
  apparentTemperature: number
  humidity: number
  cloudCover: number | null
  uvIndex: number | null
  windSpeed: number
  windDirection: number | null
  windGusts: number | null
  weatherCode: number
  isDay: boolean
}

interface HourlyPoint {
  time: string
  temperature: number
  apparentTemperature: number
  precipProbability: number | null
  precipitation: number | null
  cloudCover: number | null
  uvIndex: number | null
  windSpeed: number | null
  windDirection: number | null
  weatherCode: number | null
}

interface DailyForecast {
  date: string
  weatherCode: number
  tempMax: number
  tempMin: number
  precipProbability: number | null
  uvIndexMax: number | null
  windSpeedMax: number | null
  windGustsMax: number | null
  windDirectionDominant: number | null
  sunrise: string | null
  sunset: string | null
  daylightDuration: number | null
}

interface WeatherData {
  timezone: string
  current: CurrentWeather
  hourly: HourlyPoint[]
  daily: DailyForecast[]
}

interface AirQuality {
  aqi: number
  level: string
  primary: string | null
  pm25: number
  pm10: number
  updatedAt: string
}

/** WMO 天气代码 → 中文描述 + 图标（night 为夜间替代图标） */
const WMO: Record<number, { desc: string; icon: string; night?: string }> = {
  0: { desc: '晴', icon: '☀️', night: '🌙' },
  1: { desc: '基本晴', icon: '🌤️' },
  2: { desc: '局部多云', icon: '⛅' },
  3: { desc: '阴', icon: '☁️' },
  45: { desc: '雾', icon: '🌫️' },
  48: { desc: '冻雾', icon: '🌫️' },
  51: { desc: '小毛毛雨', icon: '🌦️' },
  53: { desc: '毛毛雨', icon: '🌦️' },
  55: { desc: '大毛毛雨', icon: '🌧️' },
  56: { desc: '冻毛毛雨', icon: '🌧️' },
  57: { desc: '强冻毛毛雨', icon: '🌧️' },
  61: { desc: '小雨', icon: '🌧️' },
  63: { desc: '中雨', icon: '🌧️' },
  65: { desc: '大雨', icon: '🌧️' },
  66: { desc: '冻雨', icon: '🌧️' },
  67: { desc: '强冻雨', icon: '🌧️' },
  71: { desc: '小雪', icon: '🌨️' },
  73: { desc: '中雪', icon: '🌨️' },
  75: { desc: '大雪', icon: '❄️' },
  77: { desc: '雪粒', icon: '🌨️' },
  80: { desc: '小阵雨', icon: '🌦️' },
  81: { desc: '阵雨', icon: '🌧️' },
  82: { desc: '强阵雨', icon: '⛈️' },
  85: { desc: '小阵雪', icon: '🌨️' },
  86: { desc: '大阵雪', icon: '❄️' },
  95: { desc: '雷暴', icon: '⛈️' },
  96: { desc: '雷暴伴冰雹', icon: '⛈️' },
  99: { desc: '强雷暴伴冰雹', icon: '⛈️' },
}

const RAIN_CODES = [51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99]
const SNOW_CODES = [71, 73, 75, 77, 85, 86]

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const DIR8 = ['北', '东北', '东', '东南', '南', '西南', '西', '西北']
/** 蒲福风级上限风速（km/h）与名称 */
const BEAUFORT_MAX = [1, 6, 12, 20, 29, 39, 50, 62, 75, 89, 103, 118]
const BEAUFORT_NAME = ['无风', '软风', '轻风', '微风', '和风', '劲风', '强风', '疾风', '大风', '烈风', '狂风', '暴风', '飓风']

function wmo(code: number, isDay = true) {
  const m = WMO[code] ?? { desc: '未知', icon: '🌡️' }
  return { desc: m.desc, icon: !isDay && m.night ? m.night : m.icon }
}

function dayLabel(dateStr: string, index: number) {
  if (index === 0) return '今天'
  if (index === 1) return '明天'
  const [y, m, d] = dateStr.split('-').map(Number)
  return WEEK[new Date(y, m - 1, d).getDay()]
}

/** 秒 → 「12小时28分」 */
function fmtDuration(sec: number | null | undefined): string {
  if (sec == null) return '—'
  const h = Math.floor(sec / 3600)
  const m = Math.round((sec % 3600) / 60)
  return `${h}小时${String(m).padStart(2, '0')}分`
}

/** 逐小时图表跨天分隔线标签（图表最多跨 1 天，切换处即明天） */
function dayDividerLabel(dateStr: string) {
  const [y, m, d] = dateStr.slice(0, 10).split('-').map(Number)
  return `明天 · ${m}月${d}日 ${WEEK[new Date(y, m - 1, d).getDay()]}`
}

function windDirLabel(deg: number | null | undefined) {
  if (deg == null) return '—'
  return DIR8[Math.round(deg / 45) % 8]
}

function beaufort(kmh: number) {
  let lv = 0
  while (lv < 12 && kmh >= BEAUFORT_MAX[lv]) lv++
  return lv
}

function uvLevel(uv: number) {
  if (uv < 3) return { name: '弱', advice: '紫外线弱，无需特别防护' }
  if (uv < 6) return { name: '中等', advice: '外出涂防晒霜、戴帽子' }
  if (uv < 8) return { name: '强', advice: '避免正午暴晒，SPF30+ 防晒' }
  if (uv < 11) return { name: '很强', advice: '10-16 时尽量待在室内，SPF50+' }
  return { name: '极强', advice: '尽量减少外出，硬防晒 + 高倍防晒霜' }
}

function clothingAdvice(t: number, code: number) {
  let head: string
  let body: string
  if (t >= 30) {
    head = '炎热'
    body = '轻薄透气的短袖短裤，注意防暑补水'
  } else if (t >= 26) {
    head = '较热'
    body = '短袖为主，选浅色轻薄面料'
  } else if (t >= 21) {
    head = '舒适'
    body = '短袖或薄长袖，早晚可加一件薄外套'
  } else if (t >= 16) {
    head = '微凉'
    body = '长袖 + 薄外套或卫衣'
  } else if (t >= 11) {
    head = '偏凉'
    body = '夹克、风衣或薄毛衣'
  } else if (t >= 6) {
    head = '较冷'
    body = '厚外套配毛衣，注意保暖'
  } else if (t >= 0) {
    head = '寒冷'
    body = '棉服或羽绒服，戴好帽子围巾'
  } else {
    head = '严寒'
    body = '厚羽绒服，注意防冻防滑'
  }
  if (RAIN_CODES.includes(code)) body += '；记得带伞'
  else if (SNOW_CODES.includes(code)) body += '；注意防滑保暖'
  return { head, body }
}

const AQI_COLOR: Record<string, string> = {
  优: '#4ade80',
  良: '#eab308',
  轻度污染: '#fb923c',
  中度污染: '#f87171',
  重度污染: '#c084fc',
  严重污染: '#ef4444',
}

/** 云量条颜色：晴朗（适合观星）→ 阴 */
function cloudColor(c: number) {
  if (c <= 25) return '#38bdf8'
  if (c <= 50) return '#818cf8'
  if (c <= 75) return '#a78bfa'
  return '#64748b'
}

/** 15 日温度折线图：最高/最低两条折线 + 逐日降水概率柱 + 天气图标 */
function DailyTrend({ daily }: { daily: DailyForecast[] }) {
  const svgRef = useRef<SVGSVGElement | null>(null)

  // 入场：折线逐段画出 → 降水柱升起 → 节点弹出 → 标注浮现
  useLayoutEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const ctx = gsap.context(() => {
      svg.querySelectorAll<SVGPolylineElement>('.wd-line').forEach((line, i) => {
        const len = line.getTotalLength()
        gsap.fromTo(
          line,
          { strokeDasharray: len, strokeDashoffset: len },
          { strokeDashoffset: 0, duration: 1.1, delay: 0.35 + i * 0.2, ease: 'power2.inOut' },
        )
      })
      gsap.from(svg.querySelectorAll('.wd-bar'), {
        scaleY: 0,
        transformOrigin: 'bottom',
        stagger: 0.03,
        duration: 0.4,
        delay: 0.5,
        ease: 'power2.out',
      })
      gsap.from(svg.querySelectorAll('.wd-pt'), {
        opacity: 0,
        scale: 0,
        transformOrigin: 'center',
        stagger: 0.025,
        duration: 0.3,
        delay: 0.55,
      })
      gsap.from(svg.querySelectorAll('.wd-lbl'), {
        opacity: 0,
        y: 6,
        stagger: 0.03,
        duration: 0.35,
        delay: 0.6,
      })
    }, svg)
    return () => ctx.revert()
  }, [])

  if (daily.length === 0) return null
  const W = 1000
  const H = 264
  let maxT = Math.max(...daily.map((d) => d.tempMax))
  let minT = Math.min(...daily.map((d) => d.tempMin))
  if (maxT === minT) maxT = minT + 1
  maxT += 0.5
  minT -= 0.5
  const y = (t: number) => 18 + ((maxT - t) / (maxT - minT)) * 132
  const step = W / daily.length
  const x = (i: number) => step * (i + 0.5)
  const line = (key: 'tempMax' | 'tempMin') =>
    daily.map((d, i) => `${x(i)},${y(d[key])}`).join(' ')
  return (
    <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="wd-trend">
      {daily.map((d, i) => {
        const p = d.precipProbability ?? 0
        if (p <= 0) return null
        const barH = (p / 100) * 22
        return (
          <rect
            key={`p${d.date}`}
            className="wd-bar"
            x={x(i) - 9}
            y={194 - barH}
            width={18}
            height={barH}
            rx={2}
            fill="rgba(96,165,250,0.4)"
          />
        )
      })}
      <polyline className="wd-line" points={line('tempMax')} fill="none" stroke="#fb923c" strokeWidth={2} />
      <polyline className="wd-line" points={line('tempMin')} fill="none" stroke="#60a5fa" strokeWidth={2} />
      {daily.map((d, i) => (
        <g key={d.date}>
          <circle className="wd-pt" cx={x(i)} cy={y(d.tempMax)} r={2.5} fill="#fb923c" />
          <circle className="wd-pt" cx={x(i)} cy={y(d.tempMin)} r={2.5} fill="#60a5fa" />
          <g className="wd-lbl">
            <text x={x(i)} y={y(d.tempMax) - 7} textAnchor="middle" fontSize={11} fill="#fdba74">
              {Math.round(d.tempMax)}°
            </text>
            <text x={x(i)} y={y(d.tempMin) + 14} textAnchor="middle" fontSize={11} fill="#93c5fd">
              {Math.round(d.tempMin)}°
            </text>
            <text x={x(i)} y={207} textAnchor="middle" fontSize={14}>
              {wmo(d.weatherCode).icon}
            </text>
            <text x={x(i)} y={227} textAnchor="middle" fontSize={10} fill="rgba(255,255,255,0.6)">
              {dayLabel(d.date, i)}
            </text>
            <text x={x(i)} y={243} textAnchor="middle" fontSize={9} fill="rgba(255,255,255,0.35)">
              {d.date.slice(5).replace('-', '/')}
            </text>
            {(d.precipProbability ?? 0) > 0 && (
              <text x={x(i)} y={259} textAnchor="middle" fontSize={9} fill="#93c5fd">
                雨{d.precipProbability}%
              </text>
            )}
          </g>
        </g>
      ))}
    </svg>
  )
}

/** 15 日列表：逐日 天气/温度/降水/紫外线/最大风（入场逐行浮现） */
function DailyList({ daily }: { daily: DailyForecast[] }) {
  const boxRef = useRef<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    const el = boxRef.current
    if (!el) return
    const ctx = gsap.context(() => {
      gsap.from('.wd-dlist-row', {
        y: 12,
        opacity: 0,
        stagger: 0.028,
        duration: 0.35,
        ease: 'power2.out',
      })
    }, el)
    return () => ctx.revert()
  }, [])

  return (
    <div ref={boxRef} className="wd-dlist">
      <div className="wd-dlist-row wd-dlist-head">
        <span>日期</span>
        <span>天气</span>
        <span>高/低</span>
        <span>降水</span>
        <span>紫外线</span>
        <span>最大风</span>
      </div>
      {daily.map((d, i) => (
        <div key={d.date} className="wd-dlist-row">
          <span>
            {dayLabel(d.date, i)}
            <small> {d.date.slice(5).replace('-', '/')}</small>
          </span>
          <span>
            {wmo(d.weatherCode).icon} {wmo(d.weatherCode).desc}
          </span>
          <span className="wd-dlist-temp">
            {Math.round(d.tempMax)}° / {Math.round(d.tempMin)}°
          </span>
          <span>{d.precipProbability != null ? `${d.precipProbability}%` : '—'}</span>
          <span>{d.uvIndexMax != null ? uvLevel(d.uvIndexMax).name : '—'}</span>
          <span>
            {d.windDirectionDominant != null && d.windSpeedMax != null
              ? `${windDirLabel(d.windDirectionDominant)}风${beaufort(d.windSpeedMax)}级`
              : '—'}
          </span>
        </div>
      ))}
    </div>
  )
}

/** 天气 → 场景类型（ColorOS 天气背景风格：动态天空 + 分层天气元素） */
function sceneKind(code: number): 'clear' | 'partly' | 'overcast' | 'fog' | 'rain' | 'thunder' | 'snow' {
  if (code === 0 || code === 1) return 'clear'
  if (code === 2) return 'partly'
  if (code === 3) return 'overcast'
  if (code === 45 || code === 48) return 'fog'
  if (code >= 95) return 'thunder'
  if (SNOW_CODES.includes(code)) return 'snow'
  if (RAIN_CODES.includes(code)) return 'rain'
  return 'overcast'
}

/** WMO 代码 + 昼夜 → Meteocons 动画图标 */
function heroIcon(code: number, isDay: boolean): string {
  if (code === 0 || code === 1) return isDay ? iconClearDay : iconClearNight
  if (code === 2) return isDay ? iconPartlyDay : iconPartlyNight
  if (code === 3) return isDay ? iconOvercastDay : iconOvercastNight
  if (code === 45 || code === 48) return isDay ? iconFogDay : iconFogNight
  if (code >= 95) return isDay ? iconThunderDay : iconThunderNight
  if (SNOW_CODES.includes(code)) return iconSnow
  if (RAIN_CODES.includes(code)) return iconRain
  return isDay ? iconOvercastDay : iconOvercastNight
}

/** 各场景的云层配置：top%/宽(px)/透明度/景深模糊(px)/漂移时长(秒)/相位 */
const CLOUD_SETS: Record<string, Array<{ top: number; width: number; opacity: number; blur: number; dur: number; delay: number }>> = {
  clear: [
    { top: 6, width: 110, opacity: 0.35, blur: 5, dur: 130, delay: -60 },
    { top: 24, width: 150, opacity: 0.5, blur: 1.5, dur: 95, delay: -30 },
  ],
  partly: [
    { top: 2, width: 120, opacity: 0.5, blur: 4, dur: 120, delay: -80 },
    { top: 14, width: 175, opacity: 0.8, blur: 0, dur: 85, delay: -30 },
    { top: 34, width: 140, opacity: 0.55, blur: 2, dur: 100, delay: -60 },
  ],
  overcast: [
    { top: -6, width: 190, opacity: 0.45, blur: 6, dur: 110, delay: -70 },
    { top: 8, width: 225, opacity: 0.7, blur: 2, dur: 85, delay: -20 },
    { top: 20, width: 185, opacity: 0.8, blur: 0, dur: 70, delay: -45 },
    { top: 38, width: 150, opacity: 0.5, blur: 3, dur: 125, delay: -95 },
  ],
  rain: [
    { top: -8, width: 235, opacity: 0.75, blur: 4, dur: 100, delay: -55 },
    { top: 2, width: 205, opacity: 0.85, blur: 0, dur: 75, delay: -15 },
    { top: 12, width: 175, opacity: 0.6, blur: 1, dur: 90, delay: -70 },
  ],
  thunder: [
    { top: -10, width: 255, opacity: 0.8, blur: 5, dur: 105, delay: -60 },
    { top: 0, width: 225, opacity: 0.9, blur: 0, dur: 80, delay: -25 },
    { top: 10, width: 185, opacity: 0.65, blur: 1, dur: 95, delay: -75 },
  ],
  snow: [
    { top: -4, width: 205, opacity: 0.7, blur: 3, dur: 95, delay: -50 },
    { top: 8, width: 175, opacity: 0.8, blur: 0, dur: 78, delay: -20 },
  ],
  fog: [],
}

/** 软轮廓云（椭圆簇剪影），配合逐层景深模糊 */
function CloudSvg({ width, blur, night }: { width: number; blur: number; night: boolean }) {
  return (
    <svg
      viewBox="0 0 220 110"
      width={width}
      style={{ filter: blur ? `blur(${blur}px)` : undefined }}
    >
      <g fill={night ? 'rgba(148, 163, 184, 0.75)' : 'url(#wxCloudGrad)'}>
        <ellipse cx="62" cy="72" rx="46" ry="26" />
        <ellipse cx="110" cy="52" rx="52" ry="36" />
        <ellipse cx="158" cy="72" rx="46" ry="26" />
        <ellipse cx="110" cy="84" rx="74" ry="20" />
      </g>
    </svg>
  )
}

/**
 * 动态天气场景（参考 ColorOS 天气背景）：
 * 按天气代码 + 昼夜渲染天空底色，叠加日月/星辰/流云/雨丝/雪花/闪电等
 * 纯 CSS 动画元素，作为展开页顶部的背景层。
 */
function WeatherScene({ code, isDay }: { code: number; isDay: boolean }) {
  const kind = sceneKind(code)
  const night = !isDay
  const clouds = CLOUD_SETS[kind] ?? []
  // 确定性伪随机（按索引推导），避免每次渲染重新洗牌
  const stars = useMemo(
    () =>
      Array.from({ length: 20 }, (_, i) => ({
        top: (i * 37 + 7) % 68,
        left: (i * 53 + 11) % 100,
        size: 1 + ((i * 7) % 3) * 0.7,
        dur: 2.5 + ((i * 13) % 25) / 10,
        delay: -((i * 17) % 30) / 10,
      })),
    [],
  )
  const drops = useMemo(
    () =>
      Array.from({ length: 22 }, (_, i) => ({
        left: (i * 41 + 9) % 100,
        height: i < 10 ? 10 + ((i * 11) % 7) : 18 + ((i * 11) % 9),
        far: i < 10,
        dur: i < 10 ? 0.95 + ((i * 17) % 9) / 20 : 0.55 + ((i * 17) % 9) / 16,
        delay: -((i * 29) % 22) / 10,
      })),
    [],
  )
  const flakes = useMemo(
    () =>
      Array.from({ length: 14 }, (_, i) => ({
        left: (i * 47 + 5) % 100,
        size: 2.5 + ((i * 7) % 4) * 0.8,
        dur: 5 + ((i * 13) % 35) / 10,
        delay: -((i * 23) % 40) / 10,
      })),
    [],
  )
  return (
    <div className={`wx-scene wx-${kind}${night ? ' wx-night' : ''}`} aria-hidden>
      <svg width="0" height="0" style={{ position: 'absolute' }}>
        <defs>
          <linearGradient id="wxCloudGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#ffffff" />
            <stop offset="1" stopColor="#c7d7f0" />
          </linearGradient>
        </defs>
      </svg>
      {night &&
        stars.map((s, i) => (
          <span
            key={`st${i}`}
            className="wx-star"
            style={{
              top: `${s.top}%`,
              left: `${s.left}%`,
              width: s.size,
              height: s.size,
              animationDuration: `${s.dur}s`,
              animationDelay: `${s.delay}s`,
            }}
          />
        ))}
      {/* Meteocons 动画图标作为场景主体；云层仅保留远景模糊层作氛围 */}
      <img className="wx-hero-icon" src={heroIcon(code, isDay)} alt="" />
      {night && kind === 'clear' && <div className="wx-milkyway" />}
      {night && <div className="wx-shooter" />}
      {clouds
        .filter((c) => c.blur > 0)
        .map((c, i) => (
          <div
            key={`cl${i}`}
            className="wx-cloud"
            style={{
              top: `${c.top}%`,
              opacity: c.opacity,
              animationDuration: `${c.dur}s`,
              animationDelay: `${c.delay}s`,
            }}
          >
            <CloudSvg width={c.width} blur={c.blur} night={night} />
          </div>
        ))}
      {(kind === 'rain' || kind === 'thunder') && (
        <div className="wx-rain-field">
          {drops.map((d, i) => (
            <span
              key={`dr${i}`}
              className="wx-drop"
              style={{
                left: `${d.left}%`,
                height: d.height,
                opacity: d.far ? 0.35 : 0.65,
                animationDuration: `${d.dur}s`,
                animationDelay: `${d.delay}s`,
              }}
            />
          ))}
        </div>
      )}
      {kind === 'snow' && (
        <div className="wx-snow-field">
          {flakes.map((f, i) => (
            <span
              key={`fl${i}`}
              className="wx-flake"
              style={{
                left: `${f.left}%`,
                width: f.size,
                height: f.size,
                opacity: f.size > 3.5 ? 0.9 : 0.55,
                filter: f.size > 3.5 ? undefined : 'blur(1px)',
                animationDuration: `${f.dur}s`,
                animationDelay: `${f.delay}s`,
              }}
            />
          ))}
        </div>
      )}
      {kind === 'fog' && (
        <>
          <div className="wx-fogband" style={{ top: '22%', width: '72%' }} />
          <div className="wx-fogband" style={{ top: '48%', width: '88%', animationDelay: '-4s' }} />
          <div className="wx-fogband" style={{ top: '72%', width: '60%', animationDelay: '-8s' }} />
        </>
      )}
      {kind === 'thunder' && <div className="wx-flash-overlay" />}
      <div className="wx-fade" />
    </div>
  )
}

/** 记住上次查询的城市 */
const CITY_KEY = 'kairos.weather.city'
/** 通知去重记录 */
const NOTIFY_KEY = 'kairos.weather.alerts'

/**
 * 天气提醒（Electron 通知，每日每类一次）：
 * 1) 未来 12h 降水概率 ≥70% → 带伞提醒
 * 2) 明日最低温较今日下降 ≥5°C → 降温提醒
 * 3) 今日紫外线 ≥8 → 防晒提醒
 */
function checkAlerts(place: GeoPlace, data: WeatherData) {
  if (!place.name || !window.kairos) return
  try {
    const now = new Date()
    const dayKey = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`
    const key = (t: string) => `${dayKey}|${place.name}|${t}`
    const records = (): string[] => {
      try {
        return JSON.parse(localStorage.getItem(NOTIFY_KEY) || '[]')
      } catch {
        return []
      }
    }
    const fired = (k: string) => records().includes(k)
    const fire = (k: string, title: string, body: string) => {
      if (fired(k)) return
      window.kairos!.notify(title, body)
      const next = records()
      next.push(k)
      if (next.length > 400) next.splice(0, next.length - 400)
      localStorage.setItem(NOTIFY_KEY, JSON.stringify(next))
    }

    const nowMs = Date.now()
    const rainPeak = (data.hourly || [])
      .filter((h) => {
        const t = new Date(h.time).getTime()
        return t >= nowMs && t - nowMs <= 12 * 3600 * 1000
      })
      .reduce((m, h) => Math.max(m, h.precipProbability ?? 0), 0)
    if (rainPeak >= 60) {
      fire(key('rain'), `${place.name} 未来 12 小时有雨`, `降水概率最高 ${rainPeak}%，出门记得带伞`)
    }

    const lt = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const fut = (data.daily || []).filter((d) => d.date >= lt)
    if (fut.length >= 2 && fut[0].tempMin - fut[1].tempMin >= 5) {
      fire(
        key('cold'),
        `${place.name} 明晨降温`,
        `明天最低 ${Math.round(fut[1].tempMin)}°C，比今天低 ${Math.round(fut[0].tempMin - fut[1].tempMin)}°C，注意添衣`,
      )
    }
    const uvMax = fut[0]?.uvIndexMax ?? 0
    if (uvMax >= 8) {
      fire(key('uv'), `${place.name} 今日紫外线强`, `紫外线指数最高 ${uvMax}，外出注意防晒`)
    }

    // 每日简报：每天首次拿到数据后必发一条，保证通知功能可见
    const t0 = fut[0]
    if (t0) {
      fire(
        key('brief'),
        `${place.name} · 今日天气`,
        `${wmo(t0.weatherCode).desc} ${Math.round(t0.tempMax)}°/${Math.round(t0.tempMin)}°，降水概率 ${t0.precipProbability ?? 0}%`,
      )
    }
  } catch {
    // 提醒失败不影响天气展示
  }
}

export default function WeatherPanel({ expanded }: { expanded: boolean }) {
  const now = new Date()
  const dateLabel = `${now.getMonth() + 1}月${now.getDate()}日 ${WEEK[now.getDay()]}`
  const [query, setQuery] = useState('上海')
  const [cityName, setCityName] = useState('定位中…')
  const [cityHint, setCityHint] = useState('')
  const [w, setW] = useState<WeatherData | null>(null)
  const [aq, setAq] = useState<AirQuality | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [dailyView, setDailyView] = useState<'line' | 'list'>('line')
  const placeRef = useRef<GeoPlace | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const bootedRef = useRef(false)

  // 展开时的内容渐进入场：温度 → 详情卡 → 15日预报 → 云量条纹逐条生长
  useLayoutEffect(() => {
    if (!expanded) return
    const ctx = gsap.context(() => {
      const tl = gsap.timeline({ defaults: { ease: 'power3.out' } })
      tl.from('.weather-temp', { y: 16, opacity: 0, duration: 0.5 }, 0.2)
        .from('.wd-grid .wd-card', { y: 18, opacity: 0, stagger: 0.06, duration: 0.5 }, 0.3)
        .from('.wd-daily', { y: 20, opacity: 0, duration: 0.5 }, '-=0.3')
        .from(
          '.wd-cloud-row, .wd-cloud-divider',
          { x: -16, opacity: 0, stagger: 0.015, duration: 0.32 },
          '-=0.25',
        )
        .from(
          '.wd-cloud-fill',
          { scaleX: 0, transformOrigin: 'left center', stagger: 0.012, duration: 0.3 },
          '<',
        )
        .from(
          '.wd-precip-fill',
          { scaleX: 0, transformOrigin: 'left center', stagger: 0.012, duration: 0.3 },
          '<',
        )
    }, panelRef)
    return () => ctx.revert()
  }, [expanded])

  const fetchByPlace = useCallback(async (place: GeoPlace) => {
    setBusy(true)
    setError('')
    try {
      const [data, air] = await Promise.all([
        invoke<WeatherData>('weather_forecast', {
          latitude: place.latitude,
          longitude: place.longitude,
        }),
        invoke<AirQuality>('weather_air_quality', {
          latitude: place.latitude,
          longitude: place.longitude,
        }).catch(() => null),
      ])
      setW(data)
      setAq(air)
      checkAlerts(place, data)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [])

  const fetchByCity = useCallback(
    async (name: string, opts?: { persist?: boolean }) => {
      const kw = name.trim()
      if (!kw) return
      setBusy(true)
      setError('')
      try {
        const places = await invoke<GeoPlace[]>('weather_geocode', { city: kw })
        if (places.length === 0) {
          setError(`未找到城市「${kw}」`)
          setBusy(false)
          return
        }
        const place = places[0]
        placeRef.current = place
        setQuery(place.name)
        setCityName(place.name)
        setCityHint([place.admin1, place.country].filter(Boolean).join(' · '))
        if (opts?.persist !== false) localStorage.setItem(CITY_KEY, place.name)
        await fetchByPlace(place)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        setBusy(false)
      }
    },
    [fetchByPlace],
  )

  // 启动：记住的上次城市 > IP 自动定位 > 上海兜底
  useEffect(() => {
    if (bootedRef.current) return
    bootedRef.current = true
    const saved = localStorage.getItem(CITY_KEY)
    if (saved) {
      setQuery(saved)
      fetchByCity(saved, { persist: false })
    } else {
      invoke<GeoPlace | null>('weather_ip_locate')
        .then((place) => {
          if (place) {
            placeRef.current = place
            setQuery(place.name)
            setCityName(place.name)
            setCityHint([place.admin1, place.country].filter(Boolean).join(' · '))
            localStorage.setItem(CITY_KEY, place.name)
            fetchByPlace(place)
          } else {
            fetchByCity('上海')
          }
        })
        .catch(() => fetchByCity('上海'))
    }
  }, [fetchByCity, fetchByPlace])

  // 数据中的「今天起」的逐日预报（后端含 past_days，需滤掉昨天）
  const localToday = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const dailyFuture = w ? w.daily.filter((d) => d.date >= localToday) : []
  const today = dailyFuture[0]
  const cur = w?.current

  // 昨日同一时刻温度（hourly 含 past_days=1 的过去 24h）
  const yesterTemp = (() => {
    if (!w || !cur || w.hourly.length === 0) return null
    const yDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
    const yStr = `${yDate.getFullYear()}-${String(yDate.getMonth() + 1).padStart(2, '0')}-${String(yDate.getDate()).padStart(2, '0')}`
    const stamp = `${yStr}T${cur.time.slice(11, 13)}:00`
    const hit = w.hourly.find((h) => h.time.startsWith(stamp))
    return hit ? hit.temperature : null
  })()

  // 展开详情数据
  const uv = cur?.uvIndex ?? null
  const windLv = cur ? beaufort(cur.windSpeed) : 0
  const cloth = cur ? clothingAdvice(cur.apparentTemperature, cur.weatherCode) : null
  const hourly24 = w
    ? (() => {
        const stamp = cur ? cur.time.slice(0, 13) : ''
        const start = Math.max(0, w.hourly.findIndex((h) => h.time.slice(0, 13) >= stamp))
        return w.hourly.slice(start, start + 24)
      })()
    : []

  return (
    <div ref={panelRef} className="panel-stack weather">
      <div className={expanded ? 'wx-hero wx-hero-expanded' : 'wx-hero'}>
        {expanded && w && cur && <WeatherScene code={cur.weatherCode} isDay={cur.isDay} />}
        {expanded && w && cur && <div className="wx-hero-spacer" />}
        <form
        className="weather-head"
        onSubmit={(e) => {
          e.preventDefault()
          fetchByCity(query)
        }}
      >
        <div>
          <p className="weather-city" title={cityHint}>
            📍 {cityName}
            {busy ? ' …' : ''}
          </p>
          <p className="weather-date">{dateLabel}</p>
        </div>
        <input
          className="weather-city-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="城市名，回车查询"
          aria-label="城市"
        />
      </form>

      {w && cur ? (
        <>
          <div className="weather-now">
            <span className="weather-temp">{Math.round(cur.temperature)}°C</span>
            <span className="weather-desc">
              {wmo(cur.weatherCode, cur.isDay).desc} · 体感 {Math.round(cur.apparentTemperature)}°
            </span>
            {!expanded && (
              <img
                className="weather-icon-big"
                src={heroIcon(cur.weatherCode, cur.isDay)}
                alt=""
                width={40}
                height={40}
              />
            )}
          </div>
          <p className="weather-hl">
            {today && (
              <>
                最高 {Math.round(today.tempMax)}° · 最低 {Math.round(today.tempMin)}°
                {today.precipProbability != null ? ` · 降水 ${today.precipProbability}%` : ''}
              </>
            )}
          </p>
          {/* 昨日对比（小时级数据含 past_days） */}
          {yesterTemp != null && cur && Math.abs(cur.temperature - yesterTemp) >= 0.4 && (
            <p className="weather-yday">
              较昨日同时
              <span className={cur.temperature >= yesterTemp ? 'up' : 'down'}>
                {cur.temperature >= yesterTemp ? ' ↑' : ' ↓'}{' '}
                {Math.abs(cur.temperature - yesterTemp).toFixed(1)}°C
              </span>
            </p>
          )}
          {/* 日出日落与昼长（仅展开页） */}
          {expanded && today?.sunrise && today.sunset && (
            <p className="weather-sun">
              🌅 {today.sunrise.slice(11, 16)} · 🌇 {today.sunset.slice(11, 16)} · 昼长{' '}
              {fmtDuration(today.daylightDuration)}
            </p>
          )}
        </>
      ) : (
        <p className="panel-note">{error ? `⚠ ${error}` : '数据加载中…'}</p>
      )}
      </div>

      {/* 4 天横条只用于小卡片；展开页的逐日信息由「15 日预报」区块承担 */}
      {w && cur && !expanded && (
        <div className="weather-days">
          {dailyFuture.slice(0, 4).map((d, i) => (
            <div key={d.date} className="weather-day">
              <p>{dayLabel(d.date, i)}</p>
              <p className="weather-day-icon">{wmo(d.weatherCode).icon}</p>
              <p>
                {Math.round(d.tempMax)}° / {Math.round(d.tempMin)}°
              </p>
            </div>
          ))}
        </div>
      )}

      {w && cur && expanded && (
        <>
              <div className="wd-grid">
                <div className="wd-card">
                  <p className="wd-title">👕 穿衣建议</p>
                  <p className="wd-main">{cloth?.head ?? '—'}</p>
                  <p className="wd-sub">{cloth?.body ?? '—'}</p>
                </div>
                <div className="wd-card">
                  <p className="wd-title">🌞 紫外线</p>
                  <p className="wd-main">
                    {uv != null ? `${uv.toFixed(1)} · ${uvLevel(uv).name}` : '—'}
                  </p>
                  <p className="wd-sub">{uv != null ? uvLevel(uv).advice : '暂无数据'}</p>
                </div>
                <div className="wd-card">
                  <p className="wd-title">💨 风向风级</p>
                  <p className="wd-main">
                    {windDirLabel(cur.windDirection)}风 · {windLv}级{' '}
                    {BEAUFORT_NAME[windLv]}
                  </p>
                  <p className="wd-sub">
                    风速 {cur.windSpeed.toFixed(1)} km/h
                    {cur.windGusts != null ? ` · 阵风 ${cur.windGusts.toFixed(1)}` : ''}
                  </p>
                </div>
                <div className="wd-card">
                  <p className="wd-title">🫁 空气质量</p>
                  {aq ? (
                    <>
                      <p className="wd-main">
                        <span style={{ color: AQI_COLOR[aq.level] ?? '#94a3b8' }}>
                          AQI {aq.aqi} · {aq.level}
                        </span>
                      </p>
                      <p className="wd-sub">
                        {aq.primary ? `首要污染物 ${aq.primary} · ` : ''}
                        PM2.5 {aq.pm25.toFixed(1)} · PM10 {aq.pm10.toFixed(1)} μg/m³
                      </p>
                    </>
                  ) : (
                    <p className="wd-sub">暂无数据</p>
                  )}
                </div>
              </div>

              <div className="wd-card wd-daily">
                <div className="wd-daily-head">
                  <p className="wd-title">📅 15 日预报（最高温 / 最低温 / 降水）</p>
                  <div className="wd-toggle">
                    <button
                      className={dailyView === 'line' ? 'on' : ''}
                      onClick={() => setDailyView('line')}
                    >
                      📈 折线
                    </button>
                    <button
                      className={dailyView === 'list' ? 'on' : ''}
                      onClick={() => setDailyView('list')}
                    >
                      📋 列表
                    </button>
                  </div>
                </div>
                {dailyView === 'line' ? <DailyTrend daily={dailyFuture} /> : <DailyList daily={dailyFuture} />}
              </div>

              <div className="wd-card wd-cloud">
                <p className="wd-title">☁️ 云量 / 🌧 降水 · 未来 24 小时（云量低 = 适合观星）</p>
                {hourly24.map((h, i) => {
                  const c = h.cloudCover ?? 0
                  const p = h.precipProbability ?? 0
                  const mm = h.precipitation ?? 0
                  const dateChanged =
                    i > 0 && h.time.slice(0, 10) !== hourly24[i - 1].time.slice(0, 10)
                  return (
                    <Fragment key={h.time}>
                      {dateChanged && <div className="wd-cloud-divider">{dayDividerLabel(h.time)}</div>}
                      <div className="wd-cloud-row">
                        <span className="wd-cloud-t">{h.time.slice(11, 13)}时</span>
                        <div className="wd-bars">
                          <div className="wd-cloud-bar">
                            <div
                              className="wd-cloud-fill"
                              style={{ width: `${c}%`, background: cloudColor(c) }}
                            />
                          </div>
                          <div className="wd-precip-bar">
                            <div className="wd-precip-fill" style={{ width: `${p}%` }} />
                          </div>
                        </div>
                        <span className="wd-cloud-v">
                          <span>{c}%</span>
                          <span className="wd-precip-v">
                            {p > 0 ? `雨${p}%` : ''}
                            {mm > 0 ? `·${mm.toFixed(1)}mm` : ''}
                          </span>
                        </span>
                      </div>
                    </Fragment>
                  )
                })}
              </div>
            </>
          )}

          {w && cur && (
            <p className="panel-note">
              Open-Meteo（ECMWF/GFS）· 更新于 {cur.time.slice(11, 16)}
              {busy ? ' · 刷新中…' : ''}
            </p>
          )}

      {w && error ? <p className="panel-note">⚠ {error}</p> : null}
    </div>
  )
}
