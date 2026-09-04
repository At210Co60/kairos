//! Windows 系统媒体会话（GSMT/SMTC）轮询：
//! 从系统拿到"正在播放什么"（QQ 音乐等任何注册媒体会话的播放器），
//! 推送给前端。封面元数据仅在变化时推送，进度按 300ms 推送。
//!
//! 进度策略：优先 SMTC timeline（网易云等正常上报的播放器）；
//! QQ 音乐不上报（Position/EndTime 恒为 0），退回本地秒表——
//! 切歌即从 0 计时，暂停冻结、恢复继续。
//! 会话短暂消失（QQ 暂停/切后台时可能注销会话）进入 20s 宽限期：
//! 冻结进度与界面，期间恢复则无缝续上，超时才真正清空。

use base64::Engine as _;
use serde::Serialize;
use std::sync::{Arc, Mutex};
use tauri::Emitter;
use windows::core::RuntimeType;
use windows_future::IAsyncOperation;
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession,
    GlobalSystemMediaTransportControlsSessionManager,
    GlobalSystemMediaTransportControlsSessionMediaProperties,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus,
};
use windows::Storage::Streams::DataReader;

/// 本地秒表状态：轮询线程与"歌词对齐"命令共享
#[derive(Default)]
pub struct PlaybackInner {
    pub cur_song: String,
    pub base_pos: f64,
    pub base_at: Option<std::time::Instant>,
}
pub struct PlaybackState(pub Mutex<PlaybackInner>, pub Mutex<Vec<(f64, String)>>);

impl Default for PlaybackState {
    fn default() -> Self {
        PlaybackState(Mutex::new(PlaybackInner::default()), Mutex::new(Vec::new()))
    }
}

