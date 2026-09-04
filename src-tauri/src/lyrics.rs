//! 歌词获取，两级来源：
//! 1. QQ 音乐接口（搜索 -> songmid -> LRC），曲库与 QQ 音乐完全对齐
//! 2. LRCLIB（https://lrclib.net）兜底
//! 查不到 => 前端按纯音乐处理（不显示歌词）。

use std::collections::HashMap;
use std::sync::Mutex;

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tauri::State;

const QQ_SEARCH: &str = "https://c.y.qq.com/soso/fcgi-bin/client_search_cp";
const QQ_LYRIC: &str = "https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg";
const LRCLIB_API: &str = "https://lrclib.net/api/search";

#[derive(Deserialize)]
struct LrcLibHit {
    #[serde(default)]
    instrumental: bool,
    #[serde(default)]
    plain_lyrics: Option<String>,
    #[serde(default)]
    synced_lyrics: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct LyricLine {
    pub time: f64,
    pub text: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LyricsPayload {
    /// true = 命中歌词（synced 或 plain）
    pub found: bool,
    /// true = 有逐行时间戳，可卡拉OK滚动
    pub synced: bool,
    /// true = LRCLIB 明确标记为纯音乐
    pub instrumental: bool,
    pub plain: Option<String>,
    pub lines: Vec<LyricLine>,
}

pub struct LyricsCache(pub Mutex<HashMap<String, LyricsPayload>>);

fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("Kairos/0.1 (desktop assistant)")
        .build()
        .expect("failed to build http client")
}

fn parse_time_tag(tag: &str) -> Option<f64> {
    let (m, s) = tag.split_once(':')?;
    let m: f64 = m.trim().parse().ok()?;
    let s: f64 = s.trim().parse().ok()?;
    Some(m * 60.0 + s)
}

/// 解析 LRC：支持一行多个时间戳；忽略 [ti:]/[ar:] 等元数据标签
fn parse_lrc(raw: &str) -> Vec<LyricLine> {
    let mut out = Vec::new();
    for line in raw.lines() {
        let mut rest = line.trim_start();
        let mut times = Vec::new();
        while let Some(inner) = rest.strip_prefix('[') {
            let Some(end) = inner.find(']') else { break };
            match parse_time_tag(&inner[..end]) {
                Some(t) => {
                    times.push(t);
                    rest = &inner[end + 1..];
                }
                None => break,
            }
        }
        if times.is_empty() {
            continue;
        }
        let text = rest.trim().to_string();
        for t in times {
            out.push(LyricLine { time: t, text: text.clone() });
        }
    }
    out.sort_by(|a, b| a.time.partial_cmp(&b.time).unwrap_or(std::cmp::Ordering::Equal));
    out
}

/// QQ 音乐：搜索关键词拿前几个 songmid，逐个取 LRC
async fn query_qq_music(title: &str, artist: &str) -> Option<Vec<LyricLine>> {
    let client = http_client();
    let query = format!("{title} {artist}");

    let resp = client
        .get(QQ_SEARCH)
        .query(&[("w", query.as_str()), ("format", "json"), ("n", "3")])
        .header("Referer", "https://y.qq.com/")
        .timeout(std::time::Duration::from_secs(8))
        .send()
        .await
        .ok()?
        .json::<serde_json::Value>()
        .await
        .ok()?;

    let songs = resp.pointer("/data/song/list")?.as_array()?;
    let mut candidates: Vec<(String, String)> = songs
        .iter()
        .filter_map(|s| {
            let mid = s.get("songmid")?.as_str()?.to_string();
            let name = s.get("songname")?.as_str()?.to_string();
            Some((mid, name))
        })
        .collect();
    // 按歌名与目标的相似度排序：完全同名 > 包含 > 其余。
    // 避免 "Arc" 命中 "Arc-en-ciel" 这类相关性搜索的错配
    let title_lc = title.to_lowercase();
    candidates.sort_by_key(|(_, name)| {
        let n = name.to_lowercase();
        if n == title_lc {
            0
        } else if n.contains(&title_lc) || title_lc.contains(&n) {
            1
        } else {
            2
        }
    });
    // 候选全都不含目标歌名关键词：相关性搜索结果不可信，弃用
    // （交给 LRCLIB 兜底），防止张冠李戴的歌词
    let top_match = candidates
        .first()
        .map(|(_, name)| {
            let n = name.to_lowercase();
            n.contains(&title_lc) || title_lc.contains(&n)
        })
        .unwrap_or(false);
    if !top_match {
        return None;
    }

    for (mid, _) in candidates {
        let Ok(resp) = client
            .get(QQ_LYRIC)
            .query(&[
                ("songmid", mid.as_str()),
                ("g_tk", "5381"),
                ("format", "json"),
                ("nobase64", "0"),
            ])
            .header("Referer", "https://c.y.qq.com/")
            .timeout(std::time::Duration::from_secs(8))
            .send()
            .await
        else {
            continue;
        };
        let Ok(json) = resp.json::<serde_json::Value>().await else {
            continue;
        };
        let Some(b64) = json.get("lyric").and_then(|v| v.as_str()) else {
            continue;
        };
        let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(b64) else {
            continue;
        };
        let Ok(text) = String::from_utf8(bytes) else {
            continue;
        };
        let lines = parse_lrc(&text);
        if !lines.is_empty() {
            return Some(lines);
        }
    }
    None
}

async fn query_lrclib(title: &str, artist: &str) -> Option<Vec<LrcLibHit>> {
    let client = http_client();
    let resp = client
        .get(LRCLIB_API)
        .query(&[("track_name", title), ("artist_name", artist)])
        .timeout(std::time::Duration::from_secs(8))
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    resp.json::<Vec<LrcLibHit>>().await.ok()
}

#[tauri::command]
pub async fn fetch_lyrics(
    title: String,
    artist: String,
    cache: State<'_, LyricsCache>,
) -> Result<LyricsPayload, String> {
    let key = format!("{artist}|{title}");
    if let Some(hit) = cache.0.lock().unwrap().get(&key) {
        return Ok(hit.clone());
    }

    // 1. QQ 音乐接口（同步 LRC）
    if let Some(lines) = query_qq_music(&title, &artist).await {
        let payload = LyricsPayload {
            found: true,
            synced: true,
            instrumental: false,
            plain: None,
            lines,
        };
        cache.0.lock().unwrap().insert(key, payload.clone());
        return Ok(payload);
    }

    // 2. LRCLIB 兜底
    let hits = query_lrclib(&title, &artist).await.unwrap_or_default();

    let payload = if let Some(hit) = hits
        .iter()
        .find(|h| h.synced_lyrics.as_deref().is_some_and(|s| !s.trim().is_empty()))
    {
        LyricsPayload {
            found: true,
            synced: true,
            instrumental: false,
            plain: None,
            lines: parse_lrc(hit.synced_lyrics.as_deref().unwrap()),
        }
    } else if let Some(hit) = hits
        .iter()
        .find(|h| !h.instrumental && h.plain_lyrics.as_deref().is_some_and(|s| !s.trim().is_empty()))
    {
        LyricsPayload {
            found: true,
            synced: false,
            instrumental: false,
            plain: hit.plain_lyrics.clone(),
            lines: Vec::new(),
        }
    } else {
        let marked_instrumental = hits.iter().any(|h| h.instrumental);
        LyricsPayload {
            found: false,
            synced: false,
            instrumental: marked_instrumental,
            plain: None,
            lines: Vec::new(),
        }
    };

    cache.0.lock().unwrap().insert(key, payload.clone());
    Ok(payload)
}
