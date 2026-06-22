// 聊天窗（main.tsx 按 #chat 路由渲染）。两种形态由 URL 参数决定：
//   · 无 room        → 「发起/加入群」启动器（选/建连接档案 + 房间号）
//   · profile + room → 该连接的独立聊天窗，可多个并排（不同档案=不同服务器同时开）
// 只依赖 ChatBackend 抽象，不关心底层是 Supabase 还是自建服务器。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc, invoke as coreInvoke } from "@tauri-apps/api/core";
import { WebviewWindow, getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import * as api from "../api";
import {
  createBackend,
  drainOutbox,
  randomRoom,
  getProfiles,
  getProfile,
  saveProfile,
  removeProfile,
  isProfileReady,
  resolveConfig,
  getNickname,
  setNickname,
  getAvatar,
  setAvatar,
  getBubbleColor,
  setBubbleColor,
  BUBBLE_COLORS,
  EMOJIS,
  readableText,
  AVATAR_CHOICES,
  fileToAvatar,
  isImageAvatar,
  addJoinedConn,
  getJoinedConns,
  removeJoinedConn,
  setActiveConn,
  clearActiveConn,
  getStickers,
  removeSticker,
  type Sticker,
  type JoinedConn,
  CHAT_OUTBOX_KEY,
  BAKED_PROFILE_ID,
  PROVIDER_LABELS,
  SUPABASE_SETUP_SQL,
  type ChatBackend,
  type ChatConfig,
  type ChatMessage,
  type ChatProfile,
  type ChatProvider,
  type ConnStatus,
} from "../chat";
import "./ChatWindow.css";
import UnoGame, { UNO_TAG, type GEvent } from "./UnoGame";
import LudoGame, { LUDO_TAG, type LEvent } from "./LudoGame";
import LiarGame, { LIAR_TAG, type LiarEvent } from "./LiarGame";
import GameChat from "./GameChat";

const LAUNCHER_LABEL = "chat";

function urlParams(): URLSearchParams {
  return new URLSearchParams(location.hash.split("?")[1] || "");
}

function roomWindowLabel(profileId: string, room: string): string {
  return `chat-${`${profileId}-${room}`.replace(/[^\w-]/g, "_")}`;
}

/** 打开（或聚焦）某连接（档案+房间）的独立窗口 */
async function openConnWindow(profileId: string, room: string) {
  const label = roomWindowLabel(profileId, room);
  const existing = await WebviewWindow.getByLabel(label).catch(() => null);
  if (existing) {
    await existing.setFocus().catch(() => {});
    return;
  }
  const url = `index.html#chat?profile=${encodeURIComponent(profileId)}&room=${encodeURIComponent(room)}`;
  const win = new WebviewWindow(label, {
    url,
    title: `Nobi 聊天 · ${room}`,
    width: 380,
    height: 560,
    minWidth: 300,
    minHeight: 360,
    resizable: true,
    alwaysOnTop: true, // 便签置顶，像便利贴一样浮在其它窗口上
    dragDropEnabled: false, // 走 HTML5 拖放收桌面图片
    visible: false, // 隐藏建窗，窗口 mount 后调 stealth_show 打 toolwindow 再显示（不进 Alt+Tab/任务栏）
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
    width: 360,
    height: 520,
    resizable: true,
    alwaysOnTop: true, // 启动器也置顶，和便签一致
    visible: false, // 同上，stealth_show 后再显示
  });
}

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

function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

/** 头像：图片(data/http)显图，emoji 显 emoji，否则名字首字 + 确定性配色（默认） */
function MsgAvatar({ name, avatar }: { name: string; avatar?: string }) {
  if (isImageAvatar(avatar)) return <img className="chat-ava chat-ava-img" src={avatar} alt="" />;
  if (avatar) return <div className="chat-ava chat-ava-emoji">{avatar}</div>;
  const ch = (name || "?").trim().charAt(0).toUpperCase() || "?";
  return (
    <div className="chat-ava" style={{ background: `hsl(${hashHue(name)} 52% 45%)` }}>
      {ch}
    </div>
  );
}

/** 把消息文本里的 @昵称 高亮；@到自己或@所有人时更醒目 */
function renderBody(body: string, myNick: string) {
  return body.split(/(@[^\s@]+)/g).map((p, i) => {
    if (p.startsWith("@")) {
      const name = p.slice(1);
      const me = name === myNick || name === "所有人";
      return (
        <span key={i} className={`chat-at${me ? " me" : ""}`}>
          {p}
        </span>
      );
    }
    return <span key={i}>{p}</span>;
  });
}

/** 这条消息是否 @ 了我（含 @所有人）*/
function mentionsMe(body: string | undefined, myNick: string): boolean {
  if (!body || !myNick) return false;
  return body.includes(`@${myNick}`) || body.includes("@所有人");
}

const STATUS_TEXT: Record<ConnStatus, string> = {
  idle: "未连接",
  connecting: "连接中…",
  connected: "已连接",
  error: "连接出错",
  disconnected: "已断开",
};

export default function ChatWindow() {
  const params = urlParams();
  const room = params.get("room") || "";
  const profileId = params.get("profile") || "";
  // 本窗是隐藏建出来的：mount 后打 WS_EX_TOOLWINDOW 标记再显示，便签不进 Alt+Tab/任务栏
  useEffect(() => {
    void coreInvoke("stealth_show").catch(() => {});
  }, []);
  return room && profileId ? <ChatRoom profileId={profileId} room={room} /> : <ChatLauncher />;
}

// ===== 房间聊天窗 =====

function ChatRoom({ profileId, room }: { profileId: string; room: string }) {
  const profile = useMemo(() => getProfile(profileId), [profileId]);
  const [cfg] = useState<ChatConfig | null>(() =>
    profile ? resolveConfig(profile, room) : null,
  );

  // 身份（昵称/头像）单独存：可在房间内现改，不动 cfg 故不会触发重连。
  // 渲染处一律用这两个 state（而非 cfg.nickname），改完即时反映。
  const [nickname, setNick] = useState<string>(() => getNickname());
  const [avatar, setAva] = useState<string>(() => getAvatar());
  const [bubbleColor, setBubble] = useState<string>(() => getBubbleColor());
  const [editId, setEditId] = useState(false);
  const avaFileRef = useRef<HTMLInputElement | null>(null);

  const [status, setStatus] = useState<ConnStatus>("idle");
  const [statusDetail, setStatusDetail] = useState<string>("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState("");
  const [dragging, setDragging] = useState(false);
  const [panel, setPanel] = useState<null | "emoji" | "sticker">(null);
  const [stickers, setStickers] = useState<Sticker[]>(() => getStickers());
  const [mentionQ, setMentionQ] = useState<string | null>(null); // 正在输入的 @查询(null=没在@)

  // @候选：按"人"(clientId)去重，每人只取其最新用过的名字——避免某人改名后
  // 历史里堆一堆旧名字。排除自己 + 加「所有人」。
  const mentionNames = useMemo(() => {
    const byClient = new Map<string, string>(); // clientId → 最新名字（后出现的覆盖先前的）
    for (const m of messages) {
      if (m.clientId && m.clientId !== cfg?.clientId && m.sender) {
        byClient.set(m.clientId, m.sender);
      }
    }
    return ["所有人", ...byClient.values()];
  }, [messages, cfg]);
  const mentionList =
    mentionQ === null
      ? []
      : mentionNames.filter((n) => n.toLowerCase().includes(mentionQ.toLowerCase())).slice(0, 8);

  const onDraftChange = (val: string) => {
    setDraft(val);
    const m = val.match(/@([^\s@]*)$/); // 末尾正在打的 @词
    setMentionQ(m ? m[1] : null);
  };
  const pickMention = (name: string) => {
    setDraft((d) => d.replace(/@([^\s@]*)$/, `@${name} `));
    setMentionQ(null);
  };

  const backendRef = useRef<ChatBackend | null>(null);
  const seenIds = useRef<Set<string>>(new Set());
  const listRef = useRef<HTMLDivElement | null>(null);

  const appendMsg = useCallback((m: ChatMessage) => {
    if (seenIds.current.has(m.id)) return;
    seenIds.current.add(m.id);
    setMessages((prev) => [...prev, m]);
  }, []);

  // 小游戏走聊天通道，但正文带各自的 TAG 前缀：分流给对应游戏、不进消息流。
  // UNO 与飞行棋各用独立 tag + 监听集，互不干扰；UNO 线路保持原样不动。
  const [openGame, setOpenGame] = useState<null | "uno" | "ludo" | "liar">(null);
  const unoListeners = useRef<Set<(ev: GEvent) => void>>(new Set());
  const ludoListeners = useRef<Set<(ev: LEvent) => void>>(new Set());
  const liarListeners = useRef<Set<(ev: LiarEvent) => void>>(new Set());
  const routeIncoming = useCallback(
    (m: ChatMessage) => {
      const dispatch = <E,>(tag: string, set: Set<(ev: E) => void>): boolean => {
        if (!m.body || !m.body.startsWith(tag)) return false;
        try {
          const ev = JSON.parse(m.body.slice(tag.length)) as E;
          set.forEach((fn) => fn(ev));
        } catch {
          /* 坏帧忽略 */
        }
        return true;
      };
      if (dispatch<GEvent>(UNO_TAG, unoListeners.current)) return;
      if (dispatch<LEvent>(LUDO_TAG, ludoListeners.current)) return;
      if (dispatch<LiarEvent>(LIAR_TAG, liarListeners.current)) return;
      // 兜底：任何以控制字符(<0x08)开头的帧都是游戏/系统帧，绝不进消息流——防以后新增游戏的帧在旧客户端刷屏成乱码消息
      if (m.body && m.body.charCodeAt(0) < 0x08) return;
      appendMsg(m);
    },
    [appendMsg],
  );
  // 高频游戏帧（state/action）走 backend.sendGame（瞬时广播、不落历史库），没实现就回退 sendText。
  const sendGameFrame = useCallback((frame: string) => {
    const b = backendRef.current;
    if (!b) return;
    if (b.sendGame) b.sendGame(frame);
    else void b.sendText(frame).catch(() => {});
  }, []);
  // 低频但需要"新人/重连补齐"的帧（lobby/join）走持久化通道，靠 history 回放才进得来；高频 state/action 走广播。
  const sendChatFrame = useCallback((frame: string) => {
    void backendRef.current?.sendText(frame).catch(() => {});
  }, []);
  const routeGameSend = useCallback(
    (tag: string, ev: { k: string }) => {
      const frame = tag + JSON.stringify(ev);
      if (ev.k === "lobby" || ev.k === "join") sendChatFrame(frame); // 可被 history 回放→晚到的人也能看到房间/加入
      else sendGameFrame(frame); // state/action：瞬时广播，不污染聊天历史
    },
    [sendChatFrame, sendGameFrame],
  );
  const sendUno = useCallback((ev: GEvent) => routeGameSend(UNO_TAG, ev), [routeGameSend]);
  const subscribeUno = useCallback((fn: (ev: GEvent) => void) => {
    unoListeners.current.add(fn);
    return () => unoListeners.current.delete(fn);
  }, []);
  const sendLudo = useCallback((ev: LEvent) => routeGameSend(LUDO_TAG, ev), [routeGameSend]);
  const subscribeLudo = useCallback((fn: (ev: LEvent) => void) => {
    ludoListeners.current.add(fn);
    return () => ludoListeners.current.delete(fn);
  }, []);
  const sendLiar = useCallback((ev: LiarEvent) => routeGameSend(LIAR_TAG, ev), [routeGameSend]);
  const subscribeLiar = useCallback((fn: (ev: LiarEvent) => void) => {
    liarListeners.current.add(fn);
    return () => liarListeners.current.delete(fn);
  }, []);

  // 活跃连接标记 + 未读清零：聚焦=正在看→记活跃+清红点；失焦/关窗=没在看→主窗能为它弹提醒
  useEffect(() => {
    setActiveConn(profileId, room);
    void api.chatClearUnread();
    const onFocus = () => {
      setActiveConn(profileId, room);
      void api.chatClearUnread();
    };
    const onBlur = () => clearActiveConn();
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      clearActiveConn();
    };
  }, [profileId, room]);

  const flushOutbox = useCallback(async () => {
    const backend = backendRef.current;
    if (!backend || status !== "connected") return;
    const items = drainOutbox(profileId, room);
    for (const it of items) {
      try {
        await backend.sendAsset({ url: toFetchUrl(it.path), name: it.name, kind: it.kind });
      } catch (e) {
        setNotice(`发送「${it.name}」失败：${String(e)}`);
      }
    }
  }, [status, profileId, room]);

  // 建立连接
  useEffect(() => {
    if (!cfg) return;
    let disposed = false;
    const backend = createBackend(cfg);
    backendRef.current = backend;
    seenIds.current = new Set();
    setMessages([]);

    const offMsg = backend.onMessage((m) => {
      if (!disposed) routeIncoming(m);
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
        if (!disposed) past.forEach(routeIncoming);
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
  }, [cfg, routeIncoming]);

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

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // 窗口取消隐藏后未聚焦时，原生滚动要先点一下才生效——手动接管滚轮，hover 即可滚
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      el.scrollTop += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Ctrl+V 直接粘贴图片/视频发送（纯文本粘贴照常进输入框）
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const backend = backendRef.current;
      if (!backend || status !== "connected") return;
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (const it of Array.from(items)) {
        if (it.kind === "file" && (it.type.startsWith("image/") || it.type.startsWith("video/"))) {
          const f = it.getAsFile();
          if (f) files.push(f);
        }
      }
      if (!files.length) return;
      e.preventDefault();
      void (async () => {
        for (const f of files) {
          const ext = (f.type.split("/")[1] || "png").split(";")[0];
          const isVid = f.type.startsWith("video/");
          try {
            await backend.sendAsset({
              name: f.name || `粘贴.${ext}`,
              blob: f,
              kind: isVid ? "video" : "image",
            });
          } catch (err) {
            setNotice(`粘贴发送失败：${String(err)}`);
          }
        }
      })();
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [status]);

  if (!cfg) {
    return (
      <div className="chat-setup">
        <h3>连接不存在</h3>
        <p className="chat-hint">这个连接可能已被删除。请关掉本窗，从聊天启动器重新进入。</p>
      </div>
    );
  }

  // 房间内改名/换头像：落盘（全局身份）+ 即时告诉后端（之后发的消息用新身份）。
  const applyName = (v: string) => {
    setNick(v);
    setNickname(v);
    backendRef.current?.updateIdentity?.(v.trim(), avatar);
  };
  const applyAvatar = (a: string) => {
    setAva(a);
    setAvatar(a);
    backendRef.current?.updateIdentity?.(nickname.trim(), a);
  };
  // 气泡颜色：本机偏好，只影响自己发出的气泡（空=默认蓝）。即时落盘+反映。
  const applyBubble = (c: string) => {
    setBubble(c);
    setBubbleColor(c);
  };
  const onPickAvaFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = ""; // 允许重选同一文件
    if (!f) return;
    try {
      applyAvatar(await fileToAvatar(f));
    } catch {
      /* ignore */
    }
  };

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

  // 游戏内聊天用：直接发一条文本（不经主输入框的 draft）
  const sendChatText = (text: string) => {
    const t = text.trim();
    const backend = backendRef.current;
    if (!t || !backend) return;
    void backend.sendText(t).catch((e) => setNotice(`发送失败：${String(e)}`));
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const backend = backendRef.current;
    if (!backend || status !== "connected") {
      setNotice("还没连上，先连接再拖图");
      return;
    }
    const files = Array.from(e.dataTransfer.files).filter(
      (f) => f.type.startsWith("image/") || f.type.startsWith("video/"),
    );
    if (!files.length) {
      setNotice("只支持拖入图片或视频文件");
      return;
    }
    for (const f of files) {
      try {
        await backend.sendAsset({
          name: f.name,
          blob: f,
          kind: f.type.startsWith("video/") ? "video" : "image",
        });
      } catch (err) {
        setNotice(`发送「${f.name}」失败：${String(err)}`);
      }
    }
  };

  // 发一张收藏的表情包（本地图片，re-upload）
  const sendSticker = async (s: Sticker) => {
    const backend = backendRef.current;
    if (!backend || status !== "connected") {
      setNotice("还没连上");
      return;
    }
    setPanel(null);
    try {
      await backend.sendAsset({ url: toFetchUrl(s.path), name: s.name, kind: "image" });
    } catch (e) {
      setNotice(`发送失败：${String(e)}`);
    }
  };

  return (
    <div
      className="chat-win"
      style={
        bubbleColor
          ? ({
              "--mine-bubble": bubbleColor,
              "--mine-bubble-text": readableText(bubbleColor),
            } as React.CSSProperties)
          : undefined
      }
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
        <div className="chat-head-actions">
          <button
            className={`chat-me${editId ? " on" : ""}`}
            title="改名 / 换头像"
            onClick={() => setEditId((v) => !v)}
          >
            <MsgAvatar name={nickname} avatar={avatar} />
          </button>
          <button
            className={`chat-gear${openGame === "uno" ? " on" : ""}`}
            title="UNO 小游戏"
            onClick={() => setOpenGame((g) => (g === "uno" ? null : "uno"))}
          >
            🎴
          </button>
          <button
            className={`chat-gear${openGame === "ludo" ? " on" : ""}`}
            title="飞行棋"
            onClick={() => setOpenGame((g) => (g === "ludo" ? null : "ludo"))}
          >
            🎲
          </button>
          <button
            className={`chat-gear${openGame === "liar" ? " on" : ""}`}
            title="骗子酒馆"
            onClick={() => setOpenGame((g) => (g === "liar" ? null : "liar"))}
          >
            🍷
          </button>
          <button className="chat-gear" title="发起/加入别的群" onClick={() => void openLauncherWindow()}>＋</button>
          {/* 自定义窗口控制：便签是隐身窗(toolwindow)，系统标题栏只剩关闭，这里补上 放大/隐藏 */}
          <button
            className="chat-gear"
            title="最大化 / 还原"
            onClick={() => void getCurrentWebviewWindow().toggleMaximize()}
          >
            ▢
          </button>
          <button
            className="chat-gear"
            title="隐藏（用老板键 Alt+C 或托盘「便签」唤回）"
            onClick={() => void getCurrentWebviewWindow().hide()}
          >
            —
          </button>
        </div>
      </header>

      <UnoGame
        open={openGame === "uno"}
        myId={cfg.clientId}
        myName={nickname}
        sendGame={sendUno}
        subscribeGame={subscribeUno}
        onClose={() => setOpenGame(null)}
      />
      <LudoGame
        open={openGame === "ludo"}
        myId={cfg.clientId}
        myName={nickname}
        sendGame={sendLudo}
        subscribeGame={subscribeLudo}
        onClose={() => setOpenGame(null)}
      />
      <LiarGame
        open={openGame === "liar"}
        myId={cfg.clientId}
        myName={nickname}
        sendGame={sendLiar}
        subscribeGame={subscribeLiar}
        onClose={() => setOpenGame(null)}
      />
      {openGame && <GameChat messages={messages} myId={cfg.clientId} onSend={sendChatText} />}

      {editId && (
        <div className="chat-idedit">
          <label className="chat-field">
            <span>我的名字</span>
            <input
              value={nickname}
              onChange={(e) => applyName(e.target.value)}
              placeholder="朋友看到的名字"
              autoFocus
            />
          </label>
          <div className="chat-ava-pick">
            <button
              type="button"
              className={`chat-ava-opt ${!avatar ? "on" : ""}`}
              title="默认（彩色首字）"
              onClick={() => applyAvatar("")}
            >
              <MsgAvatar name={nickname || "?"} />
            </button>
            <button
              type="button"
              className="chat-ava-opt chat-ava-upload"
              title="上传图片"
              onClick={() => avaFileRef.current?.click()}
            >
              ＋
            </button>
            {isImageAvatar(avatar) && (
              <button type="button" className="chat-ava-opt on" title="当前自定义头像">
                <img className="chat-ava-mini" src={avatar} alt="" />
              </button>
            )}
            {AVATAR_CHOICES.map((a) => (
              <button
                key={a}
                type="button"
                className={`chat-ava-opt ${avatar === a ? "on" : ""}`}
                onClick={() => applyAvatar(a)}
              >
                {a}
              </button>
            ))}
          </div>
          <input
            ref={avaFileRef}
            type="file"
            accept="image/*"
            style={{ display: "none" }}
            onChange={onPickAvaFile}
          />
          <div className="chat-bubble-pick">
            <span className="chat-bubble-pick-label">我的气泡颜色</span>
            <div className="chat-bubble-swatches">
              <button
                type="button"
                className={`chat-swatch chat-swatch-default${!bubbleColor ? " on" : ""}`}
                title="默认（蓝）"
                onClick={() => applyBubble("")}
              >
                默认
              </button>
              {BUBBLE_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`chat-swatch${bubbleColor.toLowerCase() === c.toLowerCase() ? " on" : ""}`}
                  style={{ background: c }}
                  title={c}
                  onClick={() => applyBubble(c)}
                />
              ))}
              <label className="chat-swatch chat-swatch-custom" title="自定义颜色">
                🎨
                <input
                  type="color"
                  value={/^#[0-9a-f]{6}$/i.test(bubbleColor) ? bubbleColor : "#2b5278"}
                  onChange={(e) => applyBubble(e.target.value)}
                />
              </label>
            </div>
          </div>
          <div className="chat-idedit-foot">
            <span className="chat-hint">改完即时生效；已发出的旧消息保留当时的名字。</span>
            <button type="button" onClick={() => setEditId(false)}>完成</button>
          </div>
        </div>
      )}

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
          const atMe = !mine && mentionsMe(m.body, nickname);
          return (
            <div key={m.id} className={`chat-row ${mine ? "mine" : "theirs"}`}>
              <MsgAvatar name={m.sender} avatar={m.avatar} />
              <div className="chat-col">
                {!mine && <div className="chat-sender">{m.sender}</div>}
                <div
                  className={`chat-bubble${atMe ? " at-me" : ""}`}
                  style={m.bubble ? { background: m.bubble, color: readableText(m.bubble) } : undefined}
                >
                  {m.kind === "image" && m.assetUrl ? (
                    <a href={m.assetUrl} target="_blank" rel="noreferrer">
                      <img className="chat-img" src={m.assetUrl} alt={m.assetName || "图片"} />
                    </a>
                  ) : null}
                  {m.kind === "video" && m.assetUrl ? (
                    <video className="chat-video" src={m.assetUrl} controls preload="metadata" />
                  ) : null}
                  {m.body ? <div className="chat-text">{renderBody(m.body, nickname)}</div> : null}
                </div>
                <div className="chat-time">{new Date(m.createdAt).toLocaleTimeString().slice(0, 5)}</div>
              </div>
            </div>
          );
        })}
      </div>

      {panel && (
        <div className="chat-panel">
          <div className="chat-panel-tabs">
            <button className={panel === "emoji" ? "on" : ""} onClick={() => setPanel("emoji")}>Emoji</button>
            <button className={panel === "sticker" ? "on" : ""} onClick={() => setPanel("sticker")}>表情包</button>
          </div>
          {panel === "emoji" ? (
            <div className="chat-emoji-grid">
              {EMOJIS.map((e) => (
                <button key={e} type="button" onClick={() => setDraft((d) => d + e)}>{e}</button>
              ))}
            </div>
          ) : (
            <div className="chat-sticker-grid">
              {stickers.length === 0 && (
                <div className="chat-empty-sm">还没有收藏的表情包。在素材库右键图片「收藏为表情包」。</div>
              )}
              {stickers.map((s) => (
                <div className="chat-sticker" key={s.path}>
                  <img src={toFetchUrl(s.path)} alt={s.name} title={s.name} onClick={() => void sendSticker(s)} />
                  <button
                    className="chat-sticker-x"
                    title="移除"
                    onClick={() => {
                      removeSticker(s.path);
                      setStickers(getStickers());
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {mentionQ !== null && mentionList.length > 0 && (
        <div className="chat-mention-pop">
          {mentionList.map((n, idx) => (
            <button
              key={n}
              type="button"
              className={`chat-mention-item${idx === 0 ? " first" : ""}`}
              onClick={() => pickMention(n)}
            >
              @{n}
            </button>
          ))}
        </div>
      )}

      <footer className="chat-input">
        <button
          className="chat-emoji-btn"
          title="表情 / 表情包"
          onClick={() => setPanel((p) => (p ? null : "emoji"))}
        >
          😀
        </button>
        <textarea
          value={draft}
          placeholder={`以 ${nickname || "我"} 的身份发消息…（@ 提到某人）`}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={(e) => {
            if (mentionQ !== null && mentionList.length) {
              if (e.key === "Enter") {
                e.preventDefault();
                pickMention(mentionList[0]);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setMentionQ(null);
                return;
              }
            }
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

const EMPTY_DRAFT: Omit<ChatProfile, "id"> = {
  label: "",
  provider: "supabase",
  supabaseUrl: "",
  supabaseAnonKey: "",
  serverUrl: "",
  serverToken: "",
};

function ChatLauncher() {
  const [nickname, setNick] = useState<string>(() => getNickname());
  const [avatar, setAva] = useState<string>(() => getAvatar());
  const [conns, setConns] = useState<JoinedConn[]>(() => getJoinedConns());
  const fileRef = useRef<HTMLInputElement | null>(null);

  // 点已记住的房间直接进（连接已持久化），并关掉启动器。
  // 注意：必须先把当前输入框里的名字落盘——否则在这里改了名直接点已存房间，
  // 房间窗 resolveConfig 读到的还是旧名字（头像在 pickAvatar 里已即时落盘）。
  const goRoom = (profileId: string, room: string) => {
    const n = nickname.trim();
    if (n) setNickname(n);
    void openConnWindow(profileId, room).then(() => {
      getCurrentWebviewWindow().close().catch(() => {});
    });
  };
  const leaveRoom = (profileId: string, room: string) => {
    removeJoinedConn(profileId, room);
    setConns(getJoinedConns());
  };
  const pickAvatar = (a: string) => {
    setAva(a);
    setAvatar(a); // 立即持久化，下次开房间窗就带上
  };
  const onPickFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = ""; // 允许重选同一文件
    if (!f) return;
    try {
      pickAvatar(await fileToAvatar(f));
    } catch {
      /* ignore */
    }
  };
  const [profiles, setProfiles] = useState<ChatProfile[]>(() => getProfiles());
  const [selectedId, setSelectedId] = useState<string>(() => {
    const ps = getProfiles();
    return ps.length ? ps[0].id : "new";
  });
  const [draft, setDraft] = useState<Omit<ChatProfile, "id">>(EMPTY_DRAFT);
  const [room, setRoom] = useState("");
  const [reveal, setReveal] = useState(false);
  const [copied, setCopied] = useState("");

  // 快捷键（老板键 + 透明度调淡/调浓，均可改）
  const [bossKey, setBossKey] = useState<string>("Alt+KeyC");
  const [opDown, setOpDown] = useState<string>("Alt+KeyV");
  const [opUp, setOpUp] = useState<string>("Alt+KeyB");
  const [recording, setRecording] = useState<null | "boss" | "opDown" | "opUp">(null);
  const [keyErr, setKeyErr] = useState("");
  const [sqlCopied, setSqlCopied] = useState(false);

  useEffect(() => {
    api.chatGetBossKey().then(setBossKey).catch(() => {});
    api
      .chatGetOpacityKeys()
      .then((ks) => {
        if (ks[0]) setOpDown(ks[0]);
        if (ks[1]) setOpUp(ks[1]);
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (!recording) return;
    const target = recording;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(null);
        return;
      }
      if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
      const mods: string[] = [];
      if (e.ctrlKey) mods.push("Control");
      if (e.altKey) mods.push("Alt");
      if (e.shiftKey) mods.push("Shift");
      if (e.metaKey) mods.push("Super");
      const accel = [...mods, e.code].join("+");
      setRecording(null);
      setKeyErr("");
      const done =
        target === "boss"
          ? api.chatSetBossKey(accel).then(() => setBossKey(accel))
          : target === "opDown"
          ? api.chatSetOpacityKey("down", accel).then(() => setOpDown(accel))
          : api.chatSetOpacityKey("up", accel).then(() => setOpUp(accel));
      done.catch((err) => setKeyErr(String(err)));
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording]);

  const keyRow = (label: string, target: "boss" | "opDown" | "opUp", accel: string) => (
    <label className="chat-field">
      <span>{label}</span>
      <div className="chat-room-row">
        <input readOnly value={recording === target ? "按新组合…（Esc 取消）" : fmtAccel(accel)} />
        <button type="button" onClick={() => { setKeyErr(""); setRecording(target); }}>改键</button>
      </div>
    </label>
  );

  const isNew = selectedId === "new";
  const selected = isNew ? null : profiles.find((p) => p.id === selectedId) || null;
  const draftReady = isProfileReady({ ...draft, id: "draft" });
  const ready =
    !!nickname.trim() &&
    !!room.trim() &&
    (isNew ? draftReady : !!selected && isProfileReady(selected));

  const flash = (msg: string) => {
    setCopied(msg);
    window.setTimeout(() => setCopied(""), 1600);
  };
  const copy = (text: string, label: string) => {
    navigator.clipboard.writeText(text).then(() => flash(`已复制${label}`)).catch(() => {});
  };
  const copySql = () => {
    navigator.clipboard.writeText(SUPABASE_SETUP_SQL).then(() => setSqlCopied(true)).catch(() => {});
    window.setTimeout(() => setSqlCopied(false), 1800);
  };

  const refreshProfiles = (selId?: string) => {
    const ps = getProfiles();
    setProfiles(ps);
    if (selId) setSelectedId(selId);
    else if (!ps.some((p) => p.id === selectedId)) setSelectedId(ps.length ? ps[0].id : "new");
  };

  const enter = () => {
    if (!ready) return;
    setNickname(nickname.trim());
    let pid = selectedId;
    if (isNew) {
      pid = saveProfile({
        ...draft,
        label: draft.label.trim() || (draft.provider === "custom" ? "自建服务器" : "Supabase"),
      });
      refreshProfiles(pid);
    }
    addJoinedConn(pid, room.trim());
    // 开房间窗后关掉启动器（要再开别的群，房间窗右上角「＋」可唤回）
    void openConnWindow(pid, room.trim()).then(() => {
      getCurrentWebviewWindow().close().catch(() => {});
    });
  };

  const forget = () => {
    if (!selected || selected.id === BAKED_PROFILE_ID) return;
    removeProfile(selected.id);
    setReveal(false);
    refreshProfiles();
  };

  const shareText = (p: ChatProfile) =>
    p.provider === "supabase"
      ? `Nobi 聊天连接：\nURL: ${p.supabaseUrl}\nkey: ${p.supabaseAnonKey}\n房间号: ${room || "（约定一个）"}\n（在 Nobi 聊天选「新建连接」填进去）`
      : `Nobi 聊天连接（自建服务器）：\n地址: ${p.serverUrl}\n房间号: ${room || "（约定一个）"}`;

  const setD = (patch: Partial<Omit<ChatProfile, "id">>) => setDraft((d) => ({ ...d, ...patch }));

  return (
    <div className="chat-setup">
      {conns.length > 0 && (
        <div className="chat-roomlist">
          <div className="chat-roomlist-title">我的聊天</div>
          {conns
            .filter((c) => getProfile(c.profileId))
            .map((c) => {
              const p = getProfile(c.profileId);
              return (
                <div
                  className="chat-roomitem"
                  key={`${c.profileId}-${c.room}`}
                  onClick={() => goRoom(c.profileId, c.room)}
                  title="点击进入"
                >
                  <span className="chat-roomitem-room">#{c.room}</span>
                  <span className="chat-roomitem-srv">{p?.label}</span>
                  <button
                    className="chat-roomitem-x"
                    title="退出此群"
                    onClick={(e) => {
                      e.stopPropagation();
                      leaveRoom(c.profileId, c.room);
                    }}
                  >
                    ✕
                  </button>
                </div>
              );
            })}
        </div>
      )}

      <h3>{conns.length > 0 ? "新建 / 加入群" : "发起 / 加入群"}</h3>

      <label className="chat-field">
        <span>名字</span>
        <input value={nickname} onChange={(e) => setNick(e.target.value)} placeholder="朋友看到的名字" autoFocus />
      </label>

      <label className="chat-field">
        <span>头像</span>
        <div className="chat-ava-pick">
          <button
            type="button"
            className={`chat-ava-opt ${!avatar ? "on" : ""}`}
            title="默认（彩色首字）"
            onClick={() => pickAvatar("")}
          >
            <MsgAvatar name={nickname || "?"} />
          </button>
          <button
            type="button"
            className="chat-ava-opt chat-ava-upload"
            title="上传图片"
            onClick={() => fileRef.current?.click()}
          >
            ＋
          </button>
          {isImageAvatar(avatar) && (
            <button type="button" className="chat-ava-opt on" title="当前自定义头像">
              <img className="chat-ava-mini" src={avatar} alt="" />
            </button>
          )}
          {AVATAR_CHOICES.map((a) => (
            <button
              key={a}
              type="button"
              className={`chat-ava-opt ${avatar === a ? "on" : ""}`}
              onClick={() => pickAvatar(a)}
            >
              {a}
            </button>
          ))}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={onPickFile}
        />
      </label>

      <label className="chat-field">
        <span>连接（后端服务器）</span>
        <select value={selectedId} onChange={(e) => { setSelectedId(e.target.value); setReveal(false); }}>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
          <option value="new">＋ 新建连接…</option>
        </select>
      </label>

      {/* 已保存的连接：分享 / 退出（内置后端可分享、不可删） */}
      {selected && (
        <div className="chat-conn-actions">
          <button type="button" onClick={() => setReveal((v) => !v)}>
            {reveal ? "隐藏凭据" : "显示 / 分享凭据"}
          </button>
          {selected.id !== BAKED_PROFILE_ID && (
            <button type="button" className="danger" onClick={forget}>退出（删除此连接）</button>
          )}
        </div>
      )}

      {selected && reveal && (
        <div className="chat-share">
          {selected.provider === "supabase" ? (
            <>
              <div className="chat-share-row">
                <span>URL</span>
                <code title={selected.supabaseUrl}>{selected.supabaseUrl}</code>
                <button type="button" onClick={() => copy(selected.supabaseUrl || "", " URL")}>复制</button>
              </div>
              <div className="chat-share-row">
                <span>key</span>
                <code title={selected.supabaseAnonKey}>{selected.supabaseAnonKey}</code>
                <button type="button" onClick={() => copy(selected.supabaseAnonKey || "", " key")}>复制</button>
              </div>
            </>
          ) : (
            <div className="chat-share-row">
              <span>地址</span>
              <code title={selected.serverUrl}>{selected.serverUrl}</code>
              <button type="button" onClick={() => copy(selected.serverUrl || "", " 地址")}>复制</button>
            </div>
          )}
          <button type="button" className="chat-share-all" onClick={() => copy(shareText(selected), "全部，发给朋友")}>
            复制全部（URL+key+房间号）发给朋友
          </button>
          {copied && <span className="chat-copied">{copied}</span>}
        </div>
      )}

      {/* 新建连接表单 */}
      {isNew && (
        <>
          <label className="chat-field">
            <span>连接名称</span>
            <input value={draft.label} onChange={(e) => setD({ label: e.target.value })} placeholder="给这个服务器起个名（如：我的Supabase）" />
          </label>
          <label className="chat-field">
            <span>后端类型</span>
            <select value={draft.provider} onChange={(e) => setD({ provider: e.target.value as ChatProvider })}>
              {(Object.keys(PROVIDER_LABELS) as ChatProvider[]).map((p) => (
                <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>
              ))}
            </select>
          </label>
          {draft.provider === "supabase" && (
            <>
              <label className="chat-field">
                <span>Supabase URL</span>
                <input value={draft.supabaseUrl} onChange={(e) => setD({ supabaseUrl: e.target.value })} placeholder="https://xxxx.supabase.co" />
              </label>
              <label className="chat-field">
                <span>anon key</span>
                <input value={draft.supabaseAnonKey} onChange={(e) => setD({ supabaseAnonKey: e.target.value })} placeholder="Settings → API 里的 anon / publishable" />
              </label>
            </>
          )}
          {draft.provider === "custom" && (
            <>
              <label className="chat-field">
                <span>服务器地址</span>
                <input value={draft.serverUrl} onChange={(e) => setD({ serverUrl: e.target.value })} placeholder="wss://你的域名/ws" />
              </label>
              <label className="chat-field">
                <span>Token（可选）</span>
                <input value={draft.serverToken} onChange={(e) => setD({ serverToken: e.target.value })} placeholder="可留空" />
              </label>
            </>
          )}

          <details className="chat-guide">
            <summary>📖 怎么搭后端？(免费 · 约 5 分钟)</summary>
            {draft.provider === "supabase" ? (
              <div className="chat-guide-body">
                <ol>
                  <li>浏览器打开 <code>supabase.com</code> 注册 → New Project（区域选 Singapore / Tokyo 离国内近）</li>
                  <li>
                    左侧 <b>SQL Editor</b> → 新建查询 → 粘贴 SQL → Run（建表 + 实时 + 存储 + 24h 自动清理）
                    <button type="button" className="chat-copy-sql" onClick={copySql}>
                      {sqlCopied ? "已复制 ✓" : "复制建表 SQL"}
                    </button>
                  </li>
                  <li>左侧 <b>Settings → API</b>，复制 <b>Project URL</b> 和 <b>anon / publishable key</b> 填到上面</li>
                  <li>把这两样 + 房间号发给朋友，他「新建连接」填一样的就进同一个群</li>
                </ol>
                <p className="chat-guide-note">消息走 HTTPS 加密、过你自己的 Supabase；24 小时自动焚毁，长期免费。</p>
              </div>
            ) : (
              <div className="chat-guide-body">
                <p>
                  填你自己的 <code>wss://</code> 地址。服务器需实现的协议见源码
                  <code> src/chat/customBackend.ts</code> 顶部注释（join / text / image 帧 + /upload /history）。
                </p>
              </div>
            )}
          </details>
        </>
      )}

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

      {keyRow("老板键（一键藏 / 显所有聊天窗）", "boss", bossKey)}
      {keyRow("透明度 · 调淡", "opDown", opDown)}
      {keyRow("透明度 · 调浓", "opUp", opUp)}
      {keyErr && <p className="chat-key-err">{keyErr}</p>}

      <p className="chat-hint">点「进入」开这个连接的独立窗口；不同连接（服务器）可并排开着。</p>
      <div className="chat-setup-actions">
        <button className="primary" disabled={!ready} onClick={enter}>进入</button>
      </div>
    </div>
  );
}
