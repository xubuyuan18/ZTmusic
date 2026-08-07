use std::sync::{Arc, Mutex};
use std::thread;

use async_channel::{unbounded, Receiver, Sender};
use windows::core::HSTRING;
use windows::Foundation::{TimeSpan, TypedEventHandler};
use windows::Media::Playback::MediaPlayer;
use windows::Media::{
    MediaPlaybackStatus, SystemMediaTransportControlsButton,
    SystemMediaTransportControlsButtonPressedEventArgs,
    SystemMediaTransportControlsTimelineProperties,
};
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};

struct ComApartment;

impl Drop for ComApartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

#[derive(Debug)]
#[allow(dead_code)]
enum WindowsSmtcMessage {
    Metadata {
        title: String,
        artist: String,
        cover_url: String,
        duration: f64,
    },
    Playback {
        playing: bool,
        position: f64,
        duration: f64,
    },
}

pub struct WindowsSmtcState {
    sender: Sender<WindowsSmtcMessage>,
    pending_action: Arc<Mutex<Option<String>>>,
}

impl WindowsSmtcState {
    pub fn new() -> Self {
        let (sender, receiver) = unbounded();
        let pending_action = Arc::new(Mutex::new(None));
        let thread_pending_action = Arc::clone(&pending_action);

        thread::spawn(move || {
            // COM 是线程绑定的，本线程只初始化一次；重连时复用同一 apartment。
            unsafe {
                if let Err(error) = CoInitializeEx(None, COINIT_MULTITHREADED).ok() {
                    log::error!(
                        "Windows SMTC CoInitializeEx failed: {error}, aborting SMTC thread"
                    );
                    return;
                }
            }
            let _com_apartment = ComApartment;
            loop {
                if let Err(error) = run_smtc(&receiver, &thread_pending_action) {
                    log::warn!("Windows SMTC disconnected: {error}, reconnecting in 5s...");
                    std::thread::sleep(std::time::Duration::from_secs(5));
                } else {
                    // run_smtc 正常返回 = receiver 关闭（应用退出），结束线程
                    log::debug!("Windows SMTC channel closed, exiting SMTC thread");
                    return;
                }
            }
        });

        Self {
            sender,
            pending_action,
        }
    }

    pub fn update_metadata(&self, title: String, artist: String, cover_url: String, duration: f64) {
        let _ = self.sender.try_send(WindowsSmtcMessage::Metadata {
            title,
            artist,
            cover_url,
            duration,
        });
    }

    pub fn update_playback_state(&self, playing: bool, position: f64, duration: f64) {
        let _ = self
            .sender
            .try_send(WindowsSmtcMessage::Playback {
                playing,
                position,
                duration,
            });
    }

    pub fn poll_pending_action(&self) -> String {
        self.pending_action
            .lock()
            .ok()
            .and_then(|mut action| action.take())
            .unwrap_or_default()
    }
}

fn run_smtc(
    receiver: &Receiver<WindowsSmtcMessage>,
    pending_action: &Arc<Mutex<Option<String>>>,
) -> windows::core::Result<()> {
    // COM 在外层线程入口已初始化一次，本函数不再重复初始化。

    // Create a MediaPlayer - this automatically creates the SMTC integration
    let player = MediaPlayer::new()?;

    // Get the SystemMediaTransportControls
    let smtc = player.SystemMediaTransportControls()?;

    // Enable buttons
    smtc.SetIsPlayEnabled(true)?;
    smtc.SetIsPauseEnabled(true)?;
    smtc.SetIsNextEnabled(true)?;
    smtc.SetIsPreviousEnabled(true)?;

    // Register button handler
    let button_handler = Arc::clone(pending_action);
    smtc.ButtonPressed(&TypedEventHandler::new(
        move |_, args: &Option<SystemMediaTransportControlsButtonPressedEventArgs>| {
            if let Some(args) = args {
                let button = args.Button()?;
                let action = match button {
                    SystemMediaTransportControlsButton::Play => "play",
                    SystemMediaTransportControlsButton::Pause => "pause",
                    SystemMediaTransportControlsButton::Next => "next",
                    SystemMediaTransportControlsButton::Previous => "prev",
                    SystemMediaTransportControlsButton::Stop => "pause",
                    _ => "",
                };
                if !action.is_empty() {
                    set_pending_action(&button_handler, action);
                }
            }
            Ok(())
        },
    ))?;

    // Get display updater
    let display_updater = smtc.DisplayUpdater()?;

    // Process messages
    while let Ok(message) = receiver.recv_blocking() {
        match message {
            WindowsSmtcMessage::Metadata {
                title,
                artist,
                cover_url,
                duration: _,
            } => {
                // Update display properties
                display_updater.SetType(windows::Media::MediaPlaybackType::Music)?;
                display_updater
                    .MusicProperties()?
                    .SetTitle(&HSTRING::from(&title))?;
                display_updater
                    .MusicProperties()?
                    .SetArtist(&HSTRING::from(&artist))?;
                // ponytail: Windows SMTC 封面图暂未实现，需要异步下载图片后通过
                // display_updater.Thumbnail() 设置 RandomAccessStreamReference。
                // 当前 cover_url 已接收但未使用，锁屏界面不会显示封面。
                log::debug!(
                    "SMTC metadata update: {} - {} (cover: {})",
                    title,
                    artist,
                    cover_url
                );

                // Update SMTC
                display_updater.Update()?;
            }
            WindowsSmtcMessage::Playback {
                playing,
                position,
                duration,
            } => {
                // Update playback status
                let status = if playing {
                    MediaPlaybackStatus::Playing
                } else {
                    MediaPlaybackStatus::Paused
                };

                // Note: We don't directly control the MediaPlayer playback here
                // because the actual audio is played in the webview
                // We just update the SMTC status display
                smtc.SetPlaybackStatus(status)?;

                // 时间轴:SMTC 客户端(Lyricify 等)与系统媒体浮窗靠它同步歌词/进度条。
                // TimeSpan 单位为 100ns,秒 = 1e7 tick。
                let timeline = SystemMediaTransportControlsTimelineProperties::new()?;
                timeline.SetEndTime(TimeSpan {
                    Duration: (duration * 10_000_000.0) as i64,
                })?;
                timeline.SetPosition(TimeSpan {
                    Duration: (position * 10_000_000.0) as i64,
                })?;
                smtc.UpdateTimelineProperties(&timeline)?;

                log::debug!(
                    "SMTC playback update: playing={}, position={}, duration={}",
                    playing,
                    position,
                    duration
                );
            }
        }
    }

    Ok(())
}

fn set_pending_action(action: &Arc<Mutex<Option<String>>>, value: &str) {
    if let Ok(mut guard) = action.lock() {
        *guard = Some(value.to_string());
    }
}
