//! QQ 音乐播放接入：搜索 → 音源流地址。
//! 播放由前端 audio 元素承担，currentTime 毫秒级驱动歌词
//! （Mineradio 同款模式：自己播，进度天生精确）。
//! 音源接口参考社区通用实现：musicu.fcg → vkey.GetVkeyServer，
//! 未登录（uin=0）可获取免费歌曲的 128k mp3 流；VIP 歌曲返回空 purl。

use serde::{Deserialize, Serialize};

const QQ_SEARCH: &str = "https://c.y.qq.com/soso/fcgi-bin/client_search_cp";
const QQ_MUSICU: &str = "https://u.y.qq.com/cgi-bin/musicu.fcg";

use base64::Engine as _;
use std::sync::{Arc, Mutex};

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct QqSong {
    pub songmid: String,
    pub name: String,
    pub singer: String,
    pub album_mid: String,
    pub duration_sec: f64,
}

fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("Kairos/0.1 (desktop assistant)")
        .build()
        .expect("failed to build http client")
}

#[tauri::command]
pub async fn qq_search_songs(keyword: String) -> Result<Vec<QqSong>, String> {
    let client = http_client();
    let resp = client
        .get(QQ_SEARCH)
        .query(&[("w", keyword.as_str()), ("format", "json"), ("n", "20")])
        .header("Referer", "https://y.qq.com/")
        .timeout(std::time::Duration::from_secs(8))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let list = json
        .pointer("/data/song/list")
        .and_then(|v| v.as_array())
        .ok_or("bad response")?;
    let mut out = Vec::new();
    for s in list {
        let songmid = s
            .get("songmid")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let name = s
            .get("songname")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        if songmid.is_empty() || name.is_empty() {
            continue;
        }
        let singers: Vec<String> = s
            .get("singer")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.get("name").and_then(|n| n.as_str()).map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        out.push(QqSong {
            songmid,
            name,
            singer: singers.join("/"),
            album_mid: s
                .get("albummid")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
            duration_sec: s.get("interval").and_then(|v| v.as_f64()).unwrap_or(0.0),
        });
    }
    Ok(out)
}

#[tauri::command]
pub async fn qq_song_url(songmid: String, app: tauri::AppHandle) -> Result<String, String> {
    let login = read_login(&app);
    let (uin, music_key) = match &login {
        Some(l) => (l.uin.clone(), Some(l.music_key.clone())),
        None => ("0".to_string(), None),
    };
    let client = http_client();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64)
        .unwrap_or(12345678);
    let guid = format!("{}", 10_000_000 + nanos % 90_000_000);
    let mut comm = serde_json::json!({ "uin": uin, "format": "json", "ct": 24, "cv": 0 });
    if let Some(k) = &music_key {
        comm["authst"] = serde_json::json!(k);
    }
    let body = serde_json::json!({
        "comm": comm,
        "req_0": {
            "module": "vkey.GetVkeyServer",
            "method": "CgiGetVkey",
            "param": {
                "guid": guid,
                "songmid": [songmid],
                "songtype": [0],
                "uin": uin,
                "loginflag": 1,
                "platform": "20",
                "filename": [format!("M500{}.mp3", songmid)]
            }
        }
    });
    let mut req = client
        .post(QQ_MUSICU)
        .json(&body)
        .header("Referer", "https://y.qq.com/")
        .timeout(std::time::Duration::from_secs(8));
    if let Some(k) = &music_key {
        req = req.header("Cookie", format!("uin={}; qm_keyst={}", uin, k));
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let purl = json
        .pointer("/req_0/data/midurlinfo/0/purl")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    if purl.is_empty() {
        let hint = if music_key.is_some() {
            "该歌曲拿不到音源（可能需要更高等级会员或区域限制）"
        } else {
            "NO_URL：该歌曲可能需要 QQ 音乐 VIP——在设置里登录 QQ 音乐账号后可播"
        };
        return Err(hint.to_string());
    }
    let sip = json
        .pointer("/req_0/data/sip/0")
        .and_then(|v| v.as_str())
        .unwrap_or("https://ws.stream.qqmusic.qq.com/");
    Ok(format!("{}{}", sip.trim_end_matches('/'), purl))
}

// ---------- QQ 音乐登录（Cookie 导入） ----------

