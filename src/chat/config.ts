// 聊天配置（全存 localStorage，Tauri 同源多窗口共享）：
//   · 连接档案 ChatProfile —— 多套后端（我的 Supabase / 同事的服务器…），每个聊天窗绑一套
//   · 全局身份 —— 昵称 + 本机 clientId
//   · 已加入连接 —— (档案, 房间) 对，主窗后台订阅它们做未读提醒
//   · 活跃连接 + 待发素材队列 —— 右键"发给朋友"发往当前活跃的那个连接
// 含从旧版「单一全局配置 + 房间字符串列表」的平滑迁移。

import type { ChatConfig, ChatProvider } from "./types";

const NICK_KEY = "nobi.chat.nickname";
const CLIENT_ID_KEY = "nobi.chat.clientId";
const PROFILES_KEY = "nobi.chat.profiles";
const CONNS_KEY = "nobi.chat.conns";
const ACTIVE_CONN_KEY = "nobi.chat.activeConn";
const LEGACY_CONFIG_KEY = "nobi.chat.config"; // 旧版单一配置，迁移用
const LEGACY_ROOMS_KEY = "nobi.chat.rooms"; // 旧版 string[]，迁移用

export const CHAT_OUTBOX_KEY = "nobi.chat.outbox";
export const CHAT_WINDOW_LABEL = "chat";

// —— 内置后端凭据（来自 .env.local，编译时注入）——
export const BAKED_SUPABASE_URL = (import.meta.env.VITE_CHAT_SUPABASE_URL || "").trim();
export const BAKED_SUPABASE_ANON_KEY = (import.meta.env.VITE_CHAT_SUPABASE_ANON_KEY || "").trim();
export const CREDENTIALS_BAKED = !!(BAKED_SUPABASE_URL && BAKED_SUPABASE_ANON_KEY);
export const BAKED_PROFILE_ID = "baked";

export const PROVIDER_LABELS: Record<ChatProvider, string> = {
  supabase: "Supabase（云后端 · 免费）",
  custom: "自建服务器（你自己的小服务器）",
};

/** 生成一个 6 位数字房间号（建群时用） */
export function randomRoom(): string {
  const buf = globalThis.crypto?.getRandomValues?.(new Uint32Array(1));
  const n = buf ? buf[0] : Math.floor(Math.random() * 1e9);
  return String(100000 + (n % 900000));
}

