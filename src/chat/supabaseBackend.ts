// Supabase 后端实现：Realtime 订阅收消息、insert 发消息、Storage 存图。
// 对应的建表/桶/权限脚本见 docs/chat-supabase-setup.sql。

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type {
  ChatBackend,
  ChatConfig,
  ChatMessage,
  ConnStatus,
  OutgoingAsset,
} from "./types";
import { getBubbleColor } from "./config";

const TABLE = "messages";
const BUCKET = "chat-assets";

/** 数据库行 → 统一消息形状 */
interface Row {
  id: number | string;
  room: string;
  sender: string;
  client_id: string;
  kind: "text" | "image" | "video";
  body: string | null;
  asset_url: string | null;
  asset_name: string | null;
  avatar?: string | null;
  bubble?: string | null;
  created_at: string;
}

/** 从可 fetch 的 URL 取字节 */
async function fetchBlob(url?: string): Promise<Blob> {
  if (!url) throw new Error("缺少图片来源");
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`读取图片失败：${resp.status}`);
  return resp.blob();
}

function rowToMessage(r: Row): ChatMessage {
  return {
    id: String(r.id),
    room: r.room,
    sender: r.sender,
    clientId: r.client_id,
    kind: r.kind,
    avatar: r.avatar ?? undefined,
    bubble: r.bubble ?? undefined,
    body: r.body ?? undefined,
    assetUrl: r.asset_url ?? undefined,
    assetName: r.asset_name ?? undefined,
    createdAt: r.created_at ? Date.parse(r.created_at) : Date.now(),
  };
}

export class SupabaseBackend implements ChatBackend {
  readonly provider = "supabase" as const;

  private client: SupabaseClient;
  private cfg: ChatConfig;
  private channel: ReturnType<SupabaseClient["channel"]> | null = null;
  private msgCbs = new Set<(m: ChatMessage) => void>();
  private stCbs = new Set<(s: ConnStatus, detail?: string) => void>();

  constructor(cfg: ChatConfig) {
    this.cfg = cfg;
    this.client = createClient(cfg.supabaseUrl!, cfg.supabaseAnonKey!, {
      realtime: { params: { eventsPerSecond: 5 } },
    });
  }

  private emitStatus(s: ConnStatus, detail?: string) {
    this.stCbs.forEach((cb) => cb(s, detail));
  }

  async connect(): Promise<void> {
    this.emitStatus("connecting");
    const room = this.cfg.room;
    this.channel = this.client
      .channel(`room:${room}`, { config: { broadcast: { self: true } } }) // self:true→自己发的游戏帧也回显（房主据此处理自己的动作）
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: TABLE,
          filter: `room=eq.${room}`,
        },
        (payload) => {
          const msg = rowToMessage(payload.new as Row);
          this.msgCbs.forEach((cb) => cb(msg));
        },
      )
      .on(
        // 机器人流式回复：同一行被反复 UPDATE 加长正文，前端按 id 覆盖已有气泡
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: TABLE,
          filter: `room=eq.${room}`,
        },
        (payload) => {
          const msg = rowToMessage(payload.new as Row);
          this.msgCbs.forEach((cb) => cb(msg));
        },
      )
      .on("broadcast", { event: "g" }, ({ payload }) => {
        // 游戏瞬时帧（不落库）：合成一条最小 ChatMessage 交给 onMessage，路由层按 TAG 分流给对应游戏
        const p = payload as { id?: string; sender?: string; client_id?: string; body?: string };
        if (typeof p?.body !== "string") return;
        const msg: ChatMessage = {
          id: p.id || `g-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          room,
          sender: p.sender || "",
          clientId: p.client_id || "",
          kind: "text",
          body: p.body,
          createdAt: Date.now(),
        };
        this.msgCbs.forEach((cb) => cb(msg));
      })
      .subscribe((status) => {
        if (status === "SUBSCRIBED") this.emitStatus("connected");
        else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT")
          this.emitStatus("error", status);
        else if (status === "CLOSED") this.emitStatus("disconnected");
      });
  }

  async disconnect(): Promise<void> {
    if (this.channel) {
      await this.client.removeChannel(this.channel);
      this.channel = null;
    }
    this.emitStatus("disconnected");
  }

  /** 插一行；若老表还没 bubble 列（未跑迁移），自动去掉 bubble 重发——颜色广播优雅降级，不影响发消息。 */
  private async insertRow(row: Record<string, unknown>): Promise<void> {
    let { error } = await this.client.from(TABLE).insert(row);
    if (error && "bubble" in row && /bubble/i.test(error.message)) {
      const { bubble: _omit, ...rest } = row;
      ({ error } = await this.client.from(TABLE).insert(rest));
    }
    if (error) throw new Error(error.message);
  }

  /** 游戏同步帧：走 realtime broadcast，**不写消息表**（不污染聊天历史）。fire-and-forget。 */
  sendGame(text: string): void {
    void this.channel?.send({
      type: "broadcast",
      event: "g",
      payload: {
        id: `g-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        sender: this.cfg.nickname,
        client_id: this.cfg.clientId,
        body: text,
      },
    });
  }

  async sendText(text: string): Promise<void> {
    const bubble = getBubbleColor(); // 本机偏好，发送时现读，随消息广播
    await this.insertRow({
      room: this.cfg.room,
      sender: this.cfg.nickname,
      client_id: this.cfg.clientId,
      kind: "text",
      body: text,
      ...(this.cfg.avatar ? { avatar: this.cfg.avatar } : {}),
      ...(bubble ? { bubble } : {}),
    });
  }

  async sendAsset(asset: OutgoingAsset, caption?: string): Promise<void> {
    // 1. 取字节（拖拽来的直接给 blob，右键发素材给 url）
    const blob = asset.blob ?? (await fetchBlob(asset.url));
    const kind = asset.kind ?? (blob.type.startsWith("video/") ? "video" : "image");

    // 2. 上传到 Storage（路径带房间号 + 时间戳避免重名）
    const safeName = asset.name.replace(/[^\w.\-]/g, "_");
    const objectPath = `${this.cfg.room}/${Date.now()}-${safeName}`;
    const up = await this.client.storage
      .from(BUCKET)
      .upload(objectPath, blob, {
        contentType: blob.type || "application/octet-stream",
        upsert: false,
      });
    if (up.error) throw new Error(`上传失败：${up.error.message}`);

    // 3. 取公开 URL
    const { data } = this.client.storage.from(BUCKET).getPublicUrl(objectPath);

    // 4. 广播 image 消息
    const bubble = getBubbleColor();
    await this.insertRow({
      room: this.cfg.room,
      sender: this.cfg.nickname,
      client_id: this.cfg.clientId,
      kind,
      body: caption || null,
      asset_url: data.publicUrl,
      asset_name: asset.name,
      ...(this.cfg.avatar ? { avatar: this.cfg.avatar } : {}),
      ...(bubble ? { bubble } : {}),
    });
  }

  updateIdentity(nickname: string, avatar?: string): void {
    this.cfg = { ...this.cfg, nickname, avatar };
  }

  async history(limit: number): Promise<ChatMessage[]> {
    const { data, error } = await this.client
      .from(TABLE)
      .select("*")
      .eq("room", this.cfg.room)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw new Error(error.message);
    return (data as Row[]).map(rowToMessage).reverse(); // 转回升序
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
