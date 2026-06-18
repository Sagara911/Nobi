---
name: desktop-tools-roadmap
description: Nobi「桌面专属工具」四件套路线（取色器/参考窗升级/批量命名/全局截图入库），逐个做；取色器已实现待真机验
metadata: 
  node_type: memory
  type: project
  originSessionId: ffd97fa2-a2df-4ab0-bd27-dd9bb14c5b11
---

2026-06-16 本会话定的方向：给 Nobi 加「**只有桌面端能做、Dobby(网页工具站)抄不走**」的功能（AI 出图归 [[dobby-nobi-distribution]]，Nobi 不重复造）。用户拍板做 4 个，**逐个做、每个真机验过再下一个**：

1. **桌面取色器** ✅ 已实现并真机验过。交互=「**Ctrl+Alt+C 进入取色模式(光标变十字吸管) → 左键点哪取哪(吞掉该点击)/右键取消**」。热键 `Ctrl+Alt+C`(原 Alt+G 被别的程序全局占了、register 静默失败，故换 Ctrl+Alt+ 系组合，启动时 eprintln 注册结果)。实现：lib.rs `color_pick_shortcut()`/`sample_point_color(x,y)`(GDI GetPixel,pub(crate))/`ColorPick`(pub(crate))；热键按下不再即时取，改调 `selection_translate::arm_color_pick()`——**复用划词翻译那个 WH_MOUSE_LL 全局鼠标钩子**：armed 时左键 emit `color-picked`+吞点击、右键取消，换光标用 `SetSystemCursor`(十字)、还原用 `SystemParametersInfoW(SPI_SETCURSORS)`。Cargo 加 `Win32_Graphics_Gdi`。前端：`App.tsx` 监听 `color-picked`(复制hex+进右下角「最近色板」左键hex/右键rgb)+`color-pick-armed/disarmed`(顶部「🎨取色模式」横幅)；**`BoardCanvas.tsx` 也监听 `color-picked` → `applyStyle({color:hex})`**，把取的色设成画板当前色(画板本就支持任意 hex，colorHex 对非调色板键原样返回)。**故意不做跟随光标放大镜浮层**——那要透明置顶 GPU 画布，正是本机 WebView2 反复翻车处（见 [[3d-preview-plan]]/[[web-mirror-window-plan]]）。未 commit/发版(还在连做四件套)。
2. **悬浮参考窗升级** ✅ 已实现待终验。`RefWindow.tsx` 加：旋转90°(transform+窗口长宽对调，旋转后窗口比例用图片反比例)、反色/对比/亮度(CSS filter，fx 面板)、点击穿透(`set_ref_click_through` 命令对所有 ref-* 窗 `set_ignore_cursor_events`，**Ctrl+Alt+R 全局热键切回**因穿透后窗口点不动)、多图轮播(素材网格多选→右键「轮播N张」，list 存 localStorage[key]、窗口按 key 读、◀▶/滚轮切)。**关键修复**：原缩放手柄飘到透明留白里(object-fit contain + 窗口比例≠图比例)→ 改成「窗口比例始终锁定显示图比例」(refit on resize，旋转用反比例，img 用 vw/vh + translate 居中)，图永远铺满、手柄贴角。
   - **首选项·快捷键面板**(新)：**编辑(E)→⌨首选项·快捷键** = `PreferencesModal.tsx`，集中改所有全局键(桌面工具/聊天/浏览窗)，复用各自既有 get/set 命令 + 统一录键 UI(冲突即拒)。两个新键(取色 Ctrl+Alt+C、参考窗穿透 Ctrl+Alt+R)做成**可配置**：lib.rs `TOOL_COLOR_KEY`/`TOOL_REF_KEY` + `tool_color_accel/tool_ref_accel` + `tool_get_keys`/`tool_set_key` 命令，存 `tool_keys.json`，启动 `load_tool_keys` 在 register 前读回。
3. **批量命名**：❌ 用户 2026-06-17 决定不做（没必要）。
4. **全局截图入库**：❌ 自研框选浮层放弃——本机 WebView2 透明/新建窗黑屏+迟滞修不顺。**改用系统 Win+Shift+S → 画板 Ctrl+V**（画板 `onPaste` 本就支持剪贴板图片落盘入库+上板，零开发）。自研代码已全删。

**✅ 2026-06-17 发了 v0.2.12**（取色器✅+参考窗升级✅+首选项面板✅，参考窗最终形态=右键开独立菜单小窗 `RefToolsWindow.tsx`/#reftools，因小窗内菜单会被 webview 裁切）。图层顺序画板本就有(`store.reorder`，`]`上移/`[`下移/`Shift+`置顶底+右键菜单)。

**屏幕标尺**用户问过，没做（优先级最低）。

## 新方向：在 Nobi 自研「文档+导图」编辑器（2026-06-17）
用户要在 Nobi 里塞「**文档(Word)**」+「**思维导图(xmind)**」，**原生自研、不是 iframe 内嵌**。集成：加 dock 面板(`panels.tsx` `DOCK_COMPONENTS` + 窗口菜单 `ensurePanel`)，持久化仿画板(SQLite，参考 `board.rs` save/load + `db.rs` 建表)。

- **文档(Word) ✅ 已做、发版 v0.2.13**：dock 面板 `doc`(`DocEditor.tsx`，TipTap 全功能 StarterKit+Underline+TextStyle+Color)，多文档存 `docs` 表(`docs.rs` 仿 board.rs)，防抖 0.7s 自动存，窗口(W)→文档。
- **思维导图(xmind) ❌ 2026-06-17 做了又撤、用户放弃，别再做**：自研过 SVG 连线 + 绝对定位 HTML 节点 + 自动布局(MindMap.tsx/.css、mind.rs、mindmaps 表、api 绑定、dock 面板、工具/窗口菜单)。**标准 Chrome(vite preview 1430 逐项 DOM 验过)全对**：节点尺寸/打字实时变宽/换行/分支配色/文字存显都正常；修过两个真 bug——①绝对定位节点在零高定位容器(.mm-world)内 auto 高度被 Chromium 错撑成方块→改显式 height；②同一事件连两次 mutate(提交文字+加同级)第二次基于旧 rootRef 克隆把文字覆盖丢→mutate 里同步 `rootRef.current=next`。**但本机 WebView2 里节点文字始终不显示**(框/连线/配色都在、就是看不到字)——和 [[3d-preview-plan]]/[[web-mirror-window-plan]] 同一类 WebView2 transform/合成层渲染坑(layered-alpha 家族),无法远程检视 WebView2 调。用户决定不做,**已整套清理回滚**(保留同会话的「拖图到画板不入库」修复,那个独立且好用)。教训:**本机 WebView2 凡涉及 transform 容器内动态渲染的方案先别投入**,先拿最小例真机验渲染再开工。

附:v0.2.13 同批还做了浏览窗/便签 Alt+Tab+任务栏彻底隐身、素材保存路径设置、设置菜单挪编辑、来消息只闪任务栏、浏览窗几何存 outer_size——细节见 AGENTS.md「桌面工具」段。

发版套路同 [[chat-system]]：bump package.json+tauri.conf.json → commit → push main → tag v* 触发 CI。lib.rs/Cargo 改动必须 `npm run tauri dev` 重启重编（注意那个 Rust watcher 停摆老坑）。

发版套路同 [[chat-system]]：bump package.json+tauri.conf.json → commit → push main → tag v* 触发 CI。lib.rs/Cargo 改动必须 `npm run tauri dev` 重启重编（注意那个 Rust watcher 停摆老坑）。