function genId(): string {
  return (
    (globalThis.crypto?.randomUUID?.() as string | undefined) ||
    `p_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
  );
}

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

// ===== 全局身份：昵称 =====

export function getNickname(): string {
  try {
    const n = localStorage.getItem(NICK_KEY);
    if (n) return n;
    // 迁移：旧单一配置里的 nickname
    const raw = localStorage.getItem(LEGACY_CONFIG_KEY);
    if (raw) {
      const o = JSON.parse(raw);
      if (o?.nickname) return String(o.nickname);
    }
  } catch {
    /* ignore */
  }
  return "";
}

export function setNickname(name: string): void {
  try {
    localStorage.setItem(NICK_KEY, name);
  } catch {
    /* ignore */
  }
}

// 头像（emoji，可空=用默认彩色首字头像）。随消息带给别人看。
const AVATAR_KEY = "nobi.chat.avatar";
export const AVATAR_CHOICES = [
  "🐱","🐶","🦊","🐼","🐯","🦁","🐸","🐵","🐰","🐻",
  "🐲","🦄","🐧","🐢","🐳","🦖","🐙","🦉","🐝","🦋",
  "🌵","🍑","🍺","🍕","⚽","🎮","🎸","🚀","👻","🤖",
  "😎","🥷","👑","🧋","🌙","🔥","💎","🍀",
];

export function getAvatar(): string {
  try {
    return localStorage.getItem(AVATAR_KEY) || "";
  } catch {
    return "";
  }
}

export function setAvatar(a: string): void {
  try {
    localStorage.setItem(AVATAR_KEY, a);
  } catch {
    /* ignore */
  }
}

// ===== 连接档案（多套后端）=====

export interface ChatProfile {
  id: string;
  label: string;
  provider: ChatProvider;
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  serverUrl?: string;
  serverToken?: string;
}

function readUserProfiles(): ChatProfile[] {
  try {
    const raw = localStorage.getItem(PROFILES_KEY);
    if (raw) {
      const a = JSON.parse(raw);
      if (Array.isArray(a)) return a;
    }
  } catch {
    /* ignore */
  }
  // 迁移：旧单一配置（含凭据）→ 一个档案
  try {
    const raw = localStorage.getItem(LEGACY_CONFIG_KEY);
    if (raw) {
      const o = JSON.parse(raw);
      const hasCreds = (o?.supabaseUrl && o?.supabaseAnonKey) || o?.serverUrl;
      if (hasCreds) {
        const p: ChatProfile = {
          id: genId(),
          label: o.provider === "custom" ? "自建服务器" : "我的 Supabase",
          provider: o.provider || "supabase",
          supabaseUrl: o.supabaseUrl,
          supabaseAnonKey: o.supabaseAnonKey,
          serverUrl: o.serverUrl,
          serverToken: o.serverToken,
        };
        localStorage.setItem(PROFILES_KEY, JSON.stringify([p]));
        return [p];
      }
    }
  } catch {
    /* ignore */
  }
  return [];
}

function writeUserProfiles(list: ChatProfile[]): void {
  try {
    localStorage.setItem(PROFILES_KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

/** 内置档案（如有 .env.local），不可编辑/删除，永远排在最前 */
export function bakedProfile(): ChatProfile | null {
  if (!CREDENTIALS_BAKED) return null;
  return {
    id: BAKED_PROFILE_ID,
    label: "内置后端",
    provider: "supabase",
    supabaseUrl: BAKED_SUPABASE_URL,
    supabaseAnonKey: BAKED_SUPABASE_ANON_KEY,
  };
}

/** 全部档案（内置在前 + 用户的） */
export function getProfiles(): ChatProfile[] {
  const baked = bakedProfile();
  const users = readUserProfiles();
  return baked ? [baked, ...users] : users;
}

export function getProfile(id: string): ChatProfile | undefined {
  return getProfiles().find((p) => p.id === id);
}

/** 新增/更新一个用户档案（内置档案不可改）。返回 id。 */
export function saveProfile(p: Omit<ChatProfile, "id"> & { id?: string }): string {
  const list = readUserProfiles();
  let id = p.id;
  if (id && id !== BAKED_PROFILE_ID) {
    const i = list.findIndex((x) => x.id === id);
    if (i >= 0) list[i] = { ...list[i], ...p, id };
    else list.push({ ...(p as ChatProfile), id });
  } else {
    id = genId();
    list.push({ ...(p as ChatProfile), id });
  }
  writeUserProfiles(list);
  return id;
}

/** 删除（退出）一个用户档案 */
export function removeProfile(id: string): void {
  if (id === BAKED_PROFILE_ID) return;
  writeUserProfiles(readUserProfiles().filter((x) => x.id !== id));
}

export function isProfileReady(p: ChatProfile): boolean {
  if (p.provider === "supabase") return !!(p.supabaseUrl?.trim() && p.supabaseAnonKey?.trim());
  if (p.provider === "custom") return !!p.serverUrl?.trim();
  return false;
}

/** 档案 + 房间 → 传给 createBackend 的完整 ChatConfig */
export function resolveConfig(p: ChatProfile, room: string): ChatConfig {
  return {
    provider: p.provider,
    nickname: getNickname(),
    clientId: getClientId(),
    avatar: getAvatar(),
    room,
    supabaseUrl: p.supabaseUrl,
    supabaseAnonKey: p.supabaseAnonKey,
    serverUrl: p.serverUrl,
    serverToken: p.serverToken,
  };
}

// ===== 已加入连接（主窗后台订阅这些做未读提醒）=====

export interface JoinedConn {
  profileId: string;
  room: string;
}

export function getJoinedConns(): JoinedConn[] {
  try {
    const raw = localStorage.getItem(CONNS_KEY);
    if (raw) {
      const a = JSON.parse(raw);
      if (Array.isArray(a)) return a;
    }
  } catch {
    /* ignore */
  }
  // 迁移：旧 rooms(string[]) → 配到第一个可用档案
  try {
    const raw = localStorage.getItem(LEGACY_ROOMS_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length) {
        const pid = getProfiles()[0]?.id;
        if (pid) {
          const conns = arr
            .filter((r) => typeof r === "string")
            .map((room: string) => ({ profileId: pid, room }));
          localStorage.setItem(CONNS_KEY, JSON.stringify(conns));
          return conns;
        }
      }
    }
  } catch {
    /* ignore */
  }
  return [];
}

export function addJoinedConn(profileId: string, room: string): void {
  const r = room.trim();
  if (!r || !profileId) return;
  const list = getJoinedConns();
  if (list.some((c) => c.profileId === profileId && c.room === r)) return;
  list.push({ profileId, room: r });
  try {
    localStorage.setItem(CONNS_KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

export function removeJoinedConn(profileId: string, room: string): void {
  const list = getJoinedConns().filter(
    (c) => !(c.profileId === profileId && c.room === room),
  );
  try {
    localStorage.setItem(CONNS_KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

// ===== 活跃连接（右键"发给朋友"发往这里）=====

export function setActiveConn(profileId: string, room: string): void {
  try {
    localStorage.setItem(ACTIVE_CONN_KEY, JSON.stringify({ profileId, room }));
  } catch {
    /* ignore */
  }
}

export function clearActiveConn(): void {
  try {
    localStorage.removeItem(ACTIVE_CONN_KEY);
  } catch {
    /* ignore */
  }
}

export function getActiveConn(): JoinedConn | null {
  try {
    const raw = localStorage.getItem(ACTIVE_CONN_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return null;
}

// ===== 跨窗口"待发素材"队列（按 档案+房间 分发）=====

export interface OutboxItem {
  path: string;
  name: string;
  profileId: string;
  room: string;
  kind?: "image" | "video";
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

/** 主窗口调用：把一张素材排进待发队列，指定目标连接（档案+房间） */
export function pushOutbox(item: {
  path: string;
  name: string;
  profileId: string;
  room: string;
  kind?: "image" | "video";
}): void {
  const items = readOutbox();
  items.push({ ...item, ts: Date.now() });
  writeOutbox(items);
}

/** 房间窗口调用：取走属于本连接的待发素材，其它的留在队列里 */
export function drainOutbox(profileId: string, room: string): OutboxItem[] {
  const all = readOutbox();
  const mine = all.filter((it) => it.profileId === profileId && it.room === room);
  if (mine.length)
    writeOutbox(all.filter((it) => !(it.profileId === profileId && it.room === room)));
  return mine;
}

// ===== 表情包收藏（本地图片，点一下直接发；存路径，跨 24h 清理不丢）=====

const STICKERS_KEY = "nobi.chat.stickers";

export interface Sticker {
  path: string;
  name: string;
}

export function getStickers(): Sticker[] {
  try {
    const raw = localStorage.getItem(STICKERS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function addSticker(s: Sticker): void {
  if (!s.path) return;
  const list = getStickers();
  if (list.some((x) => x.path === s.path)) return;
  list.unshift(s); // 新收藏排前面
  try {
    localStorage.setItem(STICKERS_KEY, JSON.stringify(list.slice(0, 60)));
  } catch {
    /* ignore */
  }
}

export function removeSticker(path: string): void {
  try {
    localStorage.setItem(
      STICKERS_KEY,
      JSON.stringify(getStickers().filter((x) => x.path !== path)),
    );
  } catch {
    /* ignore */
  }
}
