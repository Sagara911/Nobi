# Gringotts 架构与边界纪律

> 这份文档的目的：**防屎山**。每次加功能前先看这里，确认代码放对了层。
> 架构的核心保险：**会需要原生化/换实现的部分（计算）放在可替换的位置；难替换的部分（UI）恰好不需要替换。**

## 分层总览

```
┌─ UI（React + WebView）────────────────────────────┐
│  App.tsx        编排层：状态 + 动作组合 + 布局        │
│  panels.tsx     Dock 面板（只展示，不写业务）          │
│  components/    可复用组件（Inspector/MenuBar/弹窗…）  │
│  utils.ts       纯函数（颜色分桶/格式化，无副作用）      │
│  types.ts       共享类型（与后端 serde 对应）          │
├─ 边界 ──────────────────────────────────────────┤
│  api.ts         ★ 唯一的后端调用入口（typed invoke）   │
│  clip.ts        ★ CLIP/翻译推理（transformers.js）    │
├─ 后端（Rust，原生）────────────────────────────────┤
│  lib.rs         入口：模块声明 + 命令注册              │
│  db.rs          数据层（连接/迁移/公共查询）            │
│  library.rs     导入/标签/收藏/移除/导出               │
│  thumbs.rs      缩略图 + 主色调                       │
│  ai.rs          视觉 AI + Ollama 管理                │
│  search.rs      CLIP 存取检索 + 嵌入备用链路            │
│  settings.rs    Provider 配置                        │
│  collect.rs     采集 HTTP 服务 + 扩展导出              │
└──────────────────────────────────────────────────┘
外围：browser-extension/（采集插件）｜ Dobby（独立工具站，只联动不合并）
```

## 金字塔检验（架构健康的判断标准）

> 正金字塔：越往下越稳定、越标准、越不依赖具体框架；越往上越花哨、越可替换。
> 功能增多时，重量必须落在中上层（新模块/新面板），**地基（数据层）永不改变性质**。

```
  可替换 ▲   tldraw / dockview / virtuoso（第三方花活）
            panels / components（哑组件）
            App 编排 + api.ts（窄腰边界）
            Rust 核心模块（原生，按职责隔离）
  稳定   ▼   SQLite + 原位文件 + 可导出 JSON（纯标准格式，框架全死也无损）
```

### 倒置风险监控点（发现即处理）
1. **App.tsx 发胖**：超过 ~800 行 → 按功能切 hooks（useLibrary/useSearch/useAi…）。
2. **画板数据在 tldraw 私有格式里**（已知地基漏洞）：参考板内容由 tldraw persistenceKey 存浏览器存储。
   画板功能变重要后 → 把画板快照（editor.store.getSnapshot）定期写入我们的 SQLite。
3. **向量存 JSON 文本列**：万张级 → sqlite-vec/BLOB（已在下表）。
4. **重计算漂进 UI 层**：CLIP 是唯一被允许的例外（有下沉路径）；新的重活一律 Rust，不许出现第二个例外。

## 五条纪律（加功能前自查）

1. **重活进 Rust**：扫盘、数据库、文件 IO、网络服务、批处理——一律后端命令，不写进 React。
2. **invoke 只许出现在 `api.ts`**：UI 代码 import api 函数，不直接 `invoke()`。
   这样换实现（JS→Rust、 本地→云端）只改 api.ts 一处。
3. **表结构变更只许发生在 `db.rs::open_db` 的迁移区**：加列就在那里 `ALTER`，别处禁止。
4. **面板/组件不写业务**：panels/components 只接收 props/context 并转发交互；逻辑都在 App.tsx（或下沉后端）。
5. **数据永远标准格式**：原图原位存放、SQLite 元数据、可导出 JSON/CSV——保证 UI 技术随时可换、用户随时可走。

## 已知的"将来要挪"清单（按优先级）

| 项 | 现状 | 何时挪 | 怎么挪 |
|---|---|---|---|
| CLIP 图像/文本推理 | 前端 transformers.js（`clip.ts`） | 库到万张级、建索引变慢时 | Rust 侧 ONNX Runtime（ort/candle）实现同名命令；改 `api.ts` 两个函数指向后端即可 |
| 去重/检索 O(n²) | `search.rs` 余弦全比 | 万张级变慢时 | 换近邻索引（HNSW/usearch crate），接口不变 |
| 向量存储 JSON 文本列 | `assets.embedding/clip_embedding` | 同上 | 迁到 sqlite-vec/BLOB，`search.rs` 内部改 |
| Ollama 依赖 | 用户自装（设置面板一键下模型） | 打包发布时 | 路线 A：安装包内置 Ollama 运行时自动托管（见设计稿 8.x） |
| tldraw 水印 | 开发版显示 license 提示 | 商用发布前 | 购买 license 或评估替代 |

## 各模块职责一句话

**后端**
- `db.rs` —— 唯一知道表结构的地方；`Asset` 结构体与前端 `types.ts` 一一对应。
- `library.rs` —— "管"：导入三通道（选目录/拖路径/拖字节）、标签、收藏、导出。
- `thumbs.rs` —— 缩略图 400px 缓存 + 主色提取，`thumb-progress` 事件报进度。
- `ai.rs` —— `run_vision()` 是唯一的视觉调用核心；加 AI 功能 = 加 prompt，不碰核心。
- `search.rs` —— 向量存取与排序；不关心向量怎么算出来的。
- `settings.rs` —— `ai_config()/embed_config()`；配置读取只能经过这里。
- `collect.rs` —— 127.0.0.1:21420 采集服务；扩展文件 include_bytes 内嵌随程序走。

**前端**
- `api.ts` —— 后端边界；函数名与命令一一对应。
- `clip.ts` —— 浏览器内推理（fp32！q4 在 WebView2 会崩）；对外只暴露 `textVector/imageVector`。
- `App.tsx` —— 状态与动作；不含展示细节与纯算法。
- `panels.tsx` —— Dock 面板四件套 + `DockState` 上下文契约。
- `components/` —— 哑组件，props 进、事件出。

## 踩坑备忘（别再踩）

- WebView2 中 Tauri `dragDropEnabled` 会劫持全部 HTML5 DnD → 已关闭，文件拖入走 HTML5（拿不到路径，按字节导入）。
- transformers.js 模型必须 `dtype: "fp32"`，4-bit 量化报 `MatMulNBits` 错。
- tldraw 等库的内部 z-index 需要被 `.dock-host { z-index: 0 }` 堆叠上下文隔离。
- Ollama 同显存内来回换模型会極慢/超时 → 批处理与交互用同一个模型（gemma4:12b）。
- `gemma4:latest`（旧 9.6GB 版）视觉投影损坏，不可用。
