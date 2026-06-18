---
name: dobby-nobi-distribution
description: Nobi 经 Dobby 工具站(dobby-aih.pages.dev/nobi.html)分发；发版自动同步，无需动 Dobby
metadata: 
  node_type: memory
  type: project
  originSessionId: f8ff946e-2f2d-4871-8785-fe53b6d74e6d
---

**Nobi 的对外下载入口挂在 Dobby 工具站上**（Dobby = 另一个仓库 `Sagara911/Dobby`，静态站 Cloudflare Pages，线上 `dobby-aih.pages.dev`；本机 `D:\Game\toolkit`）。2026-06-12 搭好。

**衔接方式=运行时动态，不是构建时**：Dobby 的 `nobi.html` 每次被打开就调 GitHub API（`/repos/Sagara911/Nobi/releases/latest`），把下载按钮指向最新 Release 里的 `*-setup.exe`（NSIS）。所以 **Nobi 正常发一个版（改 tauri.conf 版本→tag→push→CI 发 Release），Dobby 这边零操作自动跟最新**——不用重新部署、不用改代码。同一个 GitHub Release 同时喂三条下游：装机版自动更新器（读 latest.json）、Dobby 下载页、新下载者。

**关键约束 / 维护点：**
- Dobby `nobi.html` 认安装包靠正则 `/-setup\.exe$/i`。**Nobi 若改打包格式/命名**（不再是 `nobi_<版本>_x64-setup.exe`），要同步改这条正则，否则下载页认不出。
- `nobi.html` 内有断网兜底常量 `FALLBACK_EXE`（写死某版直链，如 v0.1.13），会过时，偶尔手动 bump；正常走 API 不受影响。
- **下载页刻意不放任何指向 Nobi 仓库页的链接**（用户要求：仓库公开无所谓，但页面不外露 git 跳转）。下载按钮直指安装包文件 URL（github.com 的 release 资产直链，只下文件、不导航到仓库）。要连这串 URL 都不含 github，得走"方案 C"：源码私有 + 安装包转托公开渠道（Cloudflare R2/独立公开仓库）+ 改 updater endpoint——尚未做。
- 首页 `index.html`：Nobi 是 Hero 与工具网格之间的**独立横幅板块**，**不在** `Toolkit.TOOLS` 工具列表里（不进分类/计数/搜索）。i18n 键 `home.nobi.*` 在 `assets/i18n-strings.js` 中英都有。

**文档落点**（给 Codex/接手者）：Dobby `README.md`「技术细节」节、Nobi `docs/RELEASE.md`「下游消费方」节都写了这套衔接。发版总流程见 [[3d-preview-plan]] 的发版链路事实 / Nobi `docs/RELEASE.md`。相关：[[gringotts-project]]、[[web-mirror-window-plan]]。
