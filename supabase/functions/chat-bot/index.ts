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
  const history = rows.reverse();
  const msgs: { role: string; content: string }[] = [{ role: "system", content: SYSTEM_PROMPT }];
  for (const m of history) {
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

  if (!LLM_BASE_URL || !LLM_API_KEY || !LLM_MODEL) {
    await sendReply(row.room, "（机器人没配 LLM：去 Supabase 设 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL 密钥）").catch(() => {});
    return new Response("llm not configured", { status: 200 });
  }

  try {
    const messages = await buildMessages(row.room);
    const reply = await askLLM(messages);
    await sendReply(row.room, reply);
    return new Response("ok", { status: 200 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await sendReply(row.room, `（我出错了：${msg}）`).catch(() => {});
    return new Response(`err: ${msg}`, { status: 200 });
  }
});
