# 翻译子系统

Nobi 内置翻译。引擎集中在 `src-tauri/src/translation.rs`，所有入口都调它，不各自实现。
本文件给接手的智能体/开发者快速建立全貌 + 发版前必做项。

> 状态：在分支 `feat/offline-translation`（提交 `758f124`），**尚未合并 main**。发版前有必做项（见末尾）。

## 三个入口

| 入口 | 触发 | 实现 |
|---|---|---|
| 桌面右键浮窗（划词翻译） | 任意程序选中文字→右键，光标旁冒"译"药丸 | `selection_translate.rs`（`WH_MOUSE_LL` 全局鼠标钩子 + UI Automation 读选区，仅 Windows）+ `src/components/SelectionTranslateWindow.tsx` |
| 翻译实验室 | 应用内 | `src/components/TranslationModal.tsx`（手动翻 + 词库 + 历史 + 离线包下载入口） |
| 浏览器扩展右键翻译 | 网页右键 | `browser-extension/background.js`（POST `127.0.0.1:21420/api/translate`） |

三入口前端都渲染：译文 + 音标(`phonetic`) + 字典释义(`dictionary`，按词性分组)。

## 路由（`translate_text`，provider=`auto` 默认）

1. **代码标识符**（`python3`/`ai_config`/`camelCase`/`snake_case`/路径）→ 原样保留（provider `verbatim`），不送翻译，避免被翻成"蟒蛇3"。`is_code_like_token`。
2. **单词/短语**（≤3 词、无句末标点，en→zh）→ **离线 ECDICT 词典**（`dict-offline`，带音标+多义项）；没命中 → 在线（Google `dt=bd` 还给字典）→ 离线小词典。
3. **整句** → **本地大模型**（Ollama，`provider_translate`）→ **离线 NMT**（`offline-nmt`）→ 在线 → 离线小词典。
4. 目标语言传 `auto` 时 `resolve_target_lang` 按源语言反推：中文→英文，其它→中文。

显式 provider：`online`（Google→MyMemory）、`offline`（整句走 NMT、词走 ECDICT/小词典）、`model`（本地 LLM）。

## 在线引擎

`online_translate` 链式：**Google**（`translate.googleapis.com/translate_a/single`，`dt=t`+`dt=bd` 拿字典）→ 失败 → **MyMemory**（`api.mymemory.translated.net`，免 key）。仅作兜底，不是主力。

## 离线英汉词典（ECDICT）

- 数据：[ECDICT](https://github.com/skywind3000/ECDICT)（MIT），SQLite `stardict` 表（`word/phonetic/translation/pos/...`）。
- 打包在 `src-tauri/resources/ecdict.db`（已在 `tauri.conf.json` bundle.resources）。
- ⚠️ **当前是 12 词占位库**（`scripts/make-ecdict-fixture.mjs` 用 node:sqlite 造的，同 schema）。**发版前必须换真库**：在能连 github 的网络下 `ecdict-sqlite-28.zip`(release 1.0.28) → 解压 `stardict.db` → 改名 `ecdict.db` 覆盖。`*.db` 已 gitignore，不入库。
- 代码：`translation.rs::ecdict_lookup`/`parse_ecdict_translation`（按 `\n` 拆义项、行首词性）/`is_word_lookup`。

## 离线整句翻译（OPUS-MT 神经模型）

- 引擎：`ort`（onnxruntime）+ `tokenizers`。模块 `src-tauri/src/nmt.rs`。
- 模型：HF `Xenova/opus-mt-en-zh` + `opus-mt-zh-en` 的**量化(int8) onnx**，各 ~110MB。贪心解码（用无 past 的 `decoder.onnx`，忽略 `present.*` 输出）。token 常量两向一致：`decoder_start=65000, eos=0, pad=65000`。模型懒加载 + 全局 `Mutex<HashMap>` 常驻，首句 ~1.4s。
- **分发 = 按需下载（不打包、不入库）**：模型放 `%APPDATA%\com.nobi.app\models\opus-mt-{dir}\`，首次用到才从 HF 下载。
  - 命令：`nmt_status`（{enZh,zhEn} 是否已装）、`download_nmt_models`（缺哪个下哪个，发 `nmt-download-progress` 进度事件）。注册在 `lib.rs` invoke_handler。
  - 前端：翻译实验室 aside 有「离线翻译包」状态 + 下载按钮 + 进度。
  - `model_dir` 解析顺序：app_data/models → 开发期 `CARGO_MANIFEST_DIR/resources` → 环境变量 `NOBI_OPUS_MT_DIR`。缺则返回 None → 上层回落在线。
- ⚠️ **tokenizer.json 必须打补丁**：HF 原文件 `normalizer={type:Precompiled, charsmap:null}`，Rust tokenizers 0.23 加载会 panic → 下载后在 Rust 端把 `normalizer` 置 null（英文源无影响）。`download_dir` 已做；换模型时注意。

## 构建/网络要点

- `ort` 首次编译会下 onnxruntime 原生库（缓存在 `%LOCALAPPDATA%\ort.pyke.io`，之后离线复用）；疑似静态链接（`target/debug` 只见 `DirectML.dll`，CPU EP 运行正常）。
- 本机/网络实测：**crates.io / HuggingFace / pyke CDN 可达，仅 github 被挡**——所以模型走 HF 不走 github（在线翻译走 Google/MyMemory）。
- `git push` 实测可用（与 curl 走不同路径）。

## 发版前必做（合并 main 之前）

1. **换真 ECDICT 词典**（占位库只有 12 词）。
2. `tauri build` 出包后**在干净机器验证**：装小包（基线 ~6MB，不含模型）→ 应用内点「下载离线翻译包」从 HF 拉成功 → **断网后离线翻句子可用**；并确认 onnxruntime 原生库真进了安装包。
3. 下载按钮的真实点击未验（命令是 tauri invoke，没法 curl）；离线 NMT 已在 dev 用 `provider=offline` 实测中英双向可用。
4. 单测在 `translation.rs`（技术词识别/离线反向/智能判向/ECDICT 解析），`cargo test --lib translation` 全过。
