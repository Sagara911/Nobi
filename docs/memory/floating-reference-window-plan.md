---
name: floating-reference-window-plan
description: Nobi「悬浮参考浮窗」——MVP 已实现（2026-06-11 commit 827dede）；记录实现位置与后续可加项
metadata: 
  node_type: memory
  type: project
  originSessionId: 241b4d7b-0180-4bc7-85e6-4da59a4bcf67
---

**已实现（MVP，2026-06-11，commit 827dede）**：把库里的图"拉到桌面"——独立的无边框/透明/永远置顶小窗，浮在绘图软件上方供画师参考。

实现位置：
- 入口：素材右键菜单「悬浮到桌面（置顶参考）」→ App.tsx `openRefWindow(asset)`，用 `WebviewWindow` 建 `ref-<id>-<seq>` 窗（decorations:false / transparent / alwaysOnTop / skipTaskbar / resizable）。
- 窗口内容：src/components/RefWindow.tsx + .css；main.tsx 按 `#ref` hash 路由。整图拖动整窗(`startDragging`)、右下角缩放(`startResizeDragging('SouthEast')`)、悬停顶栏含镜像/灰度/不透明度滑杆/关闭。可多开（label 唯一）。
- 权限：src-tauri/capabilities/ref-window.json（windows `ref-*`：start-dragging / start-resize-dragging / close / set-always-on-top）；default.json 加了 create-webview-window。
- 防御：`convertFileSrc` 和 `getCurrentWebviewWindow` 都惰性/try 包裹，无 Tauri（纯浏览器预览）也不致整窗空白。

**坑（已踩/已处理）**：RefWindow 在纯浏览器预览里因 convertFileSrc 抛错会空白渲染——已用 safeSrc 包裹；窗口级行为（建窗/置顶/透明/拖拽缩放/asset 协议载图）只能在真机 Tauri 验，vite 预览验不了。

**后续可加（未做）**：①点击穿透锁定（`setIgnoreCursorEvents(true)`，需加权限 allow-set-ignore-cursor-events）让鼠标穿到下面绘图软件；②真正的"拖拽"手势从网格拖出（现在走右键菜单）；③从画板/看图浮层也能开；④多浮窗位置记忆/排列。

与 [[3d-preview-plan]] 同属"第二个 WebviewWindow"类做法，可互相参考。
