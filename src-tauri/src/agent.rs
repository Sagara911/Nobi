//! 桌宠 Agent 中转：起 codex / claude CLI 子进程，流式把输出 emit 给前端气泡。
//! 壳子很薄——真正干活的是被调的 CLI。自定义命令不受 capability 限制，桌宠窗直接调。

use std::io::{BufRead, BufReader, Read};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use tauri::{Emitter, Manager};

/// 当前在跑的子进程 pid（用于取消）。一次只跑一个任务。
#[derive(Default)]
pub struct AgentState {
    pub pid: Mutex<Option<u32>>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOpts {
    pub agent: String,   // "codex" | "claude"
    pub bin: String,     // 可执行名/路径，空=用 agent 默认
    pub cwd: String,     // 工作目录（空=不指定）
    pub sandbox: String, // "read-only" | "workspace-write" | "full"
    pub prompt: String,
}

fn default_bin(agent: &str) -> &str {
    if agent == "claude" {
        "claude"
    } else {
        "codex"
    }
}

/// 构造命令：Windows 上经 `cmd /C` 调，以兼容 npm 全局装的 .cmd shim（CreateProcess 找不到 .cmd）。
fn build_command(bin: &str, args: &[String], cwd: Option<&str>) -> Command {
    let mut cmd;
    #[cfg(windows)]
    {
        cmd = Command::new("cmd");
        cmd.arg("/C").arg(bin);
        for a in args {
            cmd.arg(a);
        }
    }
    #[cfg(not(windows))]
    {
        cmd = Command::new(bin);
        for a in args {
            cmd.arg(a);
        }
    }
    if let Some(d) = cwd {
        if !d.trim().is_empty() {
            cmd.current_dir(d);
        }
    }
    cmd
}

/// 把权限档 + prompt 翻成对应 CLI 的参数。
fn build_args(o: &AgentOpts) -> Vec<String> {
    if o.agent == "claude" {
        // Claude Code 无头模式：claude -p "<prompt>"（权限映射等接 Claude 时再细化）
        return vec!["-p".to_string(), o.prompt.clone()];
    }
    // Codex 非交互：codex exec --sandbox <level> "<prompt>"
    let sb = match o.sandbox.as_str() {
        "full" => "danger-full-access",
        "workspace-write" => "workspace-write",
        _ => "read-only",
    };
    vec![
        "exec".to_string(),
        "--json".to_string(), // 输出 JSONL 事件，前端只挑 agent_message 等显示
        "--sandbox".to_string(),
        sb.to_string(),
        o.prompt.clone(),
    ]
}

/// 探测 CLI 是否可用（跑 `<bin> --version`）。返回版本串或错误。
#[tauri::command]
pub fn agent_check(agent: String, bin: String) -> Result<String, String> {
    let b = if bin.trim().is_empty() {
        default_bin(&agent).to_string()
    } else {
        bin
    };
    let out = build_command(&b, &["--version".to_string()], None)
        .output()
        .map_err(|e| format!("找不到 {b}：{e}（确认已安装并在 PATH 里）"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() {
            format!("{b} 返回非零退出码")
        } else {
            err
        })
    }
}

/// 跑一次 agent：流式 emit "agent-output"({stream,line})，结束 emit "agent-done"({code})。
#[tauri::command]
pub fn agent_run(app: tauri::AppHandle, opts: AgentOpts) -> Result<(), String> {
    let state = app.state::<AgentState>();
    {
        let g = state.pid.lock().map_err(|e| e.to_string())?;
        if g.is_some() {
            return Err("上一个任务还在跑，先「停止」再发".into());
        }
    }
    let bin = if opts.bin.trim().is_empty() {
        default_bin(&opts.agent).to_string()
    } else {
        opts.bin.clone()
    };
    let args = build_args(&opts);
    let mut cmd = build_command(&bin, &args, Some(&opts.cwd));
    // stdin 设 null：codex exec 会「读 stdin」，GUI 进程无控制台时不喂 EOF 会卡住
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动 {bin} 失败：{e}（装了吗？在 PATH 吗？）"))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let pid = child.id();
    *state.pid.lock().map_err(|e| e.to_string())? = Some(pid);

    if let Some(out) = stdout {
        let app2 = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                let _ = app2.emit("agent-output", serde_json::json!({ "stream": "out", "line": line }));
            }
        });
    }
    if let Some(err) = stderr {
        let app3 = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                let _ = app3.emit("agent-output", serde_json::json!({ "stream": "err", "line": line }));
            }
        });
    }

    // 独立线程等待结束（拥有 child；取消走 pid kill，不抢这个 child）
    let app4 = app.clone();
    std::thread::spawn(move || {
        let code = child.wait().ok().and_then(|s| s.code());
        let st = app4.state::<AgentState>();
        if let Ok(mut g) = st.pid.lock() {
            *g = None;
        }
        let _ = app4.emit("agent-done", serde_json::json!({ "code": code }));
    });
    Ok(())
}