/// 在轮询线程里阻塞等待 WinRT 异步操作（windows 0.62 移除了 .get()，
/// IAsyncOperation 实现 IntoFuture，用 tauri 的 tokio runtime 等待）
fn wait_async<T: RuntimeType>(op: IAsyncOperation<T>) -> windows::core::Result<T> {
    use std::future::IntoFuture;
    tauri::async_runtime::block_on(op.into_future())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TrackMeta {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub playing: bool,
    pub cover_base64: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackProgress {
    pub title: String,
    pub artist: String,
    pub playing: bool,
    pub position_sec: f64,
    pub duration_sec: f64,
}

fn is_playing(status: GlobalSystemMediaTransportControlsSessionPlaybackStatus) -> bool {
    status == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing
}

fn session_playing(s: &GlobalSystemMediaTransportControlsSession) -> bool {
    s.GetPlaybackInfo()
        .ok()
        .and_then(|p| p.PlaybackStatus().ok())
        .map(is_playing)
        .unwrap_or(false)
}

fn source_id(s: &GlobalSystemMediaTransportControlsSession) -> String {
    s.SourceAppUserModelId().map(|id| id.to_string()).unwrap_or_default()
}

fn cover_to_data_uri(
    props: &GlobalSystemMediaTransportControlsSessionMediaProperties,
) -> Option<String> {
    let op = props.Thumbnail().ok()?.OpenReadAsync().ok()?;
    let stream = wait_async(op).ok()?;
    let mime = stream.ContentType().ok().map(|c| c.to_string());
    let size = stream.Size().ok()? as u32;
    if size == 0 {
        return None;
    }
    let reader = DataReader::CreateDataReader(&stream).ok()?;
    let loaded = wait_async(reader.LoadAsync(size).ok()?).ok()? as usize;
    let mut buf = vec![0u8; loaded];
    reader.ReadBytes(&mut buf).ok()?;
    // ContentType 可能是脏的逗号列表（如 "image/jpeg,image/jpe,image/jpg"），
    // 用文件头 magic bytes 判断最可靠
    let content_type = if buf.starts_with(&[0x89, b'P', b'N', b'G']) {
        "image/png"
    } else if buf.starts_with(&[0xFF, 0xD8]) {
        "image/jpeg"
    } else {
        match mime.as_deref() {
            Some(m) if m.starts_with("image/") && !m.contains(',') => m,
            _ => "image/png",
        }
    };
    let b64 = base64::engine::general_purpose::STANDARD.encode(&buf);
    Some(format!("data:{};base64,{}", content_type, b64))
}

const SESSION_GRACE: std::time::Duration = std::time::Duration::from_secs(20);

// ---------- 自动对齐引擎：OCR 读取 QQ 音乐桌面歌词 ----------
//
// QQ 音乐不向系统上报播放进度（也不上报 seek），秒表无法感知跳进度。
// 但 QQ 音乐的"桌面歌词"文字是精确同步的，因此：
//   1. 找到桌面歌词窗口（QQ 进程内置顶的扁宽 TXGuiFoundation 小窗）
//   2. 定期截图 → Windows 内置 OCR 识别文字
//   3. 与当前 LRC 匹配出对应行 → 拿到精确时间戳 → 校准秒表
// 这样 seek、中途启动等场景全部自动对齐。

fn find_lyric_window() -> Option<windows::Win32::Foundation::HWND> {    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetWindowLongPtrW, GetWindowRect, GetWindowThreadProcessId,
        IsWindowVisible, GWL_EXSTYLE, WS_EX_TOPMOST,
    };
    use windows::core::BOOL;

    unsafe extern "system" fn enum_cb(hwnd: HWND, _: LPARAM) -> BOOL {
        unsafe {
            let mut pid: u32 = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            // 桌面歌词特征：QQ 进程、可见、置顶、扁宽小窗（高度 30~250）
            if pid == 0
                || !IsWindowVisible(hwnd).as_bool()
                || !is_qqmusic_process(pid)
            {
                return true.into();
            }
            let mut rect = windows::Win32::Foundation::RECT::default();
            let _ = GetWindowRect(hwnd, &mut rect);
            let w = rect.right - rect.left;
            let h = rect.bottom - rect.top;
            if !(200..=1600).contains(&w) || !(30..=250).contains(&h) {
                return true.into();
            }
            let topmost = (GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32 & WS_EX_TOPMOST.0) != 0;
            if !topmost {
                return true.into();
            }
            let mut buf = [0u16; 64];
            let cls_len = GetClassNameW(hwnd, &mut buf) as usize;
            let class = String::from_utf16_lossy(&buf[..cls_len]);
            if class == "TXGuiFoundation" {
                LYRIC_HWND.with(|c| *c.borrow_mut() = Some(hwnd));
            }
        }
        true.into()
    }

    thread_local! {
        static LYRIC_HWND: std::cell::RefCell<Option<HWND>> = const { std::cell::RefCell::new(None) };
    }
    LYRIC_HWND.with(|c| *c.borrow_mut() = None);
    unsafe {
        let _ = EnumWindows(Some(enum_cb), LPARAM(0));
    }
    LYRIC_HWND.with(|c| *c.borrow())
}

fn capture_window_ocr(
    hwnd: windows::Win32::Foundation::HWND,
    ocr: &windows::Media::Ocr::OcrEngine,
    bottom_crop: bool,
) -> Option<String> {
    use windows::Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap};
    use windows::Security::Cryptography::CryptographicBuffer;
    use windows::Win32::Foundation::RECT;
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
        ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    };
    use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
    use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;

    unsafe {
        let mut rect = RECT::default();
        let _ = GetWindowRect(hwnd, &mut rect);
        let w = (rect.right - rect.left).max(1);
        let h = (rect.bottom - rect.top).max(1);
        if w > 2400 || h > 1600 {
            return None;
        }

        let hdc_screen = GetDC(None);
        let hdc_mem = CreateCompatibleDC(Some(hdc_screen));
        let bmp = CreateCompatibleBitmap(hdc_screen, w, h);
        let old = SelectObject(hdc_mem, bmp.into());
        // PW_CLIENTONLY(1) | PW_RENDERFULLCONTENT(2)：自绘窗口必须带 RENDERFULLCONTENT
        let ok = PrintWindow(hwnd, hdc_mem, PRINT_WINDOW_FLAGS(3)).as_bool();
        let mut pixels: Vec<u8> = vec![0; (w * h * 4) as usize];
        let mut copied = 0i32;
        if ok {
            let mut info = BITMAPINFO::default();
            info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
            info.bmiHeader.biWidth = w;
            info.bmiHeader.biHeight = -h; // 自顶向下
            info.bmiHeader.biPlanes = 1;
            info.bmiHeader.biBitCount = 32;
            info.bmiHeader.biCompression = BI_RGB.0;
            copied = GetDIBits(
                hdc_mem,
                bmp,
                0,
                h as u32,
                Some(pixels.as_mut_ptr() as *mut _),
                &mut info,
                DIB_RGB_COLORS,
            );
        }
        SelectObject(hdc_mem, old);
        let _ = DeleteObject(bmp.into());
        let _ = DeleteDC(hdc_mem);
        ReleaseDC(Some(hwnd), hdc_screen);
        if !ok || copied == 0 {
            return None;
        }

        // BGRA → Gray8（alpha 由 PrintWindow 输出不可靠，灰度化规避）。
        // bottom_crop=true 时只取最底部 ~95px 的播放条（进度时间在那里），
        // 最近邻 4 倍放大 + 自适应二值化——小字 + 深色主题下识别率的关键
        let crop_y: i32 = if bottom_crop { (h - 95).max(0) } else { 0 };
        let crop_h = h - crop_y;
        let scale: usize = if bottom_crop { 4 } else { 1 };
        let gw = (w as usize) * scale;
        let gh = (crop_h as usize) * scale;
        let mut gray = Vec::with_capacity(gw * gh);
        for y in crop_y..h {
            let row = ((y * w) as usize) * 4;
            for _s in 0..scale {
                for x in 0..w {
                    let px = &pixels[row + (x as usize) * 4..row + (x as usize) * 4 + 4];
                    let g = ((px[2] as u32 * 299 + px[1] as u32 * 587 + px[0] as u32 * 114) / 1000)
                        as u8;
                    for _sx in 0..scale {
                        gray.push(g);
                    }
                }
            }
        }
        // 自适应二值化：亮于均值 → 白，否则 → 黑（文字与背景彻底分离）
        if bottom_crop && !gray.is_empty() {
            let avg: u64 = gray.iter().map(|v| *v as u64).sum::<u64>() / gray.len() as u64;
            for v in gray.iter_mut() {
                *v = if *v as u64 > avg { 255 } else { 0 };
            }
        }
        let buffer = CryptographicBuffer::CreateFromByteArray(&gray).ok()?;
        let bitmap = SoftwareBitmap::CreateCopyFromBuffer(
            &buffer,
            BitmapPixelFormat::Gray8,
            gw as i32,
            gh as i32,
        )
        .ok()?;

        let result = wait_async(ocr.RecognizeAsync(&bitmap).ok()?).ok()?;
        let text = result.Text().ok()?.to_string();
        if text.trim().is_empty() {
            return None;
        }
        Some(text)
    }
}