/// 登录凭证：uin + qm_keyst（QQ 音乐播放密钥）
#[derive(Serialize, Deserialize, Clone)]
pub struct QqLogin {
    pub uin: String,
    pub music_key: String,
}

fn login_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    let dir = app.path().app_data_dir().ok()?;
    Some(dir.join("qq_login.json"))
}

fn read_login(app: &tauri::AppHandle) -> Option<QqLogin> {
    let p = login_path(app)?;
    let text = std::fs::read_to_string(p).ok()?;
    serde_json::from_str(&text).ok()
}

/// 从 cookie 字符串解析 uin + qm_keyst（兼容 qqmusic_key、微信 wxuin/wxskey）
fn parse_cookie_string(raw: &str) -> Option<QqLogin> {
    let mut uin = String::new();
    let mut key = String::new();
    for part in raw.split(';') {
        let part = part.trim();
        if let Some((k, v)) = part.split_once('=') {
            let k = k.trim().to_lowercase();
            let v = v.trim().trim_matches('"').to_string();
            match k.as_str() {
                "uin" | "qqmusic_uin" | "wxuin" | "p_uin" => {
                    if uin.is_empty() {
                        let digits: String = v.chars().filter(|c| c.is_ascii_digit()).collect();
                        uin = if digits.is_empty() { v } else { digits };
                    }
                }
                "qm_keyst" | "qqmusic_key" | "music_key" => {
                    if key.is_empty() {
                        key = v;
                    }
                }
                _ => {}
            }
        }
    }
    if uin.is_empty() || key.is_empty() {
        return None;
    }
    Some(QqLogin { uin, music_key: key })
}

/// 保存登录凭证（从 y.qq.com 浏览器会话复制的 cookie）
#[tauri::command]
pub fn qq_save_login(cookie: String, app: tauri::AppHandle) -> Result<QqLogin, String> {
    let login = parse_cookie_string(&cookie).ok_or(
        "未能从粘贴内容中解析出 uin 和 qm_keyst——请复制完整的 y.qq.com cookie",
    )?;
    let p = login_path(&app).ok_or("no app data dir")?;
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&p, serde_json::to_string(&login).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    Ok(login)
}

#[tauri::command]
pub fn qq_login_status(app: tauri::AppHandle) -> Option<QqLogin> {
    read_login(&app)
}

#[tauri::command]
pub fn qq_logout(app: tauri::AppHandle) {
    if let Some(p) = login_path(&app) {
        let _ = std::fs::remove_file(p);
    }
}

// ---------- QQ 扫码登录（ptlogin2 协议，手机 QQ 扫码） ----------
//
// 流程：ptqrshow 出二维码 → 轮询 ptqrlogin → 成功后 check_sig + OAuth authorize
// → QQConnectLogin.QQLogin 换取 musickey（存盘后 vkey 请求解锁 VIP）


/// 登录扫码会话（跨命令保活，cookie store 持有 qrsig）
#[derive(Clone)]
pub struct LoginSession {
    pub client: reqwest::Client,
    pub qrsig: String,
}

fn hash33(s: &str, h: u32) -> u32 {
    let mut h = h;
    for c in s.chars() {
        h = h.wrapping_add(h.wrapping_shl(5).wrapping_add(c as u32));
        h &= 0x7FFF_FFFF;
    }
    h
}

fn qq_http() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36")
        .build()
        .expect("failed to build qq login client")
}

/// 开始扫码登录：请求二维码，返回 base64 PNG
#[tauri::command]
pub async fn qq_login_qr_start(
    state: tauri::State<'_, Arc<LoginSessionState>>,
) -> Result<String, String> {
    let client = qq_http();
    let t = format!(
        "{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(123) as f64
            / 1_000_000_000.0
    );
    let resp = client
        .get("https://ssl.ptlogin2.qq.com/ptqrshow")
        .query(&[
            ("appid", "716027609"),
            ("e", "2"),
            ("l", "M"),
            ("s", "3"),
            ("d", "72"),
            ("v", "4"),
            ("t", t.as_str()),
            ("daid", "383"),
            ("pt_3rd_aid", "100497308"),
        ])
        .header("Referer", "https://xui.ptlogin2.qq.com/")
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let qrsig = resp
        .cookies()
        .find(|c| c.name() == "qrsig")
        .map(|c| c.value().to_string())
        .ok_or("未获取到 qrsig")?;
    let png = resp.bytes().await.map_err(|e| e.to_string())?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&png);
    *state.0.lock().unwrap() = Some(LoginSession { client, qrsig });
    Ok(b64)
}

