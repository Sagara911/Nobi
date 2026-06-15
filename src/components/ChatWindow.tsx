// 聊天窗（main.tsx 按 #chat 路由渲染）。
// 两种形态由 URL 的 ?room= 决定：
//   · 无 room（#chat）        → 「发起/加入群」面板，每次「进入」开一个房间窗
//   · 有 room（#chat?room=X） → 该房间的独立聊天窗，可多个并排
// 只依赖 ChatBackend 抽象，不关心底层是 Supabase 还是自建服务器。

import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import * as api from "../api";
import {
  createBackend,
  drainOutbox,
  loadConfig,
  saveConfig,
  randomRoom,
  setActiveRoom,
  CHAT_OUTBOX_KEY,
  CREDENTIALS_BAKED,
  PROVIDER_LABELS,
  type ChatBackend,
  type ChatConfig,
  type ChatMessage,
  type ChatProvider,
  type ConnStatus,
} from "../chat";
import "./ChatWindow.css";

const LAUNCHER_LABEL = "chat";

/** 从 URL hash 取房间号（无则为空 = 启动器形态） */
function roomFromUrl(): string {
  const q = location.hash.split("?")[1] || "";
  return new URLSearchParams(q).get("room") || "";
}

function roomWindowLabel(room: string): string {
  return `chat-${room.replace(/[^\w-]/g, "_")}`;
}

/** 打开（或聚焦）某房间的独立窗口 */
async function openRoomWindow(room: string) {
  const label = roomWindowLabel(room);
  const existing = await WebviewWindow.getByLabel(label).catch(() => null);
  if (existing) {
    await existing.setFocus().catch(() => {});
    return;
  }
  const win = new WebviewWindow(label, {
    url: `index.html#chat?room=${encodeURIComponent(room)}`,
    title: `Nobi 聊天 · ${room}`,
    width: 380,
    height: 560,
    minWidth: 300,
    minHeight: 360,
    resizable: true,
    // 关掉 Tauri 原生拖放拦截，让窗口能用 HTML5 拖放收桌面拖进来的图片
    dragDropEnabled: false,
  });
  win.once("tauri://error", () => {});
}

/** 打开（或聚焦）启动器窗口 */
async function openLauncherWindow() {
  const existing = await WebviewWindow.getByLabel(LAUNCHER_LABEL).catch(() => null);
  if (existing) {
    await existing.setFocus().catch(() => {});
    return;
  }
  new WebviewWindow(LAUNCHER_LABEL, {
    url: "index.html#chat",
    title: "Nobi 聊天",
    width: 340,
    height: 420,
    resizable: true,
  });
}

/** 本地文件路径 → webview 可 fetch 的 URL（无 Tauri 时原样返回，预览不崩） */
function toFetchUrl(path: string): string {
  try {
    return convertFileSrc(path);
  } catch {
    return path;
  }
}

/** 加速键串（Alt+KeyC / Alt+Backquote）→ 人话（Alt + C） */
function fmtAccel(a: string): string {
  return a
    .split("+")
    .map((t) => {
      if (t === "Control") return "Ctrl";
      if (t === "Super") return "Win";
      if (/^Digit\d$/.test(t)) return t.slice(5);
      if (/^Key[A-Z]$/.test(t)) return t.slice(3);
      if (t === "Backquote") return "`";
      if (t === "Backslash") return "\\";
      if (t === "Space") return "Space";
      return t.replace(/^Arrow/, "");
    })
    .join(" + ");
}

const STATUS_TEXT: Record<ConnStatus, string> = {
  idle: "未连接",
  connecting: "连接中…",
  connected: "已连接",
  error: "连接出错",
  disconnected: "已断开",
};

export default function ChatWindow() {
  const room = roomFromUrl();
  return room ? <ChatRoom room={room} /> : <ChatLauncher />;
}

// ===== 房间聊天窗 =====

