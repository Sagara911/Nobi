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

## 已知的坑

- **cargo 文件锁**：`npm run tauri dev` 的 watcher 与任何并行 cargo/构建会抢锁，可能把 watcher 抢死（vite 活着但 Rust 不再重编译、应用不重启）。规则：**dev 跑着时不要并行跑 cargo build/check**；watcher 死了就重启 dev
- **Windows 图标缓存**：换图标后资源管理器显示不变是缓存问题，复制改名即可验证真身
- **画板调试**：DEV 模式下 `window.__nobiBoard` 暴露 store/stage/editor/openTextEditor/tiptap，可在控制台直接驱动
- 画板持久化双层：localStorage 快取（键 `nobi-board-doc-v1[:id]`）+ SQLite 权威副本；多画板按 id 分键
