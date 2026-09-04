mod lyrics;
#[cfg(windows)]
mod media;
mod qq_player;
mod system_stats;
mod weather;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use lyrics::LyricsCache;
use media::PlaybackState;
use qq_player::LoginSessionState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .manage(LyricsCache(Mutex::new(HashMap::new())))
    .manage(Arc::new(LoginSessionState::default()))
    .manage(system_stats::init_system_state())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      #[cfg(windows)]
      {
        let playback = Arc::new(PlaybackState::default());
        app.manage(playback.clone());
        let handle = app.handle().clone();
        std::thread::spawn(move || media::start_polling(handle, playback));
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      lyrics::fetch_lyrics,
      media::set_lyric_lines,
      qq_player::qq_search_songs,
      qq_player::qq_song_url,
      qq_player::qq_save_login,
      qq_player::qq_login_status,
      qq_player::qq_logout,
      qq_player::qq_login_qr_start,
      qq_player::qq_login_qr_check,
      system_stats::system_stats,
      weather::weather_geocode,
      weather::weather_forecast,
      weather::weather_air_quality,
      qq_player::open_qq_login_window,
      qq_player::qq_cookie_from_webview
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
