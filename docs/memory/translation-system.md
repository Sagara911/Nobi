---
name: translation-system
description: Nobi 内置翻译子系统：三个入口（桌面右键浮窗/应用内实验室/浏览器扩展）、引擎路由（Google→MyMemory→离线）、dt=bd 字典释义、本会话扩充记录
metadata: 
  node_type: memory
  type: project
  originSessionId: bdbf4c62-e946-469c-8bad-4c8dab2fc5b8
---

Nobi v0.1.15 之后从 git 拉入的内置翻译子系统（[[gringotts-project]] 的一部分）。引擎集中在 `src-tauri/src/translation.rs`，所有入口都调它，不各自实现翻译逻辑。

**仓库内有权威文档**：`docs/TRANSLATION.md`（给 Codex/接手者读，AGENTS.md 已指向它）。代码当前在分支 `feat/offline-translation`（`758f124` 功能 + `0d08e87` 文档，已推 origin），**未合 main**。下面是本会话的实现笔记。

## 三个入口（触发方式 + 能力）

| 入口 | 触发 | 实现 | 备注 |
|---|---|---|---|
| **桌面右键浮窗**（划词翻译） | 任意程序里选中文字→右键，光标旁冒"译"药丸 | `selection_translate.rs` + `SelectionTranslateWindow.tsx` | **系统级**，靠 `WH_MOUSE_LL` 全局鼠标钩子 + UI Automation 读选区（兜底模拟 Ctrl+C 偷剪贴板）。`#[cfg(windows)]` **只在 Windows 生效**。要不要弹由 `looks_translatable` 判定 |
| **翻译实验室** | Nobi 应用内，`TranslationModal` | `TranslationModal.tsx` | 粘文本手动翻，带自定义词库 + 历史 |
| **浏览器扩展右键翻译** | 网页里右键 | `browser-extension/`（background.js / manifest.json） | 第三套 |

> 我（Claude）能调 Nobi 的 MCP + 读构建输出，但**无法在别的程序里真实右键**，所以桌面浮窗的"选中→冒泡→出译文"只能由用户手动验；编译和数据链可由我验。

## 引擎路由（`translate_text`）

- provider 选 `auto`（默认）：**Google → MyMemory → 离线兜底**链式。Google 接口（`translate.googleapis.com/translate_a/single`）国内常被墙，MyMemory（`api.mymemory.translated.net`，免 key）是第二道；都挂才回落离线。返回 `provider` 字段标明是谁答的（`online-google`/`online-mymemory`/`offline-fallback`）。
- 其它 provider：`online`（仅在线链）、`offline`/`builtin`（仅本地词典）、`model`（走 `ai_config` 的 OpenAI 兼容端点）。
- 目标语言传 `auto` 时 `resolve_target_lang` 按源语言反推方向：中文→英文，其它→中文。划词浮窗就传 `auto`。

## 字典释义（关键技巧）

Google 同一接口加 `dt=bd` 参数，**免 key** 就能拿到按词性分组的释义（`v[1] = [[pos,[terms…],…],…]`）。`parse_google_dictionary` 解析成 `DictionaryEntry{pos,terms}`，进 `TranslationResult.dictionary`。**只有单词/短词组**才有 `dt=bd` 数据，整句时为空 → UI 只显示译文。MyMemory 无字典。`v[1][i][2]` 里还带反查词/未展开的例句，将来想丰富可加。

## 本会话（2026-06-15）扩充记录

针对"翻译不全面"补了 5 点：
1. 划词从"仅英文"（旧 `looks_like_english_text`）改为 `looks_translatable`——任意语言≥2 字符就弹，只挡纯数字/符号。
2. `resolve_target_lang` 智能方向，浮窗 `targetLang` 从写死 `zh-CN` 改 `auto`。
3. 在线源从只有 Google 加 MyMemory 备用（链式）。
4. 离线词典 107→约180 词，且 `offline_translate` 加中→英（贪婪最长匹配 `offline_zh_to_en`），原来只英→中。
5. 加 `dt=bd` 字典释义（见上）。**三个入口前端都渲染了**：桌面浮窗、实验室、浏览器扩展（扩展还顺手把写死的 `targetLang:"zh-CN"` 改 `auto`，popover 加 `dict()`）。引擎层改进（备用源/离线扩充/双向/字典数据）三入口自动共享，因为都走 `translate_text`；扩展经 `/api/translate`（`mcp_api.rs`）。

