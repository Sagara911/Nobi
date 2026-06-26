---
name: library-portability-features
description: Nobi「拖出/以图搜图/库备份」三件套实现状态与设计取舍（2026-06-25 本会话）
metadata: 
  node_type: memory
  type: project
  originSessionId: 085d3946-b8ed-452d-8534-32261e8b059b
---

2026-06-25 用户要「补常用功能」，确认推荐三件「第一梯队」全做。开工先核查，结论与实现：

- **以图搜图（外部图/截图反查库）——早已存在，没重做**。入口在 [panels.tsx] GridPanel 搜索栏的 `.rev-search-zone`（🖼 以图搜图，可拖图/点选），走 `reverseSearchByFile` → `imageVector`(CLIP) → `clipSearch`。本会话只确认，未改。
- **拖出到外部应用（PS/资源管理器）——本会话新增**。用 `tauri-plugin-drag`（crate 2.1.1 + npm `@crabnebula/tauri-plugin-drag` 2.1.0，原生 OLE DoDragDrop，与 WebView2 合成层无关、不踩本机那串渲染坑）。链路：[panels.tsx] GridCard `draggable={!a.missing}` + onDragStart(preventDefault 取消 HTML5 拖 → `d.dragOut`) → [App.tsx] `dragOut`(多选则整批，过滤 missing) → [api.ts] `dragOutFiles(paths, icon)` = `startDrag({item, icon, mode:"copy"})`。icon 用缩略图(无则原图)。权限：default.json 加 `drag:allow-start-drag`；插件在 lib.rs builder `.plugin(tauri_plugin_drag::init())`。**编译过了但拖放是交互手势，未真机验证**——发版前手动拖一张到桌面/PS 确认。
- **库备份/迁移——本会话新增**。新模块 src-tauri/src/backup.rs：`export_library(destDir)` 把 nobi.sqlite + thumbnails/ 拷到 `destDir/Nobi备份-<ts>/` 并写 nobi-backup.json 清单；`import_library(srcDir)` 校验→当前库改名留底 `nobi.sqlite.bak-<ts>`→覆盖 db+缩略图→清 -journal。**故意只备份「数据库+缩略图」不含原图**（Nobi 不持有原图，原图在各自目录/图片\Nbi，需另备；缩略图在即使原图缺也能显示、元数据零丢失）。无新依赖、纯 std::fs。入口在 [App.tsx] 文件(F) 菜单：💾 备份库 / 📥 从备份恢复（恢复后 reload，建议重启）。**命令编译过，运行时未点测**。

校验：`npx tsc --noEmit` 退出 0；`cargo check` 完成（仅 3 个预存 `tauri::Manager` 未用警告，非本次引入）。未提交、未 bump 版本——用户没说发版，留给他按 [[release-process]] 自己 bump+tag。

**组合筛选 + 智能文件夹（2026-06-25 同会话续做，用户要的）**：把原来单一 `filter: Filter`（一次只一个条件）重构成 **`scope: Scope`(互斥基础集:all/missing/trash/collection) + `conds: Cond[]`(AND 叠加:tag/folder/color/favorite/type)**。规则：切作用域=清空 conds（“去到某处”）；点 tag/配色/收藏/类型/文件夹=在 conds 里加/减（组合筛选）；任何筛选交互都清 semanticIds。[App.tsx] 重写 matchesScope/matchesCond/matchesAll、isActive/setFilter/toggleFilter/filterLabel/condLabel + saveSmartFolder/applySmartFolder/deleteSmartFolder。UI：[panels.tsx] GridPanel 搜索框下方 `.cond-bar`（叠加条件 chip 可✕、清空、＋存为智能文件夹）；LibraryPanel 新增「智能文件夹」Section（🔎 一点重现、✕ 删）。[TagTree.tsx] activeValue→isActive 谓词（支持多标签高亮）。**智能文件夹存 localStorage `nobi-smart-folders-v1`，按机器、不随库备份迁移**（folder 条件含绝对路径换机也失配；标签/配色/收藏/类型可迁），轻量可重建的取舍。CSS 加在 App.css 末尾。tsc 退出 0；未真机点测。

**又一批五件（2026-06-25 同会话，用户「这五个全做」；SD/ComfyUI 提示词解析因 AI 生图占比不高而暂不做）**：
1. **自动后台建 CLIP 索引**：[App.tsx] `autoBuildIndex`(useCallback)+`indexingRef` 防并发，启动 3s 后 & assets.length 变化(导入)后 setTimeout 触发；逐张 setClipEmbedding 之间 `await setTimeout 0` 让出主线程；不占 busy、静默。手动 buildIndex 也走同一 indexingRef。解决「语义/以图搜图/找相似/去重」以前要手动点「建立语义索引」才可用的痛点。
2. **复制图片到剪贴板(位图)**：[utils.ts] `copyImageToClipboard(src)` canvas→PNG blob→`navigator.clipboard.write([ClipboardItem])`；右键菜单「复制图片（粘贴用）」(仅图片)。
3. **键盘翻图**：[App.tsx] 末尾 useEffect，←→/↑↓ 选上/下一张、Enter/Space 看大图、Delete 移回收站；输入框/编辑区/看图浮层开着时不抢键。**未做选中项自动滚动入视野**(virtuoso 没接 ref，待补)。
4. **按元数据筛选**：扩 `Cond`(+`Filter`) 加 `format`/`orient`(land/port/square,阈值 r>1.15、r<0.87)/`big`(长边≥2000)，插进组合筛选；[panels.tsx] 侧栏「属性筛选」Section(横/竖/方/大图/各格式 chip，格式从库里 a.format 大写集去重得)。注意 a.format 存大写。
5. **标签管理(重命名/合并/删除)**：[library.rs] `rewrite_tags_all`+`rename_tag`(to 已存在即合并、去重)/`delete_tag`，全库遍历 tags JSON 改写(先 collect 行再 update 避免 stmt 借用冲突)；[components/TagManagerModal.tsx] 列表+筛选+逐个重命名/删除；编辑菜单「🏷 标签管理…」。api.ts renameTag/deleteTag。

校验：tsc 退出 0；cargo check 干净(仅 3 个预存 Manager 警告)。坑修复：condKey 用 `"value" in c` 兼容无值条件(favorite/big)；新 cond 种类要同步加进 `Filter` 联合(isActive/toggleFilter 参数类型)。均未真机点测。

待做（用户当时没选的第二/三梯队）：星级评分+备注、选中批量后处理(转格式/缩放)、回收站已存在(trashed_at)、按元数据筛选(尺寸/格式/大小/日期，可作为新 Cond.kind 加进组合筛选)、视频/GIF 悬停 scrub、读 SD/ComfyUI 提示词元数据。另：备份可升级为含原图/打 zip；智能文件夹可改存 SQLite settings 表让它随备份走。
