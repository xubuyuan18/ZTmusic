use tauri::State;

use crate::NativeMediaState;
#[cfg(target_os = "android")]
use crate::NativeMetadataPayload;

/// 更新需要原生桥接的平台媒体元数据（Android 通知栏 / Linux MPRIS）。
/// Windows 由 WebView2 / Web Media Session 直接向系统暴露元数据。
#[allow(non_snake_case)]
#[tauri::command]
pub fn updateMetadata(
    state: State<'_, NativeMediaState>,
    title: String,
    artist: String,
    album: String,
    coverUrl: String,
    duration: f64,
) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let guard = state.handle.lock().map_err(|error| error.to_string())?;
        if let Some(handle) = guard.as_ref() {
            handle
                .run_mobile_plugin::<()>(
                    "updateMetadata",
                    NativeMetadataPayload {
                        title,
                        artist,
                        cover_url: coverUrl,
                        duration,
                    },
                )
                .map_err(|error| error.to_string())?;
        }
        let _ = album;
    }

    #[cfg(target_os = "linux")]
    {
        state
            .mpris
            .update_metadata(title, artist, album, coverUrl, duration);
    }

    #[cfg(not(any(target_os = "android", target_os = "linux")))]
    {
        let _ = (state, title, artist, album, coverUrl, duration);
    }

    Ok(())
}
