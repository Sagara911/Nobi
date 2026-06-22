// 文件夹实时监听：导入的根目录加入监听，磁盘新增媒体文件 → 自动入库 + 通知前端刷新。
// 删除/移动只触发一次刷新（前端重算「失效链接」标灰），**不在这里硬删/软删**——保持非破坏。
// 监听是系统级事件(Windows ReadDirectoryChangesW)，且只对变化的那个文件做导入，不重扫整棵树。
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, Manager};

use crate::db::{now_secs, open_db};
use crate::library::scan_path;

/// 监听器存活在 Tauri 托管状态里（丢弃即停止监听）。
pub struct WatchState(pub Mutex<Option<RecommendedWatcher>>);

const KEY_ROOTS: &str = "watched_folders";
const KEY_ENABLED: &str = "auto_sync";

fn get_setting(app: &AppHandle, key: &str) -> Option<String> {
    let conn = open_db(app).ok()?;
    conn.query_row(
        "SELECT value FROM settings WHERE key=?1",
        rusqlite::params![key],
        |r| r.get::<_, String>(0),
    )
    .ok()
}

fn set_setting(app: &AppHandle, key: &str, value: &str) {
    if let Ok(conn) = open_db(app) {
        let _ = conn.execute(
            "INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=?2",
            rusqlite::params![key, value],
        );
    }
}

pub fn watched_roots(app: &AppHandle) -> Vec<String> {
    get_setting(app, KEY_ROOTS)
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .unwrap_or_default()
}

pub fn auto_sync_enabled(app: &AppHandle) -> bool {
    // 默认开
    get_setting(app, KEY_ENABLED).map(|v| v != "0").unwrap_or(true)
}

/// 追加导入根（去重）并按当前开关重挂监听。
pub fn add_roots(app: &AppHandle, roots: Vec<String>) {
    let mut cur = watched_roots(app);
    let mut changed = false;
    for r in roots {
        if !cur.iter().any(|x| x == &r) {
            cur.push(r);
            changed = true;
        }
    }
    if changed {
        set_setting(
            app,
            KEY_ROOTS,
            &serde_json::to_string(&cur).unwrap_or_else(|_| "[]".into()),
        );
    }
    let _ = rewatch(app);
}

/// 取消监听某个根。
pub fn remove_root(app: &AppHandle, root: &str) {
    let cur: Vec<String> = watched_roots(app).into_iter().filter(|r| r != root).collect();
    set_setting(
        app,
        KEY_ROOTS,
        &serde_json::to_string(&cur).unwrap_or_else(|_| "[]".into()),
    );
    let _ = rewatch(app);
}

/// 按当前 enabled + roots 重建监听器（先丢弃旧的：停止监听 + 其处理线程因通道关闭而退出）。
pub fn rewatch(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<WatchState>();
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    *guard = None;
    if !auto_sync_enabled(app) {
        return Ok(());
    }
    let roots = watched_roots(app);
    if roots.is_empty() {
        return Ok(());
    }

    let (tx, rx) = std::sync::mpsc::channel::<PathBuf>();
    let mut watcher: RecommendedWatcher =
        notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(ev) = res {
                use notify::EventKind;
                if matches!(
                    ev.kind,
                    EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
                ) {
                    for p in ev.paths {
                        let _ = tx.send(p);
                    }
                }
            }
        })
        .map_err(|e| e.to_string())?;
    for r in &roots {
        let _ = watcher.watch(Path::new(r), RecursiveMode::Recursive);
    }

    // 处理线程：防抖批处理——收到事件后再多等 800ms 收集同批，统一导入 + 只 emit 一次。
    let app2 = app.clone();
    std::thread::spawn(move || {
        while let Ok(first) = rx.recv() {
            let mut batch = vec![first];
            while let Ok(p) = rx.recv_timeout(Duration::from_millis(800)) {
                if batch.len() < 8000 {
                    batch.push(p);
                }
            }
            if let Ok(conn) = open_db(&app2) {
                let now = now_secs();
                for p in &batch {
                    // 只对"现在还在的文件"做导入(新增/改名落地)；删除的不管(交给前端失效检测标灰)
                    if p.is_file() {
                        let _ = scan_path(&conn, &p.to_string_lossy(), now); // INSERT OR IGNORE，幂等
                    }
                }
            }
            let _ = app2.emit("library-changed", ()); // 新增/删除/移动都刷新一次
        }
    });

    *guard = Some(watcher);
    Ok(())
}

#[tauri::command]
pub fn get_auto_sync(app: AppHandle) -> bool {
    auto_sync_enabled(&app)
}

#[tauri::command]
pub fn set_auto_sync(app: AppHandle, on: bool) -> Result<(), String> {
    set_setting(&app, KEY_ENABLED, if on { "1" } else { "0" });
    rewatch(&app)
}

#[tauri::command]
pub fn list_watched(app: AppHandle) -> Vec<String> {
    watched_roots(&app)
}

#[tauri::command]
pub fn unwatch_folder(app: AppHandle, root: String) -> Result<(), String> {
    remove_root(&app, &root);
    Ok(())
}
