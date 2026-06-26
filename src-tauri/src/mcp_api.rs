//! MCP 本地 API：挂在采集服务器（127.0.0.1:21420）上的 /api/* JSON 接口，
//! 供 scripts/nobi-mcp.mjs（stdio MCP 桥）转发给 Claude Code / Codex 等智能体。
//! 只监听回环地址；写操作均复用既有命令逻辑，不绕过任何业务规则。

use std::collections::HashMap;
use std::sync::mpsc::Sender;
use std::sync::Mutex;

use tauri::{Emitter, Manager};

use crate::db::{fetch_assets, open_db};

/// 等待前端回填 CLIP 搜索结果的挂起请求表（语义/以图搜图：向量由前端 transformers.js 算）。
#[derive(Default)]
pub struct McpSearch {
    pub pending: Mutex<HashMap<u64, Sender<Vec<i64>>>>,
}
static SEARCH_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// 前端算完语义搜索结果后回填给等待中的 /api/search 请求。
#[tauri::command]
pub fn mcp_search_result(app: tauri::AppHandle, id: u64, ids: Vec<i64>) {
    if let Some(tx) = app
        .state::<McpSearch>()
        .pending
        .lock()
        .ok()
        .and_then(|mut m| m.remove(&id))
    {
        let _ = tx.send(ids);
    }
}

/// 解析 URL 查询串（极简：不做 url-decode 之外的处理，参数值需 encodeURIComponent）
fn query_params(url: &str) -> std::collections::HashMap<String, String> {
    let mut m = std::collections::HashMap::new();
    if let Some(q) = url.split_once('?').map(|(_, q)| q) {
        for pair in q.split('&') {
            if let Some((k, v)) = pair.split_once('=') {
                m.insert(k.to_string(), urldecode(v));
            }
        }
    }
    m
}