fn kill_pid(pid: u32) {
    #[cfg(windows)]
    {
        // /T 连子进程一起杀（codex 可能再起子进程）
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill").arg(pid.to_string()).output();
    }
}

/// 取消当前在跑的任务（按 pid 杀进程树）。
#[tauri::command]
pub fn agent_cancel(app: tauri::AppHandle) -> Result<(), String> {
    let pid = app
        .state::<AgentState>()
        .pid
        .lock()
        .map_err(|e| e.to_string())?
        .take();
    if let Some(pid) = pid {
        kill_pid(pid);
    }
    Ok(())
}

// ============================================================
// API 聊天：与上面「转 CLI 干活」完全独立的第二条路。
// 用户不以 `/` 开头说话时走这里——直接请求 OpenAI 兼容的 /chat/completions
// 流式（SSE）回 token。国内国外只要填对 Base URL / Key / 模型即可，代码一套。
// ============================================================

/// 聊天取消用的「代数」计数器：每次发送 +1；流式循环发现代数变了就停（被新发送/取消打断）。
#[derive(Default)]
pub struct ChatState {
    pub gen: AtomicU64,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct ChatMsg {
    pub role: String, // "system" | "user" | "assistant"
    // 纯文本时是字符串；带图片时是 OpenAI vision 数组（text + image_url 段）。直接透传给 API。
    pub content: serde_json::Value,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatOpts {
    pub base_url: String, // 如 https://api.openai.com/v1 或 https://api.deepseek.com
    pub api_key: String,
    pub model: String,
    pub messages: Vec<ChatMsg>, // 多轮历史 + 当前这句（前端拼好）
}

/// 把用户填的 Base URL 拼成 chat/completions 端点（已带则不重复拼）。
fn chat_url(base: &str) -> String {
    let b = base.trim().trim_end_matches('/');
    if b.ends_with("/chat/completions") {
        b.to_string()
    } else {
        format!("{b}/chat/completions")
    }
}

/// 发一轮聊天：流式 emit "chat-delta"({text}) 增量 token。
/// 命令本身在整段流结束后才 resolve——前端 await 到返回即「说完了」，出错则 reject。
#[tauri::command]
pub async fn chat_send(app: tauri::AppHandle, opts: ChatOpts) -> Result<(), String> {
    let my_gen = app
        .state::<ChatState>()
        .gen
        .fetch_add(1, Ordering::SeqCst)
        + 1;

    if opts.api_key.trim().is_empty() {
        return Err("还没填 API Key（点 ⚙ 设置）".into());
    }
    if opts.base_url.trim().is_empty() {
        return Err("还没填 API 地址（点 ⚙ 设置）".into());
    }
    let url = chat_url(&opts.base_url);
    let body = serde_json::json!({
        "model": opts.model,
        "stream": true,
        "messages": opts.messages,
    });
    let client = reqwest::Client::new();
    let mut resp = client
        .post(&url)
        .bearer_auth(opts.api_key.trim())
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("连接失败：{e}（检查 API 地址 / 网络）"))?;
    if !resp.status().is_success() {
        let code = resp.status();
        let txt = resp.text().await.unwrap_or_default();
        let brief: String = txt.chars().take(300).collect();
        return Err(format!("API 返回 {code}：{brief}"));
    }

    let mut buf = String::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        // 被新一轮发送 / 取消打断：不再读、不再回显
        if app.state::<ChatState>().gen.load(Ordering::SeqCst) != my_gen {
            return Ok(());
        }
        buf.push_str(&String::from_utf8_lossy(&chunk));
        // SSE：逐行处理，`data: {...}` 是事件，`data: [DONE]` 收尾
        while let Some(nl) = buf.find('\n') {
            let line: String = buf.drain(..=nl).collect();
            let line = line.trim();
            if line.is_empty() || !line.starts_with("data:") {
                continue;
            }
            let data = line["data:".len()..].trim();
            if data == "[DONE]" {
                continue;
            }
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(data) {
                if let Some(t) = v["choices"][0]["delta"]["content"].as_str() {
                    if !t.is_empty() {
                        let _ = app.emit("chat-delta", serde_json::json!({ "text": t }));
                    }
                }
            }
        }
    }
    Ok(())
}

