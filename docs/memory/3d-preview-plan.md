---
name: 3d-preview-plan
description: Nobi 3D 预览——已彻底下线(ENABLE_3D=false)；确诊本机 WebView2 无法呈现实时 GPU 画布；别再做了
metadata: 
  node_type: memory
  type: project
  originSessionId: 241b4d7b-0180-4bc7-85e6-4da59a4bcf67
---

**最终状态（2026-06-12，已下线，别再做）**：用户放弃 3D（"太麻烦"）。`ENABLE_3D=false`（utils.ts + db.rs），`isModel` 恒假→3D 不识别/不导入/不路由，相关分支成死代码。**已删** `ModelViewer.tsx/.css`、ModelPanel 停靠面板、App 的 modelViewer 状态/路由/context、`three`+`@types/three` 依赖（剪 8 包）。Inspector/网格卡/右键菜单里的 isModel 分支留着但永不触发（无害）。

**确定性诊断（2026-06-12 真机逐一验出，这是最终结论，别再走老路）**：本机 RTX 3060 / ANGLE-D3D11 下，**WebView2 无法持续呈现实时 GPU 画布**——
- WebGL 渲染 + readback：✅ 好（封面缩略图完美，证明渲染和读回都正常）
- 实时 `<canvas>` 上屏：❌ **第一帧闪一下就黑**（present 不下去）；浮层、普通停靠面板**都黑**（排除"浮层上下文"假说）
- `<img>` 贴**文件**(asset://)：✅（详情面板封面能显）；`<img>` 贴 **data:URL**：❌ 黑（兼容模式因此也黑）；实时 2D 画布：❌（历史验过）
- **唯一可靠显示路 = 渲染→存文件→当文件图显示**（封面就这么来的）
- 结论：实时交互 3D 在本机 WebView2 里走不通，挪面板/兼容模式/重做取景都救不了。要做只能：①系统查看器 `openPath`（独立窗，可靠，但 .fbx 关联缺失时打不开——用户实测"打不开"）②预渲染转盘到文件（伪3D）③原生 wgpu 渲染（重）。用户三者都不要了。

**黑屏案教训（重要）**：此前六轮修复全押在"WebView2 合成层"上（离屏 blit / readPixels / CPU 画布 / img 贴 data:URL 全试过，记录在 git d30da06→3289508）。但用户重做时的 `a91c1b3 make fbx models visible in viewer` + 关视锥剔除 + 重做取景表明，**真凶很可能是相机取景/视锥剔除把模型剔掉了**（FBX 单位/包围盒问题），而非合成层。教训：黑屏排查应先用"已知可见的测试三角形/立方体"区分"渲染管线问题"vs"取景问题"，再追合成层。
（注：若用户未来还报黑屏，再回到合成层假设；独立 WebviewWindow 方案仍是备选。）

**发版链路事实**：v0.1.2/v0.1.3 当年 CI 因 updater 签名密钥校验失败未发布（a507e65 在 workflow 加了 secrets 校验修复）；v0.1.4 起正常。release 流程=改版本→tag→push→CI 云端签名发布，latest.json 在 GitHub release 资产里，装机版与最新 release 同版本时不提示更新（正确行为）。

**待确认（2026-06-12 复盘新增）**：最终版 ModelViewer(3b2795c) 默认走实时 WebGL 上屏（`setCompatMode(false)`），并把当年判为坑的 `antialias`+`preserveDrawingBuffer` 又开回来了。**未向用户确认那台开发机上实时 canvas 现在到底显示没有**；若仍需手点「◫ 兼容」才看得到，注意兼容模式是 `<img>` 贴 `toDataURL` 的 data URL——正是六轮里被堵死的同一条通道，那台机上可能照样黑。结论二选一：①实时显示=真修好（兼容仅保险）；②仍需兼容=主路修好但兜底存疑。用户说"后需要改"。

**遗留/可加**：①批量为已有 3D 生成封面；②fbx 动画播放；③3D 的 CLIP 找相似（封面 PNG 可喂 CLIP，clip_targets 现排除 3D）；④gltf 外链贴图经 URLModifier 映射同目录（已实现，多文件场景留意）。
