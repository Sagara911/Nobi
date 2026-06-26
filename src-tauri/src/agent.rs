//! 桌宠 Agent 中转：起 codex / claude CLI 子进程，流式把输出 emit 给前端气泡。
//! 壳子很薄——真正干活的是被调的 CLI。自定义命令不受 capability 限制，桌宠窗直接调。

use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
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
