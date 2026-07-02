// Nobi 聊天室机器人 · Supabase Edge Function（Deno）
// ---------------------------------------------------------------------------
// 真·无人值守的聊天室成员机器人：messages 表每插一行，数据库 Webhook（pg_net
// 触发器）就 POST 到这里；本函数看到消息里 @机器人 就调 LLM 回一句、再插一行。
// 机器人自己那行也会触发本函数，但按 client_id 自我识别跳过 → 无死循环。
//
// 不依附任何客户端、不用挂机：函数跑在 Supabase 云端，谁开没开 Nobi 都在。
// 它对所有房间生效——任何房间里 @机器人 都会回。
//
// 部署 + 配置见 docs/chat-bot-edge-function.md。
// ---------------------------------------------------------------------------

// 这两个是 Supabase 自动注入的，不用自己设
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// 这些走 `supabase secrets set` 配（见部署文档）
const LLM_BASE_URL = Deno.env.get("LLM_BASE_URL") ?? "";
const LLM_API_KEY = Deno.env.get("LLM_API_KEY") ?? "";
const LLM_MODEL = Deno.env.get("LLM_MODEL") ?? "";
const BOT_NAME = (Deno.env.get("BOT_NAME") ?? "机器人").trim();
const BOT_AVATAR = Deno.env.get("BOT_AVATAR") ?? "🤖";
const SYSTEM_PROMPT =
  Deno.env.get("SYSTEM_PROMPT") ??
  `你是 Nobi 聊天室里的助手机器人，名叫「${BOT_NAME}」。回答简洁、友好、用中文。`;
const CONTEXT_SIZE = Number(Deno.env.get("CONTEXT_SIZE") ?? "8"); // 带几条最近消息当上下文
const MAX_TOKENS = Number(Deno.env.get("MAX_TOKENS") ?? "500");
const WEBHOOK_SECRET = Deno.env.get("BOT_WEBHOOK_SECRET") ?? ""; // 设了就校验 x-bot-secret 头

const BOT_CLIENT_ID = "nobi-bot"; // 机器人固定标识：据此忽略自己发的消息

// 清空上下文：用户 @机器人 + 这些词 → 机器人立一条「清空标记」消息，之后建上下文只取标记之后
const RESET_MARK = "🧹 上下文已清空"; // 机器人发的标记消息以此开头；buildMessages 据此截断
const RESET_RE = /^\/?\s*(清空|清除|重置|忘记|reset|clear)\s*(上下文|记忆|对话|历史)?\s*$/i;

const REST = `${SUPABASE_URL}/rest/v1/messages`;
const DB_HEADERS = {
  "Content-Type": "application/json",
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
};

interface Row {
  room: string;
  sender: string;
  client_id: string;
  kind: string;
  body: string | null;
}

// 拼成 OpenAI 兼容 /chat/completions（和 Winky 的 chat_once 同款）
function chatUrl(base: string): string {
  const b = base.trim().replace(/\/+$/, "");
  return b.endsWith("/chat/completions") ? b : `${b}/chat/completions`;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripMention(body: string): string {
  // 不分大小写地去掉 @机器人名（@winky / @Winky / @WINKY 都算）
  return (body || "")
    .split(new RegExp(`@${escapeRe(BOT_NAME)}`, "gi")).join("")
    .replace(/\s+/g, " ")
    .trim();
}

async function buildMessages(room: string) {
  const url =
    `${REST}?room=eq.${encodeURIComponent(room)}` +
    `&order=created_at.desc&limit=${CONTEXT_SIZE}&select=sender,client_id,kind,body`;
  const r = await fetch(url, { headers: DB_HEADERS });
  const rows: Row[] = r.ok ? await r.json() : [];
  const history = rows.reverse(); // 升序

  // 找最后一次「清空标记」，只保留它之后的消息（标记之前的全不参考）
  let startIdx = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.client_id === BOT_CLIENT_ID && m.body && m.body.startsWith(RESET_MARK)) {
      startIdx = i + 1;
      break;
    }
  }
  const relevant = history.slice(startIdx);

  const msgs: { role: string; content: string }[] = [{ role: "system", content: SYSTEM_PROMPT }];
  for (const m of relevant) {
    if (m.kind !== "text" || !m.body) continue;
    if (m.body.charCodeAt(0) < 0x08) continue; // 游戏/系统帧不进上下文
    if (m.client_id === BOT_CLIENT_ID) {
      msgs.push({ role: "assistant", content: m.body });
    } else {
      const clean = stripMention(m.body);
      if (clean) msgs.push({ role: "user", content: `${m.sender}：${clean}` });
    }
  }
  return msgs;
}

