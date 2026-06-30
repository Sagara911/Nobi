// Nobi 聊天室常驻机器人（独立进程，不依附任何客户端）
// ---------------------------------------------------------------------------
// 它就是「房间里的第 N 个成员」：用同一套 Supabase 凭据订阅房间，
// 谁在消息里 @机器人 它就调 LLM 回复，再 insert 一行——所有人的聊天窗
// 都会像收到普通人发言一样收到它。和 Winky（依附个人客户端）无关。
//
// 跑法（在项目根目录）：
//   node scripts/chat-bot/bot.mjs            # 用 config.json 里的 rooms
//   node scripts/chat-bot/bot.mjs 1234 5678  # 命令行指定房间，覆盖配置
//
// Supabase 凭据：自动读项目根的 .env.local（VITE_CHAT_SUPABASE_URL / ANON_KEY），
//   不用重复填。LLM（baseUrl/apiKey/model）+ 房间 + 人设放 config.json。
// ---------------------------------------------------------------------------

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..", "..");

const TABLE = "messages";
const BOT_CLIENT_ID = "nobi-bot"; // 固定标识：机器人据此忽略自己发的消息，各端看到的也是同一个"人"

// —— 读 .env.local，取 Supabase URL / anon key ——
function loadEnvLocal() {
  const out = {};
  try {
    const txt = readFileSync(resolve(PROJECT_ROOT, ".env.local"), "utf8");
    for (const line of txt.split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s.startsWith("#")) continue;
      const i = s.indexOf("=");
      if (i < 0) continue;
      out[s.slice(0, i).trim()] = s.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    /* 没有就靠 config / 环境变量兜底 */
  }
  return out;
}

// —— 读 config.json ——
function loadConfig() {
  try {
    return JSON.parse(readFileSync(resolve(__dirname, "config.json"), "utf8"));
  } catch (e) {
    console.error("✘ 读不到 scripts/chat-bot/config.json —— 先把 config.example.json 复制成 config.json 并填好。");
    console.error("  原因：", e.message);
    process.exit(1);
  }
}

const env = loadEnvLocal();
const cfg = loadConfig();

const SUPABASE_URL = cfg.supabaseUrl || env.VITE_CHAT_SUPABASE_URL;
const SUPABASE_KEY = cfg.supabaseAnonKey || env.VITE_CHAT_SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("✘ 缺 Supabase 凭据：在项目根 .env.local 填 VITE_CHAT_SUPABASE_URL / VITE_CHAT_SUPABASE_ANON_KEY，或在 config.json 里给 supabaseUrl / supabaseAnonKey。");
  process.exit(1);
}

const BOT_NAME = (cfg.botName || "机器人").trim();
const BOT_AVATAR = cfg.botAvatar || "🤖";
const SYSTEM_PROMPT =
  cfg.systemPrompt ||
  `你是 Nobi 聊天室里的助手机器人，名叫「${BOT_NAME}」。回答简洁、友好、用中文。不要重复别人的 @提及。`;
const CONTEXT_SIZE = Number.isFinite(cfg.contextSize) ? cfg.contextSize : 8; // 带几条最近消息当上下文
const MAX_TOKENS = Number.isFinite(cfg.maxTokens) ? cfg.maxTokens : 500;
const ANNOUNCE = cfg.announceOnStart === true; // 启动时打个招呼（让自己进 @候选列表）

const llm = cfg.llm || {};
if (!llm.baseUrl || !llm.apiKey || !llm.model) {
  console.error("✘ config.json 的 llm 没填全：需要 baseUrl / apiKey / model。");
  process.exit(1);
}

// 命令行房间号优先；否则用 config.rooms
const rooms = (process.argv.slice(2).length ? process.argv.slice(2) : cfg.rooms || []).map(String);
if (!rooms.length) {
  console.error("✘ 没指定房间：在 config.json 填 rooms: [\"1234\"]，或命令行 `node scripts/chat-bot/bot.mjs 1234`。");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  realtime: { params: { eventsPerSecond: 5 } },
});

// —— 调 OpenAI 兼容 /chat/completions（和 Winky 的 chat_once 同款拼法） ——
function chatUrl(base) {
  const b = String(base).trim().replace(/\/+$/, "");
  return b.endsWith("/chat/completions") ? b : `${b}/chat/completions`;
}