6. 技术词误译修复：`is_code_like_token` 识别单个代码标识符（含数字/下划线/驼峰/路径，如 python3、ai_config、camelCase、src/main.rs）→ 原样保留（provider `verbatim`），不送在线翻译，避免 "python3→蟒蛇3"。普通英文词（python、apple）不受影响、照翻照给字典。`translation.rs` tests 模块加了 3 个单测（is_code_like_token / offline_zh_to_en / resolve_target_lang），全过。

7. **离线英汉词典 + 大模型翻句（ECDICT，2026-06-15 大改）**：英文查词改为**离线主力**。
   - 词典 = **ECDICT**（skywind3000/ECDICT，MIT，stardict 表：word/phonetic/translation/pos…）打包进安装包（`tauri.conf.json` bundle.resources += `resources/ecdict.db`），**不走首次下载**（github 在本机连不上，见下）。
   - ⚠️ **当前 `src-tauri/resources/ecdict.db` 是 12 词占位库**（`scripts/make-ecdict-fixture.mjs` 用 node:sqlite 造的，同 schema）。**发版前必须换成真库**：在能连 github 的网络下 `ecdict-sqlite-28.zip`(1.0.28) 解压出 stardict.db → 改名 `ecdict.db` 覆盖。~80MB，别提交进 git（建议 LFS 或本地替换）。
   - Rust：`translation.rs` 加 `ecdict_lookup`/`ecdict_db_path`（resource_dir → 开发期 `CARGO_MANIFEST_DIR/resources` → `NOBI_ECDICT_DB` 环境变量；缺库则优雅回落在线）、`parse_ecdict_translation`、`is_word_lookup`。`TranslationResult` 加 `phonetic` 字段。
   - **auto 路由**：单词/短语(en→zh,≤3词无标点) → ECDICT(provider `dict-offline`,带音标+多义项)；没命中 → 在线；**整句 → 本地大模型(provider_translate)优先 → 在线 → 离线小词典**。在线(Google→MyMemory)与 180 词小词典只作兜底。实测：apple→dict-offline+音标、render→多词性、serendipity(库无)→online、整句→local-openai。
   - 前端三入口都加了音标渲染（`phonetic`）。本地大模型整句翻译实测可用（provider=model 直接通）。
   - **没本地模型也 OK**：`ai_config` 默认 base=`http://localhost:11434/v1`，没装 Ollama→连接瞬拒→秒回落在线；`provider_translate` 加了 `connect_timeout(3s)`（总超时仍 45s 不掐生成），兜住"配了连不上的远程端点"原本白等 45s 的坑。即：查词永远离线词典、整句有模型走模型/没模型走在线。

