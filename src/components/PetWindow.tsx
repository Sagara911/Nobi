// 桌宠助手窗（#pet 路由）：常驻桌面的置顶小浮窗，你说人话 → 转给 codex/claude CLI 干活。
// 壳子很薄：起子进程、流式回显都在 Rust(agent.rs)，这里只管 UI + 设置。
import { useEffect, useMemo, useRef, useState } from "react";
import {
  getCurrentWindow,
  availableMonitors,
  primaryMonitor,
  LogicalSize,
  PhysicalPosition,
  PhysicalSize,
} from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import * as api from "../api";
import "./PetWindow.css";

// step = 过程类（命令/改文件/token/codex 日志），默认折叠隐藏
type Line = { role: "user" | "out" | "step" | "err" | "sys"; text: string };
const PREFS = "nobi-pet-settings-v1";
const POS_KEY = "nobi-winky-pos-v1"; // 记住手动摆放的图标位置（物理坐标）
const ICON = 60; // 折叠态小图标边长（逻辑像素），与 open_pet_window 的 inner_size 一致

function savePos(x: number, y: number) {
  try {
    localStorage.setItem(POS_KEY, JSON.stringify({ x, y }));
  } catch {
    /* ignore */
  }
}
function loadPos(): { x: number; y: number } | null {
  try {
    const v = JSON.parse(localStorage.getItem(POS_KEY) || "null");
    return v && typeof v.x === "number" && typeof v.y === "number" ? v : null;
  } catch {
    return null;
  }
}
// 按坐标找包含该点的显示器（避开"当前窗口所在屏"在接缝处的歧义）；找不到回退主屏
async function monitorForPoint(px: number, py: number) {
  try {
    const all = await availableMonitors();
    const hit = all.find(
      (m) =>
        px >= m.position.x &&
        px < m.position.x + m.size.width &&
        py >= m.position.y &&
        py < m.position.y + m.size.height,
    );
    if (hit) return hit;
  } catch {
    /* ignore */
  }
  return (await primaryMonitor()) ?? null;
}
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

