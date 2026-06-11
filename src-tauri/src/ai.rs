//! AI 视觉能力：打标 / 反推提示词 / 画面分析 / 自定义指令 / Ollama 模型管理。
//! 所有调用走 OpenAI 兼容接口（settings::ai_config 决定本地或云端），
//! 上层加功能 = 加一段 prompt（内置 mode 或用户自定义指令），不动调用核心。

use std::fs;

use base64::Engine;
use serde::Serialize;
use tauri::Emitter;

use crate::db::open_db;
use crate::settings::ai_config;

fn image_data_uri(path: &str) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let lower = path.to_lowercase();
    let mime = if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else {
        "image/png"
    };
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{};base64,{}", mime, b64))
}

/// 视觉调用核心：取图（优先缩略图）→ 调 Vision Provider → 返回文本
async fn run_vision(app: &tauri::AppHandle, id: i64, prompt: &str) -> Result<String, String> {
    let img_path: String = {
        let conn = open_db(app)?;
        conn.query_row(
            "SELECT COALESCE(NULLIF(thumb,''), path) FROM assets WHERE id=?1",
            rusqlite::params![id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?
    };
    let data_uri = image_data_uri(&img_path)?;

    let (base, model, key) = ai_config(app);
    let url = format!("{}/chat/completions", base.trim_end_matches('/'));
    let body = serde_json::json!({
        "model": model,
        "stream": false,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": data_uri}}
            ]
        }]
    });

    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", key))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求 AI 服务失败：{e}（确认 Ollama 在运行）"))?;
    if !resp.status().is_success() {
        let st = resp.status();
        let t = resp.text().await.unwrap_or_default();
        // 典型场景：纯文本 API（如 DeepSeek 官方）不认识 image_url 内容块
        if t.contains("image_url") && (t.contains("unknown variant") || t.contains("expected `text`")) {
            return Err("该 API 不支持图像输入：Nobi 的打标/反推/分析需要视觉(VL)模型。\
                请在 AI 设置里换支持看图的服务（预设里有：智谱 GLM-4V-Flash 免费、\
                硅基流动/阿里云 Qwen-VL、GPT-4o-mini），DeepSeek 官方 API 目前纯文本。"
                .to_string());
        }
        return Err(format!("AI 服务返回 {st}: {t}"));
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let content = v["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_string();
    if content.is_empty() {
        return Err("AI 返回空结果".to_string());
    }
    Ok(content)
}

/// 对某素材跑一次内置模式。mode: "tags" | "prompt" | "caption" | 其它=分析。
#[tauri::command]
pub async fn ai_run(app: tauri::AppHandle, id: i64, mode: String) -> Result<String, String> {
    let prompt = match mode.as_str() {
        "tags" => "请用中文为这张图片生成 6-10 个简短标签，覆盖：题材/主体、风格、场景、配色、明暗氛围。只输出标签本身，用英文逗号 , 分隔，不要编号、不要解释。",
        "prompt" => "Generate a single Stable Diffusion / Midjourney style prompt (comma-separated English keywords) describing this reference image: subject, style, lighting, composition, camera, quality. Output ONLY the prompt text.",
        "caption" => "用中文一句话（40字以内）概括这张图：主体、风格、场景、配色、氛围。只输出这一句话，不要解释、不要换行。",
        _ => "用中文分析这张画面：构图、打光、配色、风格特点。简明扼要，分点列出。",
    };
    let content = run_vision(&app, id, prompt).await?;

    // tags 模式：解析并合并写回
    if mode == "tags" {
        let new_tags: Vec<String> = content
            .split(|c| c == ',' || c == '，' || c == '、' || c == '\n')
            .map(|s| {
                s.trim()
                    .trim_matches(|c| c == '#' || c == '-' || c == '*' || c == '.')
                    .trim()
                    .to_string()
            })
            .filter(|s| !s.is_empty() && s.chars().count() <= 12)
            .collect();
        let conn = open_db(&app)?;
        let cur: String = conn
            .query_row(
                "SELECT COALESCE(tags,'[]') FROM assets WHERE id=?1",
                rusqlite::params![id],
                |r| r.get(0),
            )
            .unwrap_or_else(|_| "[]".to_string());
        let mut tags: Vec<String> = serde_json::from_str(&cur).unwrap_or_default();
        for t in new_tags {
            if !tags.contains(&t) {
                tags.push(t);
            }
        }
        let cj = serde_json::to_string(&tags).unwrap_or_else(|_| "[]".to_string());
        let _ = conn.execute(
            "UPDATE assets SET tags=?1 WHERE id=?2",
            rusqlite::params![cj, id],
        );
    }

    Ok(content)
}

/// 批量给多张素材跑自动打标。返回成功数量。
#[tauri::command]
pub async fn ai_tag_bulk(app: tauri::AppHandle, ids: Vec<i64>) -> Result<usize, String> {
    let mut ok = 0usize;
    for id in ids {
        if ai_run(app.clone(), id, "tags".to_string()).await.is_ok() {
            ok += 1;
        }
    }
    Ok(ok)
}

// ===== 自定义 AI 指令（用户自己的 prompt 模板库）=====

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCommand {
    id: i64,
    name: String,
    prompt: String,
}

/// 用任意 prompt 对某素材跑一次视觉模型（自定义指令）
#[tauri::command]
pub async fn ai_run_custom(
    app: tauri::AppHandle,
    id: i64,
    prompt: String,
) -> Result<String, String> {
    run_vision(&app, id, &prompt).await
}

#[tauri::command]
pub fn list_ai_commands(app: tauri::AppHandle) -> Result<Vec<AiCommand>, String> {
    let conn = open_db(&app)?;
    let mut stmt = conn
        .prepare("SELECT id,name,prompt FROM ai_commands ORDER BY id")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(AiCommand {
                id: r.get(0)?,
                name: r.get(1)?,
                prompt: r.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub fn save_ai_command(app: tauri::AppHandle, name: String, prompt: String) -> Result<(), String> {
    let (n, p) = (name.trim(), prompt.trim());
    if n.is_empty() || p.is_empty() {
        return Err("名称和指令内容都不能为空".into());
    }
    let conn = open_db(&app)?;
    conn.execute(
        "INSERT INTO ai_commands(name,prompt) VALUES(?1,?2)",
        rusqlite::params![n, p],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_ai_command(app: tauri::AppHandle, id: i64) -> Result<(), String> {
    let conn = open_db(&app)?;
    conn.execute("DELETE FROM ai_commands WHERE id=?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ===== 本地 AI 一键安装（检测 Ollama / 拉取模型带进度）=====

fn ollama_host(app: &tauri::AppHandle) -> String {
    let (base, _m, _k) = ai_config(app);
    base.trim_end_matches("/v1").trim_end_matches('/').to_string()
}

/// 检测本地 Ollama 是否在运行，以及当前模型是否已下载
#[tauri::command]
pub async fn ai_status(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let (_b, model, _k) = ai_config(&app);
    let host = ollama_host(&app);
    let client = reqwest::Client::new();
    let resp = client
        .get(format!("{}/api/tags", host))
        .timeout(std::time::Duration::from_secs(3))
        .send()
        .await;
    match resp {
        Ok(r) if r.status().is_success() => {
            let v: serde_json::Value = r.json().await.unwrap_or(serde_json::json!({"models":[]}));
            let models: Vec<String> = v["models"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|m| m["name"].as_str().map(|s| s.to_string()))
                        .collect()
                })
                .unwrap_or_default();
            let present = models.iter().any(|m| m == &model);
            Ok(serde_json::json!({
                "ollama": true, "model": model, "modelPresent": present, "models": models
            }))
        }
        _ => Ok(serde_json::json!({
            "ollama": false, "model": model, "modelPresent": false, "models": []
        })),
    }
}

/// 一键拉取模型；通过 "pull-progress" 事件把进度推给前端
#[tauri::command]
pub async fn pull_model(app: tauri::AppHandle, model: String) -> Result<(), String> {
    let host = ollama_host(&app);
    let client = reqwest::Client::new();
    let mut resp = client
        .post(format!("{}/api/pull", host))
        .json(&serde_json::json!({ "model": model, "stream": true }))
        .send()
        .await
        .map_err(|e| format!("连接 Ollama 失败：{e}（确认已安装并运行）"))?;
    if !resp.status().is_success() {
        return Err(format!("Ollama 返回 {}", resp.status()));
    }
    let mut buf = String::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        buf.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(nl) = buf.find('\n') {
            let line: String = buf.drain(..=nl).collect();
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                let status = v["status"].as_str().unwrap_or("").to_string();
                let completed = v["completed"].as_f64().unwrap_or(0.0);
                let total = v["total"].as_f64().unwrap_or(0.0);
                let percent = if total > 0.0 {
                    (completed / total * 100.0) as i64
                } else {
                    -1
                };
                let _ = app.emit(
                    "pull-progress",
                    serde_json::json!({ "status": status, "percent": percent }),
                );
            }
        }
    }
    let _ = app.emit(
        "pull-progress",
        serde_json::json!({ "status": "success", "percent": 100 }),
    );
    Ok(())
}
