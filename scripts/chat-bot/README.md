# Nobi 聊天室机器人（独立脚本版 · 备选）

> 推荐用**云函数版**（无人值守、不用挂机）：见 [`docs/chat-bot-edge-function.md`](../../docs/chat-bot-edge-function.md)。
> 本目录是**不上云**的备选——同一套逻辑，但需要一台机器常驻 `node` 跑。

聊天室里的**常驻成员机器人**——它是「房间里的第 N 个人」，谁在消息里 `@机器人`
它就调 LLM 回复。和 Winky（依附个人客户端的桌宠助手）无关：这个机器人是个
独立进程，只要它在跑，不管谁开没开 Nobi，房间里都有它。每个房间配一个（一个
进程可同时盯多个房间）。

## 配置

1. 复制配置模板：
   ```
   cp scripts/chat-bot/config.example.json scripts/chat-bot/config.json
   ```
2. 编辑 `config.json`：
   - `llm.baseUrl / apiKey / model`：和 Winky 一样的 OpenAI 兼容三件套，把你在
     Winky 里用的那家抄过来（DeepSeek / Gemini / OpenAI / 通义 / 豆包 …）。
   - `rooms`：要进的房间号，可多个。
   - `botName`：机器人昵称，大家用 `@这个名字` 触发。
   - `systemPrompt`：人设/语气，随便改。
   - `announceOnStart`：true 则启动时打个招呼（顺便让自己出现在大家的 @候选里）。

   Supabase 凭据**不用填**——默认自动读项目根 `.env.local` 里那两个
   `VITE_CHAT_SUPABASE_*`（和客户端同一套）。

## 运行

在**项目根目录**跑（要用到项目的 node_modules 里的 `@supabase/supabase-js`）：

```
node scripts/chat-bot/bot.mjs            # 用 config.json 里的 rooms
node scripts/chat-bot/bot.mjs 1234 5678  # 命令行指定房间，覆盖配置
```

看到 `✓ 已进房间 1234，监听 @机器人` 就成了。在任意客户端进同一个房间，
发 `@机器人 你好`，它就回。第一次它说过话后，输入 `@` 的候选列表里就有它了。

要它常驻：丢进 pm2 / nssm / 计划任务，或开机自启那台机器上 `node ... &`。

## 行为说明

- **只在被 `@机器人` 时回复**；`@所有人` 不触发（免刷屏）。
- 自己发的、游戏同步帧（UNO/飞行棋/骗子酒馆等控制字符前缀）一律忽略。
- 回复带最近 `contextSize` 条消息当上下文，所以能接着群里的话题聊。
- 权限和普通客户端一样（匿名 key 可读写），消息照样走 24h 阅后即焚。

## 注意

- `config.json` 含 API Key，已被 `.gitignore` 排除，不进仓库。
- Node 需 ≥ 18（用到全局 `fetch` 与 `WebSocket`；项目实测 Node 24 正常）。
- 机器人和客户端用**同一个 anon key**，所以任何能进房间的人都能伪造它的身份——
  小圈子够用，别当严肃鉴权。