fn urldecode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) =
                u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""), 16)
            {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(if bytes[i] == b'+' { b' ' } else { bytes[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn json_ok(v: serde_json::Value) -> (u16, String) {
    (200, v.to_string())
}
fn json_err(code: u16, msg: &str) -> (u16, String) {
    (code, serde_json::json!({ "ok": false, "error": msg }).to_string())
}

/// 处理 /api/* 请求，返回 (状态码, JSON 字符串)
pub fn handle_api(app: &tauri::AppHandle, method: &str, url: &str, body: &str) -> (u16, String) {
    let path = url.split('?').next().unwrap_or(url);
    let q = query_params(url);
    let parsed: serde_json::Value =
        serde_json::from_str(if body.is_empty() { "{}" } else { body }).unwrap_or_default();

    match (method, path) {
        ("GET", "/api/status") => {
            let conn = match open_db(app) {
                Ok(c) => c,
                Err(e) => return json_err(500, &e),
            };
            let total: i64 = conn
                .query_row("SELECT COUNT(*) FROM assets", [], |r| r.get(0))
                .unwrap_or(0);
            let favs: i64 = conn
                .query_row("SELECT COUNT(*) FROM assets WHERE favorite=1", [], |r| r.get(0))
                .unwrap_or(0);
            let boards: i64 = conn
                .query_row("SELECT COUNT(*) FROM boards", [], |r| r.get(0))
                .unwrap_or(0);
            json_ok(serde_json::json!({
                "ok": true, "app": "Nobi", "assets": total, "favorites": favs, "boards": boards
            }))
        }

        ("GET", "/api/assets") => {
            let conn = match open_db(app) {
                Ok(c) => c,
                Err(e) => return json_err(500, &e),
            };
            let all = match fetch_assets(&conn) {
                Ok(a) => a,
                Err(e) => return json_err(500, &e),
            };
            let query = q.get("query").map(|s| s.to_lowercase());
            let tag = q.get("tag");
            let folder = q.get("folder");
            let favorite = q.get("favorite").map(|s| s == "1" || s == "true");
            let limit: usize = q.get("limit").and_then(|s| s.parse().ok()).unwrap_or(50);
            let offset: usize = q.get("offset").and_then(|s| s.parse().ok()).unwrap_or(0);
            let hits: Vec<&crate::db::Asset> = all
                .iter()
                .filter(|a| {
                    if let Some(qs) = &query {
                        if !a.name.to_lowercase().contains(qs)
                            && !a.tags.iter().any(|t| t.to_lowercase().contains(qs))
                        {
                            return false;
                        }
                    }
                    if let Some(t) = tag {
                        if !a.tags.iter().any(|x| x == t) {
                            return false;
                        }
                    }
                    if let Some(f) = folder {
                        // 按父目录完整路径前缀（与前端文件夹语义一致：精确父目录）
                        let dir = a.path.rsplit_once(['\\', '/']).map(|(d, _)| d).unwrap_or("");
                        if dir != f {
                            return false;
                        }
                    }
                    if let Some(fav) = favorite {
                        if a.favorite != fav {
                            return false;
                        }
                    }
                    true
                })
                .collect();
            let total = hits.len();
            let page: Vec<_> = hits.into_iter().skip(offset).take(limit.min(500)).collect();
            json_ok(serde_json::json!({ "ok": true, "total": total, "assets": page }))
        }

        ("GET", "/api/asset") => {
            let id: i64 = match q.get("id").and_then(|s| s.parse().ok()) {
                Some(i) => i,
                None => return json_err(400, "missing id"),
            };
            let conn = match open_db(app) {
                Ok(c) => c,
                Err(e) => return json_err(500, &e),
            };
            match fetch_assets(&conn) {
                Ok(all) => match all.into_iter().find(|a| a.id == id) {
                    Some(a) => json_ok(serde_json::json!({ "ok": true, "asset": a })),
                    None => json_err(404, "asset not found"),
                },
                Err(e) => json_err(500, &e),
            }
        }

        ("GET", "/api/similar") => {
            let id: i64 = match q.get("id").and_then(|s| s.parse().ok()) {
                Some(i) => i,
                None => return json_err(400, "missing id"),
            };
            let top: usize = q.get("top").and_then(|s| s.parse().ok()).unwrap_or(12);
            match crate::search::clip_similar(app.clone(), id, top) {
                Ok(ids) => json_ok(serde_json::json!({ "ok": true, "ids": ids })),
                Err(e) => json_err(500, &e),
            }
        }

        ("POST", "/api/tags") => {
            let ids: Vec<i64> = parsed["ids"]
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_i64()).collect())
                .unwrap_or_default();
            let tag = parsed["tag"].as_str().unwrap_or("").to_string();
            if ids.is_empty() || tag.is_empty() {
                return json_err(400, "missing ids/tag");
            }
            match crate::library::add_tag_bulk(app.clone(), ids.clone(), tag) {
                Ok(_) => {
                    let _ = app.emit("library-changed", ());
                    json_ok(serde_json::json!({ "ok": true, "count": ids.len() }))
                }
                Err(e) => json_err(500, &e),
            }
        }

        ("POST", "/api/favorite") => {
            let id = match parsed["id"].as_i64() {
                Some(i) => i,
                None => return json_err(400, "missing id"),
            };
            let fav = parsed["fav"].as_bool().unwrap_or(true);
            match crate::library::set_favorite(app.clone(), id, fav) {
                Ok(_) => {
                    let _ = app.emit("library-changed", ());
                    json_ok(serde_json::json!({ "ok": true }))
                }
                Err(e) => json_err(500, &e),
            }
        }

        ("POST", "/api/remove") => {
            let ids: Vec<i64> = parsed["ids"]
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_i64()).collect())
                .unwrap_or_default();
            if ids.is_empty() {
                return json_err(400, "missing ids");
            }
            match crate::library::remove_assets(app.clone(), ids) {
                Ok(n) => {
                    let _ = app.emit("library-changed", ());
                    json_ok(serde_json::json!({ "ok": true, "removed": n }))
                }
                Err(e) => json_err(500, &e),
            }
        }

        ("POST", "/api/import") => {
            let path = parsed["path"].as_str().unwrap_or("");
            if path.is_empty() {
                return json_err(400, "missing path");
            }
            match crate::library::import_folder(app.clone(), path.to_string()) {
                Ok(n) => {
                    let _ = app.emit("library-changed", ());
                    json_ok(serde_json::json!({ "ok": true, "added": n }))
                }
                Err(e) => json_err(500, &e),
            }
        }

        ("POST", "/api/translate") => {
            // 翻译引擎入口：浏览器扩展 / 划词浮窗 / MCP 桥都走这里
            let req_value = parsed.get("req").cloned().unwrap_or(parsed.clone());
            let req: crate::translation::TranslationRequest = match serde_json::from_value(req_value) {
                Ok(r) => r,
                Err(e) => return json_err(400, &format!("bad translation request: {e}")),
            };
            match tauri::async_runtime::block_on(crate::translation::translate_text(
                app.clone(),
                req,
            )) {
                Ok(result) => json_ok(serde_json::json!({ "ok": true, "result": result })),
                Err(e) => json_err(500, &e),
            }
        }

        ("GET", "/api/search") => {
            // 语义 / 以图搜图：CLIP 向量在前端算，这里发事件给前端、阻塞等回填（带超时）。
            let query = match q.get("query") {
                Some(s) if !s.trim().is_empty() => s.clone(),
                _ => return json_err(400, "missing query"),
            };
            let top: usize = q.get("top").and_then(|s| s.parse().ok()).unwrap_or(20);
            let id = SEARCH_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let (tx, rx) = std::sync::mpsc::channel::<Vec<i64>>();
            if let Ok(mut m) = app.state::<McpSearch>().pending.lock() {
                m.insert(id, tx);
            }
            if app
                .emit("mcp-search", serde_json::json!({ "id": id, "query": query, "top": top }))
                .is_err()
            {
                let _ = app.state::<McpSearch>().pending.lock().map(|mut m| m.remove(&id));
                return json_err(500, "emit failed");
            }
            match rx.recv_timeout(std::time::Duration::from_secs(20)) {
                Ok(ids) => json_ok(serde_json::json!({ "ok": true, "ids": ids })),
                Err(_) => {
                    let _ = app.state::<McpSearch>().pending.lock().map(|mut m| m.remove(&id));
                    json_err(504, "搜索超时——请确认 Nobi 主窗开着（语义搜索的向量在前端计算）")
                }
            }
        }

        ("GET", "/api/tags") => {
            let conn = match open_db(app) {
                Ok(c) => c,
                Err(e) => return json_err(500, &e),
            };
            let all = match fetch_assets(&conn) {
                Ok(a) => a,
                Err(e) => return json_err(500, &e),
            };
            let mut counts: std::collections::BTreeMap<String, i64> = std::collections::BTreeMap::new();
            for a in &all {
                for t in &a.tags {
                    *counts.entry(t.clone()).or_insert(0) += 1;
                }
            }
            let tags: Vec<_> = counts
                .into_iter()
                .map(|(name, count)| serde_json::json!({ "name": name, "count": count }))
                .collect();
            json_ok(serde_json::json!({ "ok": true, "tags": tags }))
        }

        ("POST", "/api/tags/set") => {
            let id = match parsed["id"].as_i64() {
                Some(i) => i,
                None => return json_err(400, "missing id"),
            };
            let tags: Vec<String> = parsed["tags"]
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                .unwrap_or_default();
            match crate::library::set_tags(app.clone(), id, tags) {
                Ok(_) => {
                    let _ = app.emit("library-changed", ());
                    json_ok(serde_json::json!({ "ok": true }))
                }
                Err(e) => json_err(500, &e),
            }
        }

        ("POST", "/api/tag/rename") => {
            let from = parsed["from"].as_str().unwrap_or("").to_string();
            let to = parsed["to"].as_str().unwrap_or("").to_string();
            match crate::library::rename_tag(app.clone(), from, to) {
                Ok(n) => {
                    let _ = app.emit("library-changed", ());
                    json_ok(serde_json::json!({ "ok": true, "changed": n }))
                }
                Err(e) => json_err(500, &e),
            }
        }

        ("POST", "/api/tag/delete") => {
            let name = parsed["name"].as_str().unwrap_or("").to_string();
            match crate::library::delete_tag(app.clone(), name) {
                Ok(n) => {
                    let _ = app.emit("library-changed", ());
                    json_ok(serde_json::json!({ "ok": true, "changed": n }))
                }
                Err(e) => json_err(500, &e),
            }
        }

        ("GET", "/api/collections") => match crate::collections::list_collections(app.clone()) {
            Ok(c) => json_ok(serde_json::json!({ "ok": true, "collections": c })),
            Err(e) => json_err(500, &e),
        },

        ("POST", "/api/collection/create") => {
            let name = parsed["name"].as_str().unwrap_or("").to_string();
            let ids: Vec<i64> = parsed["ids"]
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_i64()).collect())
                .unwrap_or_default();
            match crate::collections::create_collection(app.clone(), name, ids) {
                Ok(id) => {
                    let _ = app.emit("library-changed", ());
                    json_ok(serde_json::json!({ "ok": true, "id": id }))
                }
                Err(e) => json_err(500, &e),
            }
        }

        ("POST", "/api/collection/add") => {
            let id = match parsed["id"].as_i64() {
                Some(i) => i,
                None => return json_err(400, "missing id"),
            };
            let ids: Vec<i64> = parsed["ids"]
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_i64()).collect())
                .unwrap_or_default();
            match crate::collections::add_to_collection(app.clone(), id, ids) {
                Ok(n) => {
                    let _ = app.emit("library-changed", ());
                    json_ok(serde_json::json!({ "ok": true, "added": n }))
                }
                Err(e) => json_err(500, &e),
            }
        }

        ("GET", "/api/boards") => match crate::board::list_boards(app.clone()) {
            Ok(b) => json_ok(serde_json::json!({ "ok": true, "boards": b })),
            Err(e) => json_err(500, &e),
        },

        ("POST", "/api/board/add") => {
            // 把素材推上当前画板：发事件给前端，前端用 openBoardWith 现场摆放（所见即所得）
            let ids: Vec<i64> = parsed["ids"]
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_i64()).collect())
                .unwrap_or_default();
            if ids.is_empty() {
                return json_err(400, "missing ids");
            }
            match app.emit("mcp-add-to-board", serde_json::json!({ "ids": ids })) {
                Ok(_) => json_ok(serde_json::json!({ "ok": true, "sent": ids.len() })),
                Err(e) => json_err(500, &e.to_string()),
            }
        }

        _ => json_err(404, "unknown api"),
    }
}