/// 轮询扫码状态：waiting / scanned / ok / expired / failed
#[tauri::command]
pub async fn qq_login_qr_check(
    state: tauri::State<'_, Arc<LoginSessionState>>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {

    let Some(session) = state.0.lock().unwrap().clone() else {
        return Ok(serde_json::json!({ "status": "idle" }));
    };
    let ptqrtoken = hash33(&session.qrsig, 5381).to_string();
    let resp = session
        .client
        .get("https://ssl.ptlogin2.qq.com/ptqrlogin")
        .query(&[
            ("u1", "https://graph.qq.com/oauth2.0/login_jump"),
            ("ptqrtoken", ptqrtoken.as_str()),
            ("ptredirect", "0"),
            ("h", "1"),
            ("t", "1"),
            ("g", "1"),
            ("from_ui", "1"),
            ("ptlang", "2052"),
            ("action", "0-0-0"),
            ("js_ver", "20102616"),
            ("js_type", "1"),
            ("pt_uistyle", "40"),
            ("aid", "716027609"),
            ("daid", "383"),
            ("pt_3rd_aid", "100497308"),
            ("has_onekey", "1"),
        ])
        .header("Referer", "https://xui.ptlogin2.qq.com/")
        // qrsig 登录态必须显式携带（不依赖 cookie jar）
        .header("Cookie", format!("qrsig={}", session.qrsig))
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let text = resp.text().await.map_err(|e| e.to_string())?;
    // 响应形如 ptuiCB('66','0','','0','二维码未失效。')
    let inner = text
        .split("ptuiCB(")
        .nth(1)
        .and_then(|s| s.split(")").next())
        .unwrap_or("");
    let args: Vec<String> = inner
        .split('\'')
        .filter(|s| !s.trim().is_empty() || false)
        .map(|s| s.trim_matches(',').trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let Some(code_str) = args.first() else {
        eprintln!(
            "Kairos qr check: 无法解析状态, resp={}",
            &text[..text.len().min(180)]
        );
        return Ok(serde_json::json!({ "status": "failed", "message": "无法解析状态" }));
    };
    if code_str != "66" {
        eprintln!(
            "Kairos qr check: state={} resp={}",
            code_str,
            &text[..text.len().min(180)]
        );
    }
    match code_str.as_str() {
        "66" => Ok(serde_json::json!({ "status": "waiting" })),
        "67" => Ok(serde_json::json!({ "status": "scanned" })),
        "0" => {
            // args[2] 形如 https://ssl.ptlogin2.graph.qq.com/check_sig?uin=..&ptsigx=..&s_url=..
            let jump = args.get(2).cloned().unwrap_or_default();
            let sigx = jump
                .split("ptsigx=")
                .nth(1)
                .and_then(|s| s.split('&').next())
                .unwrap_or("")
                .to_string();
            let uin = jump
                .split("uin=")
                .nth(1)
                .and_then(|s| s.split('&').next())
                .unwrap_or("")
                .to_string();
            eprintln!("Kairos qr check: 扫码确认完成 uin={}，进入授权换票", uin);
            drop(state);
            finish_qq_login(app, session, uin, sigx).await
        }
        "65" => Ok(serde_json::json!({ "status": "expired" })),
        other => Ok(serde_json::json!({ "status": "failed", "code": other })),
    }
}

/// check_sig → OAuth authorize → QQLogin 换取 musickey 并保存
async fn finish_qq_login(
    app: tauri::AppHandle,
    session: LoginSession,
    uin: String,
    sigx: String,
) -> Result<serde_json::Value, String> {
    use tauri::Emitter;

    let client = session.client;
    eprintln!("Kairos qr finish: step1 check_sig");
    // 1) check_sig：获取 p_skey（显式携带 ptlogin2 域的 qrsig 登录态）
    let resp = client
        .get("https://ssl.ptlogin2.graph.qq.com/check_sig")
        .query(&[
            ("uin", uin.as_str()),
            ("pttype", "1"),
            ("service", "ptqrlogin"),
            ("nodirect", "0"),
            ("ptsigx", sigx.as_str()),
            ("s_url", "https://graph.qq.com/oauth2.0/login_jump"),
            ("ptlang", "2052"),
            ("ptredirect", "100"),
            ("aid", "716027609"),
            ("daid", "383"),
            ("j_later", "0"),
            ("low_login_hour", "0"),
            ("regmaster", "0"),
            ("pt_login_type", "3"),
            ("pt_aid", "0"),
            ("pt_aaid", "16"),
            ("pt_light", "0"),
            ("pt_3rd_aid", "100497308"),
        ])
        .header("Referer", "https://xui.ptlogin2.qq.com/")
        .header("Cookie", format!("qrsig={}", session.qrsig))
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let p_skey = resp
        .cookies()
        .find(|c| c.name() == "p_skey")
        .map(|c| c.value().to_string())
        .ok_or("获取 p_skey 失败")?;
    eprintln!("Kairos qr finish: step2 authorize (p_skey ok)");

    // 2) OAuth authorize：拿 code（显式携带 check_sig 阶段设置的 graph.qq.com 域登录态）
    let g_tk = hash33(&p_skey, 5381);
    let graph_cookies: Vec<String> = resp
        .cookies()
        .map(|c| format!("{}={}", c.name(), c.value()))
        .collect();
    let resp = client
        .post("https://graph.qq.com/oauth2.0/authorize")
        .form(&[
            ("response_type", "code"),
            ("client_id", "100497308"),
            (
                "redirect_uri",
                "https://y.qq.com/portal/wx_redirect.html?login_type=1&surl=https://y.qq.com/",
            ),
            ("scope", "get_user_info,get_app_friends"),
            ("state", "state"),
            ("switch", ""),
            ("from_ptlogin", "1"),
            ("src", "1"),
            ("update_auth", "1"),
            ("openapi", "1010_1030"),
            ("g_tk", g_tk.to_string().as_str()),
            ("auth_time", &format!("{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0))),
        ])
        .header("Referer", "https://graph.qq.com/")
        .header("Cookie", graph_cookies.join("; "))
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let location = resp
        .headers()
        .get("Location")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let code = location
        .split("code=")
        .nth(1)
        .and_then(|s| s.split('&').next())
        .unwrap_or("")
        .to_string();
    eprintln!(
        "Kairos qr finish: step3 authorize done, location={} code={}",
        &location[..location.len().min(120)],
        if code.is_empty() { "(empty)" } else { &code }
    );
    if code.is_empty() {
        return Err("获取 OAuth code 失败".into());
    }

    // 3) QQLogin：code 换 musickey
    let body = serde_json::json!({
        "comm": { "tmeLoginType": 2, "format": "json", "ct": 24, "cv": 0 },
        "req_1": {
            "module": "QQConnectLogin.LoginServer",
            "method": "QQLogin",
            "param": { "code": code }
        }
    });
    let resp = http_client()
        .post(QQ_MUSICU)
        .json(&body)
        .header("Referer", "https://y.qq.com/")
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    eprintln!(
        "Kairos qr finish: step4 QQLogin resp={}",
        &json.to_string()[..json.to_string().len().min(200)]
    );
    let data = json.pointer("/req_1/data").ok_or("QQLogin 无数据")?;
    let music_key = data
        .get("musickey")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let musicid = data
        .get("musicid")
        .and_then(|v| v.as_u64())
        .map(|v| v.to_string())
        .unwrap_or_else(|| uin.clone());
    if music_key.is_empty() {
        return Err("QQLogin 未返回 musickey".into());
    }

    // 4) 保存凭证
    let login = QqLogin {
        uin: musicid.clone(),
        music_key,
    };
    let p = login_path(&app).ok_or("no app data dir")?;
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&p, serde_json::to_string(&login).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let _ = app.emit("qq-login-ok", login.clone());
    eprintln!("Kairos: QQ QR login ok, uin={}", login.uin);
    let _ = base64::engine::general_purpose::STANDARD; // 保留引擎引用
    Ok(serde_json::json!({
        "status": "ok",
        "uin": login.uin,
    }))
}

/// 扫码会话全局状态
#[derive(Default)]
pub struct LoginSessionState(pub Mutex<Option<LoginSession>>);

/// 打开 QQ 音乐官方登录窗口：加载 y.qq.com，用户在官方页面完成登录，
/// 注入脚本检测 qm_keyst 后把凭证写进 document.title，
/// Rust 端轮询标题提取并保存（外部页面没有 Tauri IPC，title 是可靠通道）
/// （保留作为 UIA/自动化路径的备用入口）
#[tauri::command]
pub fn qq_cookie_from_webview(
    cookie: String,
    app: tauri::AppHandle,
    window: tauri::Window,
) -> Result<(), String> {
    let login = parse_cookie_string(&cookie).ok_or("cookie 解析失败")?;
    let p = login_path(&app).ok_or("no app data dir")?;
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&p, serde_json::to_string(&login).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;

    use tauri::Emitter;
    let _ = window.close(); // 关闭登录窗口
    let _ = app.emit("qq-login-ok", login.clone());
    eprintln!("Kairos: QQ login saved for uin={}", login.uin);
    Ok(())
}

/// 打开 QQ 音乐官方登录窗口（y.qq.com）。
/// 外部页面没有 Tauri IPC，凭证回传走 document.title 通道：
///   注入脚本检测 cookie 里的 qm_keyst → 写入标题 KAIROS_SIG|cookie|...
///   Rust 监控线程轮询标题提取并保存，完成后关闭窗口并通知前端。
/// 标题同时用于白屏诊断：页面 JS 若活着，标题会立即变为 KAIROS_SIG|loaded|...，
/// 日志里看不到该标记即说明页面根本没有加载（网络/WebView2 层问题）。
#[tauri::command]
pub fn open_qq_login_window(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

    if let Some(w) = app.get_webview_window("qq-login") {
        let _ = w.set_focus();
        return Ok(());
    }

    let url: tauri::Url = "https://y.qq.com/"
        .parse()
        .map_err(|e| format!("bad url: {e}"))?;

    WebviewWindowBuilder::new(&app, "qq-login", WebviewUrl::External(url))
        .title("登录 QQ 音乐（官方页面）")
        .inner_size(1100.0, 780.0)
        .initialization_script(
            r#"
            (function () {
                if (window.__kairosHook) return;
                window.__kairosHook = true;
                function put(t) {
                    try { document.title = 'KAIROS_SIG|' + t; } catch (e) {}
                }
                put('loaded|' + location.href);
                setInterval(function () {
                    try {
                        var c = document.cookie || '';
                        if (c.indexOf('qm_keyst=') !== -1 && c.indexOf('uin=') !== -1) {
                            put('cookie|' + c);
                        }
                    } catch (e) {}
                }, 800);
            })();
            "#,
        )
        .build()
        .map_err(|e| e.to_string())?;
    let _ = app.get_webview_window("qq-login").map(|w| w.set_focus());

    // 监控线程：轮询登录窗口标题（最多 3 分钟）
    let monitor = app.clone();
    std::thread::spawn(move || {
        use tauri::Emitter;
        let mut loaded_logged = false;
        let mut last_logged = String::new();
        for _ in 0..180 {
            std::thread::sleep(std::time::Duration::from_millis(1000));
            let Some(w) = monitor.get_webview_window("qq-login") else {
                eprintln!("Kairos login window: closed by user");
                return;
            };
            let title = w.title().unwrap_or_default();
            let Some(sig) = title.strip_prefix("KAIROS_SIG|") else {
                continue;
            };
            if let Some(cookie_part) = sig.strip_prefix("cookie|") {
                if let Some(login) = parse_cookie_string(cookie_part) {
                    if let Some(p) = login_path(&monitor) {
                        if let Some(dir) = p.parent() {
                            let _ = std::fs::create_dir_all(dir);
                        }
                        let save_ok = std::fs::write(
                            &p,
                            serde_json::to_string(&login).unwrap_or_default(),
                        )
                        .is_ok();
                        if save_ok {
                            let _ = monitor.emit("qq-login-ok", login.clone());
                            let _ = w.close();
                            eprintln!("Kairos: QQ login saved for uin={}", login.uin);
                        }
                    }
                    return;
                }
            } else if !loaded_logged {
                loaded_logged = true;
                eprintln!("Kairos login window: page JS alive ({})", sig);
            } else if last_logged != *sig {
                eprintln!("Kairos login window: {}", sig);
            }
            last_logged = sig.to_string();
        }
        eprintln!("Kairos login window: timeout (3min) without completed login");
    });
    Ok(())
}
