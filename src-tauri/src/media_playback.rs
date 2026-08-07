use tauri::State;

use crate::NativeMediaState;
#[cfg(target_os = "android")]
use crate::NativePlaybackPayload;

/// 更新需要原生桥接的平台播放状态（Android / Linux）。
/// Windows 由 WebView2 / Web Media Session 直接同步播放状态和时间轴。
#[allow(non_snake_case)]
#[tauri::command]
pub fn updatePlaybackState(
    state: State<'_, NativeMediaState>,
    playing: bool,
    position: f64,
    duration: f64,
) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let guard = state.handle.lock().map_err(|error| error.to_string())?;
        if let Some(handle) = guard.as_ref() {
            handle
                .run_mobile_plugin::<()>(
                    "updatePlaybackState",
                    NativePlaybackPayload {
                        playing,
                        position,
                        duration,
                    },
                )
                .map_err(|error| error.to_string())?;
        }
    }

    #[cfg(target_os = "linux")]
    {
        let _ = duration;
        state.mpris.update_playback_state(playing, position);
    }

    #[cfg(not(any(target_os = "android", target_os = "linux")))]
    {
        let _ = (state, playing, position, duration);
    }

    Ok(())
}
