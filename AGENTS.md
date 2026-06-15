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

## 聊天子系统（2026-06-15 加，已并入 main）

「和朋友聊天」：默认走云端 Supabase，**后端可换**（留了自建服务器接口）。

- **后端抽象** `src/chat/`：`types.ts` 的 `ChatBackend` 接口是核心——UI 只依赖它。`supabaseBackend.ts`（Realtime 收/insert 发/Storage 存图）、`customBackend.ts`（自建服务器，完整 WS+HTTP 客户端，顶部注释定义协议，搭匹配小服务器即可零改前端切过去）、`index.ts` 工厂、`config.ts`（连接档案/身份/已加入连接/outbox/活跃连接）、`setupSql.ts`（内嵌建表 SQL 供 app 内教程复制）、`avatar.ts`（头像图压成 64px data URL）
- **连接档案（多服务器）** `ChatProfile`：可存多套后端（我的 Supabase / 同事的服务器…），每个聊天窗绑一套——**不同窗口可同时连不同服务器**。启动器有连接下拉/新建/退出删除/「显示·分享凭据」（像 WiFi 密码，含内置后端，可复制 URL+key+房间号发朋友）。`getProfiles/saveProfile/removeProfile/resolveConfig`
- **窗口** `src/components/ChatWindow.tsx`：`main.tsx` 按 `#chat` 路由；URL `?profile=&room=` → 房间窗（label `chat-<profile>-<room>`，**可并排多群**），无参 → 启动器（label `chat`，进入后自动关）。启动器顶部「我的聊天」= 已加入连接列表（持久化，微信式点进去）。`App.tsx` 的 openChatWindow/openChatRoom/sendAssetToFriend
- **凭据内置**：`.env.local`（`*.local` 已 gitignore，**不进仓库**）放 `VITE_CHAT_SUPABASE_URL`/`VITE_CHAT_SUPABASE_ANON_KEY`，Vite 编译打进包→`CREDENTIALS_BAKED` 时有「内置后端」连接。**改 .env 必须重启 dev**
- **发媒体**：文字/图片/**视频**(kind 字段；拖图或视频进群窗，或素材右键「发给朋友」→ outbox 按 profile+room tag → 发活跃连接)。**Emoji 面板 + 表情包收藏**（素材右键「收藏为表情包」，本地路径存 localStorage，发时 re-upload，不受 24h 清理影响）。outbox 跨窗口靠 localStorage **轮询**（WebView2 多窗 storage 事件不可靠）。Supabase 免费档单文件约 50MB 上限
- **头像**：默认彩色首字（确定性），可选 emoji / **上传图片** / 素材右键「设为聊天头像」。随消息 `avatar` 字段带走（data URL，需表有 `avatar` 列）
- **未读提醒**：主窗后台订阅所有已加入连接，没在看的群来消息 → **托盘红点+数字**（`lib.rs` `CHAT_UNREAD`/`badged_tray_icon`/`chat_bump_unread`/`chat_clear_unread`），开/聚焦聊天窗清零。聊天窗全关也能提醒
- **全局快捷键（随聊天窗占用/全关归还，均可改键带冲突检测，存 `chat_prefs.json`）**：老板键 `Alt+C` 藏/显所有聊天窗（`toggle_chat_windows`）；透明度 `Alt+V` 调淡 / `Alt+B` 调浓（`CHAT_OPACITY`+Win32 `SetLayeredWindowAttributes`，跨重启记忆、新窗继承）。命令 `chat_get/set_boss_key`、`chat_get_opacity_keys/chat_set_opacity_key`
- **看球窗隐藏**：`lib.rs` `hide_from_alt_tab`（Win32 `WS_EX_TOOLWINDOW`）让直开窗不在 Alt+Tab/任务栏出现
- **权限** `capabilities/chat-window.json`：`["chat","chat-*"]` + create-webview-window
- **Supabase 建表** `docs/chat-supabase-setup.sql`：messages 表（含 `avatar` 列）+ RLS（anon 读写）+ Realtime + chat-assets 公开桶 + **24h pg_cron 阅后即焚**（`nobi-chat-cleanup` 每小时删超 24h 消息/图片，存量不涨、长期免费）。**选头像/emoji 前用户须跑 `alter table messages add column if not exists avatar text;`**
- 依赖：`@supabase/supabase-js`。**发图/视频/多服务器真机端到端未最终确认**

## 开机自启

`tauri-plugin-autostart`（desktop dep + setup 内 desktop-gated 注册 + `capabilities/default.json` 的 `autostart:*` 权限）。前端 `api.getAutostart/setAutostart`（包 `@tauri-apps/plugin-autostart`），工具→⚙设置→开机自启（菜单 `checked` 勾选态）。Windows 走 HKCU Run，无需管理员；**dev 登记调试 exe 路径，安装版才准**

## 已知的坑

- **cargo 文件锁**：`npm run tauri dev` 的 watcher 与任何并行 cargo/构建会抢锁，可能把 watcher 抢死（vite 活着但 Rust 不再重编译、应用不重启）。规则：**dev 跑着时不要并行跑 cargo build/check**；watcher 死了就重启 dev
- **Windows 图标缓存**：换图标后资源管理器显示不变是缓存问题，复制改名即可验证真身
- **画板调试**：DEV 模式下 `window.__nobiBoard` 暴露 store/stage/editor/openTextEditor/tiptap，可在控制台直接驱动
- 画板持久化双层：localStorage 快取（键 `nobi-board-doc-v1[:id]`）+ SQLite 权威副本；多画板按 id 分键