export type WinkyPhase = "idle" | "waiting" | "running" | "done";
// Winky logo：参考图的样式(粗描边/那个 `>` 形/黄方块) + 终端提示符表情
// 空闲 `>_`(光标闪) / 等待 `>_•` / 执行中 `>_…`(呼吸) / 完成 `>_✓`
function WinkyLogo({ className, phase = "idle" }: { className?: string; phase?: WinkyPhase }) {
  return (
    <svg className={className} viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <rect x="14" y="14" width="72" height="72" rx="20" fill="#F5A623" />
      <g fill="none" stroke="#2b2b2b" strokeWidth="5.75" strokeLinecap="round" strokeLinejoin="round">
        {/* > 左眼 */}
        <polyline points="26,43 36,51 26,59" />
        {/* _ 嘴 */}
        <line className={phase === "idle" ? "winky-cursor" : undefined} x1="42" y1="72.5" x2="60" y2="72.5" />
      </g>
      {/* 状态符号当"右眼"位（中心 69.5, 50） */}
      {phase === "waiting" && <circle cx="69.5" cy="50" r="5" fill="#2b2b2b" />}
      {phase === "running" && (
        <g className="winky-dots" fill="#2b2b2b">
          <circle cx="60.5" cy="50" r="3.5" />
          <circle cx="69.5" cy="50" r="3.5" />
          <circle cx="78.5" cy="50" r="3.5" />
        </g>
      )}
      {phase === "done" && (
        <polyline
          points="61.5,50 67.5,58 79.1,44.4"
          fill="none"
          stroke="#2b2b2b"
          strokeWidth="5.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

export default function PetWindow() {
  const [cfg, setCfg] = useState<api.AgentOpts>(loadPrefs);
  const [showCfg, setShowCfg] = useState(false);
  const [collapsed, setCollapsed] = useState(true); // 默认折叠成小图标
  const [origin, setOrigin] = useState("100% 0%"); // 展开动画的起点角（随图标位置动态定）
  const [autoshow, setAutoshow] = useState(false); // 开机自动出现
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState<WinkyPhase>("idle"); // 表情：空闲/等待/执行中/完成
  const [log, setLog] = useState<Line[]>([]); // 内存态：折叠/展开期间在，关窗即清
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
      setPhase((p) => (p === "waiting" ? "running" : p)); // 出第一条输出 → 执行中
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
      setPhase("done"); // 完成 → ✓，2.5s 后回空闲
      setTimeout(() => setPhase((p) => (p === "done" ? "idle" : p)), 2500);
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

  const sendText = async (raw: string) => {
    const prompt = raw.trim();
    if (!prompt || running) return;
    setLog((l) => [...l, { role: "user", text: prompt }]);
    setInput("");
    setRunning(true);
    setPhase("waiting"); // 已发送、等首条输出
    try {
      await api.agentRun({ ...cfg, prompt });
    } catch (e) {
      setRunning(false);
      setPhase("idle");
      setLog((l) => [...l, { role: "err", text: String(e) }]);
    }
  };
  const send = () => sendText(input);
  const stop = () => {
    api.agentCancel().catch(() => {});
    setRunning(false);
    setPhase("idle");
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
  // 窗口从当前尺寸/位置平滑变到目标(物理像素)。用 rAF 驱动 + 每帧不 await(fire-and-forget)，
  // 让窗口以刷新率最快速度跟着长大——这是逐帧 resize 在本机能做到的最顺，不再卡。
  function animateBox(tx: number, ty: number, tw: number, th: number) {
    return new Promise<void>((resolve) => {
      void (async () => {
        let sx: number;
        let sy: number;
        let sw: number;
        let sh: number;
        try {
          const sp = await win.outerPosition();
          const ss = await win.outerSize();
          sx = sp.x;
          sy = sp.y;
          sw = ss.width;
          sh = ss.height;
        } catch {
          resolve();
          return;
        }
        const t0 = performance.now();
        const dur = 190;
        const step = (now: number) => {
          const p = Math.min(1, (now - t0) / dur);
          const e = 1 - Math.pow(1 - p, 3); // easeOutCubic
          // 先 position 后 size（IPC 有序），保证锚定边每帧都稳，不抖
          void win.setPosition(
            new PhysicalPosition(Math.round(sx + (tx - sx) * e), Math.round(sy + (ty - sy) * e)),
          );
          void win.setSize(
            new PhysicalSize(Math.round(sw + (tw - sw) * e), Math.round(sh + (th - sh) * e)),
          );
          if (p < 1) requestAnimationFrame(step);
          else resolve();
        };
        requestAnimationFrame(step);
      })();
    });
  }

  const expand = async () => {
    try {
      const cur = await win.outerPosition();
      const mon = await monitorForPoint(cur.x, cur.y);
      let tx = cur.x;
      let ty = cur.y;
      let tw = 360;
      let th = 480;
      if (mon) {
        const s = mon.scaleFactor;
        const w = Math.round(360 * s);
        const h = Math.round(480 * s);
        const pad = Math.round(8 * s);
        const size = Math.round(ICON * s);
        const { x: mx, y: my } = mon.position;
        const { width: mw, height: mh } = mon.size;
        const rightSide = cur.x + size / 2 > mx + mw / 2;
        const bottomSide = cur.y + size / 2 > my + mh / 2;
        tx = rightSide ? cur.x + size - w : cur.x; // 右侧→向左展(右缘锚定)；左侧→向右展
        ty = bottomSide ? cur.y + size - h : cur.y; // 下半→向上展；上半→向下展
        tx = Math.max(mx + pad, Math.min(tx, mx + mw - w - pad));
        ty = Math.max(my + pad, Math.min(ty, my + mh - h - pad));
        tw = w;
        th = h;
        setOrigin(`${rightSide ? "100%" : "0%"} ${bottomSide ? "100%" : "0%"}`);
      }
      await win.setResizable(true);
      setCollapsed(false); // 内容先就位，随窗口一起长大
      await animateBox(tx, ty, tw, th);
      win.setFocus();
    } catch {
      await win.setSize(new LogicalSize(360, 480));
      setCollapsed(false);
    }
  };

  const collapse = async () => {
    const target = loadPos(); // 收起后回到图标上次停的位置
    try {
      const cur = await win.outerPosition();
      const mon = await monitorForPoint(cur.x, cur.y);
      const size = Math.round(ICON * (mon?.scaleFactor ?? 1));
      const tx = target ? target.x : cur.x;
      const ty = target ? target.y : cur.y;
      await animateBox(tx, ty, size, size); // 平滑缩回并移到原位
      await win.setResizable(false);
      setCollapsed(true);
      if (!target) {
        const pos = await win.outerPosition();
        await snapToEdge(pos.x, pos.y, true);
      }
    } catch {
      await win.setSize(new LogicalSize(ICON, ICON));
      setCollapsed(true);
    }
  };

  // 图标态：按住拖动挪位置 / 轻点展开（靠移动距离区分）；松手吸附最近屏幕边
  const downRef = useRef<{ x: number; y: number } | null>(null);
  const movedRef = useRef(false);
  const onIconDown = (e: React.MouseEvent) => {
    downRef.current = { x: e.screenX, y: e.screenY };
    movedRef.current = false;
  };
  const onIconMove = (e: React.MouseEvent) => {
    if (!downRef.current || e.buttons !== 1) return;
    if (Math.abs(e.screenX - downRef.current.x) + Math.abs(e.screenY - downRef.current.y) > 4) {
      movedRef.current = true;
      downRef.current = null;
      win.startDragging().catch(() => {});
    }
  };
  const onIconClick = () => {
    if (!movedRef.current) expand();
  };

  // 拖完（窗口停止移动 220ms）：靠近某条边才吸附，且平滑飘过去
  const snappingRef = useRef(false);
  useEffect(() => {
    if (!collapsed) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const unP = win.onMoved(({ payload }) => {
      if (snappingRef.current) return; // 飘移动画自身触发的移动，忽略
      clearTimeout(t);
      t = setTimeout(() => void snapToEdge(payload.x, payload.y), 220);
    });
    return () => {
      clearTimeout(t);
      unP.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapsed]);

  // 缓动飘到目标位置（easeOutCubic，约 200ms）
  async function glideTo(tx: number, ty: number) {
    snappingRef.current = true;
    try {
      const start = await win.outerPosition();
      const sx = start.x;
      const sy = start.y;
      const steps = 14;
      for (let i = 1; i <= steps; i++) {
        const e = 1 - Math.pow(1 - i / steps, 3);
        await win.setPosition(
          new PhysicalPosition(Math.round(sx + (tx - sx) * e), Math.round(sy + (ty - sy) * e)),
        );
        await new Promise((r) => setTimeout(r, 14));
      }
    } catch {
      /* ignore */
    } finally {
      snappingRef.current = false;
    }
  }

  async function snapToEdge(px: number, py: number, force = false) {
    try {
      // 用图标所在那块屏（跨屏也支持），避开"当前窗口所在屏"在接缝处的歧义
      const mon = await monitorForPoint(px, py);
      if (!mon) return;
      const s = mon.scaleFactor;
      const size = Math.round(ICON * s);
      const margin = Math.round(8 * s);
      const threshold = Math.round(90 * s); // 只在离边 90px 内才吸附；拖到中间则留在原地
      const { x: mx, y: my } = mon.position;
      const { width: mw, height: mh } = mon.size;
      const dL = px - mx;
      const dR = mx + mw - (px + size);
      const dT = py - my;
      const dB = my + mh - (py + size);
      const m = Math.min(dL, dR, dT, dB);
      if (!force && m > threshold) {
        savePos(px, py); // 不吸附也记住手动摆放的位置
        return;
      }
      let nx = px;
      let ny = py;
      if (m === dL) nx = mx + margin;
      else if (m === dR) nx = mx + mw - size - margin;
      else if (m === dT) ny = my + margin;
      else ny = my + mh - size - margin;
      savePos(nx, ny); // 记住吸附后的位置
      if (Math.abs(nx - px) < 2 && Math.abs(ny - py) < 2) return; // 已贴边，别重复飘
      await glideTo(nx, ny);
    } catch {
      /* 吸附失败不致命 */
    }
  }

  // 打开时定位：优先回到上次手动摆放的位置；没有/失效则默认主屏右边缘
  useEffect(() => {
    (async () => {
      try {
        await win.setSize(new LogicalSize(ICON, ICON)); // 强制方形，避免首开被拉成椭圆
        const saved = loadPos();
        if (saved) {
          const m = await monitorForPoint(saved.x, saved.y);
          if (m) {
            await win.setPosition(new PhysicalPosition(saved.x, saved.y));
            return;
          }
        }
        const mon = await primaryMonitor();
        if (!mon) return;
        const s = mon.scaleFactor;
        const size = Math.round(ICON * s);
        const margin = Math.round(12 * s);
        const x = mon.position.x + mon.size.width - size - margin;
        const y = mon.position.y + Math.round(mon.size.height * 0.32);
        await win.setPosition(new PhysicalPosition(x, y));
        savePos(x, y);
      } catch {
        /* ignore */
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        title="点击展开 Winky · 按住拖动可挪位置（松手吸附边缘）"
        onMouseDown={onIconDown}
        onMouseMove={onIconMove}
        onClick={onIconClick}
      >
        <WinkyLogo className="winky-logo" phase={phase} />
      </div>
    );
  }

  return (
    <div className="pet" style={{ transformOrigin: origin }}>
      <div className="pet-head" data-tauri-drag-region>
        <span className="pet-face" data-tauri-drag-region>
          <WinkyLogo className="winky-logo" phase={phase} />
        </span>
        <span className="pet-titlewrap" data-tauri-drag-region>
          <span className="pet-title">Winky</span>
          <span className="pet-sub">{cfg.agent} · {SANDBOX_LABEL[cfg.sandbox]?.replace(/（.*）/, "")}</span>
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
            <div className="pet-empty-face"><WinkyLogo className="winky-logo" /></div>
            <div className="pet-empty-hi">我是 Winky</div>
            <div className="pet-empty-sub">说句话，我转给 {cfg.agent} 去干</div>
            <div className="pet-chips">
              {["列出当前目录有哪些文件", "讲讲这个项目是做什么的", "找找代码里的 TODO"].map((s) => (
                <button key={s} className="pet-chip" onClick={() => sendText(s)} disabled={running}>
                  {s}
                </button>
              ))}
            </div>
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
          ) : row.line.role === "user" ? (
            <div key={i} className="pet-msg pet-msg-user">
              <div className="pet-bubble pet-bubble-user">{row.line.text}</div>
            </div>
          ) : row.line.role === "sys" ? (
            <div key={i} className="pet-sysline">{row.line.text}</div>
          ) : (
            <div key={i} className="pet-msg pet-msg-bot">
              <span className="pet-msg-ava"><WinkyLogo className="winky-logo" /></span>
              <div className={"pet-bubble" + (row.line.role === "err" ? " pet-bubble-err" : "")}>
                {row.line.text}
              </div>
            </div>
          ),
        )}
        {running && (
          <div className="pet-msg pet-msg-bot">
            <span className="pet-msg-ava">🌀</span>
            <div className="pet-bubble pet-typing">干活中…</div>
          </div>
        )}
      </div>

      <div className="pet-input">
        <div className="pet-input-pill">
          <textarea
            value={input}
            placeholder="让它做点什么…"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          {running ? (
            <button className="pet-send danger" title="停止" onClick={stop}>■</button>
          ) : (
            <button className="pet-send" title="发送（Enter）" onClick={send} disabled={!input.trim()}>↑</button>
          )}
        </div>
      </div>
    </div>
  );
}
