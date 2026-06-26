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

未提交、未发版(写完时)。
