//! 浏览器采集：本地 HTTP 服务（127.0.0.1:21420）接收扩展发来的图片（带来源出处），
//! 以及把内嵌的扩展文件导出给用户安装。

use std::fs;

use base64::Engine;
use tauri::{Emitter, Manager};

use crate::db::{now_secs, open_db};

fn sanitize_filename(s: &str) -> String {
    s.chars()
        .filter(|c| !"\\/:*?\"<>|".contains(*c))
        .take(60)
        .collect::<String>()
        .trim()
        .to_string()
}

fn handle_collect(app: &tauri::AppHandle, body: &str) -> Result<String, String> {
    let v: serde_json::Value = serde_json::from_str(body).map_err(|e| e.to_string())?;
    let data_b64 = v["dataB64"].as_str().ok_or("missing dataB64")?;
    let mime = v["mime"].as_str().unwrap_or("image/png");
    let src_url = v["srcUrl"].as_str().unwrap_or("");
    let page_url = v["pageUrl"].as_str().unwrap_or("");
    let page_title = v["pageTitle"].as_str().unwrap_or("");

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_b64)
        .map_err(|e| e.to_string())?;
    let ext = match mime {
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "image/bmp" => "bmp",
        "image/avif" => "avif",
        _ => "png",
    };

    // 存到 图片/Nobi（文件透明可见），失败回退应用数据目录
    let dir = app
        .path()
        .picture_dir()
        .map(|d| d.join("Nobi"))
        .or_else(|_| app.path().app_data_dir().map(|d| d.join("collected")))
        .map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    // 文件名：优先取图片 URL 的文件名，否则用页面标题
    let base = src_url
        .split('/')
        .next_back()
        .unwrap_or("")
        .split('?')
        .next()
        .unwrap_or("");
    let stem = std::path::Path::new(base)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    let mut name_stem = sanitize_filename(if stem.chars().count() >= 3 {
        stem
    } else {
        page_title
    });
    if name_stem.is_empty() {
        name_stem = format!("采集_{}", now_secs());
    }
    let mut path = dir.join(format!("{}.{}", name_stem, ext));
    let mut n = 1;
    while path.exists() {
        path = dir.join(format!("{}_{}.{}", name_stem, n, ext));
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
    let conn = open_db(app)?;
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
            "Nobi采集",
            page_url,
            "",
            "[]",
            now_secs()
        ],
    )
    .map_err(|e| e.to_string())?;

    let _ = app.emit("collected", serde_json::json!({ "name": fname }));
    Ok(fname)
}

/// 把内嵌的浏览器扩展文件导出到应用数据目录，返回文件夹路径（供用户在浏览器加载）
#[tauri::command]
pub fn export_extension(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("browser-extension");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::write(
        dir.join("manifest.json"),
        include_bytes!("../../browser-extension/manifest.json"),
    )
    .map_err(|e| e.to_string())?;
    fs::write(
        dir.join("background.js"),
        include_bytes!("../../browser-extension/background.js"),
    )
    .map_err(|e| e.to_string())?;
    fs::write(
        dir.join("icon.png"),
        include_bytes!("../../browser-extension/icon.png"),
    )
    .map_err(|e| e.to_string())?;
    fs::write(
        dir.join("README.md"),
        include_bytes!("../../browser-extension/README.md"),
    )
    .map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().to_string())
}

/// 后台线程跑一个本地 HTTP 服务（127.0.0.1:21420），接收浏览器扩展的采集请求
pub fn start_collect_server(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let server = match tiny_http::Server::http("127.0.0.1:21420") {
            Ok(s) => s,
            Err(_) => return, // 端口被占（比如开了第二个实例），静默放弃
        };
        for mut req in server.incoming_requests() {
            let cors = || {
                vec![
                    tiny_http::Header::from_bytes("Access-Control-Allow-Origin", "*").unwrap(),
                    tiny_http::Header::from_bytes("Access-Control-Allow-Headers", "Content-Type")
                        .unwrap(),
                    tiny_http::Header::from_bytes("Access-Control-Allow-Methods", "POST, OPTIONS")
                        .unwrap(),
                ]
            };
            if req.method() == &tiny_http::Method::Options {
                let mut resp = tiny_http::Response::empty(204);
                for h in cors() {
                    resp = resp.with_header(h);
                }
                let _ = req.respond(resp);
                continue;
            }
            if req.method() == &tiny_http::Method::Post && req.url() == "/collect" {
                let mut body = String::new();
                let _ = req.as_reader().read_to_string(&mut body);
                let (code, msg) = match handle_collect(&app, &body) {
                    Ok(name) => (200, format!("{{\"ok\":true,\"name\":\"{}\"}}", name)),
                    Err(e) => (
                        500,
                        format!("{{\"ok\":false,\"error\":\"{}\"}}", e.replace('"', "'")),
                    ),
                };
                let mut resp = tiny_http::Response::from_string(msg).with_status_code(code);
                for h in cors() {
                    resp = resp.with_header(h);
                }
                let _ = req.respond(resp);
            } else {
                let _ = req.respond(
                    tiny_http::Response::from_string("Nobi collect server")
                        .with_status_code(200),
                );
            }
        }
    });
}
