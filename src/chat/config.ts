// 聊天配置 + 跨窗口"待发素材"队列（均存 localStorage）。
// localStorage 在 Tauri 同源的多个 webview 窗口间共享，且写入会触发其它
// 窗口的 `storage` 事件——这正是主窗口把素材递给聊天窗口的零权限通道。

import type { ChatConfig, ChatProvider } from "./types";

const CONFIG_KEY = "nobi.chat.config";
const CLIENT_ID_KEY = "nobi.chat.clientId";

// —— 内置后端凭据（来自 .env.local，编译时注入）——
// 有内置凭据时，用户无需填 URL/key，只要「名字 + 房间号」即可进群（微信面对面建群式）。
export const BAKED_SUPABASE_URL = (import.meta.env.VITE_CHAT_SUPABASE_URL || "").trim();
export const BAKED_SUPABASE_ANON_KEY = (import.meta.env.VITE_CHAT_SUPABASE_ANON_KEY || "").trim();
export const CREDENTIALS_BAKED = !!(BAKED_SUPABASE_URL && BAKED_SUPABASE_ANON_KEY);

/** 生成一个 6 位数字房间号（建群时用） */
export function randomRoom(): string {
  // 100000–999999，避免前导 0
  let n = 0;
  const buf = globalThis.crypto?.getRandomValues?.(new Uint32Array(1));
  n = buf ? buf[0] : Math.floor(Math.random() * 1e9);
  return String(100000 + (n % 900000));
}
/** 主窗口"发给朋友"会往这里塞素材，聊天窗口排空它 */
export const CHAT_OUTBOX_KEY = "nobi.chat.outbox";
/** 聊天窗口 WebviewWindow 的 label */
export const CHAT_WINDOW_LABEL = "chat";

/** 取（或首次生成并持久化）本机稳定标识 */
export function getClientId(): string {
  let id = "";
  try {
    id = localStorage.getItem(CLIENT_ID_KEY) || "";
  } catch {
    /* ignore */
  }
  if (!id) {
    id =
      (globalThis.crypto?.randomUUID?.() as string | undefined) ||
      `c_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    try {
      localStorage.setItem(CLIENT_ID_KEY, id);
    } catch {
      /* ignore */
    }
  }
  return id;
}

const DEFAULT_CONFIG: ChatConfig = {
  provider: "supabase",
  nickname: "",
  room: "",
  clientId: "",
};

/** 有内置凭据时强制套用，确保用户/老配置都连到内置后端 */
function withBaked(cfg: ChatConfig): ChatConfig {
  if (!CREDENTIALS_BAKED) return cfg;
  return {
    ...cfg,
    provider: "supabase",
    supabaseUrl: BAKED_SUPABASE_URL,
    supabaseAnonKey: BAKED_SUPABASE_ANON_KEY,
  };
}

export function loadConfig(): ChatConfig {
  let raw = "";
  try {
    raw = localStorage.getItem(CONFIG_KEY) || "";
  } catch {
    /* ignore */
  }
  let parsed: Partial<ChatConfig> = {};
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      /* ignore，坏数据当空配置 */
    }
  }
  return withBaked({ ...DEFAULT_CONFIG, ...parsed, clientId: getClientId() });
}

export function saveConfig(cfg: ChatConfig): void {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
  } catch {
    /* ignore */
  }
}

/** 配置是否齐全到可以连接 */
export function isConfigReady(cfg: ChatConfig): boolean {
  if (!cfg.nickname.trim() || !cfg.room.trim()) return false;
  // 有内置凭据：只要名字 + 房间号即可
  if (CREDENTIALS_BAKED && cfg.provider === "supabase") return true;
  if (cfg.provider === "supabase") {
    return !!(cfg.supabaseUrl?.trim() && cfg.supabaseAnonKey?.trim());
  }
  if (cfg.provider === "custom") {
    return !!cfg.serverUrl?.trim();
  }
  return false;
}

export const PROVIDER_LABELS: Record<ChatProvider, string> = {
  supabase: "Supabase（云后端 · 免费）",
  custom: "自建服务器（你自己的小服务器）",
};

// ===== 活跃房间（右键"发给朋友"发往哪个群）=====

export const CHAT_ACTIVE_ROOM_KEY = "nobi.chat.activeRoom";

/** 房间窗口获得焦点/打开时调用，标记自己为"当前活跃群" */
export function setActiveRoom(room: string): void {
  try {
    localStorage.setItem(CHAT_ACTIVE_ROOM_KEY, room);
  } catch {
    /* ignore */
  }
}

export function getActiveRoom(): string {
  try {
    return localStorage.getItem(CHAT_ACTIVE_ROOM_KEY) || "";
  } catch {
    return "";
  }
}

// ===== 跨窗口"待发素材"队列（按房间号分发）=====

export interface OutboxItem {
  /** 本地文件路径（聊天窗口用 convertFileSrc 转成可 fetch 的 URL） */
  path: string;
  name: string;
  /** 目标房间号——只有该房间的窗口会取走它 */
  room: string;
  ts: number;
}

function readOutbox(): OutboxItem[] {
  try {
    const raw = localStorage.getItem(CHAT_OUTBOX_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writeOutbox(items: OutboxItem[]): void {
  try {
    localStorage.setItem(CHAT_OUTBOX_KEY, JSON.stringify(items));
  } catch {
    /* ignore */
  }
}

/** 主窗口调用：把一张素材排进待发队列，指定目标房间 */
export function pushOutbox(item: { path: string; name: string; room: string }): void {
  const items = readOutbox();
  items.push({ path: item.path, name: item.name, room: item.room, ts: Date.now() });
  writeOutbox(items);
}

/** 房间窗口调用：取走属于本房间的待发素材，其它房间的留在队列里 */
export function drainOutbox(room: string): OutboxItem[] {
  const all = readOutbox();
  const mine = all.filter((it) => it.room === room);
  if (mine.length) writeOutbox(all.filter((it) => it.room !== room));
  return mine;
}
