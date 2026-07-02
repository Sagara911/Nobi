//! 桌面音频可视化壁纸 —— Phase 2 本地推流层。
//!
//! 把 Phase 1 的一次性探针升级成「常驻推流」：一个本地 WebSocket 服务，把系统音频频段
//! （~60fps）和当前歌曲/封面（切歌时）持续推给**独立 Chromium 渲染器进程**。
//!
//! 为什么要 WS 而不是 Tauri event：渲染器是 Nobi 之外的独立进程（走 Chromium 内核，绕开
//! 本机 WebView2 实时画布渲染坑），Tauri 的 event 传不到外部进程，只能靠本地 socket。
//!
//! 结构（都在独立线程/任务里，互不阻塞）：
//! - WS 服务（tokio 任务，进程内常驻）：每来一个连接就订阅广播、把消息转发过去。
//! - 采集线程（std，MTA）：loopback 读音频 → 滚动窗口 → FFT 分频 → 广播 `{type:"audio"}`。
//! - 曲目轮询线程（std，MTA）：每 ~1s 查 SMTC，切歌时广播 `{type:"track"}`（封面转 base64）。
//!
//! Windows 专属。非 Windows 下命令返回错误占位。

/// 渲染器约定的固定端口（Phase 2 原型先写死；正式版会协商/写进配置）。
#[cfg(windows)]
const PORT: u16 = 17653;

/// 每帧频段数（与渲染器约定）。
#[cfg(windows)]
const NUM_BANDS: usize = 48;

#[cfg(windows)]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(windows)]
use std::sync::OnceLock;
#[cfg(windows)]
use tokio::sync::broadcast;

/// 广播发送端：采集/轮询线程往里塞 JSON，每个 WS 连接订阅一份。进程内建一次、长存。
#[cfg(windows)]
static SENDER: OnceLock<broadcast::Sender<String>> = OnceLock::new();
/// WS 服务是否已起（进程内只起一次，端口独占，不随 stop 关闭）。
#[cfg(windows)]
static SERVER_STARTED: AtomicBool = AtomicBool::new(false);
/// 采集/轮询线程是否在跑（stop 时置 false，线程随即退出）。
#[cfg(windows)]
static CAPTURE_RUNNING: AtomicBool = AtomicBool::new(false);
/// 最近一次曲目消息的快照（JSON）。广播不补发历史，新连接靠它立刻拿到当前曲目/封面。
#[cfg(windows)]
static LAST_TRACK: OnceLock<std::sync::Mutex<Option<String>>> = OnceLock::new();

#[cfg(windows)]
fn last_track_cell() -> &'static std::sync::Mutex<Option<String>> {
    LAST_TRACK.get_or_init(|| std::sync::Mutex::new(None))
}

/// WS 服务主循环：绑定端口，每个连接派生一个转发任务。
#[cfg(windows)]
async fn run_ws_server(tx: broadcast::Sender<String>) {
    use tokio::net::TcpListener;
    let listener = match TcpListener::bind(("127.0.0.1", PORT)).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[wallpaper] WS 绑定 127.0.0.1:{PORT} 失败: {e}");
            SERVER_STARTED.store(false, Ordering::SeqCst);
            return;
        }
    };
    eprintln!("[wallpaper] WS 服务就绪 ws://127.0.0.1:{PORT}");
    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                tauri::async_runtime::spawn(forward_to_client(stream, tx.subscribe()));
            }
            Err(_) => continue,
        }
    }
}

/// 单个连接：握手后把广播来的每条消息转发给客户端；客户端断开则结束。
#[cfg(windows)]
async fn forward_to_client(
    stream: tokio::net::TcpStream,
    mut rx: broadcast::Receiver<String>,
) {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;

    let ws = match tokio_tungstenite::accept_async(stream).await {
        Ok(ws) => ws,
        Err(_) => return,
    };
    let (mut write, mut read) = ws.split();
    // 读方向：渲染器不发指令，但需驱动读循环以感知对端关闭。
    tauri::async_runtime::spawn(async move { while read.next().await.is_some() {} });

    // 一接上就补发当前曲目/封面（广播不补历史，否则晚连的客户端拿不到）。
    let snapshot = last_track_cell().lock().ok().and_then(|g| g.clone());
    if let Some(track_json) = snapshot {
        if write.send(Message::Text(track_json.into())).await.is_err() {
            return;
        }
    }

    loop {
        match rx.recv().await {
            Ok(msg) => {
                if write.send(Message::Text(msg.into())).await.is_err() {
                    break;
                }
            }
            // 渲染器跟不上导致积压：丢弃滞后，继续追最新。
            Err(broadcast::error::RecvError::Lagged(_)) => continue,
            Err(broadcast::error::RecvError::Closed) => break,
        }
    }
}

