# Nobi 开发指南（给接手的智能体 / 开发者）

Nobi：AI 驱动的本地美术素材管理器。Tauri 2 + React 19 + TypeScript（前端）/ Rust（后端）。
画板为自研 Konva 实现（无 tldraw），文本支持行内富文本（TipTap 编辑 + 自研排版）。

## 必读文档

- `docs/ARCHITECTURE.md` —— 架构纪律（**改代码前先读**：invoke 只能在 api.ts、表结构只能在 db.rs 等五条铁律）
- `docs/RELEASE.md` —— 发版流程（自动发版一条命令 + 手动备用 + 坑表）
- `docs/TRANSLATION.md` —— 翻译子系统（三入口/智能路由/离线 ECDICT 词典/离线 OPUS-MT 整句/按需下载；**含发版前必做项**。现在分支 `feat/offline-translation`，未合 main）

## 常用命令

```bash
npm run tauri dev    # 开发（vite 1420 + Rust watcher；端口被占先杀 nobi 进程）
npx tsc --noEmit     # 前端类型检查（提交前必跑）
cargo check          # Rust 检查（在 src-tauri 下；见下方"坑"）
npm run build        # 前端构建（tsc + vite）
node scripts/release.mjs 0.x.y   # 一键发版（改版本号→提交→打 tag→推送→CI 云端发布）
```

## 提交规范

- 提交信息用**中文**，前缀沿用 `feat:` / `fix:` / `chore:` / `docs:` / `ci:`
- 直接提交并推送 `main`（个人项目无 PR 流程）；每完成一个功能/修复就提交，不攒大包
- 提交前确保 `npx tsc --noEmit` 通过；动了 Rust 还要 `cargo check`

## 关键事实

- **数据**：`%APPDATA%\com.nobi.app\nobi.sqlite`；素材原位索引不复制原图；所有"删除"只清库记录与缩略图，**绝不动用户原文件**
- **更新签名密钥**：`C:\Users\huobingli\.tauri\nobi-updater.key`（已加密；**密码在用户的备忘录里，问用户要，不在任何仓库/文档中**）。公钥在 `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`
- **CI Secrets**（已配置）：`TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`，供 `.github/workflows/release.yml` 云端签名
- **MCP**：应用运行时在 `127.0.0.1:21420/api/*` 提供本地接口；stdio 桥为 `scripts/nobi-mcp.mjs`，项目级注册在 `.mcp.json`（10 个工具：检索/打标/相似/上画板等）
- **AI Provider**：OpenAI 兼容三件套（设置面板），默认本地 Ollama；**必须用支持图片输入的视觉模型**（DeepSeek 官方 API 纯文本不可用）

## 聊天子系统（2026-06-15 加，分支 `feat/offline-translation`）

「和朋友聊天」：默认走云端 Supabase，**后端可换**（留了自建服务器接口）。

- **后端抽象** `src/chat/`：`types.ts` 的 `ChatBackend` 接口是核心——UI 只依赖它。`supabaseBackend.ts`（Realtime 收/insert 发/Storage 存图）、`customBackend.ts`（自建服务器，完整 WS+HTTP 客户端，顶部注释定义协议，搭匹配的小服务器即可零改前端切过去）、`index.ts` 工厂（加后端只改这里）、`config.ts`（配置/outbox/活跃房间）
- **窗口** `src/components/ChatWindow.tsx`：`main.tsx` 按 `#chat` 路由；URL 有无 `?room=` 决定形态——无=「发起/加入群」启动器（label `chat`），有=该房间独立窗（label `chat-<房间号>`，**可并排多群**）。`App.tsx` 的 openChatWindow/openChatRoom/sendAssetToFriend
- **凭据内置**：`.env.local`（被 `*.local` gitignore，**不进仓库**）放 `VITE_CHAT_SUPABASE_URL` / `VITE_CHAT_SUPABASE_ANON_KEY`（publishable 可公开 key），Vite 编译时打进包。`CREDENTIALS_BAKED` 为真时用户只填「名字+房间号」即进群。**改 .env 必须重启 dev**（Vite 启动才读）
- **发图两路**：桌面拖图进群窗（窗口 `dragDropEnabled:false` 走 HTML5 拖放）/ 素材右键「发给朋友」→ outbox 按房间号 tag → 发往活跃群。outbox 跨窗口靠 localStorage **轮询**（WebView2 多窗口 storage 事件不可靠）
- **老板键** `Alt+C`（可改键）：Rust 全局快捷键藏/显所有聊天窗，随窗占用/全关归还（`lib.rs` `toggle_chat_windows`/`CHAT_BOSS_ON`/`chat_get_boss_key`/`chat_set_boss_key`，存 `chat_prefs.json`）。看球老板键是 Alt+\`，独立
- **看球窗隐藏**：`lib.rs` `hide_from_alt_tab`（Win32 `WS_EX_TOOLWINDOW`）让直开窗不在 Alt+Tab/任务栏出现
- **权限** `src-tauri/capabilities/chat-window.json`：`["chat","chat-*"]`
- **Supabase 建表** `docs/chat-supabase-setup.sql`：messages 表 + RLS（anon 读写）+ Realtime + chat-assets 公开桶 + **第5节 24h pg_cron 阅后即焚**（`nobi-chat-cleanup` 每小时删超 24h 的消息/图片，让存量不涨、长期卡在免费额度内）
- 依赖：`@supabase/supabase-js`（npm）。**发图真机端到端未最终确认**

## 已知的坑

- **cargo 文件锁**：`npm run tauri dev` 的 watcher 与任何并行 cargo/构建会抢锁，可能把 watcher 抢死（vite 活着但 Rust 不再重编译、应用不重启）。规则：**dev 跑着时不要并行跑 cargo build/check**；watcher 死了就重启 dev
- **Windows 图标缓存**：换图标后资源管理器显示不变是缓存问题，复制改名即可验证真身
- **画板调试**：DEV 模式下 `window.__nobiBoard` 暴露 store/stage/editor/openTextEditor/tiptap，可在控制台直接驱动
- 画板持久化双层：localStorage 快取（键 `nobi-board-doc-v1[:id]`）+ SQLite 权威副本；多画板按 id 分键
