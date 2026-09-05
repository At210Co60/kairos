// 天气后端：Open-Meteo（免费无 key）——地理编码 / 预报 / 中国标准 AQI
// 与原 weather.rs 一一对应；AQI 按 HJ 633-2012 由六项污染物浓度计算

const GEO_URL = 'https://geocoding-api.open-meteo.com/v1/search'
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast'
const AIR_QUALITY_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality'

const CLIENT = { headers: { 'User-Agent': 'Kairos/0.2 (electron)' } }

async function getJson(url, params, timeoutMs = 8000) {
  const qs = new URLSearchParams(params)
  const resp = await fetch(`${url}?${qs}`, { ...CLIENT, signal: AbortSignal.timeout(timeoutMs) })
  if (!resp.ok) throw new Error(`${url} -> HTTP ${resp.status}`)
  return resp.json()
}

async function geocode(city) {
  const kw = String(city || '').trim()
  if (!kw) throw new Error('请输入城市名')
  const r = await getJson(GEO_URL, {
    name: kw,
    count: '5',
    language: 'zh',
    format: 'json',
  })
  const results = (r.results || []).map((x) => ({
    name: x.name,
    admin1: x.admin1 ?? null,
    country: x.country ?? null,
    latitude: x.latitude,
    longitude: x.longitude,
    timezone: x.timezone ?? null,
  }))
  return results
}

/** IP 定位：ipwho.is（免费无 key）→ 解析到城市，再经 geocode 换中文结果 */
async function ipLocate() {
  const resp = await fetch('https://ipwho.is/', {
    headers: { 'User-Agent': 'Kairos/0.2 (electron)' },
    signal: AbortSignal.timeout(6000),
  })
  if (!resp.ok) throw new Error('ip locate failed')
  const r = await resp.json()
  if (!r.success || !r.city) throw new Error('ip locate no city')
  // 用「城市, 地区」组合搜索，命中率更高；失败退城市名
  const query = r.region ? `${r.city}, ${r.region}` : r.city
  const places = await geocode(query)
  if (places.length) return places[0]
  const fallback = await geocode(r.city)
  if (fallback.length) return fallback[0]
  throw new Error('ip locate resolve failed')
}

// ---------- 中国 AQI（HJ 633-2012，1 小时浓度） ----------

const IAQI_TABLE = [0, 50, 100, 150, 200, 300, 400, 500]

function iaqi(conc, bp) {
  if (conc < 0) return 0
  for (let i = 1; i < 8; i++) {
    if (conc <= bp[i]) {
      const lo = bp[i - 1]
      const hi = bp[i]
      const span = hi - lo
      if (span <= 0) return IAQI_TABLE[i]
      return ((IAQI_TABLE[i] - IAQI_TABLE[i - 1]) * (conc - lo)) / span + IAQI_TABLE[i - 1]
    }
  }
  return 500
}

const BREAKPOINTS = {
  PM25: [0, 35, 75, 115, 150, 250, 350, 500],
  PM10: [0, 50, 150, 250, 350, 420, 500, 600],
  SO2: [0, 150, 500, 650, 800, 1600, 2400, Infinity],
  NO2: [0, 100, 200, 700, 1200, 2340, 3090, 3840],
  CO: [0, 5, 10, 35, 60, 90, 120, 150], // mg/m³
  O3: [0, 160, 200, 300, 400, 800, 1000, 1200],
}

function chinaAqi(pm25, pm10, so2, no2, coUgm3, o3) {
  let best = 0
  let primary = null
  const items = [
    [pm25, BREAKPOINTS.PM25, 'PM2.5'],
    [pm10, BREAKPOINTS.PM10, 'PM10'],
    [so2, BREAKPOINTS.SO2, 'SO2'],
    [no2, BREAKPOINTS.NO2, 'NO2'],
    [coUgm3 == null ? null : coUgm3 / 1000, BREAKPOINTS.CO, 'CO'],
    [o3, BREAKPOINTS.O3, 'O3'],
  ]
  for (const [conc, bp, name] of items) {
    if (conc == null) continue
    const v = iaqi(conc, bp)
    if (v > best) {
      best = v
      primary = name
    }
  }
  return { aqi: Math.round(best), primary: best > 50 ? primary : null }
}

