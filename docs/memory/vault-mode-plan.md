---
name: vault-mode-plan
description: 金库模式（隐秘防护）——锁定态下主菜单/托盘都不出现浏览窗+便签入口，连点版本号5下解锁；设计取舍与实现位置
metadata: 
  node_type: memory
  type: project
  originSessionId: 26e757c2-f47a-4fd7-94f6-7ac5460560ea
---

2026-06-18 给浏览窗([[web-mirror-window-plan]])和便签([[chat-system]])加的「金库模式」隐秘防护层。

**威胁模型（用户原话）**：老板进 Nobi 里翻菜单/托盘也看不见浏览窗和便签存在。不是藏窗口（老板键早有），是藏**功能入口本身**。

✅ 2026-06-18 已做完、真机测过、发版 **v0.3.0**（commit 43e053b，tag v0.3.0 已推 → release CI）。

⚠️→✅ **v0.3.1 露馅修复**（commit 5a4beb4，tag v0.3.1）：第一版锁定时 `App.tsx:99` 把 `setStatus("🔒 已锁定并隐藏")` 写进状态栏（`panels.tsx:359` 的 `.status-text` 渲染在工具条右侧），等于挂牌告诉老板"此处有暗格"——直接违背威胁模型。修法：锁定时 status 置空（完全静默），解锁的 `🔓 已解锁…` 提示保留（解锁是主动操作、风险低）。**教训：任何会把"隐藏功能存在"写进可见 UI 的提示都是破绽，锁定路径必须静默。**

**隐藏覆盖三处（缺一就露馅）**：① 主菜单工具项 ② 托盘右键菜单 ③ **首选项·快捷键面板**（最易漏！第一版漏了，用户指出后补：`src/components/PreferencesModal.tsx` 锁定时整组不 push「聊天（便签）」「浏览窗」，只留「桌面工具」组）。

**实现**：
- 后端 `src-tauri/src/lib.rs`：`VAULT_UNLOCKED` 原子布尔 + `build_tray_menu`/`refresh_tray`（锁定态托盘只挂「显示/退出」）+ `lock_hide_windows`（上锁时藏所有 web-*/chat 窗、静音、归还 web 控制键，镜像老板键的「藏」分支）+ 命令 `vault_get`/`vault_set`。
- 前端 `src/App.tsx`：`vaultUnlocked` state；品牌区版本号 `<span className="brand-ver">` 是暗号触发点，`onBrandTap` 2.5 秒内连点 5 下切换；工具菜单两项用 `...(vaultUnlocked ? [...] : [])` 条件渲染。`src/api.ts`：`vaultGet`/`vaultSet`。`PreferencesModal.tsx`：`reload()` 里 `api.vaultGet()` 决定是否 push 那两组。

**关键设计取舍（改之前先懂为什么）**：
- **故意不持久化**：每次启动 `VAULT_UNLOCKED=false`（默认锁定），重启即回「什么都看不到」——这才安全。若哪天想「记住解锁态」要明确知道是在降安全性。
- **用户明确「先不要 PIN」**：只靠连点暗号解锁，无口令。以后想加 PIN 在 `vault_set` 前加校验即可。
- **暗号选版本号连点而非热键**：当面按热键手势会被瞄到；点版本号像手抖。故意不改 cursor/hover，不给「可点」暗示。
- **boss 键仍随窗注册**：lock 只镜像老板键的「藏」，没强行注销 web/chat 老板键（boss 不知道键，随机命中概率极低；强行注销会动到调好的热键生命周期）。

**旁注**：做本功能时发现 `src/App.tsx` 含一个裸 NUL 字节（git 当二进制、Grep 需 `-a`），详见 [[app-tsx-null-byte]]。
