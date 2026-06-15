//! 离线神经翻译（OPUS-MT / Marian，onnxruntime via `ort`）。
//!
//! 整句翻译的离线兜底：不依赖本地大模型，也不依赖联网。模型（量化 onnx +
//! tokenizer.json）打包在 resources/opus-mt-{en-zh,zh-en}/，首次用到时加载并
//! 常驻缓存。贪心解码，够日常用；缺模型/出错时返回 None，由上层回落到在线。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use ort::session::Session;
use ort::value::Tensor;
use tauri::Manager;
use tokenizers::Tokenizer;

// Marian/OPUS-MT 通用常量（en-zh 与 zh-en 一致，已核对 config.json）
const DECODER_START: i64 = 65000;
const EOS: i64 = 0;
const PAD: i64 = 65000;
const MAX_NEW_TOKENS: usize = 400;
const MAX_INPUT_TOKENS: usize = 400;

struct NmtModel {
    encoder: Session,
    decoder: Session,
    tokenizer: Tokenizer,
}

#[allow(clippy::type_complexity)]
static MODELS: OnceLock<Mutex<HashMap<String, NmtModel>>> = OnceLock::new();

/// 按需下载的安装位置：<app_data>/models/opus-mt-{dir}/
fn installed_dir(app: &tauri::AppHandle, dir: &str) -> Option<PathBuf> {
    let base = app.path().app_data_dir().ok()?;
    Some(base.join("models").join(format!("opus-mt-{dir}")))
}

fn dir_complete(p: &std::path::Path) -> bool {
    p.join("encoder.onnx").exists()
        && p.join("decoder.onnx").exists()
        && p.join("tokenizer.json").exists()
}

/// 找到某个方向的模型目录：按需下载目录 → 开发期源码树 → 环境变量覆盖。
fn model_dir(app: &tauri::AppHandle, dir: &str) -> Option<PathBuf> {
    if let Some(p) = installed_dir(app, dir) {
        if dir_complete(&p) {
            return Some(p);
        }
    }
    let rel = format!("opus-mt-{dir}");
    if let Some(manifest) = option_env!("CARGO_MANIFEST_DIR") {
        let p = PathBuf::from(manifest).join("resources").join(&rel);
        if dir_complete(&p) {
            return Some(p);
        }
    }
    if let Ok(root) = std::env::var("NOBI_OPUS_MT_DIR") {
        let p = PathBuf::from(root).join(&rel);
        if dir_complete(&p) {
            return Some(p);
        }
    }
    None
}

const DIRECTIONS: [&str; 2] = ["en-zh", "zh-en"];

/// 某方向离线包是否已安装（用于前端显示/决定是否提示下载）。
pub fn is_installed(app: &tauri::AppHandle, dir: &str) -> bool {
    model_dir(app, dir).is_some()
}

/// 下载进度事件载荷。
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    dir: String,
    file: String,
    index: usize,
    total_files: usize,
    downloaded: u64,
    total: u64,
}

/// 下载某方向模型到安装目录（encoder/decoder/tokenizer），tokenizer 下载后打补丁
/// （normalizer 置空，否则 Rust tokenizers 加载会 panic）。带进度事件。
async fn download_dir(app: &tauri::AppHandle, dir: &str) -> Result<(), String> {
    use tauri::Emitter;
    let target = installed_dir(app, dir).ok_or("无法定位数据目录")?;
    std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;

    let repo = format!("Xenova/opus-mt-{dir}");
    let base = format!("https://huggingface.co/{repo}/resolve/main");
    // (远程文件, 本地文件名)
    let files = [
        ("onnx/encoder_model_quantized.onnx", "encoder.onnx"),
        ("onnx/decoder_model_quantized.onnx", "decoder.onnx"),
        ("tokenizer.json", "tokenizer.json"),
    ];
    let client = reqwest::Client::new();
    for (i, (remote, local)) in files.iter().enumerate() {
        let url = format!("{base}/{remote}");
        let tmp = target.join(format!("{local}.part"));
        let mut resp = client
            .get(&url)
            .send()
            .await
            .map_err(|e| format!("下载 {local} 失败：{e}"))?;
        if !resp.status().is_success() {
            return Err(format!("下载 {local} 返回 {}", resp.status()));
        }
        let total = resp.content_length().unwrap_or(0);
        let mut buf: Vec<u8> = Vec::with_capacity(total as usize);
        let mut downloaded = 0u64;
        while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
            buf.extend_from_slice(&chunk);
            downloaded += chunk.len() as u64;
            let _ = app.emit(
                "nmt-download-progress",
                DownloadProgress {
                    dir: dir.to_string(),
                    file: (*local).to_string(),
                    index: i + 1,
                    total_files: files.len(),
                    downloaded,
                    total,
                },
            );
        }
        // tokenizer.json：置空 normalizer 后再落盘
        if *local == "tokenizer.json" {
            let mut v: serde_json::Value =
                serde_json::from_slice(&buf).map_err(|e| format!("解析 tokenizer 失败：{e}"))?;
            v["normalizer"] = serde_json::Value::Null;
            buf = serde_json::to_vec(&v).map_err(|e| e.to_string())?;
        }
        std::fs::write(&tmp, &buf).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, target.join(local)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 各方向离线包安装状态。
#[tauri::command]
pub fn nmt_status(app: tauri::AppHandle) -> serde_json::Value {
    serde_json::json!({
        "enZh": is_installed(&app, "en-zh"),
        "zhEn": is_installed(&app, "zh-en"),
    })
}

/// 下载离线翻译包（缺哪个下哪个）。带 `nmt-download-progress` 进度事件。
#[tauri::command]
pub async fn download_nmt_models(app: tauri::AppHandle) -> Result<(), String> {
    for dir in DIRECTIONS {
        if !is_installed(&app, dir) {
            download_dir(&app, dir).await?;
            // 下完清掉缓存里可能的旧句柄（一般没有），下次用时重新加载
            if let Some(cache) = MODELS.get() {
                if let Ok(mut g) = cache.lock() {
                    g.remove(dir);
                }
            }
        }
    }
    Ok(())
}

fn load_model(app: &tauri::AppHandle, dir: &str) -> Result<NmtModel, String> {
    let d = model_dir(app, dir).ok_or_else(|| format!("离线翻译模型缺失：opus-mt-{dir}"))?;
    let encoder = Session::builder()
        .map_err(|e| e.to_string())?
        .commit_from_file(d.join("encoder.onnx"))
        .map_err(|e| format!("加载 encoder 失败：{e}"))?;
    let decoder = Session::builder()
        .map_err(|e| e.to_string())?
        .commit_from_file(d.join("decoder.onnx"))
        .map_err(|e| format!("加载 decoder 失败：{e}"))?;
    let tokenizer =
        Tokenizer::from_file(d.join("tokenizer.json")).map_err(|e| format!("加载分词器失败：{e}"))?;
    Ok(NmtModel {
        encoder,
        decoder,
        tokenizer,
    })
}

/// 选择翻译方向：zh 目标→en-zh；en 目标→zh-en；其它不支持。
fn direction_for(source_lang: &str, target_lang: &str) -> Option<&'static str> {
    let s = source_lang.to_lowercase();
    let t = target_lang.to_lowercase();
    if t.starts_with("zh") && !s.starts_with("zh") {
        Some("en-zh")
    } else if t.starts_with("en") && (s.starts_with("zh") || s == "auto") {
        Some("zh-en")
    } else {
        None
    }
}