function aqiLevel(aqi) {
  if (aqi <= 50) return '优'
  if (aqi <= 100) return '良'
  if (aqi <= 150) return '轻度污染'
  if (aqi <= 200) return '中度污染'
  if (aqi <= 300) return '重度污染'
  return '严重污染'
}

async function airQuality(latitude, longitude) {
  const r = await getJson(AIR_QUALITY_URL, {
    latitude: String(latitude),
    longitude: String(longitude),
    current: 'pm10,pm2_5,carbon_monoxide,nitrogen_dioxide,sulphur_dioxide,ozone',
    timezone: 'auto',
  })
  const cur = r.current || {}
  const { aqi, primary } = chinaAqi(
    cur.pm2_5,
    cur.pm10,
    cur.sulphur_dioxide,
    cur.nitrogen_dioxide,
    cur.carbon_monoxide,
    cur.ozone,
  )
  return {
    aqi,
    level: aqiLevel(aqi),
    primary: aqi > 50 ? primary : null,
    pm25: cur.pm2_5 ?? 0,
    pm10: cur.pm10 ?? 0,
    updatedAt: cur.time ?? '',
  }
}

async function forecast(latitude, longitude) {
  const r = await getJson(
    FORECAST_URL,
    {
      latitude: String(latitude),
      longitude: String(longitude),
      current:
        'temperature_2m,apparent_temperature,relative_humidity_2m,is_day,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,cloud_cover,uv_index',
      hourly:
        'temperature_2m,apparent_temperature,precipitation_probability,precipitation,cloud_cover,uv_index,wind_speed_10m,wind_direction_10m,weather_code',
      daily:
        'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,uv_index_max,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant,sunrise,sunset,daylight_duration',
      timezone: 'auto',
      past_days: '1',
      forecast_days: '15',
    },
    10000,
  )
  const pick = (arr, i, dflt = null) => (arr && arr[i] != null ? arr[i] : dflt)
  const hourly = (r.hourly?.time || []).map((time, i) => ({
    time,
    temperature: pick(r.hourly.temperature_2m, i, 0),
    apparentTemperature: pick(r.hourly.apparent_temperature, i, 0),
    precipProbability: pick(r.hourly.precipitation_probability, i),
    precipitation: pick(r.hourly.precipitation, i),
    cloudCover: pick(r.hourly.cloud_cover, i),
    uvIndex: pick(r.hourly.uv_index, i),
    windSpeed: pick(r.hourly.wind_speed_10m, i),
    windDirection: pick(r.hourly.wind_direction_10m, i),
    weatherCode: pick(r.hourly.weather_code, i),
  }))
  const daily = (r.daily?.time || []).map((date, i) => ({
    date,
    weatherCode: pick(r.daily.weather_code, i, 0),
    tempMax: pick(r.daily.temperature_2m_max, i, 0),
    tempMin: pick(r.daily.temperature_2m_min, i, 0),
    precipProbability: pick(r.daily.precipitation_probability_max, i),
    uvIndexMax: pick(r.daily.uv_index_max, i),
    windSpeedMax: pick(r.daily.wind_speed_10m_max, i),
    windGustsMax: pick(r.daily.wind_gusts_10m_max, i),
    windDirectionDominant: pick(r.daily.wind_direction_10m_dominant, i),
    sunrise: pick(r.daily.sunrise, i) || null,
    sunset: pick(r.daily.sunset, i) || null,
    daylightDuration: pick(r.daily.daylight_duration, i) || null,
  }))
  return {
    timezone: r.timezone || 'auto',
    current: {
      time: r.current?.time ?? '',
      temperature: r.current?.temperature_2m ?? 0,
      apparentTemperature: r.current?.apparent_temperature ?? 0,
      humidity: r.current?.relative_humidity_2m ?? 0,
      cloudCover: r.current?.cloud_cover ?? null,
      uvIndex: r.current?.uv_index ?? null,
      windSpeed: r.current?.wind_speed_10m ?? 0,
      windDirection: r.current?.wind_direction_10m ?? null,
      windGusts: r.current?.wind_gusts_10m ?? null,
      weatherCode: r.current?.weather_code ?? 0,
      isDay: (r.current?.is_day ?? 1) === 1,
    },
    hourly,
    daily,
  }
}

module.exports = { geocode, forecast, airQuality, ipLocate }
