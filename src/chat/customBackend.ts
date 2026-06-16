// 自建服务器后端 —— 「留给你将来自己搭小服务器」的接口。
//
// 这是一个**完整可用的客户端实现**，照着下面的极简协议来连。你将来只要
// 搭一个满足该协议的小服务器（Node ws / Python websockets / Rust 都行），
// 在聊天设置里把 provider 切到 "custom"、填上 serverUrl，就能直接用，
// 无需改任何前端代码。若你想用别的协议，只改本文件即可，UI/其它后端不受影响。
//
// ┌─ 参考协议（客户端 ⇄ 你的服务器） ───────────────────────────────┐
// │ 传输：WebSocket（serverUrl，如 wss://chat.example.com/ws）         │
// │                                                                    │
// │ 1) 连上后客户端先发 join 帧：                                       │
// │    { "type":"join", "room":"...", "nickname":"...",                │
// │      "clientId":"...", "token":"<可选>" }                          │
// │                                                                    │
// │ 2) 客户端发文本：                                                  │
// │    { "type":"text", "room","sender","clientId","body" }            │
// │                                                                    │
// │ 3) 客户端发图片：先把图片 POST 到 <httpBase>/upload（见下），        │
// │    服务器返回 { "url":"https://..." }，再发：                        │
// │    { "type":"image", "room","sender","clientId",                   │
// │      "assetUrl","assetName","body":"<图注，可空>" }                 │
// │                                                                    │
// │ 4) 服务器把同房间的每条消息**广播**给所有客户端（含发送者自己），     │
// │    帧形如：                                                         │
// │    { "type":"message", "id","room","sender","clientId",            │
// │      "kind":"text|image","body","assetUrl","assetName",            │
// │      "createdAt": <epoch ms> }                                     │
// │                                                                    │
// │ 5)（可选）历史：HTTP GET <httpBase>/history?room=...&limit=...      │
// │    返回上面 message 对象的数组（升序）。没实现就返回 []。            │
// │                                                                    │
// │ httpBase = serverUrl 把 ws→http、wss→https，并去掉末尾路径段。       │
// │ 例：wss://x.com/ws → https://x.com                                 │
// └────────────────────────────────────────────────────────────────┘

import type {
  ChatBackend,
  ChatConfig,
  ChatMessage,
  ConnStatus,
  OutgoingAsset,
} from "./types";

interface WireMessage {
  type: "message";
  id: string;
  room: string;
  sender: string;
  clientId: string;
  kind: "text" | "image" | "video";
  avatar?: string;
  body?: string;
  assetUrl?: string;
  assetName?: string;
  createdAt: number;
}

/** wss://host/ws → https://host （供 /upload、/history 用） */
function httpBaseOf(serverUrl: string): string {
  try {
    const u = new URL(serverUrl);
    u.protocol = u.protocol === "wss:" ? "https:" : "http:";
    u.pathname = "";
    u.search = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return serverUrl;
  }
}

export class CustomServerBackend implements ChatBackend {
  readonly provider = "custom" as const;

  private cfg: ChatConfig;
  private ws: WebSocket | null = null;
  private httpBase: string;
  private msgCbs = new Set<(m: ChatMessage) => void>();
  private stCbs = new Set<(s: ConnStatus, detail?: string) => void>();
  private closedByUs = false;

  constructor(cfg: ChatConfig) {
    this.cfg = cfg;
    this.httpBase = httpBaseOf(cfg.serverUrl || "");
  }