async function askLLM(messages) {
  const resp = await fetch(chatUrl(llm.baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${String(llm.apiKey).trim()}`,
    },
    body: JSON.stringify({
      model: llm.model,
      stream: false,
      max_tokens: MAX_TOKENS,
      messages,
    }),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`API 返回 ${resp.status} ${t.slice(0, 200)}`);
  }
  const v = await resp.json();
  const text = (v?.choices?.[0]?.message?.content || "").trim();
  if (!text) throw new Error("空回复");
  return text;
}

// 去掉对机器人的 @提及，留下真正的问题
function stripMention(body) {
  return String(body || "")
    .split(new RegExp(`@${BOT_NAME}\\b`, "g")).join("")
    .replace(/\s+/g, " ")
    .trim();
}

async function sendReply(room, text) {
  const { error } = await supabase.from(TABLE).insert({
    room,
    sender: BOT_NAME,
    client_id: BOT_CLIENT_ID,
    kind: "text",
    body: text,
    avatar: BOT_AVATAR,
  });
  if (error) {
    // 老表没 avatar 列时去掉重发（和 supabaseBackend 的优雅降级一致）
    if (/avatar/i.test(error.message)) {
      const { error: e2 } = await supabase
        .from(TABLE)
        .insert({ room, sender: BOT_NAME, client_id: BOT_CLIENT_ID, kind: "text", body: text });
      if (e2) throw new Error(e2.message);
    } else {
      throw new Error(error.message);
    }
  }
}

// 拉最近若干条，拼成 LLM 的对话上下文
async function buildMessages(room) {
  const { data } = await supabase
    .from(TABLE)
    .select("sender,client_id,kind,body,created_at")
    .eq("room", room)
    .order("created_at", { ascending: false })
    .limit(CONTEXT_SIZE);
  const history = (data || []).reverse();
  const msgs = [{ role: "system", content: SYSTEM_PROMPT }];
  for (const r of history) {
    if (r.kind !== "text" || !r.body) continue;
    if (r.body.charCodeAt(0) < 0x08) continue; // 游戏/系统帧不进上下文
    if (r.client_id === BOT_CLIENT_ID) {
      msgs.push({ role: "assistant", content: r.body });
    } else {
      const clean = stripMention(r.body);
      if (clean) msgs.push({ role: "user", content: `${r.sender}：${clean}` });
    }
  }
  return msgs;
}

const handled = new Set(); // 防 Realtime 偶发重复投递

async function onMessage(room, row) {
  if (!row || handled.has(row.id)) return;
  handled.add(row.id);
  if (handled.size > 500) handled.clear();

  if (row.client_id === BOT_CLIENT_ID) return; // 自己发的不理（防自问自答死循环）
  if (row.kind !== "text" || !row.body) return; // 只应答文字
  if (row.body.charCodeAt(0) < 0x08) return; // 游戏/系统帧
  if (!row.body.includes(`@${BOT_NAME}`)) return; // 没 @机器人 不应答（@所有人 也不触发，免刷屏）

  console.log(`[${room}] ${row.sender} → @${BOT_NAME}: ${row.body}`);
  try {
    const messages = await buildMessages(room);
    const reply = await askLLM(messages);
    await sendReply(room, reply);
    console.log(`[${room}] ${BOT_NAME} ✓ ${reply.slice(0, 60)}${reply.length > 60 ? "…" : ""}`);
  } catch (e) {
    console.error(`[${room}] ✘`, e.message);
    try {
      await sendReply(room, `（我出错了：${e.message}）`);
    } catch {
      /* 连报错都发不出去就算了 */
    }
  }
}

function subscribe(room) {
  supabase
    .channel(`bot:room:${room}`)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: TABLE, filter: `room=eq.${room}` },
      (payload) => void onMessage(room, payload.new),
    )
    .subscribe((status) => {
      if (status === "SUBSCRIBED") {
        console.log(`✓ 已进房间 ${room}，监听 @${BOT_NAME}`);
        if (ANNOUNCE) void sendReply(room, `${BOT_AVATAR} ${BOT_NAME}上线啦，@我 试试～`).catch(() => {});
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        console.error(`✘ 房间 ${room} 订阅出错：${status}`);
      }
    });
}

console.log(`Nobi 聊天机器人「${BOT_NAME}」启动 —— 模型 ${llm.model} @ ${llm.baseUrl}`);
console.log(`房间：${rooms.join(", ")}`);
for (const r of rooms) subscribe(r);

process.on("SIGINT", () => {
  console.log("\n机器人下线。");
  process.exit(0);
});
