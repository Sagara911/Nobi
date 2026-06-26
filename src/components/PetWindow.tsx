// 桌宠助手窗（#pet 路由）：常驻桌面的置顶小浮窗，你说人话 → 转给 codex/claude CLI 干活。
// 壳子很薄：起子进程、流式回显都在 Rust(agent.rs)，这里只管 UI + 设置。
import { useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import * as api from "../api";
import "./PetWindow.css";

// step = 过程类（命令/改文件/token/codex 日志），默认折叠隐藏
type Line = { role: "user" | "out" | "step" | "err" | "sys"; text: string };
const PREFS = "nobi-pet-settings-v1";
const SANDBOX_LABEL: Record<string, string> = {
  "read-only": "只读（安全）",
  "workspace-write": "工作区可写",
  full: "完全放手（危险）",
};

function loadPrefs(): api.AgentOpts {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS) || "{}");
    return {
      agent: p.agent || "codex",
      bin: p.bin || "",
      cwd: p.cwd || "",
      sandbox: p.sandbox || "read-only",
      prompt: "",
    };
  } catch {
    return { agent: "codex", bin: "", cwd: "", sandbox: "read-only", prompt: "" };
  }
}

export default function PetWindow() {
  const [cfg, setCfg] = useState<api.AgentOpts>(loadPrefs);
  const [showCfg, setShowCfg] = useState(false);
  const [collapsed, setCollapsed] = useState(true); // 默认折叠成小图标
  const [autoshow, setAutoshow] = useState(false); // 开机自动出现
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<Line[]>([]);
  const [status, setStatus] = useState("检测中…");
  const logRef = useRef<HTMLDivElement | null>(null);

  const save = (next: Partial<api.AgentOpts>) => {
    setCfg((c) => {
      const merged = { ...c, ...next };
      localStorage.setItem(
        PREFS,
        JSON.stringify({ agent: merged.agent, bin: merged.bin, cwd: merged.cwd, sandbox: merged.sandbox }),
      );
      return merged;
    });
  };

  // 探测 CLI 是否就绪
  const check = (agent: string, bin: string) => {
    setStatus("检测中…");
    api
      .agentCheck(agent, bin)
      .then((v) => setStatus(`✓ ${agent} ${v}`))
      .catch((e) => setStatus(`✗ ${e}`));
  };
  useEffect(() => {
    check(cfg.agent, cfg.bin);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg.agent, cfg.bin]);

  // 流式输出
  useEffect(() => {
    const un1 = listen<{ stream: string; line: string }>("agent-output", (e) => {
      const { stream, line } = e.payload;
      // stderr：codex 的人类日志，显暗灰（不是错误）
      if (stream === "err") {
        if (line.trim()) setLog((l) => [...l, { role: "step", text: line }]);
        return;
      }
      // stdout：codex --json 的 JSONL 事件，只挑有用的显示
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        if (line.trim()) setLog((l) => [...l, { role: "out", text: line }]);
        return;
      }
      const push = (role: Line["role"], text: string) =>
        text && setLog((l) => [...l, { role, text }]);
      if (ev.type === "item.completed" || ev.type === "item.started") {
        const it = ev.item || {};
        if (it.type === "agent_message" || it.type === "assistant_message") {
          if (ev.type === "item.completed") push("out", it.text || "");
        } else if (it.type === "command_execution") {
          if (ev.type === "item.started") push("step", "🛠 " + (it.command || it.cmd || "运行命令"));
        } else if (it.type === "file_change" || it.type === "patch") {
          push("step", "✏ 改动文件");
        } else if (it.type === "error") {
          push("err", it.message || JSON.stringify(it));
        }
      } else if (ev.type === "turn.completed") {
        const u = ev.usage || {};
        push("step", `· tokens 用量 in ${u.input_tokens ?? "?"} / out ${u.output_tokens ?? "?"}`);
      } else if (ev.type === "error") {
        push("err", ev.message || line);
      }
    });
    const un2 = listen<{ code: number | null }>("agent-done", (e) => {
      setRunning(false);
      setLog((l) => [...l, { role: "sys", text: `— 完成（退出码 ${e.payload.code ?? "?"}）—` }]);
    });
    return () => {
      un1.then((f) => f());
      un2.then((f) => f());
    };
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight);
  }, [log]);

  const send = async () => {
    const prompt = input.trim();
    if (!prompt || running) return;
    setLog((l) => [...l, { role: "user", text: prompt }]);
    setInput("");
    setRunning(true);
    try {
      await api.agentRun({ ...cfg, prompt });
    } catch (e) {
      setRunning(false);
      setLog((l) => [...l, { role: "err", text: String(e) }]);
    }
  };
  const stop = () => {
    api.agentCancel().catch(() => {});
    setRunning(false);
  };
  const pickCwd = async () => {
    const d = await openDialog({ directory: true, title: "选 Agent 干活的工作目录" }).catch(() => null);
    if (typeof d === "string") save({ cwd: d });
  };

  // 把连续的「过程」行归并成一个可折叠块（右侧小箭头展开/收起）
  type Row = { kind: "line"; line: Line } | { kind: "steps"; steps: Line[] };
  const rows = useMemo<Row[]>(() => {
    const r: Row[] = [];
    for (const l of log) {
      if (l.role === "step") {
        const last = r[r.length - 1];
        if (last && last.kind === "steps") last.steps.push(l);
        else r.push({ kind: "steps", steps: [l] });
      } else {
        r.push({ kind: "line", line: l });
      }
    }
    return r;
  }, [log]);

  const win = getCurrentWindow();
  const expand = async () => {
    await win.setSize(new LogicalSize(360, 480));
    setCollapsed(false);
    win.setFocus();
  };
  const collapse = async () => {
    await win.setSize(new LogicalSize(76, 76));
    setCollapsed(true);
  };

  // 读「开机自动出现」回显
  useEffect(() => {
    api.winkyGetAutoshow().then(setAutoshow).catch(() => {});
  }, []);
  const toggleAutoshow = (on: boolean) => {
    setAutoshow(on);
    api.winkySetAutoshow(on).catch(() => {});
  };

  // 折叠态：只是个小图标，点开展开成聊天窗；拖动可挪位置
  if (collapsed) {
    return (
      <div
        className={"winky-bubble" + (running ? " busy" : "")}
        title="点击展开 Winky"
        onClick={expand}
      >
        {running ? "🌀" : "🧚"}
      </div>
    );
  }

  return (
    <div className="pet">
      <div className="pet-head" data-tauri-drag-region>
        <span className="pet-face">{running ? "🌀" : "🧚"}</span>
        <span className="pet-title" data-tauri-drag-region>
          桌宠 · {cfg.agent}
        </span>
        <button className="pet-x" title="设置" onClick={() => setShowCfg((s) => !s)}>⚙</button>
        <button className="pet-x" title="收回小图标" onClick={collapse}>—</button>
        <button className="pet-x" title="关闭" onClick={() => win.close()}>✕</button>
      </div>

      {showCfg && (
        <div className="pet-cfg">
          <label>
            Agent
            <select value={cfg.agent} onChange={(e) => save({ agent: e.target.value })}>
              <option value="codex">Codex</option>
              <option value="claude">Claude</option>
            </select>
          </label>
          <label>
            权限
            <select value={cfg.sandbox} onChange={(e) => save({ sandbox: e.target.value })}>
              <option value="read-only">{SANDBOX_LABEL["read-only"]}</option>
              <option value="workspace-write">{SANDBOX_LABEL["workspace-write"]}</option>
              <option value="full">{SANDBOX_LABEL["full"]}</option>
            </select>
          </label>
          <label className="pet-cfg-row">
            工作目录
            <input value={cfg.cwd} placeholder="(默认当前目录)" onChange={(e) => save({ cwd: e.target.value })} />
            <button onClick={pickCwd}>选…</button>
          </label>
          <label className="pet-cfg-row">
            可执行
            <input value={cfg.bin} placeholder={`(默认 ${cfg.agent})`} onChange={(e) => save({ bin: e.target.value })} />
          </label>
          <label className="pet-chk">
            <input type="checkbox" checked={autoshow} onChange={(e) => toggleAutoshow(e.target.checked)} />
            开机自动出现（需 Nobi 已开机自启）
          </label>
          <div className="pet-status">{status}</div>
        </div>
      )}

      <div className="pet-log" ref={logRef}>
        {log.length === 0 && (
          <div className="pet-empty">
            跟我说句话,我转给 {cfg.agent} 去干。
            <br />
            权限当前:{SANDBOX_LABEL[cfg.sandbox]}
          </div>
        )}
        {rows.map((row, i) =>
          row.kind === "steps" ? (
            <details key={i} className="pet-steps">
              <summary>过程 · {row.steps.length} 步</summary>
              {row.steps.map((s, j) => (
                <div key={j} className="pet-step">{s.text}</div>
              ))}
            </details>
          ) : (
            <div key={i} className={"pet-line pet-" + row.line.role}>
              {row.line.role === "user" ? "🧑 " : row.line.role === "err" ? "⚠ " : ""}
              {row.line.text}
            </div>
          ),
        )}
        {running && <div className="pet-running">🌀 干活中…</div>}
      </div>

      <div className="pet-input">
        <textarea
          value={input}
          placeholder="让它做点什么…（Enter 发送，Shift+Enter 换行）"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        {running ? (
          <button className="pet-send danger" onClick={stop}>停止</button>
        ) : (
          <button className="pet-send" onClick={send}>发送</button>
        )}
      </div>
    </div>
  );
}
