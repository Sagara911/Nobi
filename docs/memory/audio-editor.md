---
name: audio-editor
description: Nobi 音频编辑窗（仿 Audacity 常用子集）实现位置/技术/边界（2026-06-25）
metadata: 
  node_type: memory
  type: project
  originSessionId: 085d3946-b8ed-452d-8534-32261e8b059b
---

2026-06-25 用户想要个"像 Audacity 的窗口工具"。结论：**全部功能不现实**(Audacity 20 年专业编辑器)，做了"容易+中等"子集。

**形态决策**：v0.4.1/4.2 一开始做成全屏浮层(ImageViewer 式)，**v0.4.3 应用户要求改成 dock 面板**(DOCK_COMPONENTS.audio，与画板/文档同级，可并排/拖拽)——AudioPanel 从 DockCtx 取 `audioAsset`+`onAudioSaved`，入口走 `setAudioAsset(...)+ensurePanel("audio","音频编辑")`(右键音频素材 / 窗口菜单)；AudioEditor 去掉 modal-overlay/onClose、改 height:100% 填面板、波形区 flex:1+ResizeObserver 自适应。工具栏也重排：走带/编辑/导出三行+分隔线，七个效果收进「加效果…」下拉(applyFx)。查证过：**自定义 `#[tauri::command]` 不受 capability 限制**(ref/chat 窗调自定义命令都没在权限文件里列)。

**实现**：
- [src/audio/dsp.ts]：纯函数(AudioBuffer 进出)。decode/clone/trim/deleteRange/silence/gain/normalize/fadeIn-Out/reverse/changeSpeed(线性重采样,变速连带变调)；离线渲染效果 filter(low/high/peaking BiquadFilter)/compress(DynamicsCompressor)/reverb(合成脉冲 Convolver 干湿混)/echo(DelayNode 反馈环)；genSilence/genTone；encodeWav(自写 16bit PCM)/encodeMp3(@breezystack/lamejs)；peaks(画波形)/fft(自写迭代基2,画频谱)。混响脉冲用确定性伪随机(Math.sin 派生)而非 Math.random。
- [src/components/AudioEditor.tsx]：浮层 UI。波形 canvas(峰值)/频谱图切换/拖拽选区/缩放(spp+viewStart)/播放头;播放(选区/整段/循环选区,AudioBufferSourceNode);撤销重做(AudioBuffer 快照栈,用 bufRef 镜像避免 StrictMode 更新函数里改 ref 双触发);效果参数走 window.prompt;录音(getUserMedia+MediaRecorder→decode);导出 WAV/MP3(saveDialog+saveFile)、另存为新素材(importBlob)、设为波形封面(setThumb 该资产)。
- 接线：[App.tsx] state `audioEdit`，音频资产右键「🎵 编辑音频」开浮层，onSavedNew→reload。CSS .audio-editor/.ae-* 在 App.css 末尾。lamejs ESM 同时导出 default 和具名，用**具名导入** `import { Mp3Encoder }`(对齐包自带 type.d.ts，删掉了我手写的冲突声明)。

**依赖**：新增 `@breezystack/lamejs`(纯 JS MP3 编码，无 SharedArrayBuffer/COOP-COEP 烦恼——故意没用 ffmpeg.wasm)。

**明确没做(用户问时再说)**：多轨混音、降噪/消人声/修复、VST/LADSPA/Nyquist 插件、FLAC/OGG 导出、**变速不变调/变调不变速**(需 SoundTouch 相位声码器，blind 集成风险高，暂用 changeSpeed 连带变调顶着)。

**校验**：tsc 退出 0；**完全没真机点测**——音频输出/各格式 decodeAudioData 支持度/MP3 编码/录音麦克风权限/频谱图正确性全未验，发版/合并前必须 `npm run tauri dev` 实测。WebView2 解码 flac/部分格式可能不支持(失败有提示，建议先转 wav/mp3)。
