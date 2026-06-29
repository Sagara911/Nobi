---
name: pet-agent
description: Nobi 桌宠助手（转 codex/claude CLI 干活）实现位置/设计/坑（2026-06-26）
metadata: 
  node_type: memory
  type: project
  originSessionId: 085d3946-b8ed-452d-8534-32261e8b059b
---

2026-06-26 用户想要个"桌宠"——说人话，它转给 **codex / claude CLI** 真去干活（中转壳）。**嵌进 Nobi**（不单独做应用），形态是 Nobi 拉起的**置顶浮窗**(label `pet`，不是 dock 面板——dock 会被关在主窗里，没桌宠味)。论证过：壳子用什么语言无关（活是 CLI 干的），Tauri/Rust 最顺，**不用 C++**。

**实现**：
- [src-tauri/src/agent.rs]：`AgentState{pid:Mutex<Option<u32>>}` managed；`agent_check(agent,bin)` 跑 `--version` 探测；`agent_run(opts)` 起子进程、两条线程流式读 stdout/stderr → emit `agent-output{stream,line}`，独立线程 wait → emit `agent-done{code}`；`agent_cancel` 按 pid 杀(taskkill /T /F)。**Windows 经 `cmd /C` 调**(npm 全局是 codex.cmd，CreateProcess 找不到 .cmd)。权限档→codex `--sandbox read-only|workspace-write|danger-full-access`；claude 暂只 `-p`(stub)。
- [src-tauri/src/lib.rs]：`mod agent` + manage + 注册 3 命令 + `open_pet_window`(建 pet 窗，**transparent(false)**——本机 WebView2 透明窗 layered-alpha 坑，先不透明稳妥；decorations(false)+always_on_top+skip_taskbar，仿 open_chat_launcher 的隐藏建窗→show)。
- [capabilities/pet-window.json]：windows ["pet"]，core:default + 窗口控制 + dialog:default。
- [src/main.tsx]：`#pet` 路由 → PetWindow。[src/components/PetWindow.tsx + .css]：自绘标题栏(data-tauri-drag-region 拖动)、设置(agent/权限/工作目录/可执行路径，存 localStorage `nobi-pet-settings-v1`)、流式气泡、发送/停止；listen agent-output/agent-done。[src/api.ts]：agentCheck/agentRun/agentCancel/openPetWindow。入口：窗口菜单「🧚 桌宠助手」。

**前提**：用户机器要装 `npm i -g @openai/codex` + `codex login`(或 OPENAI_API_KEY)。没装 agent_check 报错、气泡提示。

**校验**：tsc 0、cargo check 干净(仅 3 个预存 Manager 警告)。**完全没真机跑过**——codex 实际调用、cmd/C 对带特殊字符 prompt 的引号处理、流式回显、透明/置顶窗在本机的表现，全待测。

**明确没做(v2)**：stream-json 结构化解析(看工具调用过程)、逐动作气泡审批(exec 非交互模式难做)、Claude 权限映射、宠物动画/语音、读 Nobi 上下文(可让它调 [[gringotts-project]] 里的 nobi MCP `nobi_search` 联动)。

**v0.4.5 精修定稿**(2026-06-26)：折叠态 **60px 透明圆角小图标**(open_pet_window `transparent(true)`+`shadow(false)`，首开 setSize 强制方形防椭圆)；可拖动(mousedown 阈值判定拖/点，startDragging)+松手**吸附最近屏幕边**(rAF 缓动飘移)+**记住手动位置**(localStorage `nobi-winky-pos-v1`)；展开按图标所在屏(monitorForPoint 按坐标查屏，避开多屏接缝歧义)**自动定方向**(右→左/左→右/上下半)，**rAF 逐帧 fire-and-forget 平滑长大**(awaited setSize 会卡，必须 rAF+不 await)；收起回记忆位置。logo 改成 **WinkyLogo 终端表情**(SVG，参考图样式：`>` 左眼 polyline + `_` 嘴 line + 右眼位状态符号)，phase 状态机：idle `>_`(光标闪)/waiting `>_•`/running `>_…`(三点呼吸)/done `>_✓`(2.5s 回 idle)；坐标是用户在 artifact 调试台(winky-face-tuner)调好烘进的(eye 26,43/36,51/26,59；mouth 42→60 @72.5；stroke 5.75；sym 中心 69.5,50)。气泡 UI(用户右金/Winky 左灰带头像，过程折叠 details)。pet-window.json capability 补了 set-resizable/set-position/outer-position/outer-size/current-monitor/primary-monitor/hide/start-dragging。**已发版 v0.4.5。仍未真机端到端验 codex 实跑**。

**v0.4.6 收起动画修瑕疵**：收起时若用 animateBox 逐帧缩窗口，透明窗"圆角 alpha 裁切跟不上每帧 resize"→末尾右上角(缩放支点)闪成实心直角(本机 WebView2 老坑)。改法：收起的可见"缩小+淡出"全用 **CSS transform**(`.pet.closing { opacity:0; transform:scale(0.2) }`，transform-origin=展开方向那个角，GPU、圆角整体缩不抠角)，窗口**只在 `.pet` 已透明后(setTimeout 200ms)一步 setSize 到 ICON**——可见动画期间不 resize 窗口，根除直角。展开仍用 animateBox(变大没人抱怨直角)。收起 setClosing(true)→等 CSS→setSize/移位→setCollapsed(true)(图标 winky-in 淡入)。

**v0.5.0 大改：Winky = 完整 AI 助手 + Petdex 动画桌宠**(2026-06-29 本会话，已发版)。

