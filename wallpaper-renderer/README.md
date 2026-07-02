# Nobi 音频可视化壁纸渲染器

独立的 Chromium（Electron）进程，负责把音频频谱渲染成视觉。**刻意独立于 Nobi 主程序**：
Nobi 是 Tauri（WebView2），本机 WebView2 渲染不了实时 GPU 画布；而 Chromium 内核可以，
所以视觉层单独跑在这个进程里，通过本地 WebSocket 从 Nobi 取数据。

## 数据来源

Nobi 后端命令 `wallpaper_stream_start` 会在 `ws://127.0.0.1:17653` 起一个本地 WebSocket，
持续推两类 JSON 帧：

- `{ "type": "audio", "bands": [..48..], "peak": 0..1 }` —— 系统音频频段（~60fps）
- `{ "type": "track", "title, artist, album, cover }` —— 当前歌曲；`cover` 是 base64 data URL

没连上时页面显示待机呼吸动画（可单独验证 WebGL 是否正常渲染）。

## 运行（Phase 2 原型）

```bash
npm install
npm start
```

先在 Nobi 里调用 `wallpaper_stream_start` 开启推流，再启动本渲染器，放音乐即可看到实时反应。

## 许可

本模块整体按 **GPL-3.0-or-later** 分发。视觉层将改编自 [Mineradio](https://github.com/XxHuberrr/Mineradio)（GPL-3.0）。