async function askLLM(messages: { role: string; content: string }[]): Promise<string> {
  const resp = await fetch(chatUrl(LLM_BASE_URL), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${LLM_API_KEY.trim()}` },
    body: JSON.stringify({ model: LLM_MODEL, stream: false, max_tokens: MAX_TOKENS, messages }),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`API 返回 ${resp.status} ${t.slice(0, 200)}`);
  }
  const v = await resp.json();
  const text = (v?.choices?.[0]?.message?.content ?? "").trim();
  if (!text) throw new Error("空回复");
  return text;
}

const CURSOR = "▍"; // 流式期间追加在末尾的"打字光标"，收尾时去掉
const FLUSH_MS = 500; // 更新那一行的最小间隔（realtime eventsPerSecond=5，别刷太密）

// 流式调 LLM：每积累一点就回调 onText(累计全文)。返回最终全文。
// 端点不支持 SSE（返回的不是 text/event-stream）时退回整段 JSON 解析。
async function streamLLM(
  messages: { role: string; content: string }[],
  onText: (full: string) => void,
): Promise<string> {
  const resp = await fetch(chatUrl(LLM_BASE_URL), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${LLM_API_KEY.trim()}` },
    body: JSON.stringify({ model: LLM_MODEL, stream: true, max_tokens: MAX_TOKENS, messages }),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`API 返回 ${resp.status} ${t.slice(0, 200)}`);
  }
  const ct = resp.headers.get("content-type") ?? "";
  if (!resp.body || !ct.includes("text/event-stream")) {
    // 端点忽略了 stream:true，按整段返回
    const v = await resp.json().catch(() => null);
    const text = (v?.choices?.[0]?.message?.content ?? "").trim();
    if (!text) throw new Error("空回复");
    onText(text);
    return text;
  }

  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let full = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? ""; // 最后一段可能是半行，留到下次
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const data = t.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const j = JSON.parse(data);
        const delta = j?.choices?.[0]?.delta?.content ?? "";
        if (delta) {
          full += delta;
          onText(full);
        }
      } catch {
        /* 半个 JSON 块，忽略等下一片 */
      }
    }
  }
  full = full.trim();
  if (!full) throw new Error("空回复");
  return full;
}

async function sendReply(room: string, text: string): Promise<void> {
  await fetch(REST, {
    method: "POST",
    headers: { ...DB_HEADERS, Prefer: "return=minimal" },
    body: JSON.stringify({
      room,
      sender: BOT_NAME,
      client_id: BOT_CLIENT_ID,
      kind: "text",
      body: text,
      avatar: BOT_AVATAR,
    }),
  });
}

// 先占个空位：插一条机器人行并拿回它的 id，之后往这一行里灌流式内容。
// 拿不到 id（老 PostgREST/异常）就返回 null，调用方退回一次性回复。
async function insertPlaceholder(room: string): Promise<string | null> {
  const r = await fetch(REST, {
    method: "POST",
    headers: { ...DB_HEADERS, Prefer: "return=representation" },
    body: JSON.stringify({
      room,
      sender: BOT_NAME,
      client_id: BOT_CLIENT_ID,
      kind: "text",
      body: CURSOR,
      avatar: BOT_AVATAR,
    }),
  });
  if (!r.ok) return null;
  const rows = await r.json().catch(() => null);
  const id = rows?.[0]?.id;
  return id == null ? null : String(id);
}

async function updateRow(id: string, text: string): Promise<void> {
  await fetch(`${REST}?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { ...DB_HEADERS, Prefer: "return=minimal" },
    body: JSON.stringify({ body: text }),
  });
}

Deno.serve(async (req: Request) => {
  // 可选共享密钥：防别人拿到函数 URL 乱触发
  if (WEBHOOK_SECRET && req.headers.get("x-bot-secret") !== WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 401 });
  }

  let payload: { record?: Row };
  try {
    payload = await req.json();
  } catch {
    return new Response("bad json", { status: 400 });
  }
  const row = payload?.record;
  if (!row) return new Response("no record", { status: 200 });

  // —— 守卫（任一不满足就静默放过，回 200 免得 webhook 重试）——
  if (row.client_id === BOT_CLIENT_ID) return new Response("self", { status: 200 }); // 自己发的
  if (row.kind !== "text" || !row.body) return new Response("not text", { status: 200 });
  if (row.body.charCodeAt(0) < 0x08) return new Response("game frame", { status: 200 }); // 游戏/系统帧
  if (!row.body.toLowerCase().includes(`@${BOT_NAME}`.toLowerCase())) return new Response("not mentioned", { status: 200 }); // 不分大小写

  // 清空上下文指令：@机器人 清空/重置/clear → 不调模型，只立一条清空标记
  if (RESET_RE.test(stripMention(row.body))) {
    await sendReply(row.room, `${RESET_MARK}，之前的对话我就不参考啦，咱们重新开始～`).catch(() => {});
    return new Response("context cleared", { status: 200 });
  }

  if (!LLM_BASE_URL || !LLM_API_KEY || !LLM_MODEL) {
    await sendReply(row.room, "（机器人没配 LLM：去 Supabase 设 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL 密钥）").catch(() => {});
    return new Response("llm not configured", { status: 200 });
  }

  const messages = await buildMessages(row.room);

  // 先占位：让用户瞬间看到机器人在"打字"，把冷启动 + 生成的等待藏起来
  const id = await insertPlaceholder(row.room);
  if (id == null) {
    // 拿不到行 id：退回老的一次性回复
    try {
      const reply = await askLLM(messages);
      await sendReply(row.room, reply);
      return new Response("ok (non-stream)", { status: 200 });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await sendReply(row.room, `（我出错了：${msg}）`).catch(() => {});
      return new Response(`err: ${msg}`, { status: 200 });
    }
  }

  // 边收边灌：按 FLUSH_MS 节流更新那一行，末尾强制刷一次完整文本（保证最后落地的是全文）
  let lastSent = 0;
  let chain: Promise<void> = Promise.resolve();
  const flush = (text: string, force: boolean) => {
    const now = Date.now();
    if (!force && now - lastSent < FLUSH_MS) return;
    lastSent = now;
    chain = chain.then(() => updateRow(id, text)).catch(() => {});
  };

  try {
    const reply = await streamLLM(messages, (full) => flush(full + CURSOR, false));
    flush(reply, true); // 去掉光标 + 补齐可能被节流跳过的尾巴
    await chain;
    return new Response("ok", { status: 200 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    flush(`（我出错了：${msg}）`, true);
    await chain;
    return new Response(`err: ${msg}`, { status: 200 });
  }
});
