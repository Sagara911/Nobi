//! 素材库管理：导入（扫描/拖拽路径/拖拽字节）、收藏、标签、移除、导出。
//! 原则：导入"原位索引不复制"；唯一例外是 import_blob（HTML5 拖放拿不到路径）。

use std::fs;

use base64::Engine;
use rusqlite::Connection;
use tauri::Manager;
use walkdir::WalkDir;

use crate::db::{
    fetch_assets, fetch_trashed, now_secs, open_db, Asset, AUDIO_EXTS, ENABLE_3D, IMAGE_EXTS,
    MODEL_EXTS, VIDEO_EXTS,
};

/// 递归扫描一个路径（文件或文件夹），图片入库。返回新增数量。
pub(crate) fn scan_path(conn: &Connection, path: &str, now: i64) -> Result<usize, String> {
    let mut added = 0usize;

    for entry in WalkDir::new(path).into_iter().filter_map(|e| e.ok()) {
        if !entry.file_type().is_file() {
            continue;
        }
        let p = entry.path();
        let ext = p
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| s.to_lowercase())
            .unwrap_or_default();
        if !IMAGE_EXTS.contains(&ext.as_str())
            && !VIDEO_EXTS.contains(&ext.as_str())
            && !AUDIO_EXTS.contains(&ext.as_str())
            && !(ENABLE_3D && MODEL_EXTS.contains(&ext.as_str()))
        {
            continue;
        }

        // 音频/视频拿不到尺寸时落 0×0，前端按品类渲染占位
        let (w, h) = match imagesize::size(p) {
            Ok(sz) => (sz.width as i64, sz.height as i64),
            Err(_) => (0, 0),
        };
        let size_bytes = entry.metadata().map(|m| m.len() as i64).unwrap_or(0);
        let name = p
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let folder = p
            .parent()
            .and_then(|s| s.file_name())
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let path_str = p.to_string_lossy().to_string();

        let changed = conn
            .execute(
                "INSERT OR IGNORE INTO assets
                 (path,name,format,width,height,size_bytes,folder,source,author,tags,added_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
                rusqlite::params![
                    path_str,
                    name,
                    ext.to_uppercase(),
                    w,
                    h,
                    size_bytes,
                    folder,
                    "本地",
                    "",
                    "[]",
                    now
                ],
            )
            .map_err(|e| e.to_string())?;
        added += changed;
    }

    Ok(added)
}

/// 扫描文件夹（递归），把图片文件入库。返回本次新增数量。
#[tauri::command]
pub fn import_folder(app: tauri::AppHandle, path: String) -> Result<usize, String> {
    let conn = open_db(&app)?;
    let n = scan_path(&conn, &path, now_secs())?;
    crate::watch::add_roots(&app, vec![path]); // 记住这个导入根并挂上实时监听（按开关）
    Ok(n)
}

/// 快速数一个文件夹里有多少图片/视频/音频文件（不入库）——导入前给用户体量提示用。
#[tauri::command]
pub fn count_folder_media(path: String) -> usize {
    let mut n = 0usize;
    for entry in WalkDir::new(&path).into_iter().filter_map(|e| e.ok()) {
        if !entry.file_type().is_file() {
            continue;
        }
        let ext = entry
            .path()
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| s.to_lowercase())
            .unwrap_or_default();
        if IMAGE_EXTS.contains(&ext.as_str())
            || VIDEO_EXTS.contains(&ext.as_str())
            || AUDIO_EXTS.contains(&ext.as_str())
            || (ENABLE_3D && MODEL_EXTS.contains(&ext.as_str()))
        {
            n += 1;
        }
    }
    n
}

/// 导入多个路径（拖拽进来的文件/文件夹）。返回新增数量。
#[tauri::command]
pub fn import_paths(app: tauri::AppHandle, paths: Vec<String>) -> Result<usize, String> {
    let conn = open_db(&app)?;
    let now = now_secs();
    let mut added = 0usize;
    let mut dirs = Vec::new();
    for p in paths {
        added += scan_path(&conn, &p, now)?;
        if std::path::Path::new(&p).is_dir() {
            dirs.push(p);
        }
    }
    if !dirs.is_empty() {
        crate::watch::add_roots(&app, dirs); // 拖进来的文件夹也加入实时监听
    }
    Ok(added)
}

/// import_blob 的返回：落盘后的文件信息（画板贴图需要路径与尺寸）
#[derive(serde::Serialize)]
pub struct ImportedBlob {
    pub path: String,
    pub name: String,
    pub width: i64,
    pub height: i64,
}

