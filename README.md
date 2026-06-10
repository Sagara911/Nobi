# 🧝 Nobi（诺比）

> AI 驱动的本地美术素材库 —— "会用 AI 的 Eagle"。
> 把图原样存在你硬盘里、能用大白话搜、导入即自动打标签，还能反推 AI 提示词。

与处理工具 **Dobby**（[dobby-aih.pages.dev](https://dobby-aih.pages.dev/)）是一对小精灵：
**Dobby 负责处理（工坊），Nobi 负责收纳（素材库 + 搜索 + AI + 画板）。**

---

## ✨ 核心特性（规划）

- 📦 **本地管理**：扫描文件夹/拖入，文件原样存硬盘，**绝不锁定你的数据**（元数据可一键导出）
- 🏷 **多级标签** + 批量打标/重命名
- 🔍 **AI 语义搜索**：用大白话搜图、以图搜图（本地 CLIP/SigLIP）
- ✨ **AI 能力**：自动打标签、生成描述、反推绘画提示词、画面分析（本地 Gemma 4，或接自己的 DeepSeek/GPT key）
- 🎨 **颜色/配色筛选**、**视觉近似去重**
- 📌 **内置参考板**：选图一键生成 PureRef 式无限画布拼贴

详见设计稿：[`docs/美术素材管理器-设计思路.md`](docs/美术素材管理器-设计思路.md)

---

## 🛠 技术栈

| 层 | 选型 |
|----|------|
| 桌面壳 | Tauri 2.0（Rust） |
| 前端 | React 19 + TypeScript + Vite |
| 元数据 | SQLite |
| 向量检索 | sqlite-vec |
| 本地 AI | Ollama / llama.cpp（GGUF）；嵌入用 CLIP/SigLIP |

---

## 🚀 开发

### 前置依赖
- [Node.js](https://nodejs.org/)（已具备）
- [Rust](https://www.rust-lang.org/tools/install)（**桌面端编译需要，尚未安装**）
- Windows 还需 **Microsoft C++ Build Tools**（MSVC）

### 命令
```bash
npm install            # 安装前端依赖
npm run dev            # 仅启动前端（Vite，浏览器预览，无需 Rust）
npm run tauri dev      # 启动桌面应用（需要 Rust）
npm run tauri build    # 打包
```

---

## 📍 路线图

- **阶段一（MVP）**：扫描入库 → 缩略图网格 → 文件夹/多级标签 → 基础搜索 → 颜色筛选 → 元数据导出
- **阶段二**：语义搜索（向量）→ 视觉去重 → 来源记录 → 参考板 → 可选云端 AI
- **阶段三**：浏览器采集插件 → AI 扩展能力 → 视频/3D 预览 → 云同步/移动端

---

*Dobby 负责处理，Nobi 负责收纳。* 🧦🧝
