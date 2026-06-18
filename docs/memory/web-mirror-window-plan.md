---
name: web-mirror-window-plan
description: "Nobi「看球小窗」——v0.1.13 重做为「直开」独立顶层窗为主 + 全局快捷键全家桶"
metadata:
  node_type: memory
  type: project
  originSessionId: f8ff946e-2f2d-4871-8785-fe53b6d74e6d
---

**现状（2026-06-12，v0.1.13 重做，commit 57609e1）**：边干活边小窗看球的工具。**已彻底改走「直开」独立顶层窗**——iframe 启动窗（旧 WebMirror.tsx/#web 路由/web-mirror.json）**已全部删除**。

**为什么砍 iframe**：①登录站在 iframe 里是**第三方上下文**，浏览器隔离第三方 cookie/存储→二维码白块、验证码发不出（画面能加载，但登不进）；②全屏/控件受跨域限制。直开窗是第一方顶层窗，登录/网页全屏/站内跳转全正常。

**实现位置**：
- 入口：工具菜单「📺 看球小窗…」→ App.tsx `setShowWebTV(true)` → `src/components/WebTVModal.tsx`（药丸式搜索栏：输网址直跳、输搜索词走所选引擎；引擎下拉 Google/Bing/百度，与 Rust 同步）。回车/「↗ 直开」→ `api.webOpenDirect(url)`。
- 建窗：lib.rs `web_open_direct`（**async 命令**——同步会占主线程致 WebView2 白屏，官方明示）→ `open_direct_window()`：`WebviewWindowBuilder` 建 `web-d<seq>` 窗，decorations:false / always_on_top / resizable，注入 `NEWWIN_FIX_JS`（把 window.open/_blank 改写成本窗跳转，否则「进入直播间」点不动），还原 `webdirect_geom.json` 的几何，记 `webdirect_lasturl.txt`（托盘直达用）。
- 搜索引擎：`web_set_search_engine` 命令 + `WEB_ENGINE` 静态量；前端 localStorage `nobi.webmirror.engine` 与之双向同步。默认 google（国内要梯子，菜单/弹窗可切）。

**全局快捷键**（Rust 侧注册，不经 IPC 无需 capabilities；**只在看球窗可见时占用、藏起/全关即归还系统**，靠 `set_web_hotkeys_async` + on_window_event 生命周期管理）。默认：Alt+1/2 透明度淡/浓·Alt+Q/W 页面缩放·Alt+3 标题栏·Alt+4 穿透·Alt+E 换台搜索·Alt+Z/X 网页后退/前进·Alt+R 静音·Alt+S 截图入库·Alt+D 贴角·Alt+\` 老板键。**Alt+1/2/Q/W 支持按住连调**（HOLD_KEY/HOLD_GEN + 重复线程，330ms 后每 110ms 一步）。

**v0.1.14：快捷键全部可自定义**（解决与他软件冲突）。Rust 把写死的键改成「动作→加速键」动态映射：`KEY_ACTIONS`(默认) + 用户覆盖存 prefs 的 `keys`，启动 `rebuild_web_keys` 填 `WEB_KEYS`(Mutex<Vec<(action,accel,Shortcut)>>)；handler 按「按下的键属于哪个动作」分发（不再写死比较）。命令 `web_get_keys/web_set_key/web_reset_keys`，看球弹窗里逐个录制改键 + 冲突检测 + 恢复默认。**加速键三方统一格式**：前端 e.code 拼修饰符 / `Shortcut::from_str` / 默认值都是 `Alt+Digit1` `Alt+KeyQ` `Alt+Backquote`。坑：①`set_web_hotkeys` 必须先快照再 register（不能握着 WEB_KEYS 锁去 register，否则与主线程 handler 锁互等死锁）；②改 KEY_ACTIONS 长度无所谓（不再有定长数组）。

**v0.1.14：老板键升级**——藏时暂停在播视频(注入 JS 标 `data-nobiPaused` + pause)、显时只续播标记过的；配合原有静音。跨域 iframe 播放器里的 video 够不着（同截图/缩放限制，静音不受影响）。

**新手引导**：试过空状态引导 + 首启欢迎弹窗，用户嫌繁琐，**已全部撤掉**（别再加）。保留了弹窗次要按钮的描边胶囊统一样式（`.modal-actions .btn:not(.primary)`，App.css）。

**本机 WebView2 合成层脆——一族坑与统一修法（重要，再动看球务必记住）**：
- 透明度只能走 **Win32 原生 alpha**（`SetLayeredWindowAttributes` on hwnd），DOM 够不着第一方页面。
- `set_decorations`/`set_ignore_cursor_events`/`show`/`set_zoom` 都会**冲掉 layered alpha**（异步落地）→ 必须 `reapply_web_opacity_soon`（**立即 + 延迟 120ms 回主线程再补一刀**），否则透明度闪一下/丢失。
- 快捷键 register/unregister **必须甩工作线程**（`set_web_hotkeys_async`）——在快捷键/窗口事件回调里同步调会自锁、整 app 无响应。
- 新窗获焦继承透明度时：全实(255)跳过别在 WebView2 初始化期打 WS_EX_LAYERED（曾疑致白屏）；且先 zoom 后透明度（反了会被 zoom 冲掉）。

**记忆/持久化**：`webdirect_prefs.json`（透明度/缩放/缩放手动态/搜索引擎，JSON 对象宽容读取）+ `webdirect_geom.json`（窗口几何，逻辑像素，全屏/最小化时不记）+ `webdirect_lasturl.txt`。均在 app_config_dir。

**依赖**：`tauri-plugin-global-shortcut`、`windows`(Win32_Foundation/UI_WindowsAndMessaging/System_Com/System_Com_StructuredStorage)、`webview2-com`（静音 ICoreWebView2_8::SetIsMuted、截图 CapturePreview）——均 `cfg(windows)`。

**坑（已踩）**：①Bash 工具传多行提交信息**别用 PowerShell here-string `@'...'@`**（`@` 会混进消息），用 bash `-F - <<'EOF'`。②改 `ctrl_shortcuts()` 数组长度时返回类型 `[Shortcut; N]` 要同步改 N。③窗体行为 vite 预览验不了，只能 `npm run tauri dev` 真机验。④反复杀 nobi.exe 会留线程数 0 的僵尸（无害，杀不掉，重启系统收尸）；调试别开两个实例（会抢全局键）。

与 [[floating-reference-window-plan]]、[[3d-preview-plan]] 同属"第二个 WebviewWindow"类。发版链路见 [[3d-preview-plan]]（改 tauri.conf.json 版本→tag→push→CI 云端签名→latest.json）。
