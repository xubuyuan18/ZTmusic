use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use futures_lite::future;
use mpris_server::{Metadata, PlaybackStatus, Player, Time};

#[derive(Debug)]
enum LinuxMprisMessage {
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
    },
}

pub struct LinuxMprisState {
    sender: async_channel::Sender<LinuxMprisMessage>,
    pending_action: Arc<Mutex<Option<String>>>,
}

impl LinuxMprisState {
    pub fn new() -> Self {
        let (sender, receiver) = async_channel::unbounded();
        let pending_action = Arc::new(Mutex::new(None));
        let thread_pending_action = Arc::clone(&pending_action);

        thread::spawn(move || {
            future::block_on(async move {
                loop {
                    match run_mpris(&receiver, &thread_pending_action).await {
                        Ok(true) => {
                            // channel 关闭：应用退出，结束线程
                            log::debug!("Linux MPRIS channel closed, exiting MPRIS thread");
                            return;
                        }
                        Ok(false) => {
                            // run_task 主动结束（zbus 断连等），5s 后重连
                            log::warn!("Linux MPRIS run_task ended, reconnecting in 5s...");
                            std::thread::sleep(std::time::Duration::from_secs(5));
                        }
                        Err(error) => {
                            log::warn!("Linux MPRIS disconnected: {error}, reconnecting in 5s...");
                            std::thread::sleep(std::time::Duration::from_secs(5));
                        }
                    }
                }
            });
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
        let _ = self.sender.try_send(LinuxMprisMessage::Metadata {
            title,
            artist,
            album,
            cover_url,
            duration,
        });
    }

    pub fn update_playback_state(&self, playing: bool, position: f64) {
        let _ = self
            .sender
            .try_send(LinuxMprisMessage::Playback { playing, position });
    }

    pub fn poll_pending_action(&self) -> String {
        self.pending_action
            .lock()
            .ok()
            .and_then(|mut action| action.take())
            .unwrap_or_default()
    }
}

async fn run_mpris(
    receiver: &async_channel::Receiver<LinuxMprisMessage>,
    pending_action: &Arc<Mutex<Option<String>>>,
) -> Result<bool, Box<dyn std::error::Error>> {
    // 独立追踪播放状态：play_pause 回调不再跨线程读 player.playback_status()，
    // 避免 Player 的 Sync 边界与 async 任务修改状态之间的数据竞争。
    let is_playing = Arc::new(AtomicBool::new(false));

    let player = Player::builder("zheting")
        .identity("哲听")
        .desktop_entry("zheting")
        .supported_uri_schemes(["file", "http", "https"])
        .can_go_next(true)
        .can_go_previous(true)
        .can_play(true)
        .can_pause(true)
        .can_seek(false)
        .can_control(true)
        .build()
        .await?;

    player.connect_next({
        let action = Arc::clone(pending_action);
        move |_| set_pending_action(&action, "next")
    });
    player.connect_previous({
        let action = Arc::clone(pending_action);
        move |_| set_pending_action(&action, "prev")
    });
    player.connect_play({
        let action = Arc::clone(pending_action);
        move |_| set_pending_action(&action, "play")
    });
    player.connect_pause({
        let action = Arc::clone(pending_action);
        move |_| set_pending_action(&action, "pause")
    });
    player.connect_stop({
        let action = Arc::clone(pending_action);
        move |_| set_pending_action(&action, "pause")
    });

    let play_pause_pending = Arc::clone(pending_action);
    let play_pause_state = Arc::clone(&is_playing);
    player.connect_play_pause(move |_player| {
        // 从共享原子读，而非从 player 读，回避 Player: Sync 未确定的问题
        let action = if play_pause_state.load(Ordering::Relaxed) { "pause" } else { "play" };
        set_pending_action(&play_pause_pending, action);
    });

    let run_task = player.run();
    let message_task = async {
        while let Ok(message) = receiver.recv().await {
            match message {
                LinuxMprisMessage::Metadata {
                    title,
                    artist,
                    album,
                    cover_url,
                    duration,
                } => {
                    let mut builder = Metadata::builder()
                        .title(title)
                        .artist(split_artists(&artist))
                        .album(album)
                        .length(seconds_to_time(duration));
                    if !cover_url.is_empty() {
                        builder = builder.art_url(cover_url);
                    }
                    let _ = player.set_metadata(builder.build()).await;
                }
                LinuxMprisMessage::Playback { playing, position } => {
                    is_playing.store(playing, Ordering::Relaxed);
                    player.set_position(seconds_to_time(position));
                    let status = if playing {
                        PlaybackStatus::Playing
                    } else {
                        PlaybackStatus::Paused
                    };
                    let _ = player.set_playback_status(status).await;
                }
            }
        }
    };

    future::race(run_task, message_task).await;
    // race 结束：drop 两个 future 释放对 player 的借用；channel 关闭表示应用退出（返回
    // true），否则是 run_task 主动结束（返回 false，需重连）。
    let channel_closed = receiver.is_closed();
    // 显式 drop player，触发 mpris-server 从 D-Bus 注销 org.mpris.MediaPlayer2.zheting，
    // 避免重连时旧 bus name 与新 Player 冲突或泄漏。
    drop(player);
    Ok(channel_closed)
}

fn set_pending_action(pending_action: &Arc<Mutex<Option<String>>>, action: &str) {
    if let Ok(mut pending) = pending_action.lock() {
        *pending = Some(action.to_string());
    }
}

fn split_artists(artist: &str) -> Vec<String> {
    artist
        .split('/')
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>()
}

fn seconds_to_time(seconds: f64) -> Time {
    let micros = (seconds.max(0.0) * 1_000_000.0).round() as i64;
    Time::from_micros(micros)
}