fn normalize_text(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// 在 LRC 里找与 OCR 文字最匹配的行，返回该行时间戳
fn match_lyric_line(ocr_text: &str, lines: &[(f64, String)]) -> Option<f64> {
    let n_ocr = normalize_text(ocr_text);
    if n_ocr.chars().count() < 4 {
        return None;
    }
    let mut ocr_cnt: std::collections::HashMap<char, i32> = std::collections::HashMap::new();
    for c in n_ocr.chars() {
        *ocr_cnt.entry(c).or_insert(0) += 1;
    }
    let mut best = (0.0f64, None);
    for (t, text) in lines {
        let n = normalize_text(text);
        if n.chars().count() < 3 {
            continue;
        }
        let mut cnt: std::collections::HashMap<char, i32> = std::collections::HashMap::new();
        for c in n.chars() {
            *cnt.entry(c).or_insert(0) += 1;
        }
        let inter: i32 = cnt
            .iter()
            .map(|(c, k)| k.min(ocr_cnt.get(c).unwrap_or(&0)))
            .sum();
        let score = 2.0 * inter as f64 / (n.len() + n_ocr.len()) as f64;
        if score > best.0 {
            best = (score, Some(*t));
        }
    }
    if best.0 > 0.55 {
        best.1
    } else {
        None
    }
}

/// 找 QQ 音乐主窗口：进程内最大的可见 TXGuiFoundation 窗口
fn find_main_window() -> Option<(windows::Win32::Foundation::HWND, i32, i32)> {
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetWindowRect, GetWindowThreadProcessId, IsWindowVisible,
    };
    use windows::core::BOOL;

    thread_local! {
        static BEST: std::cell::RefCell<Option<(HWND, i32, i32)>> = const { std::cell::RefCell::new(None) };
    }
    BEST.with(|b| *b.borrow_mut() = None);

    unsafe extern "system" fn enum_cb(hwnd: HWND, _: LPARAM) -> BOOL {
        unsafe {
            let mut pid: u32 = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid == 0 || !IsWindowVisible(hwnd).as_bool() || !is_qqmusic_process(pid) {
                return true.into();
            }
            let mut buf = [0u16; 64];
            let cls_len = GetClassNameW(hwnd, &mut buf) as usize;
            if cls_len == 0 || String::from_utf16_lossy(&buf[..cls_len]) != "TXGuiFoundation" {
                return true.into();
            }
            let mut rect = windows::Win32::Foundation::RECT::default();
            let _ = GetWindowRect(hwnd, &mut rect);
            let w = rect.right - rect.left;
            let h = rect.bottom - rect.top;
            if w < 500 || h < 300 {
                return true.into();
            }
            BEST.with(|b| {
                let mut best = b.borrow_mut();
                let bigger = best.map(|(_, bw, bh)| w * h > bw * bh).unwrap_or(true);
                if bigger {
                    *best = Some((hwnd, w, h));
                }
            });
        }
        true.into()
    }

    unsafe {
        let _ = EnumWindows(Some(enum_cb), LPARAM(0));
    }
    BEST.with(|b| *b.borrow())
}

