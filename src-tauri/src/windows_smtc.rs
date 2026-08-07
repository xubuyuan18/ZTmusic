use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use async_channel::{unbounded, Receiver, Sender};
use reqwest::header::REFERER;
use reqwest::Client;
use tokio::runtime::Runtime;
use windows::core::HSTRING;
use windows::Foundation::{TimeSpan, TypedEventHandler};
use windows::Media::Playback::MediaPlayer;
use windows::Media::{
    MediaPlaybackStatus, PlaybackPositionChangeRequestedEventArgs,
    SystemMediaTransportControlsButton, SystemMediaTransportControlsButtonPressedEventArgs,
    SystemMediaTransportControlsTimelineProperties,
};
use windows::Storage::Streams::{
    DataWriter, InMemoryRandomAccessStream, RandomAccessStreamReference,
};
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};

use crate::APP_USER_AGENT;

const MAX_COVER_BYTES: u64 = 5 * 1024 * 1024;

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
        album: String,
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
                    std::thread::sleep(Duration::from_secs(5));
                } else {
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

    pub fn update_metadata(
        &self,
        title: String,
        artist: String,
        album: String,
        cover_url: String,
        duration: f64,
    ) {
        let _ = self.sender.try_send(WindowsSmtcMessage::Metadata {
            title,
            artist,
            album,
            cover_url,
            duration,
        });
    }

    pub fn update_playback_state(&self, playing: bool, position: f64, duration: f64) {
        let _ = self.sender.try_send(WindowsSmtcMessage::Playback {
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
    let player = MediaPlayer::new()?;
    let smtc = player.SystemMediaTransportControls()?;

    smtc.SetIsPlayEnabled(true)?;
    smtc.SetIsPauseEnabled(true)?;
    smtc.SetIsNextEnabled(true)?;
    smtc.SetIsPreviousEnabled(true)?;

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

    let seek_handler = Arc::clone(pending_action);
    smtc.PlaybackPositionChangeRequested(&TypedEventHandler::new(
        move |_, args: &Option<PlaybackPositionChangeRequestedEventArgs>| {
            if let Some(args) = args {
                let requested = args.RequestedPlaybackPosition()?;
                let seconds = (requested.Duration as f64 / 10_000_000.0).max(0.0);
                set_pending_action(&seek_handler, &format!("seek:{seconds:.3}"));
            }
            Ok(())
        },
    ))?;

    let display_updater = smtc.DisplayUpdater()?;
    let cover_client = match Client::builder()
        .timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::limited(3))
        .user_agent(APP_USER_AGENT)
        .build()
    {
        Ok(client) => Some(client),
        Err(error) => {
            log::warn!("SMTC cover HTTP client init failed: {}", error.without_url());
            None
        }
    };
    let cover_runtime = match Runtime::new() {
        Ok(runtime) => Some(runtime),
        Err(error) => {
            log::warn!("SMTC cover Tokio runtime init failed: {error}");
            None
        }
    };

    while let Ok(message) = receiver.recv_blocking() {
        match message {
            WindowsSmtcMessage::Metadata {
                title,
                artist,
                album,
                cover_url,
                duration: _,
            } => {
                display_updater.ClearAll()?;
                display_updater.SetType(windows::Media::MediaPlaybackType::Music)?;
                let music_properties = display_updater.MusicProperties()?;
                music_properties.SetTitle(&HSTRING::from(&title))?;
                music_properties.SetArtist(&HSTRING::from(&artist))?;
                music_properties.SetAlbumTitle(&HSTRING::from(&album))?;

                if !cover_url.is_empty() {
                    if let (Some(client), Some(runtime)) =
                        (cover_client.as_ref(), cover_runtime.as_ref())
                    {
                        let thumbnail_result = runtime
                            .block_on(fetch_cover_bytes(client, &cover_url))
                            .and_then(|bytes| create_cover_thumbnail(&bytes));
                        match thumbnail_result {
                            Ok(thumbnail) => {
                                display_updater.SetThumbnail(&thumbnail)?;
                            }
                            Err(error) => {
                                log::warn!("SMTC cover load failed: {error}");
                            }
                        }
                    }
                }

                log::debug!(
                    "SMTC metadata update: {} - {} [{}] (cover: {})",
                    title,
                    artist,
                    album,
                    cover_url
                );

                display_updater.Update()?;
            }
            WindowsSmtcMessage::Playback {
                playing,
                position,
                duration,
            } => {
                let status = if playing {
                    MediaPlaybackStatus::Playing
                } else {
                    MediaPlaybackStatus::Paused
                };

                smtc.SetPlaybackStatus(status)?;

                let duration = duration.max(0.0);
                let position = if duration > 0.0 {
                    position.max(0.0).min(duration)
                } else {
                    position.max(0.0)
                };
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

async fn fetch_cover_bytes(client: &Client, cover_url: &str) -> Result<Vec<u8>, String> {
    let url = reqwest::Url::parse(cover_url).map_err(|_| "invalid cover URL".to_string())?;
    if url.scheme() != "https" {
        return Err("cover URL must use HTTPS".to_string());
    }
    let host = url.host_str().ok_or_else(|| "cover URL missing host".to_string())?;
    if !is_allowed_cover_host(host) {
        return Err(format!("cover host not allowed: {host}"));
    }

    let response = client
        .get(url)
        .header(REFERER, "https://music.163.com/")
        .send()
        .await
        .map_err(|error| format!("cover request failed: {}", error.without_url()))?;

    if !response.status().is_success() {
        return Err(format!("cover request returned HTTP {}", response.status()));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_COVER_BYTES)
    {
        return Err("cover image is too large".to_string());
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("cover body read failed: {}", error.without_url()))?;
    if bytes.len() as u64 > MAX_COVER_BYTES {
        return Err("cover image is too large".to_string());
    }

    Ok(bytes.to_vec())
}

fn create_cover_thumbnail(bytes: &[u8]) -> Result<RandomAccessStreamReference, String> {
    let stream = InMemoryRandomAccessStream::new()
        .map_err(|error| format!("cover stream create failed: {error}"))?;
    let writer = DataWriter::CreateDataWriter(&stream)
        .map_err(|error| format!("cover writer create failed: {error}"))?;
    writer
        .WriteBytes(bytes)
        .map_err(|error| format!("cover stream write failed: {error}"))?;
    writer
        .StoreAsync()
        .and_then(|operation| operation.get())
        .map_err(|error| format!("cover stream store failed: {error}"))?;
    writer
        .DetachStream()
        .map_err(|error| format!("cover writer detach failed: {error}"))?;
    stream
        .Seek(0)
        .map_err(|error| format!("cover stream rewind failed: {error}"))?;

    RandomAccessStreamReference::CreateFromStream(&stream)
        .map_err(|error| format!("cover stream reference failed: {error}"))
}

fn is_allowed_cover_host(host: &str) -> bool {
    host == "music.126.net"
        || host.ends_with(".music.126.net")
        || host == "music.163.com"
        || host.ends_with(".music.163.com")
}

fn set_pending_action(action: &Arc<Mutex<Option<String>>>, value: &str) {
    if let Ok(mut guard) = action.lock() {
        *guard = Some(value.to_string());
    }
}
