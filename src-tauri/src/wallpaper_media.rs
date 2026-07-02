//! 桌面音频可视化壁纸 —— 当前播放歌曲信息 / 封面（Windows SMTC）。
//!
//! 通过系统媒体传输控件（GlobalSystemMediaTransportControlsSessionManager，即按下
//! 播放键时屏幕弹出的那个媒体浮层背后的 API），读取「当前正在播放」的标题 / 艺术家 /
//! 专辑与封面缩略图。任何接入 SMTC 的播放器都覆盖（Spotify、多数现代播放器、浏览器放
//! 视频等），无需登录、不碰任何音乐平台私有接口。
//!
//! 粒子视觉会用这张封面做取色 / 背景。本文件只负责「拿到信息 + 把封面落成文件」，
//! 是壁纸功能 Phase 1 地基的另一半，同样纯后端、无 WebView。

use serde::Serialize;

/// 当前播放态。无播放会话时 `has_session=false`，其余字段为空。
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NowPlaying {
    pub title: String,
    pub artist: String,
    pub album: String,
    /// 封面缓存文件的绝对路径（原样落盘）；无封面时为空串。
    pub cover_path: String,
    /// 是否真的有正在播放的媒体会话。
    pub has_session: bool,
}

/// 从 SMTC 缩略图流读出原始字节。
#[cfg(windows)]
fn read_thumbnail(
    thumb: &windows::Storage::Streams::IRandomAccessStreamReference,
) -> Result<Vec<u8>, String> {
    use windows::Storage::Streams::{DataReader, InputStreamOptions};

    let stream = thumb
        .OpenReadAsync()
        .map_err(|e| e.to_string())?
        .get()
        .map_err(|e| e.to_string())?;
    let size = stream.Size().map_err(|e| e.to_string())? as u32;
    if size == 0 {
        return Ok(Vec::new());
    }
    let reader = DataReader::CreateDataReader(&stream).map_err(|e| e.to_string())?;
    let _ = reader.SetInputStreamOptions(InputStreamOptions::ReadAhead);
    reader
        .LoadAsync(size)
        .map_err(|e| e.to_string())?
        .get()
        .map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; size as usize];
    reader.ReadBytes(&mut buf).map_err(|e| e.to_string())?;
    Ok(buf)
}

/// 当前曲目 + 封面原始字节。`cover` 为空表示无封面。供命令落盘与推流 base64 共用。
#[cfg(windows)]
pub(crate) struct Track {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub cover: Vec<u8>,
}

/// 从 SMTC 读当前曲目（含封面字节）。无播放会话时返回 `Ok(None)`。
///
/// 要求调用线程已初始化 COM 套间（见 [`ensure_com`]）。命令与 [`crate::wallpaper_stream`]
/// 的轮询线程都走这里，避免重复 SMTC 逻辑。
#[cfg(windows)]
pub(crate) fn read_track() -> Result<Option<Track>, String> {
    use windows::Media::Control::GlobalSystemMediaTransportControlsSessionManager as SessionManager;

    let mgr = SessionManager::RequestAsync()
        .map_err(|e| e.to_string())?
        .get()
        .map_err(|e| e.to_string())?;
    // 没有任何播放会话（没在放歌）——正常情况。
    let session = match mgr.GetCurrentSession() {
        Ok(s) => s,
        Err(_) => return Ok(None),
    };
    let props = session
        .TryGetMediaPropertiesAsync()
        .map_err(|e| e.to_string())?
        .get()
        .map_err(|e| e.to_string())?;

    let title = props.Title().map(|h| h.to_string()).unwrap_or_default();
    let artist = props.Artist().map(|h| h.to_string()).unwrap_or_default();
    let album = props.AlbumTitle().map(|h| h.to_string()).unwrap_or_default();

    let cover = props
        .Thumbnail()
        .ok()
        .and_then(|t| read_thumbnail(&t).ok())
        .unwrap_or_default();

    Ok(Some(Track {
        title,
        artist,
        album,
        cover,
    }))
}

/// 初始化调用线程的 COM 套间（MTA）。WinRT 调用前必须。多次调用无害。
#[cfg(windows)]
pub(crate) fn ensure_com() {
    unsafe {
        let _ = windows::Win32::System::Com::CoInitializeEx(
            None,
            windows::Win32::System::Com::COINIT_MULTITHREADED,
        );
    }
}

/// Phase 1 验证命令：读当前播放的歌曲信息，封面落到应用缓存目录。
///
/// 放歌时应返回真实标题/艺术家，`coverPath` 指向落盘的封面文件。
#[tauri::command]
pub fn wallpaper_now_playing(app: tauri::AppHandle) -> Result<NowPlaying, String> {
    #[cfg(windows)]
    {
        use tauri::Manager;
        let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?;
        let dst = dir.join("wallpaper_cover.png");
        // WinRT 调用要求线程已初始化套间；用独立线程隔离，别动 Tauri 运行时线程。
        let handle = std::thread::spawn(move || -> Result<NowPlaying, String> {
            ensure_com();
            let track = match read_track()? {
                Some(t) => t,
                None => return Ok(NowPlaying::default()),
            };
            let mut cover_path = String::new();
            if !track.cover.is_empty() {
                if let Some(d) = dst.parent() {
                    let _ = std::fs::create_dir_all(d);
                }
                std::fs::write(&dst, &track.cover).map_err(|e| e.to_string())?;
                cover_path = dst.to_string_lossy().to_string();
            }
            Ok(NowPlaying {
                title: track.title,
                artist: track.artist,
                album: track.album,
                cover_path,
                has_session: true,
            })
        });
        handle
            .join()
            .map_err(|_| "读取播放信息线程崩溃".to_string())?
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Err("读取当前播放信息目前仅支持 Windows".into())
    }
}