8. **离线整句神经翻译（OPUS-MT / ort，2026-06-15 大改）**：句子也能纯离线翻，不依赖本地大模型或联网。
   - 引擎：`ort = "2.0.0-rc.12"`（onnxruntime，原生库 ort 自动下载/链接，缓存在 `%LOCALAPPDATA%\ort.pyke.io`，**疑似静态链接**——`target/debug` 只见 `DirectML.dll` 无 `onnxruntime.dll`，CPU EP 运行 OK）+ `tokenizers = "0.23"`(onig)。模块 `src-tauri/src/nmt.rs`（`mod nmt;` 已在 lib.rs）。
   - 模型：**Xenova/opus-mt-en-zh + opus-mt-zh-en 的量化(int8) onnx**，各 ~110MB、双向 ~214MB。token 常量两向一致：decoder_start=65000, eos=0, pad=65000, vocab=65001。贪心解码、O(n²)（用无 past 的 decoder.onnx，忽略 present.* 输出）。模型懒加载 + 全局 `Mutex<HashMap>` 常驻缓存，首句 ~1.4s。
   - **分发=按需下载（不打包）**：安装包保持小巧（基线 NSIS ~6MB），不塞 214MB。模型放 `<app_data>/com.nobi.app/models/opus-mt-{dir}/`，**首次用到才从 HuggingFace 下载**（github 被挡但 HF 通）。`nmt.rs::model_dir` 解析顺序：app_data/models → 开发期 `CARGO_MANIFEST_DIR/resources` → `NOBI_OPUS_MT_DIR`。命令：`nmt_status`（{enZh,zhEn} 是否已装）、`download_nmt_models`（缺哪个下哪个，发 `nmt-download-progress` 进度事件）。前端「翻译实验室」aside 有「离线翻译包」状态 + 下载按钮 + 进度。下载 encoder/decoder/tokenizer 三件，**tokenizer 下载后 Rust 端再置空 normalizer**（同打包补丁）。决策依据：安装包经 github 下发本就吃力，HF 可达性更好 + "语言包按需下载"是用户熟悉的模式 + 更新包小。
   - 开发期：模型已手动放到 `<app_data>/models/`（不在 resources，避免打包；也不进 git）。
   - ⚠️ **tokenizer.json 必须打补丁**：原文件 `normalizer={type:Precompiled, charsmap:null}` Rust tokenizers 0.23 加载会 panic → 已把 `normalizer` 置 null（英文源无影响）。换模型时记得同样处理。
   - 路由接入（`translation.rs`）：auto 整句 = **本地大模型 → 离线 NMT(`offline-nmt`) → 在线 → 离线小词典**；显式 `provider=offline` 整句也走 NMT、词走小词典。实测 en↔zh 双向质量良好。
   - ⚠️ **发版注意**：(a) 模型已改按需下载、**不进安装包也不进 git**；`resources/` 只剩 ecdict.db（仍是 12 词占位，发版前要换真库）。(b) `tauri build` 出包后在**干净机器**验证：装小包 → 应用内点「下载离线翻译包」能从 HF 拉成功 → 断网后离线翻句子可用；并确认 onnxruntime 原生库（静态/随包 DLL）真进了安装包，CPU EP 不依赖 DirectML.dll。(c) 整套已 `cargo build` 通过 + dev 实测（含模型从 app_data 加载、双向翻译），但**下载按钮的真实点击 + 发版安装包未验**（命令是 tauri invoke，没法 curl）。
   - 工具链已实测：`ort` 在本机能下 onnxruntime + 编译链接运行；HF(huggingface.co)/crates.io/pyke CDN 可达，**仅 github 被挡**（所以模型走 HF 不走 github）。

**验证踩坑**：本机另跑着已安装正式版（`%LOCALAPPDATA%\nobi\nobi.exe`）会占 21420 端口，导致 `tauri dev` 构建的 HTTP 服务起不来、所有请求（含扩展划词）打到老正式版——表现为 `/api/translate` 返回 "unknown api"（老版无此路由）。端到端验证前必须先关正式版、让 dev 构建独占 21420。两者抢同一端口，只能活一个。

**v0.2.9 加了划词右键翻译总开关**（有用户不想用）：工具→⚙设置→「划词右键翻译」（菜单 checked）。`selection_translate.rs` 的 `SELECTION_TRANSLATE_ENABLED`(AtomicBool) 门控 `handle_right_click`——关掉后 WH_MOUSE_LL 钩子仍跑但右键不弹翻译+藏浮窗；存 `selection_translate.json`，`start()` 先 `load_enabled` 再挂钩。命令 `get/set_selection_translate_enabled`，前端 `api.*`。详见仓库 AGENTS.md「划词右键翻译开关」段。

未做（用户问过、留待按需）：反向释义/例句展开（`dt=ex`/`v[1][i][2]`）；音标（`dt=bd` 不带 IPA，需 `dt=rm` 或换源）；划词改"悬停/选中自动冒"（有道式，更顺手但易误触）；接有道智云为在线源（需 appKey/appSecret 签名，非免 key）；MyMemory 备用源未真实触发实测（仅 Google 挂才走）。
