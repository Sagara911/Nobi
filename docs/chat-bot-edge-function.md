# Nobi 聊天室机器人 · Supabase 云函数部署

**真·无人值守**的聊天室成员机器人：跑在 Supabase 云端，谁开没开 Nobi 都在，
不用挂机、不用跑脚本。对**所有房间**生效——任意房间里 `@机器人` 都会回。

原理：`messages` 表每插一行 → 数据库 Webhook（pg_net 触发器）POST 给
`chat-bot` Edge Function → 函数看到 `@机器人` 就调 LLM、再插一行回复。机器人
自己那行也会触发，但按 `client_id="nobi-bot"` 自我识别跳过，无死循环。

代码：[`supabase/functions/chat-bot/index.ts`](../supabase/functions/chat-bot/index.ts)
· 触发器：[`docs/chat-bot-webhook.sql`](chat-bot-webhook.sql)

---

## 一次性部署（5 步）

### 0. 装 Supabase CLI 并登录
```
npm i -g supabase        # 或 scoop install supabase
supabase login
supabase link --project-ref <你的项目ref>   # ref = 项目 URL https://<ref>.supabase.co 里那段
```
（`<ref>` 也就是你 .env.local 里 `VITE_CHAT_SUPABASE_URL` 域名的开头那段。）

### 1. 部署函数
在项目根目录：
```
supabase functions deploy chat-bot --no-verify-jwt
```
`--no-verify-jwt`：函数靠数据库 Webhook 内部触发，不走用户 JWT；改用下面的
共享密钥防乱触发。

### 2. 配密钥（把你在 Winky 里用的那家 API 抄过来）
```
supabase secrets set \
  LLM_BASE_URL=https://api.deepseek.com \
  LLM_API_KEY=你的key \
  LLM_MODEL=deepseek-chat \
  BOT_NAME=机器人 \
  BOT_WEBHOOK_SECRET=随便编一串长字符串
```
可选再加：`BOT_AVATAR=🤖`、`SYSTEM_PROMPT=...`、`CONTEXT_SIZE=8`、`MAX_TOKENS=500`。
`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` 是平台**自动注入**的，别自己设。

> Windows PowerShell 里换行用反引号 ` 而不是 `\`，或干脆写成一行。

### 3. 建触发器
打开 [`docs/chat-bot-webhook.sql`](chat-bot-webhook.sql)，把 `<PROJECT_REF>` 换成你的 ref、
`<SECRET>` 换成上面那串 `BOT_WEBHOOK_SECRET`，整段粘进 Supabase → SQL Editor → Run。

### 4. 测
任意客户端进任意房间，发 `@机器人 你好`，它就回。第一次它说过话后，输入 `@`
的候选弹窗里就有它了。

---

## 改东西

- **换模型/key/人设**：`supabase secrets set ...` 重设对应项（函数无需重新部署，下次调用即生效）。
- **改逻辑**：编辑 `index.ts` → `supabase functions deploy chat-bot --no-verify-jwt`。
- **看日志排查**：`supabase functions logs chat-bot`（或 Dashboard → Edge Functions → Logs）。
- **关掉机器人**：跑 webhook SQL 末尾注释里的两行 `drop`。

## 注意

- LLM key 存在 Supabase 密钥里、**不进代码仓库**；触发器 SQL 里只有占位符。
- 机器人用 service role 写库（绕过 RLS），所以一定要靠 `BOT_WEBHOOK_SECRET` 挡住乱触发。
- 消息照样走 12h 阅后即焚（机器人只是收发，不影响清理）。
- 想要**不上云**的版本：`scripts/chat-bot/` 下有个独立 Node 脚本（需一台机器常驻跑），是同一套逻辑的备选。
