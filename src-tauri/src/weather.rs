//! 天气接入：Open-Meteo（免费、无需 API key）。
//! 数据同源说明：天文通的小时预报基于 ECMWF（附 GFS 晴天钟），
//! Open-Meteo 聚合的正是 ECMWF IFS + GFS 等模型，字段对齐。
//! weather_geocode：城市名 → 经纬度候选列表（中文结果）；
//! weather_forecast：经纬度 → 实况 + 未来 48h 逐小时 + 逐日预报；
//! weather_air_quality：经纬度 → 六项污染物浓度，按 HJ 633-2012 计算
//! 中国标准 AQI（Open-Meteo 只给浓度与美国 AQI，不含中国 AQI）。
//! 天气代码（WMO）/风级/紫外线等级等展示层映射放在前端。

use serde::{Deserialize, Serialize};

const GEO_URL: &str = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL: &str = "https://api.open-meteo.com/v1/forecast";
const AIR_QUALITY_URL: &str = "https://air-quality-api.open-meteo.com/v1/air-quality";

fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("Kairos/0.1 (desktop assistant)")
        .build()
        .expect("failed to build weather http client")
}

#[derive(Debug, Deserialize)]
struct GeoResponse {
    #[serde(default)]
    results: Vec<GeoPlace>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeoPlace {
    pub name: String,
    pub admin1: Option<String>,
    pub country: Option<String>,
    pub latitude: f64,
    pub longitude: f64,
    pub timezone: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WeatherData {
    pub timezone: String,
    pub current: CurrentWeather,
    pub hourly: Vec<HourlyPoint>,
    pub daily: Vec<DailyForecast>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentWeather {
    pub time: String,
    pub temperature: f64,
    pub apparent_temperature: f64,
    pub humidity: i64,
    pub cloud_cover: Option<i64>,
    pub uv_index: Option<f64>,
    pub wind_speed: f64,
    pub wind_direction: Option<f64>,
    pub wind_gusts: Option<f64>,
    pub weather_code: i64,
    pub is_day: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HourlyPoint {
    pub time: String,
    pub temperature: f64,
    pub apparent_temperature: f64,
    pub precip_probability: Option<i64>,
    pub precipitation: Option<f64>,
    pub cloud_cover: Option<i64>,
    pub uv_index: Option<f64>,
    pub wind_speed: Option<f64>,
    pub wind_direction: Option<f64>,
    pub weather_code: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyForecast {
    pub date: String,
    pub weather_code: i64,
    pub temp_max: f64,
    pub temp_min: f64,
    pub precip_probability: Option<i64>,
    pub uv_index_max: Option<f64>,
    pub wind_speed_max: Option<f64>,
    pub wind_gusts_max: Option<f64>,
    pub wind_direction_dominant: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct ForecastResponse {
    #[serde(default)]
    timezone: String,
    current: Option<ForecastCurrent>,
    hourly: Option<ForecastHourly>,
    daily: Option<ForecastDaily>,
}

#[derive(Debug, Deserialize)]
struct ForecastCurrent {
    time: String,
    temperature_2m: f64,
    apparent_temperature: f64,
    relative_humidity_2m: i64,
    cloud_cover: Option<i64>,
    uv_index: Option<f64>,
    wind_speed_10m: f64,
    wind_direction_10m: Option<f64>,
    wind_gusts_10m: Option<f64>,
    weather_code: i64,
    is_day: i64,
}

#[derive(Debug, Deserialize)]
struct ForecastHourly {
    time: Vec<String>,
    temperature_2m: Vec<Option<f64>>,
    apparent_temperature: Vec<Option<f64>>,
    #[serde(default)]
    precipitation_probability: Vec<Option<i64>>,
    #[serde(default)]
    precipitation: Vec<Option<f64>>,
    #[serde(default)]
    cloud_cover: Vec<Option<i64>>,
    #[serde(default)]
    uv_index: Vec<Option<f64>>,
    #[serde(default)]
    wind_speed_10m: Vec<Option<f64>>,
    #[serde(default)]
    wind_direction_10m: Vec<Option<f64>>,
    #[serde(default)]
    weather_code: Vec<Option<i64>>,
}

#[derive(Debug, Deserialize)]
struct ForecastDaily {
    time: Vec<String>,
    weather_code: Vec<i64>,
    temperature_2m_max: Vec<f64>,
    temperature_2m_min: Vec<f64>,
    #[serde(default)]
    precipitation_probability_max: Vec<Option<i64>>,
    #[serde(default)]
    uv_index_max: Vec<Option<f64>>,
    #[serde(default)]
    wind_speed_10m_max: Vec<Option<f64>>,
    #[serde(default)]
    wind_gusts_10m_max: Vec<Option<f64>>,
    #[serde(default)]
    wind_direction_10m_dominant: Vec<Option<f64>>,
}

fn opt_at<T: Copy>(v: &[Option<T>], i: usize) -> Option<T> {
    v.get(i).copied().flatten()
}

#[tauri::command]
pub async fn weather_geocode(city: String) -> Result<Vec<GeoPlace>, String> {
    let city = city.trim();
    if city.is_empty() {
        return Err("请输入城市名".into());
    }
    http_client()
        .get(GEO_URL)
        .query(&[
            ("name", city),
            ("count", "5"),
            ("language", "zh"),
            ("format", "json"),
        ])
        .timeout(std::time::Duration::from_secs(8))
        .send()
        .await
        .map_err(|e| format!("城市查询失败：{e}"))?
        .json::<GeoResponse>()
        .await
        .map_err(|e| format!("城市数据解析失败：{e}"))
        .map(|r| r.results)
}

#[tauri::command]
pub async fn weather_forecast(latitude: f64, longitude: f64) -> Result<WeatherData, String> {
    let resp: ForecastResponse = http_client()
        .get(FORECAST_URL)
        .query(&[
            ("latitude", latitude.to_string()),
            ("longitude", longitude.to_string()),
            (
                "current",
                "temperature_2m,apparent_temperature,relative_humidity_2m,is_day,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,cloud_cover,uv_index"
                    .to_string(),
            ),
            (
                "hourly",
                "temperature_2m,apparent_temperature,precipitation_probability,precipitation,cloud_cover,uv_index,wind_speed_10m,wind_direction_10m,weather_code"
                    .to_string(),
            ),
            (
                "daily",
                "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,uv_index_max,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant"
                    .to_string(),
            ),
            ("timezone", "auto".to_string()),
            ("forecast_days", "15".to_string()),
        ])
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("天气请求失败：{e}"))?
        .json()
        .await
        .map_err(|e| format!("天气数据解析失败：{e}"))?;

    let current = resp.current.ok_or("天气响应缺少 current 字段")?;
    let daily = resp.daily.ok_or("天气响应缺少 daily 字段")?;
    let hourly_raw = resp.hourly.ok_or("天气响应缺少 hourly 字段")?;

    let days: Vec<DailyForecast> = daily
        .time
        .iter()
        .enumerate()
        .map(|(i, date)| DailyForecast {
            date: date.clone(),
            weather_code: *daily.weather_code.get(i).unwrap_or(&0),
            temp_max: *daily.temperature_2m_max.get(i).unwrap_or(&0.0),
            temp_min: *daily.temperature_2m_min.get(i).unwrap_or(&0.0),
            precip_probability: opt_at(&daily.precipitation_probability_max, i),
            uv_index_max: opt_at(&daily.uv_index_max, i),
            wind_speed_max: opt_at(&daily.wind_speed_10m_max, i),
            wind_gusts_max: opt_at(&daily.wind_gusts_10m_max, i),
            wind_direction_dominant: opt_at(&daily.wind_direction_10m_dominant, i),
        })
        .collect();

    let hourly: Vec<HourlyPoint> = hourly_raw
        .time
        .iter()
        .enumerate()
        .map(|(i, t)| HourlyPoint {
            time: t.clone(),
            temperature: hourly_raw
                .temperature_2m
                .get(i)
                .copied()
                .flatten()
                .unwrap_or(0.0),
            apparent_temperature: hourly_raw
                .apparent_temperature
                .get(i)
                .copied()
                .flatten()
                .unwrap_or(0.0),
            precip_probability: opt_at(&hourly_raw.precipitation_probability, i),
            precipitation: opt_at(&hourly_raw.precipitation, i),
            cloud_cover: opt_at(&hourly_raw.cloud_cover, i),
            uv_index: opt_at(&hourly_raw.uv_index, i),
            wind_speed: opt_at(&hourly_raw.wind_speed_10m, i),
            wind_direction: opt_at(&hourly_raw.wind_direction_10m, i),
            weather_code: opt_at(&hourly_raw.weather_code, i),
        })
        .collect();

    Ok(WeatherData {
        timezone: if resp.timezone.is_empty() {
            "auto".into()
        } else {
            resp.timezone
        },
        current: CurrentWeather {
            time: current.time,
            temperature: current.temperature_2m,
            apparent_temperature: current.apparent_temperature,
            humidity: current.relative_humidity_2m,
            cloud_cover: current.cloud_cover,
            uv_index: current.uv_index,
            wind_speed: current.wind_speed_10m,
            wind_direction: current.wind_direction_10m,
            wind_gusts: current.wind_gusts_10m,
            weather_code: current.weather_code,
            is_day: current.is_day == 1,
        },
        hourly,
        daily: days,
    })
}

// ===== 空气质量（中国标准 AQI） =====

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AirQuality {
    pub aqi: u32,
    pub level: String,
    pub primary: Option<String>,
    pub pm25: f64,
    pub pm10: f64,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
struct AqResponse {
    current: Option<AqCurrent>,
}

#[derive(Debug, Deserialize)]
struct AqCurrent {
    #[serde(default)]
    time: String,
    pm10: Option<f64>,
    pm2_5: Option<f64>,
    carbon_monoxide: Option<f64>,
    nitrogen_dioxide: Option<f64>,
    sulphur_dioxide: Option<f64>,
    ozone: Option<f64>,
}

/// 单项污染物 IAQI：浓度在断点区间内线性插值，超出最高断点记 500。
fn iaqi(conc: f64, breakpoints: &[f64; 8]) -> f64 {
    const IAQI: [f64; 8] = [0.0, 50.0, 100.0, 150.0, 200.0, 300.0, 400.0, 500.0];
    if conc < 0.0 {
        return 0.0;
    }
    for i in 1..8 {
        if conc <= breakpoints[i] {
            let (lo, hi) = (breakpoints[i - 1], breakpoints[i]);
            let span = hi - lo;
            if span <= 0.0 {
                return IAQI[i];
            }
            return (IAQI[i] - IAQI[i - 1]) * (conc - lo) / span + IAQI[i - 1];
        }
    }
    500.0
}

/// 中国 AQI（HJ 633-2012）：六项污染物 1 小时浓度分别算 IAQI，取最大值，
/// 最大项为首要污染物。CO 接口单位 μg/m³，标准断点为 mg/m³，需 /1000。
fn china_aqi(
    pm25: Option<f64>,
    pm10: Option<f64>,
    so2: Option<f64>,
    no2: Option<f64>,
    co_ugm3: Option<f64>,
    o3: Option<f64>,
) -> (u32, Option<&'static str>) {
    let items: [(Option<f64>, [f64; 8], &str); 6] = [
        (
            pm25,
            [0.0, 35.0, 75.0, 115.0, 150.0, 250.0, 350.0, 500.0],
            "PM2.5",
        ),
        (
            pm10,
            [0.0, 50.0, 150.0, 250.0, 350.0, 420.0, 500.0, 600.0],
            "PM10",
        ),
        (
            so2,
            [0.0, 150.0, 500.0, 650.0, 800.0, 1600.0, 2400.0, f64::INFINITY],
            "SO₂",
        ),
        (
            no2,
            [0.0, 100.0, 200.0, 700.0, 1200.0, 2340.0, 3090.0, 3840.0],
            "NO₂",
        ),
        (
            co_ugm3.map(|v| v / 1000.0),
            [0.0, 5.0, 10.0, 35.0, 60.0, 90.0, 120.0, 150.0],
            "CO",
        ),
        (
            o3,
            [0.0, 160.0, 200.0, 300.0, 400.0, 800.0, 1000.0, 1200.0],
            "O₃",
        ),
    ];
    let mut best = 0.0f64;
    let mut primary = None;
    for (conc, bp, name) in items {
        if let Some(c) = conc {
            let v = iaqi(c, &bp);
            if v > best {
                best = v;
                primary = Some(name);
            }
        }
    }
    (best.round() as u32, primary)
}

fn aqi_level(aqi: u32) -> &'static str {
    match aqi {
        0..=50 => "优",
        51..=100 => "良",
        101..=150 => "轻度污染",
        151..=200 => "中度污染",
        201..=300 => "重度污染",
        _ => "严重污染",
    }
}

#[tauri::command]
pub async fn weather_air_quality(latitude: f64, longitude: f64) -> Result<AirQuality, String> {
    let resp: AqResponse = http_client()
        .get(AIR_QUALITY_URL)
        .query(&[
            ("latitude", latitude.to_string()),
            ("longitude", longitude.to_string()),
            (
                "current",
                "pm10,pm2_5,carbon_monoxide,nitrogen_dioxide,sulphur_dioxide,ozone".to_string(),
            ),
            ("timezone", "auto".to_string()),
        ])
        .timeout(std::time::Duration::from_secs(8))
        .send()
        .await
        .map_err(|e| format!("空气质量请求失败：{e}"))?
        .json()
        .await
        .map_err(|e| format!("空气质量解析失败：{e}"))?;

    let cur = resp.current.ok_or("空气质量响应缺少 current 字段")?;
    let (aqi, primary) = china_aqi(
        cur.pm2_5,
        cur.pm10,
        cur.sulphur_dioxide,
        cur.nitrogen_dioxide,
        cur.carbon_monoxide,
        cur.ozone,
    );
    Ok(AirQuality {
        aqi,
        level: aqi_level(aqi).into(),
        primary: if aqi > 50 { primary.map(Into::into) } else { None },
        pm25: cur.pm2_5.unwrap_or(0.0),
        pm10: cur.pm10.unwrap_or(0.0),
        updated_at: cur.time,
    })
}
