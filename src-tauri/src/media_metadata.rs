use tauri::State;

use crate::NativeMediaState;

/// 更新原生媒体元数据（Linux MPRIS / Windows SMTC）。
#[allow(non_snake_case)]
#[tauri::command]
pub fn updateMetadata(
    state: State<'_, NativeMediaState>,
    title: String,
    artist: String,
    coverUrl: String,
    duration: f64,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        state
            .mpris
            .update_metadata(title, artist, coverUrl, duration);
    }

    #[cfg(target_os = "windows")]
    {
        state
            .smtc
            .update_metadata(title, artist, coverUrl, duration);
    }

    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    {
        let _ = (state, title, artist, coverUrl, duration);
    }

    Ok(())
}