/// 采集线程：持续 loopback 读音频，维护滚动窗口，逐帧 FFT 分频并广播。
#[cfg(windows)]
fn spawn_capture(tx: broadcast::Sender<String>) {
    use crate::wallpaper_audio::{bytes_to_mono, compute_bands, open_loopback};
    use std::collections::VecDeque;
    use wasapi::initialize_mta;

    std::thread::spawn(move || {
        if initialize_mta().ok().is_err() {
            eprintln!("[wallpaper] 采集线程 MTA 初始化失败");
            CAPTURE_RUNNING.store(false, Ordering::SeqCst);
            return;
        }
        let (audio_client, capture, block_align, sample_rate) = match open_loopback() {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[wallpaper] 打开 loopback 失败: {e}");
                CAPTURE_RUNNING.store(false, Ordering::SeqCst);
                return;
            }
        };
        if let Err(e) = audio_client.start_stream() {
            eprintln!("[wallpaper] start_stream 失败: {e}");
            CAPTURE_RUNNING.store(false, Ordering::SeqCst);
            return;
        }

        const WINDOW: usize = 4096; // FFT 滚动窗口
        let mut queue: VecDeque<u8> = VecDeque::new();
        let mut window: Vec<f32> = Vec::with_capacity(WINDOW);

        while CAPTURE_RUNNING.load(Ordering::Relaxed) {
            let _ = capture.read_from_device_to_deque(&mut queue);
            // 只取整帧的字节，剩下的半帧留到下轮。
            let take = queue.len() - (queue.len() % block_align);
            if take > 0 {
                let chunk: Vec<u8> = queue.drain(..take).collect();
                window.extend(bytes_to_mono(&chunk, block_align));
                if window.len() > WINDOW {
                    let drop = window.len() - WINDOW;
                    window.drain(..drop);
                }
            }
            if window.len() >= 256 {
                let bands = compute_bands(&window, sample_rate, NUM_BANDS);
                let peak = window.iter().fold(0f32, |m, &s| m.max(s.abs()));
                let msg = serde_json::json!({
                    "type": "audio",
                    "bands": bands,
                    "peak": peak,
                })
                .to_string();
                let _ = tx.send(msg);
            }
            std::thread::sleep(std::time::Duration::from_millis(16)); // ~60fps
        }
        let _ = audio_client.stop_stream();
    });
}

/// 曲目轮询线程：每 ~1s 查 SMTC，切歌时把新曲目 + base64 封面广播出去。
#[cfg(windows)]
fn spawn_track_poll(tx: broadcast::Sender<String>) {
    use crate::wallpaper_media::{ensure_com, read_track};
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    std::thread::spawn(move || {
        ensure_com();
        let mut last_key = String::new();
        while CAPTURE_RUNNING.load(Ordering::Relaxed) {
            if let Ok(Some(track)) = read_track() {
                let key = format!("{}|{}", track.title, track.artist);
                if key != last_key {
                    last_key = key;
                    let cover = if track.cover.is_empty() {
                        String::new()
                    } else {
                        format!("data:image/jpeg;base64,{}", STANDARD.encode(&track.cover))
                    };
                    let msg = serde_json::json!({
                        "type": "track",
                        "title": track.title,
                        "artist": track.artist,
                        "album": track.album,
                        "cover": cover,
                    })
                    .to_string();
                    if let Ok(mut g) = last_track_cell().lock() {
                        *g = Some(msg.clone());
                    }
                    let _ = tx.send(msg);
                }
            }
            // 分小段睡，及时响应 stop。
            for _ in 0..10 {
                if !CAPTURE_RUNNING.load(Ordering::Relaxed) {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        }
    });
}

/// 启动推流：起（或复用）WS 服务与采集/轮询线程，返回 WS 端口。
///
/// 渲染器连 `ws://127.0.0.1:<返回值>` 即可收到 `audio` / `track` 两类 JSON 帧。
#[tauri::command]
pub fn wallpaper_stream_start() -> Result<u16, String> {
    #[cfg(windows)]
    {
        let tx = SENDER
            .get_or_init(|| broadcast::channel::<String>(64).0)
            .clone();
        // WS 服务进程内只起一次，常驻。
        if !SERVER_STARTED.swap(true, Ordering::SeqCst) {
            tauri::async_runtime::spawn(run_ws_server(tx.clone()));
        }
        // 采集/轮询线程：未在跑才起（幂等）。
        if !CAPTURE_RUNNING.swap(true, Ordering::SeqCst) {
            spawn_capture(tx.clone());
            spawn_track_poll(tx);
        }
        Ok(PORT)
    }
    #[cfg(not(windows))]
    {
        Err("音频推流目前仅支持 Windows".into())
    }
}

/// 停止推流：采集/轮询线程随即退出（WS 服务保持常驻，下次 start 立即复用）。
#[tauri::command]
pub fn wallpaper_stream_stop() {
    #[cfg(windows)]
    {
        CAPTURE_RUNNING.store(false, Ordering::SeqCst);
    }
}