/// 从 OCR 文本解析 "01:23/04:56" 形式的进度：返回当前时间（秒）。
/// OCR 输出的冒号可能是全角/异形，且数字间可能被塞进空格，
/// 因此策略是：去掉全部空白 → 按非数字切出数字组 → 从文本末尾
/// 往前两两配对成（分, 秒）——时间显示在播放条右端，倒序配对
/// 天然避开歌名里的数字干扰。
fn parse_progress_text(text: &str) -> Option<f64> {
    let cleaned: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    let mut nums: Vec<f64> = Vec::new();
    for token in cleaned.split(|c: char| !c.is_ascii_digit()) {
        if !token.is_empty() {
            if let Ok(v) = token.parse::<u32>() {
                nums.push(v as f64);
            }
        }
    }
    if nums.len() < 4 {
        return None;
    }
    let n = nums.len();
    let total_m = nums[n - 2];
    let total_s = nums[n - 1];
    let cur_m = nums[n - 4];
    let cur_s = nums[n - 3];
    if total_s < 60.0 && total_m < 90.0 && cur_s < 60.0 && cur_m < 90.0 {
        let total = total_m * 60.0 + total_s;
        let cur = cur_m * 60.0 + cur_s;
        if cur <= total {
            return Some(cur);
        }
    }
    None
}

// ---------- QQ 音乐窗口探测（用于定位"桌面歌词"窗口） ----------

fn is_qqmusic_process(pid: u32) -> bool {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::core::PWSTR;
    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return false;
        };
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(buf.as_mut_ptr()),
            &mut len,
        )
        .is_ok();
        let _ = CloseHandle(handle);
        if !ok {
            return false;
        }
        String::from_utf16_lossy(&buf[..len as usize]).to_lowercase().contains("qqmusic")
    }
}

/// 枚举 QQ 音乐进程的所有可见窗口并打日志，
/// 用于发现"桌面歌词"窗口（置顶、扁宽小窗）的特征
fn probe_qqmusic_windows() {
    use windows::Win32::Foundation::LPARAM;
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetWindowLongPtrW, GetWindowRect, GetWindowThreadProcessId,
        GetWindowTextLengthW, GetWindowTextW, IsWindowVisible, GWL_EXSTYLE, WS_EX_TOPMOST,
    };
    use windows::core::BOOL;
    unsafe extern "system" fn enum_cb(hwnd: windows::Win32::Foundation::HWND, _: LPARAM) -> BOOL {
        unsafe {
            let mut pid: u32 = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid == 0 || !IsWindowVisible(hwnd).as_bool() {
                return true.into();
            }
            if !is_qqmusic_process(pid) {
                return true.into();
            }
            let mut rect = windows::Win32::Foundation::RECT::default();
            let _ = GetWindowRect(hwnd, &mut rect);
            let w = rect.right - rect.left;
            let h = rect.bottom - rect.top;
            if w <= 0 || h <= 0 {
                return true.into();
            }
            let exstyle = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
            let topmost = (exstyle & WS_EX_TOPMOST.0) != 0;
            let mut buf = [0u16; 256];
            let cls_len = GetClassNameW(hwnd, &mut buf) as usize;
            let class = String::from_utf16_lossy(&buf[..cls_len]);
            let ttl_len = GetWindowTextLengthW(hwnd) as usize;
            let ttl = if ttl_len > 0 && ttl_len <= 256 {
                GetWindowTextW(hwnd, &mut buf);
                String::from_utf16_lossy(&buf[..ttl_len])
            } else {
                String::new()
            };
            eprintln!(
                "Kairos probe: hwnd=0x{:x} class='{}' title='{}' rect=({},{}) {}x{} topmost={}",
                hwnd.0 as usize,
                class,
                ttl,
                rect.left,
                rect.top,
                w,
                h,
                topmost
            );
        }
        true.into()
    }
    unsafe {
        let _ = EnumWindows(Some(enum_cb), LPARAM(0));
    }
}

