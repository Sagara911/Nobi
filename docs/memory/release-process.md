---
name: release-process
description: Nobi 发版流程——单提交bump两处版本号+CHANGELOG，打tag推送触发CI；不要用release.mjs
metadata: 
  node_type: memory
  type: project
  originSessionId: 4db9e227-7d47-42c3-aaf6-edac26830d8c
---

Nobi 发版（用户说「推新版/发版」时照做）：

1. 改**两处**版本号到新版：`package.json` 和 `src-tauri/tauri.conf.json`（`Cargo.toml` 不用动，历史发版commit也没碰它）。
2. `CHANGELOG.md` 顶部加 `## vX.Y.Z` 条目（CI 会按 tag 名从这里抓发布说明 + 应用内更新弹窗内容，见 `.github/workflows/release.yml`）。注意：金库模式那种隐秘功能（v0.3.0/0.3.1）故意**不写** CHANGELOG。
3. 把代码 + 两处版本号 + CHANGELOG **一个提交**搞定，commit message 格式照历史：`feat/fix: <一句中文描述> + vX.Y.Z`。
4. `git tag vX.Y.Z` → `git push origin main` → `git push origin vX.Y.Z`。**直接推 main**（这仓库全程直推 main 发版，别开分支/PR，否则 tag 不在对的 commit 上、CI 不触发）。
5. CI 由 `push: tags: v*` 触发，windows-latest 上 tauri-action 打 nsis 包+签名+建 Release，首跑约 15 分钟。进度：https://github.com/Sagara911/Nobi/actions

**坑**：`scripts/release.mjs` 只改 tauri.conf.json + 单独建「release: vX」提交，和历史的「feat:…+vX」单提交风格不符——**别用它**，手动走上面 1-5。

**多端同步前提**（用户报「更新后看不到新功能」时先查这个）：UNO/骗子酒馆都是**房主权威**，牌库/状态由房主端生成。所以新功能要生效，**当房主那台必须在新版且重启过 app**，并**重新开局发牌**；别人当房主而没更新 → 整局都没新内容。发牌后看「牌堆/手牌」数字能反推房主用的是不是新版。相关 [[chat-system.md]]。