/// 取消正在进行的聊天（把代数 +1，流式循环下一帧自停）。
#[tauri::command]
pub fn chat_cancel(app: tauri::AppHandle) -> Result<(), String> {
    app.state::<ChatState>().gen.fetch_add(1, Ordering::SeqCst);
    Ok(())
}

// ============================================================
// Winky 取外部资料的工具：读链接、联网搜索。
// 都是「抓回文字 → 前端拼进 prompt 当参考资料」，模型本身不联网，由我们喂。
// ============================================================

/// 粗略把 HTML 转成纯文本：去掉 script/style 等噪声块、去标签、解实体、折叠空白、截断。
fn html_to_text(html: &str, max_chars: usize) -> String {
    let mut s = html.to_string();
    // 整块删掉脚本/样式/头部等不含正文的部分
    for tag in ["script", "style", "noscript", "svg", "head", "nav", "footer"] {
        let open = format!("<{tag}");
        let close = format!("</{tag}>");
        loop {
            let lower = s.to_lowercase();
            if let Some(start) = lower.find(&open) {
                if let Some(end_rel) = lower[start..].find(&close) {
                    let end = start + end_rel + close.len();
                    s.replace_range(start..end, " ");
                    continue;
                }
            }
            break;
        }
    }
    // 去标签
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    // 解常见实体 + 折叠空白
    let out = out
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'");
    let collapsed = out.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed.chars().take(max_chars).collect()
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Winky/1.0")
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())
}

/// 直抓网页 + 去 HTML（快、不经第三方）。
async fn fetch_direct(url: &str) -> Result<String, String> {
    let resp = http_client()?
        .get(url)
        .send()
        .await
        .map_err(|e| format!("打不开网页：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("网页返回 {}", resp.status()));
    }
    let html = resp.text().await.map_err(|e| e.to_string())?;
    Ok(html_to_text(&html, 6000))
}

/// 经 r.jina.ai 阅读器抓取（服务端帮忙渲染 JS、返回干净文本）。兜底用：能啃 SPA / 反爬站。
/// 代价：要读的网址会发到 jina 的服务器（第三方代抓）。
async fn fetch_via_jina(url: &str) -> Result<String, String> {
    let resp = http_client()?
        .get(format!("https://r.jina.ai/{url}"))
        .send()
        .await
        .map_err(|e| format!("阅读器抓取失败：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("阅读器返回 {}", resp.status()));
    }
    // jina 返回的已是干净 markdown/文本，保留换行结构，只截断
    let text = resp.text().await.map_err(|e| e.to_string())?;
    let cleaned: String = text.chars().take(8000).collect();
    if cleaned.trim().is_empty() {
        return Err("阅读器没返回内容".into());
    }
    Ok(cleaned)
}

/// 抓一个网页的正文。读链接用。直抓优先；抓空/抓不到（多半是 JS 渲染的 SPA）→ 走 jina 阅读器兜底。
#[tauri::command]
pub async fn fetch_url_text(url: String) -> Result<String, String> {
    let direct = fetch_direct(&url).await;
    // 直抓到的正文够多 → 直接用，不经第三方
    if let Ok(t) = &direct {
        if t.trim().chars().count() >= 200 {
            return Ok(t.clone());
        }
    }
    // 否则走 jina 渲染兜底
    match fetch_via_jina(&url).await {
        Ok(t) => Ok(t),
        Err(e) => match direct {
            // 兜底也不行：把直抓的（哪怕短）还回去，实在没有才报错
            Ok(t) if !t.trim().is_empty() => Ok(t),
            _ => Err(format!("读不到这个网页：{e}")),
        },
    }
}

#[derive(serde::Serialize)]
pub struct SearchHit {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

/// 取 HTML 里所有带某 class 的元素的内层纯文本（到 end_tag 为止），尽力而为。
fn texts_by_class(html: &str, class_marker: &str, end_tag: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(rel) = html[from..].find(class_marker) {
        let at = from + rel;
        // 从该处往后找第一个 '>'（元素开标签结束），再到 end_tag
        if let Some(gt_rel) = html[at..].find('>') {
            let content_start = at + gt_rel + 1;
            if let Some(end_rel) = html[content_start..].find(end_tag) {
                let inner = &html[content_start..content_start + end_rel];
                let txt = html_to_text(inner, 400);
                if !txt.trim().is_empty() {
                    out.push(txt);
                }
                from = content_start + end_rel + end_tag.len();
                continue;
            }
        }
        from = at + class_marker.len();
    }
    out
}

/// 无 key 网页搜索（DuckDuckGo HTML 端点，尽力而为）。返回前若干条标题/摘要。
#[tauri::command]
pub async fn web_search(query: String) -> Result<Vec<SearchHit>, String> {
    let resp = http_client()?
        .post("https://html.duckduckgo.com/html/")
        .form(&[("q", query.as_str())])
        .send()
        .await
        .map_err(|e| format!("搜索失败：{e}"))?;
    let html = resp.text().await.map_err(|e| e.to_string())?;
    // DuckDuckGo HTML：标题 <a class="result__a">…</a>，摘要 <a class="result__snippet">…</a>
    let titles = texts_by_class(&html, "result__a", "</a>");
    let snippets = texts_by_class(&html, "result__snippet", "</a>");
    let n = titles.len().min(6);
    let mut hits = Vec::with_capacity(n);
    for i in 0..n {
        hits.push(SearchHit {
            title: titles[i].clone(),
            url: String::new(), // DDG 链接是重定向跳转，解析价值不大；标题+摘要够喂模型
            snippet: snippets.get(i).cloned().unwrap_or_default(),
        });
    }
    if hits.is_empty() {
        return Err("没搜到结果（DuckDuckGo 可能临时限流，过会再试）".into());
    }
    Ok(hits)
}

// ============================================================
// Winky 看文件：把 PDF / Word / Excel / PPT / 纯文本 抽成文字，前端拼进 prompt。
// 走「字节」而非路径——拖入的文件浏览器不给真实路径，统一读字节最省事（文件选择器也复用）。
// ============================================================

/// 从 Office(zip) 字节里取指定 XML 条目、拼成纯文本。exact=精确条目名；否则按前缀匹配所有 .xml。
fn office_text(bytes: &[u8], prefix: &str, exact: Option<&str>) -> Result<String, String> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|e| format!("不是有效的 Office 文件：{e}"))?;
    let mut combined = String::new();
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().to_string();
        let take = match exact {
            Some(ex) => name == ex,
            None => name.starts_with(prefix) && name.ends_with(".xml"),
        };
        if take {
            let mut buf = Vec::new();
            entry.read_to_end(&mut buf).map_err(|e| e.to_string())?;
            combined.push_str(&html_to_text(&String::from_utf8_lossy(&buf), usize::MAX));
            combined.push(' ');
        }
    }
    Ok(combined)
}