  private emitStatus(s: ConnStatus, detail?: string) {
    this.stCbs.forEach((cb) => cb(s, detail));
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.emitStatus("connecting");
      this.closedByUs = false;
      let ws: WebSocket;
      try {
        ws = new WebSocket(this.cfg.serverUrl!);
      } catch (e) {
        this.emitStatus("error", String(e));
        reject(e);
        return;
      }
      this.ws = ws;

      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            type: "join",
            room: this.cfg.room,
            nickname: this.cfg.nickname,
            clientId: this.cfg.clientId,
            token: this.cfg.serverToken || undefined,
          }),
        );
        this.emitStatus("connected");
        resolve();
      };
      ws.onmessage = (ev) => {
        try {
          const frame = JSON.parse(ev.data as string) as WireMessage;
          if (frame.type !== "message") return;
          this.msgCbs.forEach((cb) =>
            cb({
              id: frame.id,
              room: frame.room,
              sender: frame.sender,
              clientId: frame.clientId,
              kind: frame.kind,
              avatar: frame.avatar,
              body: frame.body,
              assetUrl: frame.assetUrl,
              assetName: frame.assetName,
              createdAt: frame.createdAt || Date.now(),
            }),
          );
        } catch {
          /* 忽略坏帧 */
        }
      };
      ws.onerror = () => this.emitStatus("error", "WebSocket 错误");
      ws.onclose = () =>
        this.emitStatus(this.closedByUs ? "disconnected" : "error", "连接关闭");
    });
  }

  async disconnect(): Promise<void> {
    this.closedByUs = true;
    this.ws?.close();
    this.ws = null;
    this.emitStatus("disconnected");
  }

  async sendText(text: string): Promise<void> {
    if (this.ws?.readyState !== WebSocket.OPEN) throw new Error("未连接");
    this.ws.send(
      JSON.stringify({
        type: "text",
        room: this.cfg.room,
        sender: this.cfg.nickname,
        clientId: this.cfg.clientId,
        avatar: this.cfg.avatar || undefined,
        body: text,
      }),
    );
  }

  async sendAsset(asset: OutgoingAsset, caption?: string): Promise<void> {
    if (this.ws?.readyState !== WebSocket.OPEN) throw new Error("未连接");
    // 1. 取字节（拖拽给 blob，否则 fetch url）并 POST 到服务器上传端点
    let blob = asset.blob;
    if (!blob) {
      if (!asset.url) throw new Error("缺少图片来源");
      const resp = await fetch(asset.url);
      if (!resp.ok) throw new Error(`读取图片失败：${resp.status}`);
      blob = await resp.blob();
    }
    const form = new FormData();
    form.append("file", blob, asset.name);
    form.append("room", this.cfg.room);
    const up = await fetch(`${this.httpBase}/upload`, {
      method: "POST",
      body: form,
      headers: this.cfg.serverToken
        ? { Authorization: `Bearer ${this.cfg.serverToken}` }
        : undefined,
    });
    if (!up.ok) throw new Error(`上传失败：${up.status}`);
    const { url } = (await up.json()) as { url: string };

    // 2. 广播 image/video 帧
    const kind = asset.kind ?? (blob.type.startsWith("video/") ? "video" : "image");
    this.ws.send(
      JSON.stringify({
        type: kind,
        room: this.cfg.room,
        sender: this.cfg.nickname,
        clientId: this.cfg.clientId,
        avatar: this.cfg.avatar || undefined,
        assetUrl: url,
        assetName: asset.name,
        body: caption || undefined,
      }),
    );
  }

  updateIdentity(nickname: string, avatar?: string): void {
    this.cfg = { ...this.cfg, nickname, avatar };
    // 在线则补发一帧 join，让服务器更新该连接的昵称（presence/在线名单用）
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          type: "join",
          room: this.cfg.room,
          nickname,
          clientId: this.cfg.clientId,
          token: this.cfg.serverToken || undefined,
        }),
      );
    }
  }

  async history(limit: number): Promise<ChatMessage[]> {
    try {
      const u = `${this.httpBase}/history?room=${encodeURIComponent(
        this.cfg.room,
      )}&limit=${limit}`;
      const resp = await fetch(u, {
        headers: this.cfg.serverToken
          ? { Authorization: `Bearer ${this.cfg.serverToken}` }
          : undefined,
      });
      if (!resp.ok) return [];
      const arr = (await resp.json()) as WireMessage[];
      return arr.map((f) => ({
        id: f.id,
        room: f.room,
        sender: f.sender,
        clientId: f.clientId,
        kind: f.kind,
        body: f.body,
        assetUrl: f.assetUrl,
        assetName: f.assetName,
        createdAt: f.createdAt || Date.now(),
      }));
    } catch {
      return []; // 服务器没实现历史就当空
    }
  }

  onMessage(cb: (m: ChatMessage) => void): () => void {
    this.msgCbs.add(cb);
    return () => this.msgCbs.delete(cb);
  }

  onStatus(cb: (s: ConnStatus, detail?: string) => void): () => void {
    this.stCbs.add(cb);
    return () => this.stCbs.delete(cb);
  }
}
