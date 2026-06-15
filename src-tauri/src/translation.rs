//! Translation engine: provider routing, glossary, history, and structured results.
//!
//! Entrypoints such as browser selection, global hotkeys, OCR, MCP, and in-app panels
//! should all call this module instead of owning translation logic themselves.

use std::path::PathBuf;

use rusqlite::{params, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::db::{now_secs, open_db};
use crate::settings::ai_config;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslationRequest {
    pub text: String,
    pub source_lang: Option<String>,
    pub target_lang: Option<String>,
    pub mode: Option<String>,
    pub provider: Option<String>,
    pub source_app: Option<String>,
    pub source_url: Option<String>,
    pub asset_id: Option<i64>,
    pub save_history: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlossaryHit {
    pub source: String,
    pub target: String,
    pub explanation: String,
    pub category: String,
}

/// One dictionary sense group, e.g. part of speech "noun" with its meanings.
/// Populated for single-word / short lookups so the popover can read like a
/// dictionary (Youdao-style) instead of a single flat sentence translation.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DictionaryEntry {
    pub pos: String,
    pub terms: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslationResult {
    pub id: Option<i64>,
    pub source_text: String,
    pub target_text: String,
    pub source_lang: String,
    pub target_lang: String,
    pub mode: String,
    pub provider: String,
    pub used_glossary: Vec<GlossaryHit>,
    pub keywords: Vec<String>,
    pub dictionary: Vec<DictionaryEntry>,
    pub phonetic: Option<String>,
    pub warning: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlossaryTerm {
    pub id: i64,
    pub source: String,
    pub target: String,
    pub explanation: String,
    pub category: String,
    pub tags: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub use_count: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlossaryTermIn {
    pub id: Option<i64>,
    pub source: String,
    pub target: String,
    pub explanation: Option<String>,
    pub category: Option<String>,
    pub tags: Option<Vec<String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslationHistoryItem {
    pub id: i64,
    pub source_text: String,
    pub target_text: String,
    pub source_lang: String,
    pub target_lang: String,
    pub mode: String,
    pub provider: String,
    pub created_at: i64,
}

struct OfflineEntry {
    source: &'static str,
    target: &'static str,
}

const OFFLINE_DICTIONARY: &[OfflineEntry] = &[
    OfflineEntry {
        source: "hello",
        target: "你好",
    },
    OfflineEntry {
        source: "hi",
        target: "你好",
    },
    OfflineEntry {
        source: "thanks",
        target: "谢谢",
    },
    OfflineEntry {
        source: "thank",
        target: "谢谢",
    },
    OfflineEntry {
        source: "you",
        target: "你",
    },
    OfflineEntry {
        source: "your",
        target: "你的",
    },
    OfflineEntry {
        source: "i",
        target: "我",
    },
    OfflineEntry {
        source: "my",
        target: "我的",
    },
    OfflineEntry {
        source: "we",
        target: "我们",
    },
    OfflineEntry {
        source: "they",
        target: "他们",
    },
    OfflineEntry {
        source: "he",
        target: "他",
    },
    OfflineEntry {
        source: "she",
        target: "她",
    },
    OfflineEntry {
        source: "it",
        target: "它",
    },
    OfflineEntry {
        source: "this",
        target: "这个",
    },
    OfflineEntry {
        source: "that",
        target: "那个",
    },
    OfflineEntry {
        source: "these",
        target: "这些",
    },
    OfflineEntry {
        source: "those",
        target: "那些",
    },
    OfflineEntry {
        source: "is",
        target: "是",
    },
    OfflineEntry {
        source: "are",
        target: "是",
    },
    OfflineEntry {
        source: "was",
        target: "曾是",
    },
    OfflineEntry {
        source: "were",
        target: "曾是",
    },
    OfflineEntry {
        source: "be",
        target: "是",
    },
    OfflineEntry {
        source: "have",
        target: "有",
    },
    OfflineEntry {
        source: "has",
        target: "有",
    },
    OfflineEntry {
        source: "had",
        target: "有过",
    },
    OfflineEntry {
        source: "do",
        target: "做",
    },
    OfflineEntry {
        source: "does",
        target: "做",
    },
    OfflineEntry {
        source: "did",
        target: "做过",
    },
    OfflineEntry {
        source: "not",
        target: "不",
    },
    OfflineEntry {
        source: "no",
        target: "不",
    },
    OfflineEntry {
        source: "yes",
        target: "是",
    },
    OfflineEntry {
        source: "and",
        target: "和",
    },
    OfflineEntry {
        source: "or",
        target: "或",
    },
    OfflineEntry {
        source: "but",
        target: "但是",
    },
    OfflineEntry {
        source: "because",
        target: "因为",
    },
    OfflineEntry {
        source: "so",
        target: "所以",
    },
    OfflineEntry {
        source: "if",
        target: "如果",
    },
    OfflineEntry {
        source: "then",
        target: "然后",
    },
    OfflineEntry {
        source: "for",
        target: "为了",
    },
    OfflineEntry {
        source: "from",
        target: "来自",
    },
    OfflineEntry {
        source: "to",
        target: "到",
    },
    OfflineEntry {
        source: "in",
        target: "在",
    },
    OfflineEntry {
        source: "on",
        target: "在",
    },
    OfflineEntry {
        source: "with",
        target: "和",
    },
    OfflineEntry {
        source: "without",
        target: "没有",
    },
    OfflineEntry {
        source: "about",
        target: "关于",
    },
    OfflineEntry {
        source: "can",
        target: "可以",
    },
    OfflineEntry {
        source: "could",
        target: "可以",
    },
    OfflineEntry {
        source: "will",
        target: "将会",
    },
    OfflineEntry {
        source: "would",
        target: "会",
    },
    OfflineEntry {
        source: "should",
        target: "应该",
    },
    OfflineEntry {
        source: "need",
        target: "需要",
    },
    OfflineEntry {
        source: "want",
        target: "想要",
    },
    OfflineEntry {
        source: "make",
        target: "制作",
    },
    OfflineEntry {
        source: "create",
        target: "创建",
    },
    OfflineEntry {
        source: "use",
        target: "使用",
    },
    OfflineEntry {
        source: "work",
        target: "工作",
    },
    OfflineEntry {
        source: "test",
        target: "测试",
    },
    OfflineEntry {
        source: "testing",
        target: "测试",
    },
    OfflineEntry {
        source: "improve",
        target: "改进",
    },
    OfflineEntry {
        source: "improvement",
        target: "改进",
    },
    OfflineEntry {
        source: "start",
        target: "开始",
    },
    OfflineEntry {
        source: "stop",
        target: "停止",
    },
    OfflineEntry {
        source: "open",
        target: "打开",
    },
    OfflineEntry {
        source: "close",
        target: "关闭",
    },
    OfflineEntry {
        source: "save",
        target: "保存",
    },
    OfflineEntry {
        source: "copy",
        target: "复制",
    },
    OfflineEntry {
        source: "select",
        target: "选择",
    },
    OfflineEntry {
        source: "all",
        target: "全部",
    },
    OfflineEntry {
        source: "first",
        target: "首先",
    },
    OfflineEntry {
        source: "last",
        target: "最后",
    },
    OfflineEntry {
        source: "small",
        target: "小的",
    },
    OfflineEntry {
        source: "big",
        target: "大的",
    },
    OfflineEntry {
        source: "new",
        target: "新的",
    },
    OfflineEntry {
        source: "old",
        target: "旧的",
    },
    OfflineEntry {
        source: "good",
        target: "好的",
    },
    OfflineEntry {
        source: "bad",
        target: "坏的",
    },
    OfflineEntry {
        source: "fast",
        target: "快的",
    },
    OfflineEntry {
        source: "slow",
        target: "慢的",
    },
    OfflineEntry {
        source: "right",
        target: "正确的",
    },
    OfflineEntry {
        source: "wrong",
        target: "错误的",
    },
    OfflineEntry {
        source: "problem",
        target: "问题",
    },
    OfflineEntry {
        source: "issue",
        target: "问题",
    },
    OfflineEntry {
        source: "error",
        target: "错误",
    },
    OfflineEntry {
        source: "result",
        target: "结果",
    },
    OfflineEntry {
        source: "text",
        target: "文本",
    },
    OfflineEntry {
        source: "translation",
        target: "翻译",
    },
    OfflineEntry {
        source: "translate",
        target: "翻译",
    },
    OfflineEntry {
        source: "language",
        target: "语言",
    },
    OfflineEntry {
        source: "online",
        target: "在线",
    },
    OfflineEntry {
        source: "offline",
        target: "离线",
    },
    OfflineEntry {
        source: "network",
        target: "网络",
    },
    OfflineEntry {
        source: "page",
        target: "页面",
    },
    OfflineEntry {
        source: "window",
        target: "窗口",
    },
    OfflineEntry {
        source: "button",
        target: "按钮",
    },
    OfflineEntry {
        source: "menu",
        target: "菜单",
    },
    OfflineEntry {
        source: "file",
        target: "文件",
    },
    OfflineEntry {
        source: "image",
        target: "图片",
    },
    OfflineEntry {
        source: "video",
        target: "视频",
    },
    OfflineEntry {
        source: "audio",
        target: "音频",
    },
    OfflineEntry {
        source: "game",
        target: "游戏",
    },
    OfflineEntry {
        source: "development",
        target: "开发",
    },
    OfflineEntry {
        source: "confidence",
        target: "信心",
    },
    OfflineEntry {
        source: "come",
        target: "到来",
    },
    OfflineEntry {
        source: "comes",
        target: "到来",
    },
    OfflineEntry {
        source: "prototype",
        target: "原型",
    },
    OfflineEntry { source: "yes", target: "是" },
    OfflineEntry { source: "no", target: "否" },
    OfflineEntry { source: "ok", target: "好的" },
    OfflineEntry { source: "okay", target: "好的" },
    OfflineEntry { source: "good", target: "好" },
    OfflineEntry { source: "bad", target: "坏" },
    OfflineEntry { source: "please", target: "请" },
    OfflineEntry { source: "sorry", target: "抱歉" },
    OfflineEntry { source: "welcome", target: "欢迎" },
    OfflineEntry { source: "goodbye", target: "再见" },
    OfflineEntry { source: "bye", target: "再见" },
    OfflineEntry { source: "today", target: "今天" },
    OfflineEntry { source: "tomorrow", target: "明天" },
    OfflineEntry { source: "yesterday", target: "昨天" },
    OfflineEntry { source: "now", target: "现在" },
    OfflineEntry { source: "time", target: "时间" },
    OfflineEntry { source: "day", target: "天" },
    OfflineEntry { source: "night", target: "夜晚" },
    OfflineEntry { source: "year", target: "年" },
    OfflineEntry { source: "month", target: "月" },
    OfflineEntry { source: "week", target: "周" },
    OfflineEntry { source: "name", target: "名字" },
    OfflineEntry { source: "people", target: "人们" },
    OfflineEntry { source: "person", target: "人" },
    OfflineEntry { source: "friend", target: "朋友" },
    OfflineEntry { source: "work", target: "工作" },
    OfflineEntry { source: "home", target: "家" },
    OfflineEntry { source: "world", target: "世界" },
    OfflineEntry { source: "water", target: "水" },
    OfflineEntry { source: "food", target: "食物" },
    OfflineEntry { source: "money", target: "钱" },
    OfflineEntry { source: "love", target: "爱" },
    OfflineEntry { source: "help", target: "帮助" },
    OfflineEntry { source: "new", target: "新" },
    OfflineEntry { source: "old", target: "旧" },
    OfflineEntry { source: "big", target: "大" },
    OfflineEntry { source: "small", target: "小" },
    OfflineEntry { source: "open", target: "打开" },
    OfflineEntry { source: "close", target: "关闭" },
    OfflineEntry { source: "start", target: "开始" },
    OfflineEntry { source: "stop", target: "停止" },
    OfflineEntry { source: "save", target: "保存" },
    OfflineEntry { source: "delete", target: "删除" },
    OfflineEntry { source: "search", target: "搜索" },
    OfflineEntry { source: "setting", target: "设置" },
    OfflineEntry { source: "settings", target: "设置" },
    OfflineEntry { source: "user", target: "用户" },
    OfflineEntry { source: "password", target: "密码" },
    OfflineEntry { source: "error", target: "错误" },
    OfflineEntry { source: "success", target: "成功" },
    OfflineEntry { source: "model", target: "模型" },
    OfflineEntry { source: "color", target: "颜色" },
    OfflineEntry { source: "size", target: "尺寸" },
    OfflineEntry { source: "text", target: "文本" },
    OfflineEntry { source: "folder", target: "文件夹" },
    OfflineEntry { source: "download", target: "下载" },
    OfflineEntry { source: "upload", target: "上传" },
    OfflineEntry { source: "update", target: "更新" },
    OfflineEntry { source: "version", target: "版本" },
    OfflineEntry { source: "material", target: "材质" },
    OfflineEntry { source: "texture", target: "纹理" },
    OfflineEntry { source: "render", target: "渲染" },
    OfflineEntry { source: "scene", target: "场景" },
    OfflineEntry { source: "light", target: "灯光" },
    OfflineEntry { source: "camera", target: "相机" },
    OfflineEntry { source: "tool", target: "工具" },
    OfflineEntry { source: "project", target: "项目" },
    OfflineEntry { source: "asset", target: "素材" },
    OfflineEntry { source: "board", target: "画板" },
    OfflineEntry { source: "tag", target: "标签" },
    OfflineEntry { source: "favorite", target: "收藏" },
];

fn norm(s: &str) -> String {
    s.trim().to_lowercase()
}

fn clean_lang(s: Option<String>, fallback: &str) -> String {
    s.map(|x| x.trim().to_string())
        .filter(|x| !x.is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

/// True for a single code-like identifier — `python3`, `ai_config`, `camelCase`,
/// `snake_case`, a path. Such tokens shouldn't be machine-translated (Google
/// turns "python3" into "蟒蛇3"); we keep them verbatim. Plain words like
/// "python" or "apple" are NOT caught, so normal translation still applies.
fn is_code_like_token(text: &str) -> bool {
    let t = text.trim();
    // Single token, ASCII, must contain a letter.
    if t.is_empty() || !t.is_ascii() || t.chars().any(|c| c.is_whitespace()) {
        return false;
    }
    if !t.chars().any(|c| c.is_ascii_alphabetic()) {
        return false;
    }
    let has_digit = t.chars().any(|c| c.is_ascii_digit());
    let has_underscore = t.contains('_');
    let has_path = t.contains('/') || t.contains('\\');
    let bytes = t.as_bytes();
    let has_camel = (1..bytes.len())
        .any(|i| bytes[i].is_ascii_uppercase() && bytes[i - 1].is_ascii_lowercase());
    has_digit || has_underscore || has_path || has_camel
}

struct EcdictHit {
    phonetic: String,
    translation: String,
}

/// Locate the bundled ECDICT SQLite. Order: packaged resource dir → dev source
/// tree → `NOBI_ECDICT_DB` override. Returns None if absent (caller falls back
/// to online), so a missing dictionary degrades gracefully instead of erroring.
fn ecdict_db_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    if let Ok(dir) = app.path().resource_dir() {
        for cand in ["resources/ecdict.db", "ecdict.db"] {
            let p = dir.join(cand);
            if p.exists() {
                return Some(p);
            }
        }
    }
    if let Some(manifest) = option_env!("CARGO_MANIFEST_DIR") {
        let p = PathBuf::from(manifest).join("resources/ecdict.db");
        if p.exists() {
            return Some(p);
        }
    }
    if let Ok(p) = std::env::var("NOBI_ECDICT_DB") {
        let p = PathBuf::from(p);
        if p.exists() {
            return Some(p);
        }
    }
    None
}

/// Offline English→Chinese word lookup against the ECDICT `stardict` table.
fn ecdict_lookup(app: &tauri::AppHandle, word: &str) -> Option<EcdictHit> {
    let path = ecdict_db_path(app)?;
    let conn = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    conn.query_row(
        "SELECT phonetic, translation FROM stardict WHERE word = ?1 COLLATE NOCASE LIMIT 1",
        params![word.trim()],
        |r| {
            Ok(EcdictHit {
                phonetic: r.get::<_, Option<String>>(0)?.unwrap_or_default(),
                translation: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
            })
        },
    )
    .ok()
    .filter(|h| !h.translation.trim().is_empty())
}

/// Split a leading part-of-speech marker ("n.", "vi.", "adj.") off a gloss line.
fn split_pos(line: &str) -> (String, String) {
    if let Some(dot) = line.find('.') {
        let head = &line[..dot];
        if !head.is_empty() && head.len() <= 5 && head.chars().all(|c| c.is_ascii_alphabetic()) {
            return (format!("{head}."), line[dot + 1..].trim().to_string());
        }
    }
    (String::new(), line.to_string())
}

/// Turn ECDICT's multi-line `translation` into structured dictionary entries
/// plus a concise headline (all senses joined) used as the main target text.
fn parse_ecdict_translation(translation: &str) -> (Vec<DictionaryEntry>, String) {
    let mut entries = Vec::new();
    let mut all_terms: Vec<String> = Vec::new();
    for raw in translation.split('\n') {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        let (pos, rest) = split_pos(line);
        let mut terms: Vec<String> = rest
            .split(['；', ';'])
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        if terms.is_empty() {
            terms.push(rest.clone());
        }
        all_terms.extend(terms.iter().cloned());
        entries.push(DictionaryEntry { pos, terms });
    }
    (entries, all_terms.join("；"))
}

/// A short selection worth a dictionary lookup rather than sentence translation:
/// 1–3 words, no sentence punctuation/newlines, not too long.
fn is_word_lookup(text: &str) -> bool {
    let t = text.trim();
    if t.is_empty() || t.chars().count() > 32 {
        return false;
    }
    if t.contains(['.', '!', '?', '。', '！', '？', ',', '，', '\n']) {
        return false;
    }
    let words = t.split_whitespace().count();
    (1..=3).contains(&words)
}

/// Resolve the effective target language. When the caller passes nothing or
/// "auto" (the system-selection popover does this), translate to the opposite
/// of the detected source: Chinese → English, anything else → Chinese.
fn resolve_target_lang(requested: Option<String>, source_lang: &str) -> String {
    let r = requested.map(|x| x.trim().to_string()).unwrap_or_default();
    if !r.is_empty() && !r.eq_ignore_ascii_case("auto") {
        return r;
    }
    if source_lang.to_lowercase().starts_with("zh") {
        "en".to_string()
    } else {
        "zh-CN".to_string()
    }
}

fn clean_mode(s: Option<String>) -> String {
    let mode = s.unwrap_or_default();
    match mode.as_str() {
        "prompt" | "tags" => mode,
        _ => "normal".to_string(),
    }
}

fn is_local_base(base: &str) -> bool {
    let b = base.to_lowercase();
    b.contains("localhost") || b.contains("127.0.0.1") || b.contains("0.0.0.0")
}

fn detect_lang(text: &str) -> String {
    let zh = text
        .chars()
        .filter(|c| ('\u{4e00}'..='\u{9fff}').contains(c))
        .count();
    let ascii_alpha = text.chars().filter(|c| c.is_ascii_alphabetic()).count();
    if zh > 0 && zh >= ascii_alpha / 3 {
        "zh".to_string()
    } else if ascii_alpha > 0 {
        "en".to_string()
    } else {
        "auto".to_string()
    }
}

fn prompt_for(
    mode: &str,
    source_lang: &str,
    target_lang: &str,
    text: &str,
    hits: &[GlossaryHit],
) -> String {
    let mode_hint = match mode {
        "prompt" => {
            "Translate into a clear prompt that can be copied directly. Keep necessary proper nouns and do not add extra content."
        }
        "tags" => {
            "Translate and extract 6 to 12 short, general-purpose tags. Keep proper nouns when needed."
        }
        _ => {
            "Translate directly, naturally, and accurately like a common online translation tool. Output only the translation."
        }
    };
    let glossary = if hits.is_empty() {
        String::new()
    } else {
        let lines = hits
            .iter()
            .map(|h| format!("- {} = {} ({})", h.source, h.target, h.explanation))
            .collect::<Vec<_>>()
            .join("\n");
        format!("\nPreferred custom glossary terms:\n{lines}\n")
    };
    format!(
        "You are Nobi's built-in general-purpose translation engine.\n\
         Source language: {source_lang}\nTarget language: {target_lang}\nMode: {mode}\nRequirement: {mode_hint}\n\
         {glossary}\nOutput only the result text. Do not explain your process.\n\nSource text:\n{text}"
    )
}

fn db_terms(app: &tauri::AppHandle) -> Result<Vec<GlossaryTerm>, String> {
    let conn = open_db(app)?;
    let mut stmt = conn
        .prepare(
            "SELECT id,source,target,COALESCE(explanation,''),COALESCE(category,''),\
             COALESCE(tags,'[]'),COALESCE(created_at,0),COALESCE(updated_at,0),COALESCE(use_count,0)
             FROM glossary_terms ORDER BY length(source) DESC, updated_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            let tags_json: String = r.get(5)?;
            Ok(GlossaryTerm {
                id: r.get(0)?,
                source: r.get(1)?,
                target: r.get(2)?,
                explanation: r.get(3)?,
                category: r.get(4)?,
                tags: serde_json::from_str(&tags_json).unwrap_or_default(),
                created_at: r.get(6)?,
                updated_at: r.get(7)?,
                use_count: r.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

fn glossary_hits(text: &str, terms: &[GlossaryTerm]) -> Vec<GlossaryHit> {
    let low = norm(text);
    let mut hits = Vec::new();
    for t in terms {
        let s = norm(&t.source);
        if s.is_empty() || !low.contains(&s) {
            continue;
        }
        if hits
            .iter()
            .any(|h: &GlossaryHit| h.source.eq_ignore_ascii_case(&t.source))
        {
            continue;
        }
        hits.push(GlossaryHit {
            source: t.source.clone(),
            target: t.target.clone(),
            explanation: t.explanation.clone(),
            category: t.category.clone(),
        });
        if hits.len() >= 16 {
            break;
        }
    }
    hits
}

fn merged_terms(app: &tauri::AppHandle) -> Result<Vec<GlossaryTerm>, String> {
    let mut terms = db_terms(app)?;
    terms.sort_by_key(|t| -(t.source.chars().count() as isize));
    Ok(terms)
}

fn keywords_from(text: &str, hits: &[GlossaryHit]) -> Vec<String> {
    let mut out: Vec<String> = hits.iter().map(|h| h.target.clone()).collect();
    for word in text
        .split(|c: char| !c.is_ascii_alphanumeric() && c != '-' && c != '_')
        .map(|w| w.trim())
        .filter(|w| w.chars().count() >= 4)
    {
        if out.len() >= 12 {
            break;
        }
        if !out.iter().any(|x| x.eq_ignore_ascii_case(word)) {
            out.push(word.to_string());
        }
    }
    out
}

fn offline_lookup(word: &str) -> Option<&'static str> {
    OFFLINE_DICTIONARY
        .iter()
        .find(|entry| entry.source.eq_ignore_ascii_case(word))
        .map(|entry| entry.target)
}

fn offline_translate_token(raw: &str) -> (String, bool) {
    let start = raw
        .char_indices()
        .find(|(_, ch)| ch.is_ascii_alphanumeric())
        .map(|(i, _)| i)
        .unwrap_or(raw.len());
    let end = raw
        .char_indices()
        .rev()
        .find(|(_, ch)| ch.is_ascii_alphanumeric())
        .map(|(i, ch)| i + ch.len_utf8())
        .unwrap_or(start);
    if start >= end {
        return (raw.to_string(), false);
    }
    let head = &raw[..start];
    let core = &raw[start..end];
    let tail = &raw[end..];
    let key = core.to_ascii_lowercase();
    if let Some(target) = offline_lookup(&key) {
        return (format!("{head}{target}{tail}"), true);
    }
    if key.ends_with('s') {
        let singular = key.trim_end_matches('s');
        if let Some(target) = offline_lookup(singular) {
            return (format!("{head}{target}{tail}"), true);
        }
    }
    (raw.to_string(), false)
}

fn offline_translate(
    req: &TranslationRequest,
    source_lang: &str,
    target_lang: &str,
    _mode: &str,
    hits: &[GlossaryHit],
) -> String {
    let text = req.text.trim();
    let tl = target_lang.to_lowercase();

    // Decide direction. zh target → English→Chinese; en target → Chinese→English.
    // For any other target we can only carry the source through honestly.
    let (translated, matched) = if tl.starts_with("zh") {
        offline_en_to_zh(text)
    } else if tl.starts_with("en") {
        offline_zh_to_en(text)
    } else {
        let _ = source_lang;
        return format!(
            "[离线] 离线词典目前只支持中英互译，{target_lang} 方向请联网使用在线翻译。\n\n原文：{text}"
        );
    };

    let mut lines = vec![translated];
    if !hits.is_empty() {
        lines.push(String::new());
        lines.push("自定义词库命中：".to_string());
        for h in hits {
            lines.push(format!("{} = {}", h.source, h.target));
        }
    }
    lines.push(String::new());
    if matched == 0 && hits.is_empty() {
        lines.push("[离线] 未命中通用词典，已保留原文。联网后会自动使用在线翻译。".to_string());
    } else {
        lines.push(
            "[离线基础翻译] 这是本地词典结果，适合断网兜底；完整自然句建议使用在线翻译。"
                .to_string(),
        );
    }
    lines.join("\n")
}

fn offline_en_to_zh(text: &str) -> (String, usize) {
    let mut matched = 0usize;
    let translated = text
        .split_whitespace()
        .map(|token| {
            let (out, ok) = offline_translate_token(token);
            if ok {
                matched += 1;
            }
            out
        })
        .collect::<Vec<_>>()
        .join(" ");
    (translated, matched)
}

/// Greedy longest-match over the reverse dictionary. Chinese has no spaces, so
/// we walk the string trying the longest dictionary phrase that starts at each
/// position and fall back to passing unknown characters through unchanged.
fn offline_zh_to_en(text: &str) -> (String, usize) {
    const MAX_WINDOW: usize = 8;
    let chars: Vec<char> = text.chars().collect();
    let mut out: Vec<String> = Vec::new();
    let mut matched = 0usize;
    let mut i = 0usize;
    while i < chars.len() {
        if chars[i].is_whitespace() {
            i += 1;
            continue;
        }
        let upper = (i + MAX_WINDOW).min(chars.len());
        let mut hit: Option<(usize, &'static str)> = None;
        let mut win = upper;
        while win > i {
            let sub: String = chars[i..win].iter().collect();
            if let Some(en) = offline_lookup_zh(&sub) {
                hit = Some((win - i, en));
                break;
            }
            win -= 1;
        }
        match hit {
            Some((len, en)) => {
                out.push(en.to_string());
                matched += 1;
                i += len;
            }
            None => {
                out.push(chars[i].to_string());
                i += 1;
            }
        }
    }
    (out.join(" "), matched)
}

fn offline_lookup_zh(phrase: &str) -> Option<&'static str> {
    OFFLINE_DICTIONARY
        .iter()
        .find(|e| e.target == phrase)
        .map(|e| e.source)
}

fn online_lang_code(lang: &str) -> String {
    let lang = lang.trim();
    if lang.is_empty() || lang.eq_ignore_ascii_case("auto") {
        "auto".to_string()
    } else if lang.eq_ignore_ascii_case("zh") || lang.eq_ignore_ascii_case("zh-cn") {
        "zh-CN".to_string()
    } else {
        lang.to_string()
    }
}

struct OnlineOutcome {
    text: String,
    provider: String,
    detected: Option<String>,
    dictionary: Vec<DictionaryEntry>,
}

/// Try the online providers in order and return the first success. Keeping
/// more than one keyless source means a blocked or rate-limited Google no
/// longer drops every translation to the tiny offline dictionary.
async fn online_translate(
    req: &TranslationRequest,
    source_lang: &str,
    target_lang: &str,
) -> Result<OnlineOutcome, String> {
    match google_translate(req, source_lang, target_lang).await {
        Ok(v) => Ok(v),
        Err(google_err) => match mymemory_translate(req, source_lang, target_lang).await {
            Ok(v) => Ok(v),
            Err(mymemory_err) => Err(format!(
                "在线翻译失败（Google：{google_err}；备用源 MyMemory：{mymemory_err}）"
            )),
        },
    }
}

async fn google_translate(
    req: &TranslationRequest,
    source_lang: &str,
    target_lang: &str,
) -> Result<OnlineOutcome, String> {
    let client = reqwest::Client::new();
    let sl = online_lang_code(source_lang);
    let tl = online_lang_code(target_lang);
    let resp = client
        .get("https://translate.googleapis.com/translate_a/single")
        .timeout(std::time::Duration::from_secs(12))
        // dt=t → sentence translation, dt=bd → dictionary (per-POS meanings).
        .query(&[
            ("client", "gtx"),
            ("sl", sl.as_str()),
            ("tl", tl.as_str()),
            ("dt", "t"),
            ("dt", "bd"),
            ("q", req.text.trim()),
        ])
        .send()
        .await
        .map_err(|e| format!("请求失败：{e}"))?;
    if !resp.status().is_success() {
        let st = resp.status();
        let t = resp.text().await.unwrap_or_default();
        return Err(format!("返回 {st}: {t}"));
    }

    let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let mut out = String::new();
    if let Some(parts) = v.get(0).and_then(|x| x.as_array()) {
        for part in parts {
            if let Some(s) = part.get(0).and_then(|x| x.as_str()) {
                out.push_str(s);
            }
        }
    }
    let out = out.trim().to_string();
    if out.is_empty() {
        return Err("返回空结果".to_string());
    }
    let detected = v.get(2).and_then(|x| x.as_str()).map(|x| x.to_string());
    Ok(OnlineOutcome {
        text: out,
        provider: "online-google".to_string(),
        detected,
        dictionary: parse_google_dictionary(&v),
    })
}

/// Parse Google's `dt=bd` block: `v[1]` is an array of sense groups, each
/// `[pos, [terms…], …]`. Missing/empty blocks just yield no entries.
fn parse_google_dictionary(v: &serde_json::Value) -> Vec<DictionaryEntry> {
    let mut entries = Vec::new();
    let Some(groups) = v.get(1).and_then(|x| x.as_array()) else {
        return entries;
    };
    for g in groups {
        let pos = g
            .get(0)
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        let terms: Vec<String> = g
            .get(1)
            .and_then(|x| x.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|t| t.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();
        if !terms.is_empty() {
            entries.push(DictionaryEntry { pos, terms });
        }
    }
    entries
}

/// MyMemory needs an explicit source language, so resolve "auto" to the
/// opposite of the target before building the langpair.
async fn mymemory_translate(
    req: &TranslationRequest,
    source_lang: &str,
    target_lang: &str,
) -> Result<OnlineOutcome, String> {
    let tl = online_lang_code(target_lang);
    let sl_raw = online_lang_code(source_lang);
    let sl = if sl_raw.eq_ignore_ascii_case("auto") {
        if tl.to_lowercase().starts_with("zh") {
            "en".to_string()
        } else {
            "zh-CN".to_string()
        }
    } else {
        sl_raw
    };
    let langpair = format!("{sl}|{tl}");

    let client = reqwest::Client::new();
    let resp = client
        .get("https://api.mymemory.translated.net/get")
        .timeout(std::time::Duration::from_secs(12))
        .query(&[("q", req.text.trim()), ("langpair", langpair.as_str())])
        .send()
        .await
        .map_err(|e| format!("请求失败：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("返回 {}", resp.status()));
    }

    let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let out = v
        .get("responseData")
        .and_then(|d| d.get("translatedText"))
        .and_then(|t| t.as_str())
        .unwrap_or_default()
        .trim()
        .to_string();
    if out.is_empty() {
        return Err("返回空结果".to_string());
    }
    Ok(OnlineOutcome {
        text: out,
        provider: "online-mymemory".to_string(),
        detected: Some(sl),
        dictionary: Vec::new(),
    })
}

async fn provider_translate(
    app: &tauri::AppHandle,
    req: &TranslationRequest,
    source_lang: &str,
    target_lang: &str,
    mode: &str,
    hits: &[GlossaryHit],
) -> Result<(String, String), String> {
    let (base, model, key) = ai_config(app);
    let provider = if is_local_base(&base) {
        "local-openai"
    } else {
        "remote-openai"
    };
    let url = format!("{}/chat/completions", base.trim_end_matches('/'));
    let prompt = prompt_for(mode, source_lang, target_lang, req.text.trim(), hits);
    let body = serde_json::json!({
        "model": model,
        "stream": false,
        "messages": [
            { "role": "system", "content": "You are a precise translation engine embedded in Nobi." },
            { "role": "user", "content": prompt }
        ]
    });
    // 短连接超时：没装/连不上模型时 3 秒内放弃（auto 路由可快速回落在线），
    // 但总超时给足 45 秒，不掐断真在生成中的本地模型。
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(3))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(url)
        .timeout(std::time::Duration::from_secs(45))
        .header("Authorization", format!("Bearer {}", key))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("翻译 Provider 请求失败：{e}"))?;
    if !resp.status().is_success() {
        let st = resp.status();
        let t = resp.text().await.unwrap_or_default();
        return Err(format!("翻译 Provider 返回 {st}: {t}"));
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let content = v["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_string();
    if content.is_empty() {
        return Err("翻译 Provider 返回空结果".to_string());
    }
    Ok((content, provider.to_string()))
}

fn save_history(
    app: &tauri::AppHandle,
    req: &TranslationRequest,
    result: &TranslationResult,
) -> Result<i64, String> {
    let conn = open_db(app)?;
    let keywords = serde_json::to_string(&result.keywords).unwrap_or_else(|_| "[]".to_string());
    let terms = serde_json::to_string(&result.used_glossary).unwrap_or_else(|_| "[]".to_string());
    let summary = result
        .target_text
        .lines()
        .next()
        .unwrap_or("")
        .chars()
        .take(120)
        .collect::<String>();
    conn.execute(
        "INSERT INTO translation_history
         (source_text,target_text,source_lang,target_lang,mode,provider,summary,keywords,terms,source_app,source_url,asset_id,created_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
        params![
            &result.source_text,
            &result.target_text,
            &result.source_lang,
            &result.target_lang,
            &result.mode,
            &result.provider,
            summary,
            keywords,
            terms,
            req.source_app.as_deref().unwrap_or(""),
            req.source_url.as_deref().unwrap_or(""),
            req.asset_id,
            now_secs()
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

fn bump_terms(app: &tauri::AppHandle, hits: &[GlossaryHit]) {
    if hits.is_empty() {
        return;
    }
    if let Ok(conn) = open_db(app) {
        for h in hits {
            let _ = conn.execute(
                "UPDATE glossary_terms SET use_count=COALESCE(use_count,0)+1, updated_at=?1 WHERE source=?2",
                params![now_secs(), h.source],
            );
        }
    }
}

#[tauri::command]
pub async fn translate_text(
    app: tauri::AppHandle,
    req: TranslationRequest,
) -> Result<TranslationResult, String> {
    let text = req.text.trim();
    if text.is_empty() {
        return Err("翻译文本不能为空".to_string());
    }
    if text.chars().count() > 12_000 {
        return Err("文本太长，请先缩短到 12000 字以内".to_string());
    }

    let mut source_lang = clean_lang(req.source_lang.clone(), &detect_lang(text));
    let target_lang = resolve_target_lang(req.target_lang.clone(), &source_lang);
    let mode = clean_mode(req.mode.clone());
    let terms = merged_terms(&app)?;
    let hits = glossary_hits(text, &terms);
    let provider_choice = req
        .provider
        .clone()
        .unwrap_or_else(|| "auto".to_string())
        .to_lowercase();

    let mut phonetic: Option<String> = None;
    let (target_text, provider, warning, dictionary) = if is_code_like_token(text) {
        // 代码标识符（python3 / ai_config / camelCase / snake_case…）原样保留，
        // 否则在线会按字面翻成"蟒蛇3"之类。普通英文词不受影响，照常翻译 + 给字典。
        (text.to_string(), "verbatim".to_string(), None, Vec::new())
    } else {
        match provider_choice.as_str() {
        "offline" | "builtin" => {
            // 显式离线：整句走离线 NMT，词/短语走本地词典兜底
            if !is_word_lookup(text) {
                if let Some(zh) = crate::nmt::translate(&app, text, &source_lang, &target_lang) {
                    (zh, "offline-nmt".to_string(), None, Vec::new())
                } else {
                    (
                        offline_translate(&req, &source_lang, &target_lang, &mode, &hits),
                        "offline".to_string(),
                        None,
                        Vec::new(),
                    )
                }
            } else {
                (
                    offline_translate(&req, &source_lang, &target_lang, &mode, &hits),
                    "offline".to_string(),
                    None,
                    Vec::new(),
                )
            }
        }
        "model" => {
            match provider_translate(&app, &req, &source_lang, &target_lang, &mode, &hits).await {
                Ok((text, provider)) => (text, provider, None, Vec::new()),
                Err(e) => return Err(e),
            }
        }
        "online" => match online_translate(&req, &source_lang, &target_lang).await {
            Ok(o) => {
                if source_lang == "auto" {
                    if let Some(detected) = o.detected {
                        source_lang = detected;
                    }
                }
                (o.text, o.provider, None, o.dictionary)
            }
            Err(e) => return Err(e),
        },
        _ => {
            // auto 智能路由：
            //  · 单词/短语(en→zh) 优先离线 ECDICT 词典（带音标 + 多义项）；
            //  · 整句优先本地大模型；
            //  · 在线(Google→MyMemory)与离线小词典只作兜底。
            let target_is_zh = target_lang.to_lowercase().starts_with("zh");
            let dict_hit = if target_is_zh
                && is_word_lookup(text)
                && !source_lang.to_lowercase().starts_with("zh")
            {
                ecdict_lookup(&app, text)
            } else {
                None
            };

            if let Some(hit) = dict_hit {
                let (entries, headline) = parse_ecdict_translation(&hit.translation);
                if !hit.phonetic.trim().is_empty() {
                    phonetic = Some(hit.phonetic.trim().to_string());
                }
                let target_text = if headline.is_empty() {
                    hit.translation.clone()
                } else {
                    headline
                };
                (target_text, "dict-offline".to_string(), None, entries)
            } else if is_word_lookup(text) {
                // 短词词典没命中：在线（dt=bd 还能给释义）→ 离线小词典兜底
                match online_translate(&req, &source_lang, &target_lang).await {
                    Ok(o) => {
                        if source_lang == "auto" {
                            if let Some(detected) = o.detected {
                                source_lang = detected;
                            }
                        }
                        (o.text, o.provider, None, o.dictionary)
                    }
                    Err(e) => (
                        offline_translate(&req, &source_lang, &target_lang, &mode, &hits),
                        "offline-fallback".to_string(),
                        Some(e),
                        Vec::new(),
                    ),
                }
            } else {
                // 整句：本地大模型 → 离线 NMT(OPUS-MT) → 在线 → 离线小词典
                match provider_translate(&app, &req, &source_lang, &target_lang, &mode, &hits).await
                {
                    Ok((t, p)) => (t, p, None, Vec::new()),
                    Err(_) => {
                        if let Some(zh) = crate::nmt::translate(&app, text, &source_lang, &target_lang) {
                            (zh, "offline-nmt".to_string(), None, Vec::new())
                        } else {
                            match online_translate(&req, &source_lang, &target_lang).await {
                                Ok(o) => {
                                    if source_lang == "auto" {
                                        if let Some(detected) = o.detected {
                                            source_lang = detected;
                                        }
                                    }
                                    (o.text, o.provider, None, o.dictionary)
                                }
                                Err(e) => (
                                    offline_translate(&req, &source_lang, &target_lang, &mode, &hits),
                                    "offline-fallback".to_string(),
                                    Some(e),
                                    Vec::new(),
                                ),
                            }
                        }
                    }
                }
            }
        }
        }
    };

    let mut result = TranslationResult {
        id: None,
        source_text: text.to_string(),
        target_text,
        source_lang,
        target_lang,
        mode,
        provider,
        used_glossary: hits,
        keywords: Vec::new(),
        dictionary,
        phonetic,
        warning,
    };
    result.keywords = keywords_from(text, &result.used_glossary);
    if req.save_history.unwrap_or(true) {
        result.id = Some(save_history(&app, &req, &result)?);
        bump_terms(&app, &result.used_glossary);
    }
    Ok(result)
}

#[tauri::command]
pub fn list_glossary_terms(app: tauri::AppHandle) -> Result<Vec<GlossaryTerm>, String> {
    db_terms(&app)
}

#[tauri::command]
pub fn save_glossary_term(app: tauri::AppHandle, term: GlossaryTermIn) -> Result<i64, String> {
    let source = term.source.trim();
    let target = term.target.trim();
    if source.is_empty() || target.is_empty() {
        return Err("术语原文和译文不能为空".to_string());
    }
    let explanation = term.explanation.unwrap_or_default();
    let category = term.category.unwrap_or_default();
    let tags =
        serde_json::to_string(&term.tags.unwrap_or_default()).unwrap_or_else(|_| "[]".into());
    let now = now_secs();
    let conn = open_db(&app)?;
    if let Some(id) = term.id {
        conn.execute(
            "UPDATE glossary_terms
             SET source=?1,target=?2,explanation=?3,category=?4,tags=?5,updated_at=?6
             WHERE id=?7",
            params![
                source,
                target,
                explanation.trim(),
                category.trim(),
                tags,
                now,
                id
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(id)
    } else {
        conn.execute(
            "INSERT INTO glossary_terms(source,target,explanation,category,tags,created_at,updated_at,use_count)
             VALUES(?1,?2,?3,?4,?5,?6,?6,0)
             ON CONFLICT(source,target) DO UPDATE SET
               explanation=excluded.explanation,
               category=excluded.category,
               tags=excluded.tags,
               updated_at=excluded.updated_at",
            params![source, target, explanation.trim(), category.trim(), tags, now],
        )
        .map_err(|e| e.to_string())?;
        Ok(conn.last_insert_rowid())
    }
}

#[tauri::command]
pub fn delete_glossary_term(app: tauri::AppHandle, id: i64) -> Result<(), String> {
    let conn = open_db(&app)?;
    conn.execute("DELETE FROM glossary_terms WHERE id=?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn list_translation_history(
    app: tauri::AppHandle,
    limit: Option<i64>,
) -> Result<Vec<TranslationHistoryItem>, String> {
    let limit = limit.unwrap_or(30).clamp(1, 200);
    let conn = open_db(&app)?;
    let mut stmt = conn
        .prepare(
            "SELECT id,source_text,target_text,COALESCE(source_lang,''),COALESCE(target_lang,''),\
             COALESCE(mode,''),COALESCE(provider,''),COALESCE(created_at,0)
             FROM translation_history ORDER BY id DESC LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![limit], |r| {
            Ok(TranslationHistoryItem {
                id: r.get(0)?,
                source_text: r.get(1)?,
                target_text: r.get(2)?,
                source_lang: r.get(3)?,
                target_lang: r.get(4)?,
                mode: r.get(5)?,
                provider: r.get(6)?,
                created_at: r.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_basic_languages() {
        assert_eq!(detect_lang("hello world"), "en");
        assert_eq!(detect_lang("中文翻译"), "zh");
    }

    #[test]
    fn unsupported_mode_falls_back_to_normal() {
        assert_eq!(clean_mode(Some("unsupported".to_string())), "normal");
        assert_eq!(clean_mode(Some("normal".to_string())), "normal");
    }

    #[test]
    fn offline_translate_uses_general_dictionary() {
        let req = TranslationRequest {
            text: "hello world, testing improvement".to_string(),
            source_lang: None,
            target_lang: Some("zh-CN".to_string()),
            mode: Some("normal".to_string()),
            provider: Some("offline".to_string()),
            source_app: None,
            source_url: None,
            asset_id: None,
            save_history: Some(false),
        };
        let out = offline_translate(&req, "en", "zh-CN", "normal", &[]);
        assert!(out.contains("你好"));
        assert!(out.contains("测试"));
        assert!(out.contains("离线基础翻译"));
    }

    #[test]
    fn offline_translate_handles_reverse_direction() {
        // 图片 → image, 视频 → video（中→英贪婪匹配）
        let (out, matched) = offline_zh_to_en("图片视频");
        assert_eq!(out, "image video");
        assert_eq!(matched, 2);
    }

    #[test]
    fn resolve_target_picks_opposite_for_auto() {
        assert_eq!(resolve_target_lang(None, "zh"), "en");
        assert_eq!(resolve_target_lang(Some("auto".to_string()), "zh"), "en");
        assert_eq!(resolve_target_lang(Some("auto".to_string()), "en"), "zh-CN");
        // 显式目标语言不被覆盖
        assert_eq!(resolve_target_lang(Some("ja".to_string()), "en"), "ja");
    }

    #[test]
    fn parses_ecdict_translation_into_senses() {
        let (entries, headline) =
            parse_ecdict_translation("vt. 致使；提供；渲染\nn. 粉刷");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].pos, "vt.");
        assert_eq!(entries[0].terms, vec!["致使", "提供", "渲染"]);
        assert_eq!(entries[1].pos, "n.");
        assert_eq!(headline, "致使；提供；渲染；粉刷");
    }

    #[test]
    fn word_lookup_distinguishes_words_from_sentences() {
        assert!(is_word_lookup("apple"));
        assert!(is_word_lookup("ambient occlusion"));
        assert!(!is_word_lookup("This is a sentence."));
        assert!(!is_word_lookup("a, b, c, d, e"));
        assert!(!is_word_lookup("one two three four"));
    }

    #[test]
    fn code_like_tokens_are_preserved() {
        assert!(is_code_like_token("python3"));
        assert!(is_code_like_token("ai_config"));
        assert!(is_code_like_token("camelCase"));
        assert!(is_code_like_token("src/main.rs"));
        // 普通词照常翻译，不当作代码
        assert!(!is_code_like_token("python"));
        assert!(!is_code_like_token("apple"));
        assert!(!is_code_like_token("hello world"));
        assert!(!is_code_like_token("中文"));
    }
}