/// 离线翻译一段文本。方向不支持 / 模型缺失 / 推理出错时返回 None（上层回落在线）。
pub fn translate(app: &tauri::AppHandle, text: &str, source_lang: &str, target_lang: &str) -> Option<String> {
    let dir = direction_for(source_lang, target_lang)?;
    let cache = MODELS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = cache.lock().ok()?;
    if !guard.contains_key(dir) {
        match load_model(app, dir) {
            Ok(m) => {
                guard.insert(dir.to_string(), m);
            }
            Err(e) => {
                eprintln!("[nmt] {e}");
                return None;
            }
        }
    }
    let model = guard.get_mut(dir)?;
    match run_translate(model, text) {
        Ok(out) if !out.trim().is_empty() => Some(out),
        Ok(_) => None,
        Err(e) => {
            eprintln!("[nmt] 推理失败：{e}");
            None
        }
    }
}

fn run_translate(model: &mut NmtModel, text: &str) -> Result<String, String> {
    let enc_tok = model
        .tokenizer
        .encode(text, true)
        .map_err(|e| e.to_string())?;
    let mut ids: Vec<i64> = enc_tok.get_ids().iter().map(|&x| x as i64).collect();
    if ids.is_empty() {
        return Ok(String::new());
    }
    ids.truncate(MAX_INPUT_TOKENS);
    let s = ids.len();
    let mask: Vec<i64> = vec![1; s];

    let enc_out = model
        .encoder
        .run(ort::inputs![
            "input_ids" => Tensor::from_array(([1usize, s], ids))
                .map_err(|e| e.to_string())?,
            "attention_mask" => Tensor::from_array(([1usize, s], mask.clone()))
                .map_err(|e| e.to_string())?
        ])
        .map_err(|e| e.to_string())?;
    let (hs_shape, hs_data) = enc_out[0]
        .try_extract_tensor::<f32>()
        .map_err(|e| e.to_string())?;
    let h = *hs_shape.iter().last().unwrap_or(&512) as usize;
    let enc_hs: Vec<f32> = hs_data.to_vec();

    let mut out_ids: Vec<i64> = vec![DECODER_START];
    for _ in 0..MAX_NEW_TOKENS {
        let t = out_ids.len();
        let outs = model
            .decoder
            .run(ort::inputs![
                "input_ids" => Tensor::from_array(([1usize, t], out_ids.clone()))
                    .map_err(|e| e.to_string())?,
                "encoder_attention_mask" => Tensor::from_array(([1usize, s], mask.clone()))
                    .map_err(|e| e.to_string())?,
                "encoder_hidden_states" => Tensor::from_array(([1usize, s, h], enc_hs.clone()))
                    .map_err(|e| e.to_string())?
            ])
            .map_err(|e| e.to_string())?;
        let (_shape, logits) = outs[0]
            .try_extract_tensor::<f32>()
            .map_err(|e| e.to_string())?;
        let vocab = logits.len() / t;
        let row = &logits[(t - 1) * vocab..t * vocab];
        let mut best = 0usize;
        let mut best_v = f32::MIN;
        for (i, &v) in row.iter().enumerate() {
            if i as i64 == PAD {
                continue;
            }
            if v > best_v {
                best_v = v;
                best = i;
            }
        }
        if best as i64 == EOS {
            break;
        }
        out_ids.push(best as i64);
    }

    let gen_ids: Vec<u32> = out_ids[1..].iter().map(|&x| x as u32).collect();
    model
        .tokenizer
        .decode(&gen_ids, true)
        .map_err(|e| e.to_string())
}
