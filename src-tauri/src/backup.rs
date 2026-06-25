//! 库备份 / 迁移：把数据库 + 缩略图整体导出到用户选的文件夹，或从备份恢复回来。
//! 体现「数据不锁定」——换机/重装时不丢标签、收藏、合集、CLIP 索引、缩略图。
//!
//! 注意：**不含原图**。Nobi 默认不复制原图，原图住在用户自己的目录里（拖入/采集的归 图片\Nobi，
//! 需自行另外备份）。恢复后即使原图暂缺，缩略图仍能显示、标签/检索全在，元数据零丢失。

use std::fs;
use std::path::{Path, PathBuf};

use tauri::Manager;

use crate::db::{now_secs, open_db, thumbs_dir};

/// 数据库文件路径（与 db.rs 的 db_path 一致：app_data_dir/nobi.sqlite）。
fn db_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("nobi.sqlite"))
}

/// 递归拷贝目录（dst 不存在则建）。返回拷贝的文件数。
fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<u64> {
    fs::create_dir_all(dst)?;
    let mut n = 0u64;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let to = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            n += copy_dir_all(&entry.path(), &to)?;
        } else {
            fs::copy(entry.path(), &to)?;
            n += 1;
        }
    }
    Ok(n)
}

/// 当前在库素材数（不含回收站）。
fn live_asset_count(app: &tauri::AppHandle) -> i64 {
    open_db(app)
        .ok()
        .and_then(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM assets WHERE trashed_at IS NULL",
                [],
                |r| r.get::<_, i64>(0),
            )
            .ok()
        })
        .unwrap_or(0)
}

/// 把库（数据库 + 缩略图）备份到 dest_dir 下的新子目录 `Nobi备份-<时间戳>`。返回摘要。
#[tauri::command]
pub fn export_library(app: tauri::AppHandle, dest_dir: String) -> Result<String, String> {
    let db = db_file(&app)?;
    if !db.exists() {
        return Err("找不到数据库文件（库可能还是空的）".into());
    }
    let ts = now_secs();
    let out = Path::new(&dest_dir).join(format!("Nobi备份-{ts}"));
    fs::create_dir_all(&out).map_err(|e| format!("建备份目录失败：{e}"))?;

    // 1) 数据库
    fs::copy(&db, out.join("nobi.sqlite")).map_err(|e| format!("拷贝数据库失败：{e}"))?;

    // 2) 缩略图目录（可能不存在/为空）
    let thumbs = thumbs_dir(&app)?;
    let mut thumb_n = 0u64;
    if thumbs.exists() {
        thumb_n = copy_dir_all(&thumbs, &out.join("thumbnails"))
            .map_err(|e| format!("拷贝缩略图失败：{e}"))?;
    }

    // 3) 清单（恢复时校验/展示）
    let asset_n = live_asset_count(&app);
    let manifest = serde_json::json!({
        "app": "nobi",
        "kind": "library-backup",
        "version": 1,
        "createdAt": ts,
        "assets": asset_n,
        "thumbnails": thumb_n,
        "note": "含数据库+缩略图，不含原图（原图在各自目录 / 图片\\Nobi，需另行备份）"
    });
    fs::write(out.join("nobi-backup.json"), manifest.to_string())
        .map_err(|e| format!("写清单失败：{e}"))?;

    Ok(format!(
        "已备份 {asset_n} 条素材 + {thumb_n} 张缩略图 → {}",
        out.display()
    ))
}

/// 从备份目录恢复库：校验 → 当前库改名留底 → 覆盖数据库与缩略图。返回摘要。
/// 数据库每次命令重新打开、无常驻连接，故覆盖文件后前端 reload 即生效（稳妥起见建议重启）。
#[tauri::command]
pub fn import_library(app: tauri::AppHandle, src_dir: String) -> Result<String, String> {
    let src = PathBuf::from(&src_dir);
    let src_db = src.join("nobi.sqlite");
    if !src_db.exists() {
        return Err("该文件夹里没有 nobi.sqlite，可能选错备份目录了".into());
    }

    let cur_db = db_file(&app)?;
    if let Some(dir) = cur_db.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let ts = now_secs();
    // 当前库留底（恢复出错也能找回）
    if cur_db.exists() {
        let bak = cur_db.with_file_name(format!("nobi.sqlite.bak-{ts}"));
        let _ = fs::copy(&cur_db, &bak);
    }
    // 覆盖数据库
    fs::copy(&src_db, &cur_db).map_err(|e| format!("恢复数据库失败：{e}"))?;
    // 清掉可能残留的回滚日志（旧 -journal 会让新库读出半截事务）
    let _ = fs::remove_file(cur_db.with_file_name("nobi.sqlite-journal"));

    // 缩略图：源里有就覆盖进当前缩略图目录
    let src_thumbs = src.join("thumbnails");
    let mut thumb_n = 0u64;
    if src_thumbs.exists() {
        let dst = thumbs_dir(&app)?;
        thumb_n = copy_dir_all(&src_thumbs, &dst).map_err(|e| format!("恢复缩略图失败：{e}"))?;
    }

    let asset_n = live_asset_count(&app);
    Ok(format!(
        "已恢复 {asset_n} 条素材 + {thumb_n} 张缩略图（原库已留底 nobi.sqlite.bak-{ts}）"
    ))
}
