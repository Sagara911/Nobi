// 聊天子系统 · 后端抽象层
// 设计目标：聊天窗口（ChatWindow.tsx）只依赖 ChatBackend 这个接口，
// 永远不直接碰 Supabase。将来你自己搭小服务器，只要再写一个实现
// （见 customBackend.ts）+ 在 index.ts 的工厂里加一个分支即可，UI 零改动。

export type ChatProvider = "supabase" | "custom";

/** 一条聊天消息（各后端都把自己的原始数据映射成这个统一形状） */
export interface ChatMessage {
  /** 后端消息 id，统一用字符串以便跨实现 */
  id: string;
  room: string;
  /** 发送者昵称 */
  sender: string;
  /** 发送端的稳定标识（区分"是不是我自己发的"，昵称可能重名） */
  clientId: string;
  kind: "text" | "image";
  /** 文本内容；图片消息里作为图注（可空） */
  body?: string;
  /** 图片消息的可访问 URL */
  assetUrl?: string;
  assetName?: string;
  /** epoch 毫秒 */
  createdAt: number;
}

export type ConnStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "error"
  | "disconnected";

/** 待发送的素材：来自右键"发给朋友"(给 url)或桌面拖拽(给 blob) */
export interface OutgoingAsset {
  name: string;
  /** 直接给字节（桌面拖进来的 File）——优先用 */
  blob?: Blob;
  /** 或给一个可 fetch 的 URL（右键发素材走 convertFileSrc）——blob 缺省时用 */
  url?: string;
}

/** 聊天配置（存 localStorage，见 config.ts） */
export interface ChatConfig {
  provider: ChatProvider;
  nickname: string;
  /** 房间号：你和朋友填同一个就能聊 */
  room: string;
  /** 本机稳定标识，自动生成，不需用户填 */
  clientId: string;

  // —— Supabase 后端 ——
  supabaseUrl?: string;
  supabaseAnonKey?: string;

  // —— 自建服务器后端（将来用） ——
  /** WebSocket 地址，如 wss://chat.example.com/ws */
  serverUrl?: string;
  /** 可选鉴权 token */
  serverToken?: string;
}

/**
 * 聊天后端契约。所有实现都必须满足它。
 *
 * 典型生命周期：
 *   const backend = createBackend(config);
 *   const offMsg = backend.onMessage(m => …);
 *   const offSt  = backend.onStatus(s => …);
 *   await backend.connect();
 *   const past = await backend.history(50);   // 拉历史（可选能力，无则返回 []）
 *   await backend.sendText("hi");
 *   …
 *   offMsg(); offSt(); await backend.disconnect();
 */
export interface ChatBackend {
  readonly provider: ChatProvider;

  /** 建立连接 / 订阅。失败应通过 onStatus 抛出 "error"。 */
  connect(): Promise<void>;
  /** 断开并清理资源。 */
  disconnect(): Promise<void>;

  /** 发一条文本。 */
  sendText(text: string): Promise<void>;
  /** 发一张图：实现负责把图上传到自己的存储，再广播一条 image 消息。 */
  sendAsset(asset: OutgoingAsset, caption?: string): Promise<void>;

  /** 拉最近 limit 条历史，按时间升序。不支持则返回 []。 */
  history(limit: number): Promise<ChatMessage[]>;

  /** 订阅新消息，返回取消订阅函数。 */
  onMessage(cb: (m: ChatMessage) => void): () => void;
  /** 订阅连接状态变化，返回取消订阅函数。 */
  onStatus(cb: (s: ConnStatus, detail?: string) => void): () => void;
}
