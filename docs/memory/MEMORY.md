# Memory Index

- [Nobi 项目档案](gringotts-project.md) — 素材管理器全状态：功能清单、运行方式、数据/模型位置、待办与坑（gemma4:latest 损坏、fp32、图标生成先停 watcher）
- [3D 预览](3d-preview-plan.md) — ❌ 已彻底下线(ENABLE_3D=false、删 ModelViewer/three 依赖)；真机确诊本机 WebView2 呈现不了实时 GPU 画布(渲染/readback 好、实时画布闪一下就黑、只有文件图能显)；用户放弃,别再做
- [悬浮参考浮窗](floating-reference-window-plan.md) — ✅ MVP 已实现(827dede)：右键素材→桌面置顶透明小窗；记录实现位置/权限/防御坑与后续可加项（点击穿透等）
- [Dobby 分发 Nobi](dobby-nobi-distribution.md) — Nobi 下载入口在 Dobby 站 nobi.html(dobby-aih.pages.dev)；运行时调 GitHub API 取最新 Release,发版自动同步、无需动 Dobby；含正则/兜底常量维护点 + "不外露 git 跳转"约定
- [看球小窗](web-mirror-window-plan.md) — ✅ v0.1.13 重做：砍 iframe、改「直开」独立顶层窗(第一方,登录/全屏正常)+药丸搜索入口+全局键全家桶(Alt+1234/QWE/ZX/RSD/`,按需占用归还,按住连调)；含本机 WebView2 layered-alpha 一族坑的统一修法
- [内置翻译子系统](translation-system.md) — 三入口(桌面右键浮窗系统级钩子/应用内实验室/浏览器扩展)；引擎路由 Google→MyMemory→离线；dt=bd 免 key 拿字典释义；2026-06-15 本会话扩充五点(多语种划词/智能方向/备用源/离线双向/字典)
- [聊天子系统](chat-system.md) — ✅ 2026-06-15 从零搭：后端抽象层(Supabase 默认/自建服务器留接口)+并排多群独立窗+桌面拖图发送+Alt+C 可改老板键+看球窗 Alt+Tab 隐藏；Supabase 凭据走 .env.local 内置(只填名字+房间号)、24h pg_cron 阅后即焚卡免费额度；含 dev 重启坑/发图真机未终验
- [App.tsx 裸 NUL 隐患](app-tsx-null-byte.md) — src/App.tsx:194 嵌了真 0x00 当 chat key 分隔符→git 当二进制、Grep 需 -a；改 \0 转义即可零行为修复，用户暂缓只记着
- [金库模式](vault-mode-plan.md) — ✅ 发版 v0.3.0：浏览窗+便签隐秘防护，锁定态下主菜单/托盘/**首选项快捷键**三处都不出现入口(老板翻 Nobi 看不到功能存在)，连点版本号5下解锁；故意不持久化(重启回锁定)+用户明确先不要 PIN+暗号选版本号连点的取舍
- [桌面工具四件套路线](desktop-tools-roadmap.md) — Nobi 桌面专属功能：取色器✅/参考窗升级✅/首选项改键✅；批量命名❌全局截图改 Win+Shift+S❌。另「文档+导图」编辑器线：文档(Word/TipTap)✅发 v0.2.13、**思维导图(xmind)❌ 做了又撤、用户放弃**(Chrome 全对、本机 WebView2 节点文字不显示=transform 合成层渲染坑，已回滚)
