//! 配置：AI Provider 可插拔的核心。
//! 优先级统一为「用户设置(settings 表) > 环境变量 > 默认值」。
//! 任何模块需要 Provider 配置都从这里拿，禁止散落硬编码。

use crate::db::open_db;

/// 读取单个用户设置项（非空才算）
fn get_setting(app: &tauri::AppHandle, key: &str) -> Option<String> {
    let conn = open_db(app).ok()?;
    conn.query_row(
        "SELECT value FROM settings WHERE key=?1",
        rusqlite::params![key],
        |r| r.get::<_, String>(0),
    )
    .ok()
    .filter(|s| !s.trim().is_empty())
}

/// 配置优先级：用户设置 > 环境变量 > 默认值
fn cfg(app: &tauri::AppHandle, skey: &str, env: &str, def: &str) -> String {
    get_setting(app, skey)
        .or_else(|| std::env::var(env).ok().filter(|s| !s.is_empty()))
        .unwrap_or_else(|| def.to_string())
}

/// (base_url, model, api_key) —— 视觉/LLM Provider（默认本地 Ollama）
pub fn ai_config(app: &tauri::AppHandle) -> (String, String, String) {
    (
        cfg(app, "ai_base", "NOBI_AI_BASE", "http://localhost:11434/v1"),
        cfg(app, "ai_model", "NOBI_AI_MODEL", "gemma4:12b"),
        cfg(app, "ai_key", "NOBI_AI_KEY", "ollama"),
    )
}

/// (base_url, model, api_key) —— 文本嵌入 Provider
pub fn embed_config(app: &tauri::AppHandle) -> (String, String, String) {
    let (base, _m, key) = ai_config(app);
    let model = cfg(app, "embed_model", "NOBI_EMBED_MODEL", "bge-m3");
    (base, model, key)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSettings {
    ai_base: String,
    ai_model: String,
    ai_key: String,
    embed_model: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSettingsIn {
    ai_base: String,
    ai_model: String,
    ai_key: String,
    embed_model: String,
}

/// 返回当前生效的 AI 配置（含默认值），供设置面板回显
#[tauri::command]
pub fn get_settings(app: tauri::AppHandle) -> Result<AiSettings, String> {
    let (base, model, key) = ai_config(&app);
    let (_b, emb, _k) = embed_config(&app);
    Ok(AiSettings {
        ai_base: base,
        ai_model: model,
        ai_key: key,
        embed_model: emb,
    })
}

/// 保存 AI 配置（留空的项会回退到环境变量/默认值）
#[tauri::command]
pub fn set_settings(app: tauri::AppHandle, settings: AiSettingsIn) -> Result<(), String> {
    let conn = open_db(&app)?;
    let put = |k: &str, v: &str| {
        let _ = conn.execute(
            "INSERT INTO settings(key,value) VALUES(?1,?2)
             ON CONFLICT(key) DO UPDATE SET value=?2",
            rusqlite::params![k, v],
        );
    };
    put("ai_base", settings.ai_base.trim());
    put("ai_model", settings.ai_model.trim());
    put("ai_key", settings.ai_key.trim());
    put("embed_model", settings.embed_model.trim());
    Ok(())
}