pub fn start_polling(app: tauri::AppHandle, playback: Arc<PlaybackState>) {
    let manager = match GlobalSystemMediaTransportControlsSessionManager::RequestAsync() {
        Ok(op) => match wait_async(op) {
            Ok(m) => m,
            Err(e) => {
                eprintln!("Kairos: GSMT init failed: {e}");
                return;
            }
        },
        Err(e) => {
            eprintln!("Kairos: GSMT call failed: {e}");
            return;
        }
    };

    let mut last_meta_key = String::new();
    let mut last_title = String::new();
    let mut last_artist = String::new();
    let mut log_tick = 0u32;
    // 粘性会话：多源并存时（如抖音视频 + QQ 音乐），锁定用户正在听的播放器，
    // 防止两个会话间来回抢占导致进度/歌词闪烁；锁定源暂停超过 5 秒且有其他源
    // 在播放才转移
    let mut sticky_source: Option<String> = None;
    let mut sticky_paused_since: Option<std::time::Instant> = None;
    // 会话消失宽限期：QQ 暂停/切后台时可能注销会话，冻结界面等它回来
    let mut missed_since: Option<std::time::Instant> = None;
    // QQ 音乐窗口探测节流（定位桌面歌词窗口用）
    let mut probe_tick = 0u32;
    // 自动对齐：OCR 引擎缓存 + 节流
    let mut ocr_slot: Option<windows::Media::Ocr::OcrEngine> = None;
    let mut align_tick = 0u32;
    let mut last_ocr_pos: Option<f64> = None;

    loop {
        std::thread::sleep(std::time::Duration::from_millis(300));

        probe_tick = probe_tick.wrapping_add(1);
        if probe_tick % 50 == 3 {
            probe_qqmusic_windows();
        }

        let Ok(sessions) = manager.GetSessions() else { continue };
        let count = sessions.Size().unwrap_or(0);
        if count == 0 {
            let missed = *missed_since.get_or_insert_with(std::time::Instant::now);
            if missed.elapsed() > SESSION_GRACE {
                // 宽限期结束：真正清空
                missed_since = None;
                let clear = !last_meta_key.is_empty();
                last_meta_key.clear();
                last_title.clear();
                last_artist.clear();
                {
                    let mut inner = playback.0.lock().unwrap();
                    inner.cur_song.clear();
                    inner.base_pos = 0.0;
                    inner.base_at = None;
                }
                if clear {
                    let _ = app.emit("now-playing-stopped", ());
                }
            } else if !last_title.is_empty() {
                // 冻结进度：告知前端"已暂停"，歌词停在原地
                let frozen_pos = {
                    let inner = playback.0.lock().unwrap();
                    inner.base_pos
                };
                let _ = app.emit(
                    "playback-progress",
                    PlaybackProgress {
                        title: last_title.clone(),
                        artist: last_artist.clone(),
                        playing: false,
                        position_sec: frozen_pos,
                        duration_sec: 0.0,
                    },
                );
            }
            continue;
        }
        missed_since = None;

        // 1) 粘性锁定：上次的会话还在就继续用它（无论是否播放）
        let mut target: Option<GlobalSystemMediaTransportControlsSession> = None;
        if let Some(sid) = &sticky_source {
            for i in 0..count {
                if let Ok(s) = sessions.GetAt(i) {
                    if source_id(&s) == *sid {
                        target = Some(s);
                        break;
                    }
                }
            }
        }
        if let Some(s) = &target {
            if session_playing(s) {
                sticky_paused_since = None;
            } else if sticky_paused_since.is_none() {
                sticky_paused_since = Some(std::time::Instant::now());
            }
            // 锁定源暂停超过 5 秒且有其他源在播放 → 转移
            if !session_playing(s)
                && sticky_paused_since
                    .map(|t| t.elapsed() > std::time::Duration::from_secs(5))
                    .unwrap_or(false)
            {
                let locked_id = sticky_source.clone().unwrap_or_default();
                for i in 0..count {
                    if let Ok(c) = sessions.GetAt(i) {
                        if source_id(&c) != locked_id && session_playing(&c) {
                            let new_id = source_id(&c);
                            sticky_source = Some(new_id);
                            target = Some(c);
                            sticky_paused_since = None;
                            break;
                        }
                    }
                }
            }
        } else {
            // 2) 无锁定：优先正在播放的会话，否则取第一个
            for i in 0..count {
                let Ok(s) = sessions.GetAt(i) else { continue };
                if session_playing(&s) {
                    target = Some(s);
                    break;
                }
                if target.is_none() {
                    target = Some(s);
                }
            }
            let sid = target.as_ref().map(source_id).unwrap_or_default();
            if !sid.is_empty() {
                sticky_source = Some(sid);
            }
            sticky_paused_since = None;
        }
        let Some(session) = target else { continue };

        let Ok(props) = session.TryGetMediaPropertiesAsync().and_then(wait_async) else {
            continue;
        };
        let title = props.Title().map(|t| t.to_string()).unwrap_or_default();
        let artist = props.Artist().map(|a| a.to_string()).unwrap_or_default();
        let album = props.AlbumTitle().map(|a| a.to_string()).unwrap_or_default();
        if title.is_empty() {
            continue;
        }

        let playing = session_playing(&session);

        // 本地秒表推进（QQ 音乐不上报 timeline，靠这个对歌词）
        let song_key = format!("{title}|{artist}");
        {
            let mut inner = playback.0.lock().unwrap();
            if song_key != inner.cur_song {
                inner.cur_song = song_key;
                inner.base_pos = 0.0;
                inner.base_at = Some(std::time::Instant::now());
                last_meta_key.clear();
                last_ocr_pos = None;
            }
            if playing && inner.base_at.is_none() {
                inner.base_at = Some(std::time::Instant::now());
            } else if !playing && inner.base_at.is_some() {
                inner.base_pos += inner
                    .base_at
                    .take()
                    .map(|t| t.elapsed().as_secs_f64())
                    .unwrap_or(0.0);
            }
        }

        let local_pos = {
            let inner = playback.0.lock().unwrap();
            inner.base_pos + inner.base_at.map(|t| t.elapsed().as_secs_f64()).unwrap_or(0.0)
        };
        last_title = title.clone();
        last_artist = artist.clone();

        // 进度：优先 SMTC timeline，QQ 音乐等不上报的播放器退回本地秒表
        let (mut position_sec, duration_sec) = if let Ok(tl) = session.GetTimelineProperties() {
            let raw_pos = tl.Position().map(|t| t.Duration).unwrap_or(0) as f64 / 1e7;
            let dur = match (tl.EndTime(), tl.StartTime()) {
                (Ok(e), Ok(s)) => (e.Duration - s.Duration).max(0) as f64 / 1e7,
                _ => 0.0,
            };
            // LastUpdatedTime: Windows FILETIME（1601-01-01 起的 100ns）
            const EPOCH_DIFF_100NS: i64 = 11_644_473_600_000_000;
            let updated_100ns = tl.LastUpdatedTime().map(|d| d.UniversalTime).unwrap_or(0);
            let now_100ns = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos() as i64 / 100)
                .unwrap_or(0);
            let age_sec = ((now_100ns - EPOCH_DIFF_100NS - updated_100ns) as f64 / 1e7).max(0.0);
            let smtc_valid = dur > 1.0 && age_sec < 3600.0;
            let pos = if smtc_valid {
                if playing { raw_pos + age_sec } else { raw_pos }
            } else {
                local_pos
            };
            (pos, dur)
        } else {
            (local_pos, 0.0)
        };

        // 自动对齐（仅在 SMTC 无效时需要，即 QQ 等不上报进度的播放器）：
        // 层 1：主窗口播放条的 "01:23/04:56" 进度时间 OCR —— 无需桌面歌词，
        //       seek 后时间文本瞬间跳变，600ms 内捕获校准
        // 层 2（兜底）：桌面歌词文字与 LRC 匹配
        if playing && duration_sec < 1.0 {
            align_tick = align_tick.wrapping_add(1);
            if align_tick % 2 == 1 {
                if ocr_slot.is_none() {
                    match windows::Media::Ocr::OcrEngine::TryCreateFromUserProfileLanguages() {
                        Ok(e) => {
                            ocr_slot = Some(e);
                            eprintln!("Kairos align: OCR engine ready");
                        }
                        Err(e) => {
                            if align_tick % 200 == 1 {
                                eprintln!("Kairos align: OCR engine unavailable: {e}");
                            }
                        }
                    }
                }
                if let Some(ocr) = &ocr_slot {
                    match find_main_window() {
                        Some((hwnd, w, h)) => {
                            match capture_window_ocr(hwnd, ocr, true) {
                                Some(text) => {
                                    let parsed = parse_progress_text(&text);
                                    eprintln!(
                                        "Kairos align dbg: ocr='{}' parsed={:?}",
                                        text, parsed
                                    );
                                    if let Some(pos) = parsed {
                                        // 防数字误读：连续两次读数一致才采信
                                        let consistent = last_ocr_pos
                                            .map(|p| (pos - p).abs() < 2.0)
                                            .unwrap_or(false);
                                        last_ocr_pos = Some(pos);
                                        if consistent {
                                            let drift = pos - position_sec;
                                            if drift.abs() > 2.5 && drift.abs() < 900.0 {
                                                let mut inner = playback.0.lock().unwrap();
                                                inner.base_pos = pos;
                                                inner.base_at = Some(std::time::Instant::now());
                                                position_sec = pos;
                                                eprintln!(
                                                    "Kairos align: progress '{}' -> {:.1}s (drift {:+.1})",
                                                    text, pos, drift
                                                );
                                            }
                                        }
                                    }
                                }
                                None => {
                                    if align_tick % 100 == 1 {
                                        eprintln!(
                                            "Kairos align dbg: capture failed hwnd=0x{:x} {}x{}",
                                            hwnd.0 as usize, w, h
                                        );
                                    }
                                }
                            }
                            // 层 2：桌面歌词文字匹配 LRC（主窗口读不到进度时的兜底）
                            if position_sec == local_pos {
                                let lines = playback.1.lock().unwrap().clone();
                                if !lines.is_empty() {
                                    if let Some(hwnd) = find_lyric_window() {
                                        if let Some(text) = capture_window_ocr(hwnd, ocr, false) {
                                            if let Some(t) = match_lyric_line(&text, &lines) {
                                                let drift = t - position_sec;
                                                if drift.abs() > 3.0 && drift.abs() < 180.0 {
                                                    let mut inner = playback.0.lock().unwrap();
                                                    inner.base_pos = t;
                                                    inner.base_at = Some(std::time::Instant::now());
                                                    position_sec = t;
                                                    eprintln!(
                                                        "Kairos align: lyric '{}' -> {:.2}s (drift {:+.2})",
                                                        text, t, drift
                                                    );
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        None => {
                            if align_tick % 100 == 1 {
                                eprintln!("Kairos align dbg: QQ main window not found");
                            }
                        }
                    }
                } else if align_tick % 100 == 1 {
                    eprintln!("Kairos align dbg: no OCR engine (missing language pack?)");
                }
            }
        }
        log_tick = log_tick.wrapping_add(1);
        if log_tick % 33 == 1 {
            eprintln!(
                "Kairos timeline: playing={} -> pos={:.2}s dur={:.2}s (source: {})",
                playing,
                position_sec,
                duration_sec,
                sticky_source.as_deref().unwrap_or("?")
            );
        }
        let _ = app.emit(
            "playback-progress",
            PlaybackProgress {
                title: title.clone(),
                artist: artist.clone(),
                playing,
                position_sec,
                duration_sec,
            },
        );

        // 封面 + 元数据：仅变化时推送
        let meta_key = format!("{title}|{artist}|{playing}");
        if meta_key != last_meta_key {
            last_meta_key = meta_key;
            let cover_base64 = cover_to_data_uri(&props);
            let _ = app.emit(
                "now-playing",
                TrackMeta {
                    title,
                    artist,
                    album,
                    playing,
                    cover_base64,
                },
            );
        }
    }
}

/// 前端拉到歌词后回传给对齐引擎（OCR 匹配用）
#[tauri::command]
pub fn set_lyric_lines(
    lines: Vec<crate::lyrics::LyricLine>,
    state: tauri::State<'_, Arc<PlaybackState>>,
) {
    let mapped: Vec<(f64, String)> = lines.iter().map(|l| (l.time, l.text.clone())).collect();
    *state.1.lock().unwrap() = mapped;
}
