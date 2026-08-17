use tauri::State;

use crate::NativeMediaState;

/// 更新原生媒体播放状态（播放/暂停 + 进度）。
#[allow(non_snake_case)]
#[tauri::command]
pub fn updatePlaybackState(
    state: State<'_, NativeMediaState>,
    playing: bool,
    position: f64,
    duration: f64,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let _ = duration;
        state.mpris.update_playback_state(playing, position);
    }

    #[cfg(target_os = "windows")]
    {
        state.smtc.update_playback_state(playing, position, duration);
    }

    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    {
        let _ = (state, playing, position, duration);
    }

    Ok(())
}