/// 抽一个文件的文字。name 给后缀名判类型；优先读 path（文件选择器），否则解 data_b64（拖入）。
#[tauri::command]
pub fn extract_file_text(name: String, path: String, data_b64: String) -> Result<String, String> {
    use base64::Engine;
    let bytes = if !path.trim().is_empty() {
        std::fs::read(path.trim()).map_err(|e| format!("读文件失败：{e}"))?
    } else {
        base64::engine::general_purpose::STANDARD
            .decode(data_b64.trim())
            .map_err(|e| format!("文件数据无效：{e}"))?
    };
    let lower = if !name.trim().is_empty() {
        name.to_lowercase()
    } else {
        path.to_lowercase()
    };
    let raw = if lower.ends_with(".pdf") {
        pdf_extract::extract_text_from_mem(&bytes).map_err(|e| format!("PDF 解析失败：{e}"))?
    } else if lower.ends_with(".docx") {
        office_text(&bytes, "", Some("word/document.xml"))?
    } else if lower.ends_with(".xlsx") {
        office_text(&bytes, "", Some("xl/sharedStrings.xml"))?
    } else if lower.ends_with(".pptx") {
        office_text(&bytes, "ppt/slides/slide", None)?
    } else if lower.ends_with(".txt")
        || lower.ends_with(".md")
        || lower.ends_with(".csv")
        || lower.ends_with(".json")
        || lower.ends_with(".log")
    {
        String::from_utf8_lossy(&bytes).to_string()
    } else {
        return Err("不支持的类型（支持 PDF / Word(.docx) / Excel(.xlsx) / PPT(.pptx) / txt/md/csv，旧版 .doc/.xls 不行）".into());
    };
    let text: String = raw
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(12000)
        .collect();
    if text.trim().is_empty() {
        return Err("没从文件里抽到文字（可能是扫描版/纯图片 PDF）".into());
    }
    Ok(text)
}

// ============================================================
// Winky 皮肤：读用户自己装的 Petdex 宠物（~/.codex/pets、~/.petdex/pets）。
// 内置预设走前端 public/pets，不经这里；这里只管"自定义"那部分。
// ============================================================

fn user_home() -> Option<std::path::PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(std::path::PathBuf::from)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetInfo {
    pub id: String,
    pub display_name: String,
    pub dir: String,
}