### A. API 聊天(与"转 CLI 干活"并行的第二条路)
- [agent.rs] `chat_send`(async，OpenAI 兼容 `/chat/completions`，`stream:true` 逐行 `data:` 解析 → emit `chat-delta`；命令整段流完才 resolve，前端 await 返回=说完、reject=出错)+ `chat_cancel`(代数计数器 `ChatState.gen` 打断)。ChatMsg.content 是 `serde_json::Value`(纯文本=字符串，看图=OpenAI vision 数组)。
- **路由**(PetWindow `sendText`)：纯文字→聊天；`/` 开头→CLI 干活(原 agentRun 不动)；`//`→字面 `/` 聊天；带图/文件→强制聊天。多轮记忆从 log 里挑 via==="chat" 拼 messages，system=当前技能提示词。
- **多套 API**：ChatCfg=`{profiles:ApiProfile[],activeId,skills,activeSkillId}`，存 localStorage `nobi-winky-chat-v1`，旧单配置自动迁移；CHAT_PRESETS 预置 OpenAI/DeepSeek/智谱/Kimi/通义。

### B. 工具(都是"抓回资料拼进 prompt"，模型本身不联网)
- **读链接**：消息里 URL 自动抓→`fetch_url_text`(直抓去 HTML；正文 <200 字或抓不到→走 `r.jina.ai` 阅读器兜底渲染 SPA/反爬，免 key，代价网址过第三方)。
- **🌐 联网搜索**：开关→`web_search`(DuckDuckGo html 端点无 key，解析 result__a/__snippet)。
- **📁 查素材库**：开关→[library.rs] `winky_search_library`(SQL LIKE 搜 name/tags/caption/author/folder)。
- **看文件**：拖非图/📎选→`extract_file_text`(字节或路径；PDF=`pdf-extract` crate，office=`zip` crate 解 XML 去标签，txt/md/csv 直读)。**新依赖 pdf-extract+zip**。
- **看图**：拖图/Ctrl+V→vision 数组；**DeepSeek 文本模型不支持(image_url 400)**，需 gpt-4o/qwen-vl-max/glm-4v，出此错前端提示换视觉模型。

### C. 技能(替代旧 personas)
- Skill=`{id,name,prompt,web?,lib?,builtin?}` 可增删改，**选中=换提示词+自动开它绑的联网/查库**；内置 7 个(助手/翻译/润色/起名/写码/查资料(web)/找素材(lib))种子进 chatCfg.skills；标题栏下拉快切，⚙技能页编辑。

### D. 聊天 UI
- **自写轻量 Markdown**(MarkdownText：```代码块带复制+行内code/粗体+pre-wrap，没引 react-markdown)；助手气泡 hover 出📋；末条 **↻重新生成**(砍上轮重问，传 baseLog 避免陈旧)；**🧹新对话**清空。
- 设置改**标签页浮层**(cfgTab api/skill/skin/work)：`.pet-body` relative+`.pet-cfg` absolute inset:0 z10 盖在聊天上(不再顶下去)；标题栏弃 data-tauri-drag-region(本机不稳)改 **mousedown 手动 startDragging**；`.pet-cfg` 手动接管 wheel(同 chat-list 老坑)；输入框文字垂直居中(line-height=height+去 padding)。

### E. 皮肤 = Petdex 宠物(扒了格式直接吃)
- **格式**(`npx petdex install <slug>`→`~/.codex/pets/<id>/`+`~/.petdex/pets/`)：`pet.json`(极简`{id,displayName,description,spritesheetPath}`，**不含网格**)+ `spritesheet.webp` 或 **.png**(8列×9行/帧 192×208/1536×1872)。行→动作(clawdex 权威表)：0idle/1run-right/2run-left/3wave/4jump/5failed/6wait/7run/8review。授权 CLI=MIT，宠物=粉丝创作(公开发版 IP 风险→内置只挑原创向)。
- **PetSprite**：JS 定时器逐帧切 backgroundPosition；帧速可调(fps state `nobi-winky-fps-v1` 默认 6/2–30)。
- **内置预设**(打包 `public/pets/<id>/` 前端直 URL)：paperclip/bolt-2/white-zuccitchi/code-default(**png**)。
- **Rust 命令**：`winky_list_pets`(扫两目录认 webp/png)、`winky_read_pet_sheet`(→data URL，webp/png 各对 mime)、`winky_install_pet`(后台 `npx -y petdex install <slug>`，slug 校验防注入)、`winky_delete_pet`(两目录清)。
- **设置里在线装**：🐾 皮肤页输名字点装(extractSlug 从整条 `npx petdex install xxx`/`irm .../install/xxx`/光名字 抠 slug)；↻刷新；🗑删自定义；选 默认终端脸/内置/已装。
- **行为**：折叠态待机每 5–8s 随机 fidget(跳/挥手/审阅，播完整轮回 idle、时长按帧速算)；拖动→按方向走路(起手光标 dx 定向+onMoved 修正)；出错→failed 沮丧；**每只独立"镜像左右"开关**(`nobi-winky-flip-v1` 修作者画反的，只对该 id)；**大小可调**(滑条+数字框 `nobi-winky-size-v1` 44–200，ICON→petSizeRef 几何全跟随)。

**校验**：tsc 0+cargo clean(仅 3 预存 Manager 警告)。**真机**：本会话边做边验——文字聊天(DeepSeek)、皮肤切/动画/走路/缩放/速度、在线装/删宠物都过；看图需视觉 Key、文件/联网/查库待多验。**坑**：旧 nobi.exe 残留→新命令"not found"(在跑旧二进制)→清干净重编;在线装宠物需本机 Node。