function ChatRoom({ room }: { room: string }) {
  // room 固定（窗口级），配置取一次即可：全局昵称/凭据 + 本窗房间号
  const [cfg] = useState<ChatConfig>(() => ({ ...loadConfig(), room }));
  const [status, setStatus] = useState<ConnStatus>("idle");
  const [statusDetail, setStatusDetail] = useState<string>("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState("");
  const [dragging, setDragging] = useState(false);

  const backendRef = useRef<ChatBackend | null>(null);
  const seenIds = useRef<Set<string>>(new Set());
  const listRef = useRef<HTMLDivElement | null>(null);

  const appendMsg = useCallback((m: ChatMessage) => {
    if (seenIds.current.has(m.id)) return;
    seenIds.current.add(m.id);
    setMessages((prev) => [...prev, m]);
  }, []);

  // 标记本房间为"当前活跃群"（右键发素材发往这里）：打开时 + 获焦时
  useEffect(() => {
    setActiveRoom(room);
    const onFocus = () => setActiveRoom(room);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [room]);

  // 发送 outbox 里发往本房间的素材
  const flushOutbox = useCallback(async () => {
    const backend = backendRef.current;
    if (!backend || status !== "connected") return;
    const items = drainOutbox(room);
    for (const it of items) {
      try {
        await backend.sendAsset({ url: toFetchUrl(it.path), name: it.name });
      } catch (e) {
        setNotice(`发送「${it.name}」失败：${String(e)}`);
      }
    }
  }, [status, room]);

  // 建立连接
  useEffect(() => {
    let disposed = false;
    const backend = createBackend(cfg);
    backendRef.current = backend;
    seenIds.current = new Set();
    setMessages([]);

    const offMsg = backend.onMessage((m) => {
      if (!disposed) appendMsg(m);
    });
    const offSt = backend.onStatus((s, detail) => {
      if (disposed) return;
      setStatus(s);
      if (detail) setStatusDetail(detail);
      if (s === "connected") setStatusDetail("");
    });

    (async () => {
      try {
        await backend.connect();
        const past = await backend.history(50);
        if (!disposed) past.forEach(appendMsg);
      } catch (e) {
        if (!disposed) {
          setStatus("error");
          setStatusDetail(String(e));
        }
      }
    })();

    return () => {
      disposed = true;
      offMsg();
      offSt();
      void backend.disconnect();
      backendRef.current = null;
    };
  }, [cfg, appendMsg]);

  // 连上后轮询排空 outbox（WebView2 多窗口间 storage 事件不可靠）
  useEffect(() => {
    if (status !== "connected") return;
    void flushOutbox();
    const timer = window.setInterval(() => void flushOutbox(), 1500);
    const onStorage = (e: StorageEvent) => {
      if (e.key === CHAT_OUTBOX_KEY) void flushOutbox();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("storage", onStorage);
    };
  }, [status, flushOutbox]);

  // 新消息滚到底
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const handleSend = async () => {
    const text = draft.trim();
    const backend = backendRef.current;
    if (!text || !backend || sending) return;
    setSending(true);
    try {
      await backend.sendText(text);
      setDraft("");
    } catch (e) {
      setNotice(`发送失败：${String(e)}`);
    } finally {
      setSending(false);
    }
  };

  // 桌面拖图进来直接发（窗口 dragDropEnabled:false，走 HTML5 拖放）
  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const backend = backendRef.current;
    if (!backend || status !== "connected") {
      setNotice("还没连上，先连接再拖图");
      return;
    }
    const files = Array.from(e.dataTransfer.files).filter((f) =>
      f.type.startsWith("image/"),
    );
    if (!files.length) {
      setNotice("只支持拖入图片文件");
      return;
    }
    for (const f of files) {
      try {
        await backend.sendAsset({ name: f.name, blob: f });
      } catch (err) {
        setNotice(`发送「${f.name}」失败：${String(err)}`);
      }
    }
  };

  return (
    <div
      className="chat-win"
      onDragOver={(e) => {
        e.preventDefault();
        if (!dragging) setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.relatedTarget === null) setDragging(false);
      }}
      onDrop={(e) => void handleDrop(e)}
    >
      {dragging && <div className="chat-dropzone">松手发送图片</div>}
      <header className="chat-head">
        <div className="chat-head-room">
          <span className="chat-room">#{room}</span>
          <span className={`chat-dot chat-dot-${status}`} title={statusDetail || STATUS_TEXT[status]} />
          <span className="chat-status">{STATUS_TEXT[status]}</span>
        </div>
        <button className="chat-gear" title="发起/加入别的群" onClick={() => void openLauncherWindow()}>＋</button>
      </header>

      {statusDetail && status === "error" && <div className="chat-error">{statusDetail}</div>}
      {notice && (
        <div className="chat-error" onClick={() => setNotice("")} title="点击关闭">
          {notice} ✕
        </div>
      )}

      <div className="chat-list" ref={listRef}>
        {messages.length === 0 && (
          <div className="chat-empty">还没有消息。打个招呼，或把图片拖进来 / 从素材库右键「发给朋友」。</div>
        )}
        {messages.map((m) => {
          const mine = m.clientId === cfg.clientId;
          return (
            <div key={m.id} className={`chat-row ${mine ? "mine" : "theirs"}`}>
              {!mine && <div className="chat-sender">{m.sender}</div>}
              <div className="chat-bubble">
                {m.kind === "image" && m.assetUrl ? (
                  <a href={m.assetUrl} target="_blank" rel="noreferrer">
                    <img className="chat-img" src={m.assetUrl} alt={m.assetName || "图片"} />
                  </a>
                ) : null}
                {m.body ? <div className="chat-text">{m.body}</div> : null}
              </div>
              <div className="chat-time">{new Date(m.createdAt).toLocaleTimeString().slice(0, 5)}</div>
            </div>
          );
        })}
      </div>

      <footer className="chat-input">
        <textarea
          value={draft}
          placeholder={`以 ${cfg.nickname || "我"} 的身份发消息…`}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void handleSend();
            }
          }}
          rows={2}
        />
        <button onClick={() => void handleSend()} disabled={sending || !draft.trim()}>
          发送
        </button>
      </footer>
    </div>
  );
}