/// 导入拖入/粘贴的文件内容（HTML5 拿不到路径，按字节保存到 图片\Nobi\ 再入库）
#[tauri::command]
pub fn import_blob(
    app: tauri::AppHandle,
    name: String,
    data_b64: String,
) -> Result<ImportedBlob, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&data_b64)
        .map_err(|e| e.to_string())?;

    let safe = {
        let s: String = name
            .chars()
            .filter(|c| !"\\/:*?\"<>|".contains(*c))
            .collect();
        let s = s.trim().to_string();
        if s.is_empty() {
            format!("拖入_{}.png", now_secs())
        } else {
            s
        }
    };
    let ext = std::path::Path::new(&safe)
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default();
    if !IMAGE_EXTS.contains(&ext.as_str())
        && !VIDEO_EXTS.contains(&ext.as_str())
        && !AUDIO_EXTS.contains(&ext.as_str())
        && !(ENABLE_3D && MODEL_EXTS.contains(&ext.as_str()))
    {
        return Err(format!("不支持的格式：{ext}"));
    }

    // 保存目录走用户设置（默认 图片\Nobi）
    let dir = crate::settings::import_dir(&app);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let stem = std::path::Path::new(&safe)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("拖入")
        .to_string();
    let mut path = dir.join(&safe);
    let mut n = 1;
    while path.exists() {
        path = dir.join(format!("{}_{}.{}", stem, n, ext));
        n += 1;
    }
    fs::write(&path, &bytes).map_err(|e| e.to_string())?;

    let (w, h) = imagesize::size(&path)
        .map(|s| (s.width as i64, s.height as i64))
        .unwrap_or((0, 0));
    let fname = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    let conn = open_db(&app)?;
    conn.execute(
        "INSERT OR IGNORE INTO assets
         (path,name,format,width,height,size_bytes,folder,source,author,tags,added_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
        rusqlite::params![
            path.to_string_lossy().to_string(),
            fname,
            ext.to_uppercase(),
            w,
            h,
            bytes.len() as i64,
            "拖入",
            "拖入",
            "",
            "[]",
            now_secs()
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(ImportedBlob {
        path: path.to_string_lossy().to_string(),
        name: fname,
        width: w,
        height: h,
    })
}

/// 收藏 / 取消收藏
#[tauri::command]
pub fn set_favorite(app: tauri::AppHandle, id: i64, fav: bool) -> Result<(), String> {
    let conn = open_db(&app)?;
    conn.execute(
        "UPDATE assets SET favorite=?1 WHERE id=?2",
        rusqlite::params![fav as i64, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 返回库中所有素材
#[tauri::command]
pub fn list_assets(app: tauri::AppHandle) -> Result<Vec<Asset>, String> {
    let conn = open_db(&app)?;
    fetch_assets(&conn)
}

/// 失效链接检测：返回原文件已被移动/删除的素材 id。
/// 从加载热路径分离——大库时逐条 stat 磁盘会把首屏卡死，故前端进入后台单独跑一次。
#[tauri::command]
pub fn check_missing(app: tauri::AppHandle) -> Result<Vec<i64>, String> {
    let conn = open_db(&app)?;
    let mut stmt = conn
        .prepare("SELECT id, path FROM assets")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;
    let mut missing = Vec::new();
    for r in rows {
        let (id, path) = r.map_err(|e| e.to_string())?;
        if !std::path::Path::new(&path).exists() {
            missing.push(id);
        }
    }
    Ok(missing)
}

/// 清空库（开发期方便重置）
#[tauri::command]
pub fn clear_assets(app: tauri::AppHandle) -> Result<(), String> {
    let conn = open_db(&app)?;
    conn.execute("DELETE FROM assets", [])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 从库移除一条记录 → **软删除进回收站**（保留所有元数据与缩略图，可恢复；**不动原图**）
#[tauri::command]
pub fn remove_asset(app: tauri::AppHandle, id: i64) -> Result<(), String> {
    let conn = open_db(&app)?;
    conn.execute(
        "UPDATE assets SET trashed_at=?1 WHERE id=?2 AND trashed_at IS NULL",
        rusqlite::params![now_secs(), id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 批量移除 → 软删除进回收站（保留元数据/缩略图，可恢复；**不动原图**）
#[tauri::command]
pub fn remove_assets(app: tauri::AppHandle, ids: Vec<i64>) -> Result<usize, String> {
    let conn = open_db(&app)?;
    let now = now_secs();
    let mut n = 0usize;
    for id in ids {
        n += conn
            .execute(
                "UPDATE assets SET trashed_at=?1 WHERE id=?2 AND trashed_at IS NULL",
                rusqlite::params![now, id],
            )
            .map_err(|e| e.to_string())?;
    }
    Ok(n)
}

/// 回收站列表（软删除的素材）
#[tauri::command]
pub fn list_trashed(app: tauri::AppHandle) -> Result<Vec<Asset>, String> {
    let conn = open_db(&app)?;
    fetch_trashed(&conn)
}

/// 从回收站恢复（trashed_at 清空，回到在库）
#[tauri::command]
pub fn restore_assets(app: tauri::AppHandle, ids: Vec<i64>) -> Result<usize, String> {
    let conn = open_db(&app)?;
    let mut n = 0usize;
    for id in ids {
        n += conn
            .execute("UPDATE assets SET trashed_at=NULL WHERE id=?1", rusqlite::params![id])
            .map_err(|e| e.to_string())?;
    }
    Ok(n)
}

/// 彻底删除指定素材（真正从库删除 + 删缩略图缓存，**仍不动原图**，不可恢复）
#[tauri::command]
pub fn purge_assets(app: tauri::AppHandle, ids: Vec<i64>) -> Result<usize, String> {
    let conn = open_db(&app)?;
    let mut n = 0usize;
    for id in ids {
        if let Ok(thumb) = conn.query_row(
            "SELECT COALESCE(thumb,'') FROM assets WHERE id=?1",
            rusqlite::params![id],
            |r| r.get::<_, String>(0),
        ) {
            if !thumb.is_empty() {
                let _ = fs::remove_file(&thumb);
            }
        }
        n += conn
            .execute("DELETE FROM assets WHERE id=?1", rusqlite::params![id])
            .map_err(|e| e.to_string())?;
    }
    Ok(n)
}

/// 清空回收站（彻底删除所有软删除项 + 其缩略图，**不动原图**，不可恢复）
#[tauri::command]
pub fn empty_trash(app: tauri::AppHandle) -> Result<usize, String> {
    let conn = open_db(&app)?;
    let mut stmt = conn
        .prepare("SELECT COALESCE(thumb,'') FROM assets WHERE trashed_at IS NOT NULL")
        .map_err(|e| e.to_string())?;
    let thumbs: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .filter(|t| !t.is_empty())
        .collect();
    drop(stmt);
    for t in thumbs {
        let _ = fs::remove_file(&t);
    }
    conn.execute("DELETE FROM assets WHERE trashed_at IS NOT NULL", [])
        .map_err(|e| e.to_string())
}

/// 把某个文件夹的素材整体从库移除（清缩略图缓存，**不动原文件**），返回移除数量
#[tauri::command]
pub fn remove_folder(app: tauri::AppHandle, folder: String) -> Result<usize, String> {
    let conn = open_db(&app)?;
    let mut stmt = conn
        .prepare("SELECT COALESCE(thumb,'') FROM assets WHERE folder=?1")
        .map_err(|e| e.to_string())?;
    let thumbs: Vec<String> = stmt
        .query_map(rusqlite::params![folder], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .filter(|t| !t.is_empty())
        .collect();
    for t in thumbs {
        let _ = fs::remove_file(&t);
    }
    conn.execute("DELETE FROM assets WHERE folder=?1", rusqlite::params![folder])
        .map_err(|e| e.to_string())
}

/// 覆盖设置某素材的标签
#[tauri::command]
pub fn set_tags(app: tauri::AppHandle, id: i64, tags: Vec<String>) -> Result<(), String> {
    let conn = open_db(&app)?;
    let cj = serde_json::to_string(&tags).map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE assets SET tags=?1 WHERE id=?2",
        rusqlite::params![cj, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 批量给多个素材添加同一个标签
#[tauri::command]
pub fn add_tag_bulk(app: tauri::AppHandle, ids: Vec<i64>, tag: String) -> Result<(), String> {
    let t = tag.trim().to_string();
    if t.is_empty() {
        return Ok(());
    }
    let conn = open_db(&app)?;
    for id in ids {
        let cur: String = conn
            .query_row(
                "SELECT COALESCE(tags,'[]') FROM assets WHERE id=?1",
                rusqlite::params![id],
                |r| r.get(0),
            )
            .unwrap_or_else(|_| "[]".to_string());
        let mut tags: Vec<String> = serde_json::from_str(&cur).unwrap_or_default();
        if !tags.contains(&t) {
            tags.push(t.clone());
        }
        let cj = serde_json::to_string(&tags).unwrap_or_else(|_| "[]".to_string());
        let _ = conn.execute(
            "UPDATE assets SET tags=?1 WHERE id=?2",
            rusqlite::params![cj, id],
        );
    }
    Ok(())
}

fn csv_escape(s: &str) -> String {
    if s.contains(',') || s.contains('"') || s.contains('\n') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

/// 导出全部素材元数据到指定路径（json / csv）。返回导出条数。体现"数据不锁定"。
#[tauri::command]
pub fn export_metadata(
    app: tauri::AppHandle,
    path: String,
    format: String,
) -> Result<usize, String> {
    let conn = open_db(&app)?;
    let assets = fetch_assets(&conn)?;

    let content = if format.to_lowercase() == "csv" {
        let mut s =
            String::from("id,name,format,width,height,size_bytes,folder,source,author,tags,path\n");
        for a in &assets {
            let tags = a.tags.join("|");
            s.push_str(&format!(
                "{},{},{},{},{},{},{},{},{},{},{}\n",
                a.id,
                csv_escape(&a.name),
                a.format,
                a.width,
                a.height,
                a.size_bytes,
                csv_escape(&a.folder),
                csv_escape(&a.source),
                csv_escape(&a.author),
                csv_escape(&tags),
                csv_escape(&a.path),
            ));
        }
        s
    } else {
        serde_json::to_string_pretty(&assets).map_err(|e| e.to_string())?
    };

    fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(assets.len())
}
