//! 数据层：SQLite 连接 / 建表迁移 / 公共查询 / 路径与时间工具。
//! 原则：所有表结构变更集中在 open_db 的迁移区，别处不得 ALTER。

use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use serde::Serialize;
use tauri::Manager;

/// 单条素材的元数据（序列化成 camelCase 给前端）
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    pub id: i64,
    pub path: String,
    pub name: String,
    pub format: String,
    pub width: i64,
    pub height: i64,
    pub size_bytes: i64,
    pub folder: String,
    pub source: String,
    pub author: String,
    pub tags: Vec<String>,
    pub added_at: i64,
    /// 缓存缩略图的绝对路径（可能为空，前端回退到原图）
    pub thumb: String,
    /// 主色调（hex 数组，第一个为最主要色）
    pub colors: Vec<String>,
    /// 原文件是否已失效（被移动/删除）
    pub missing: bool,
    /// 是否收藏
    pub favorite: bool,
}

pub const IMAGE_EXTS: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "webp", "bmp", "tif", "tiff", "avif",
];
/// 视频格式：可导入与播放预览；不做缩略图/配色/CLIP（webview 原生渲染首帧）
pub const VIDEO_EXTS: &[&str] = &["mp4", "webm", "mov", "mkv", "avi"];
pub const VIDEO_FORMATS_SQL: &str = "('MP4','WEBM','MOV','MKV','AVI')";

fn db_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("nobi.sqlite"))
}

pub fn open_db(app: &tauri::AppHandle) -> Result<Connection, String> {
    let conn = Connection::open(db_path(app)?).map_err(|e| e.to_string())?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS assets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            format TEXT,
            width INTEGER,
            height INTEGER,
            size_bytes INTEGER,
            folder TEXT,
            source TEXT,
            author TEXT,
            tags TEXT,
            added_at INTEGER,
            thumb TEXT,
            colors TEXT,
            caption TEXT,
            embedding TEXT,
            embed_model_version TEXT
        );
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
        );
        CREATE TABLE IF NOT EXISTS ai_commands (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            prompt TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS boards (
            id INTEGER PRIMARY KEY,
            name TEXT,
            snapshot TEXT,
            updated_at INTEGER
        );",
    )
    .map_err(|e| e.to_string())?;
    // 旧库迁移：补列（已存在则报错，忽略即可）
    let _ = conn.execute("ALTER TABLE assets ADD COLUMN thumb TEXT", []);
    let _ = conn.execute("ALTER TABLE assets ADD COLUMN colors TEXT", []);
    let _ = conn.execute("ALTER TABLE assets ADD COLUMN caption TEXT", []);
    let _ = conn.execute("ALTER TABLE assets ADD COLUMN embedding TEXT", []);
    let _ = conn.execute("ALTER TABLE assets ADD COLUMN clip_embedding TEXT", []);
    let _ = conn.execute("ALTER TABLE assets ADD COLUMN favorite INTEGER DEFAULT 0", []);
    Ok(conn)
}

/// 缩略图缓存目录
pub fn thumbs_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("thumbnails");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

pub fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 公共查询：读出全部素材
pub fn fetch_assets(conn: &Connection) -> Result<Vec<Asset>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id,path,name,format,width,height,size_bytes,folder,source,author,tags,added_at,thumb,colors,COALESCE(favorite,0)
             FROM assets ORDER BY added_at DESC, id DESC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            let tags_json: String = row.get(10).unwrap_or_else(|_| "[]".to_string());
            let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
            let colors_json: String = row.get(13).unwrap_or_else(|_| "[]".to_string());
            let colors: Vec<String> = serde_json::from_str(&colors_json).unwrap_or_default();
            let path: String = row.get(1)?;
            let missing = !std::path::Path::new(&path).exists();
            Ok(Asset {
                id: row.get(0)?,
                path,
                name: row.get(2)?,
                format: row.get(3).unwrap_or_default(),
                width: row.get(4).unwrap_or(0),
                height: row.get(5).unwrap_or(0),
                size_bytes: row.get(6).unwrap_or(0),
                folder: row.get(7).unwrap_or_default(),
                source: row.get(8).unwrap_or_default(),
                author: row.get(9).unwrap_or_default(),
                tags,
                added_at: row.get(11).unwrap_or(0),
                thumb: row.get(12).unwrap_or_default(),
                colors,
                missing,
                favorite: row.get::<_, i64>(14).unwrap_or(0) != 0,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}