// ===== 发起/加入群 启动器 =====

function ChatLauncher() {
  const [cfg, setCfg] = useState<ChatConfig>(() => loadConfig());
  const [room, setRoom] = useState<string>(cfg.room || "");
  const set = (patch: Partial<ChatConfig>) => setCfg((p) => ({ ...p, ...patch }));

  // 老板键（可自定义）：读当前键 + 录新键
  const [bossKey, setBossKey] = useState<string>("Alt+KeyC");
  const [recording, setRecording] = useState(false);
  useEffect(() => {
    api.chatGetBossKey().then(setBossKey).catch(() => {});
  }, []);
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(false);
        return;
      }
      if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return; // 等真正主键
      const mods: string[] = [];
      if (e.ctrlKey) mods.push("Control");
      if (e.altKey) mods.push("Alt");
      if (e.shiftKey) mods.push("Shift");
      if (e.metaKey) mods.push("Super");
      const accel = [...mods, e.code].join("+");
      setRecording(false);
      api.chatSetBossKey(accel).then(() => setBossKey(accel)).catch(() => {});
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording]);

  const credsReady =
    CREDENTIALS_BAKED ||
    (cfg.provider === "supabase"
      ? !!(cfg.supabaseUrl?.trim() && cfg.supabaseAnonKey?.trim())
      : cfg.provider === "custom"
      ? !!cfg.serverUrl?.trim()
      : false);
  const ready = !!cfg.nickname.trim() && !!room.trim() && credsReady;

  const enter = () => {
    if (!ready) return;
    saveConfig({ ...cfg, room: room.trim() });
    void openRoomWindow(room.trim());
  };

  return (
    <div className="chat-setup">
      <h3>发起 / 加入群</h3>

      <label className="chat-field">
        <span>名字</span>
        <input value={cfg.nickname} onChange={(e) => set({ nickname: e.target.value })} placeholder="朋友看到的名字" autoFocus />
      </label>

      <label className="chat-field">
        <span>房间号</span>
        <div className="chat-room-row">
          <input
            value={room}
            onChange={(e) => setRoom(e.target.value)}
            placeholder="和朋友约定同一个号"
            inputMode="numeric"
            onKeyDown={(e) => {
              if (e.key === "Enter" && ready) enter();
            }}
          />
          <button type="button" onClick={() => setRoom(randomRoom())}>建群（随机号）</button>
        </div>
      </label>

      {!CREDENTIALS_BAKED && (
        <>
          <label className="chat-field">
            <span>后端</span>
            <select value={cfg.provider} onChange={(e) => set({ provider: e.target.value as ChatProvider })}>
              {(Object.keys(PROVIDER_LABELS) as ChatProvider[]).map((p) => (
                <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>
              ))}
            </select>
          </label>
          {cfg.provider === "supabase" && (
            <>
              <label className="chat-field">
                <span>Supabase URL</span>
                <input value={cfg.supabaseUrl || ""} onChange={(e) => set({ supabaseUrl: e.target.value })} placeholder="https://xxxx.supabase.co" />
              </label>
              <label className="chat-field">
                <span>anon key</span>
                <input value={cfg.supabaseAnonKey || ""} onChange={(e) => set({ supabaseAnonKey: e.target.value })} placeholder="项目 Settings → API 里的 anon public" />
              </label>
            </>
          )}
          {cfg.provider === "custom" && (
            <>
              <label className="chat-field">
                <span>服务器地址</span>
                <input value={cfg.serverUrl || ""} onChange={(e) => set({ serverUrl: e.target.value })} placeholder="wss://你的域名/ws" />
              </label>
              <label className="chat-field">
                <span>Token（可选）</span>
                <input value={cfg.serverToken || ""} onChange={(e) => set({ serverToken: e.target.value })} placeholder="可留空" />
              </label>
            </>
          )}
        </>
      )}

      <label className="chat-field">
        <span>老板键（一键藏 / 显所有聊天窗）</span>
        <div className="chat-room-row">
          <input readOnly value={recording ? "按新组合…（Esc 取消）" : fmtAccel(bossKey)} />
          <button type="button" onClick={() => setRecording(true)}>改键</button>
        </div>
      </label>

      <p className="chat-hint">点「进入」开这个群的独立窗口；可反复进入不同房间号，多个群并排开着。</p>
      <div className="chat-setup-actions">
        <button className="primary" disabled={!ready} onClick={enter}>进入</button>
      </div>
    </div>
  );
}