/// 列出用户机器上已装的 Petdex 宠物（两处目录，按 id 去重）。
#[tauri::command]
pub fn winky_list_pets() -> Result<Vec<PetInfo>, String> {
    let home = user_home().ok_or("找不到用户目录")?;
    let mut out: Vec<PetInfo> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for base in [home.join(".codex").join("pets"), home.join(".petdex").join("pets")] {
        let rd = match std::fs::read_dir(&base) {
            Ok(rd) => rd,
            Err(_) => continue,
        };
        for e in rd.flatten() {
            let dir = e.path();
            // spritesheet 可能是 .webp 或 .png
            if !dir.is_dir()
                || (!dir.join("spritesheet.webp").exists() && !dir.join("spritesheet.png").exists())
            {
                continue;
            }
            let id = dir
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            if id.is_empty() || !seen.insert(id.clone()) {
                continue;
            }
            let mut display = id.clone();
            if let Ok(txt) = std::fs::read_to_string(dir.join("pet.json")) {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) {
                    if let Some(n) = v["displayName"].as_str() {
                        display = n.to_string();
                    }
                }
            }
            out.push(PetInfo {
                id,
                display_name: display,
                dir: dir.to_string_lossy().to_string(),
            });
        }
    }
    Ok(out)
}

/// 把某宠物目录下的 spritesheet（.webp 或 .png）读成 data URL（自定义皮肤用）。
#[tauri::command]
pub fn winky_read_pet_sheet(dir: String) -> Result<String, String> {
    use base64::Engine;
    let base = std::path::Path::new(&dir);
    let (path, mime) = if base.join("spritesheet.webp").exists() {
        (base.join("spritesheet.webp"), "image/webp")
    } else {
        (base.join("spritesheet.png"), "image/png")
    };
    let bytes = std::fs::read(&path).map_err(|e| format!("读不到宠物图：{e}"))?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{mime};base64,{b64}"))
}

/// 在设置界面里直接装 Petdex 宠物：后台跑官方 CLI `npx petdex install <slug>`（鉴权/下载交给它）。
/// slug 只允许字母/数字/-/_，杜绝命令注入。
#[tauri::command]
pub fn winky_install_pet(slug: String) -> Result<String, String> {
    let s = slug.trim();
    if s.is_empty() || !s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("名字只能含字母 / 数字 / - / _".into());
    }
    let args = vec![
        "-y".to_string(),
        "petdex".to_string(),
        "install".to_string(),
        s.to_string(),
    ];
    let out = build_command("npx", &args, None)
        .output()
        .map_err(|e| format!("启动 npx 失败：{e}（装了 Node 吗？在 PATH 里吗？）"))?;
    if out.status.success() {
        Ok(format!("已安装 {s}"))
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
        let brief: String = err.trim().chars().take(300).collect();
        Err(if brief.is_empty() {
            format!("安装 {s} 失败（可能没这个宠物，或网络问题）")
        } else {
            brief
        })
    }
}

/// 删除一只自定义宠物（两处目录都清）。id 只允许字母/数字/-/_，防路径穿越。
#[tauri::command]
pub fn winky_delete_pet(id: String) -> Result<(), String> {
    let s = id.trim();
    if s.is_empty() || !s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("非法的宠物名".into());
    }
    let home = user_home().ok_or("找不到用户目录")?;
    let mut removed = false;
    for base in [home.join(".codex").join("pets"), home.join(".petdex").join("pets")] {
        let dir = base.join(s);
        if dir.is_dir() {
            std::fs::remove_dir_all(&dir).map_err(|e| format!("删除失败：{e}"))?;
            removed = true;
        }
    }
    if !removed {
        return Err("没找到这只宠物".into());
    }
    Ok(())
}

/// 一次性生成一句话（非流式，不经 chat-delta，避免污染聊天记录）。桌宠"自言自语"用。
#[tauri::command]
pub async fn chat_once(opts: ChatOpts) -> Result<String, String> {
    if opts.api_key.trim().is_empty() || opts.base_url.trim().is_empty() {
        return Err("没配 API".into());
    }
    let url = chat_url(&opts.base_url);
    let body = serde_json::json!({
        "model": opts.model,
        "stream": false,
        "max_tokens": 60,
        "messages": opts.messages,
    });
    let resp = reqwest::Client::new()
        .post(&url)
        .bearer_auth(opts.api_key.trim())
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("连接失败：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("API 返回 {}", resp.status()));
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let text = v["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_string();
    if text.is_empty() {
        return Err("空回复".into());
    }
    Ok(text)
}
