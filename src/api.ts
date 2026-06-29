// ============================================================
// 后端命令边界层：所有 invoke 调用必须经过这里（见 docs/ARCHITECTURE.md）。
// 价值：前端其余代码不知道"实现在哪"。将来把某能力下沉到 Rust /
// 换云端 API / 换模型，只改这一个文件（或它调用的实现），UI 零改动。
// ============================================================

import { invoke } from "@tauri-apps/api/core";
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import {
  enable as autostartEnable,
  disable as autostartDisable,
  isEnabled as autostartIsEnabled,
} from "@tauri-apps/plugin-autostart";
import type {
  AiCfg,
  AiCmd,
  AiStatus,
  Asset,
  ClipTarget,
  Collection,
  GlossaryTerm,
  GlossaryTermInput,
  TranslationHistoryItem,
  TranslationRequest,
  TranslationResult,
} from "./types";

// ---- 看球直开窗 ----
export const webOpenDirect = (url: string) => invoke<void>("web_open_direct", { url });
export const setWebSearchEngine = (engine: string) =>
  invoke<void>("web_set_search_engine", { engine });
// 看球快捷键自定义：取/改/恢复默认。get 返回 [动作, 加速键] 列表（保持展示顺序）
export const webGetKeys = () => invoke<[string, string][]>("web_get_keys");
export const webSetKey = (action: string, accel: string) =>
  invoke<void>("web_set_key", { action, accel });
export const webResetKeys = () => invoke<void>("web_reset_keys");

// 聊天老板键：取当前加速键 / 改键（accel 格式如 "Alt+KeyC"）
export const chatGetBossKey = () => invoke<string>("chat_get_boss_key");
export const chatSetBossKey = (accel: string) =>
  invoke<void>("chat_set_boss_key", { accel });
// 聊天窗透明度键（可改）：get 返回 [调淡键, 调浓键]
export const chatGetOpacityKeys = () => invoke<string[]>("chat_get_opacity_keys");
export const chatSetOpacityKey = (which: "down" | "up", accel: string) =>
  invoke<void>("chat_set_opacity_key", { which, accel });

// 金库模式（隐秘防护）：锁定态下主菜单/托盘都不出现「浏览窗/便签」入口。
// 解锁靠前端「连点版本号」暗号；后端不持久化，每次启动默认锁定。
export const vaultGet = () => invoke<boolean>("vault_get");
export const vaultSet = (unlocked: boolean) => invoke<void>("vault_set", { unlocked });

// 开机自启（Tauri 官方插件；Windows 走注册表 HKCU Run）
export const getAutostart = () => autostartIsEnabled();
export const setAutostart = (on: boolean) =>
  on ? autostartEnable() : autostartDisable();

// 划词右键翻译总开关
export const getSelectionTranslateEnabled = () =>
  invoke<boolean>("get_selection_translate_enabled");
export const setSelectionTranslateEnabled = (enabled: boolean) =>
  invoke<void>("set_selection_translate_enabled", { enabled });
// 聊天未读提醒（托盘红点 + 任务栏闪烁）：来新消息 +1（label=对应群窗，没开则闪主窗）/ 看了清零
export const chatBumpUnread = (label?: string) =>
  invoke<void>("chat_bump_unread", { label });
export const chatClearUnread = () => invoke<void>("chat_clear_unread");

// 桌面取色器：手动取一次光标处屏幕颜色（热键走 "color-picked" 事件，不经此）
export interface ColorPick { hex: string; r: number; g: number; b: number }
export const pickCursorColor = () => invoke<ColorPick>("pick_cursor_color");

// 桌面工具常驻热键改键（首选项面板）：get 返回 [取色键, 参考窗穿透键]
export const toolGetKeys = () => invoke<string[]>("tool_get_keys");
export const toolSetKey = (which: "color" | "ref", accel: string) =>
  invoke<void>("tool_set_key", { which, accel });

// ---- 素材库 ----
export const listAssets = () => invoke<Asset[]>("list_assets");
// 失效链接检测：移出加载热路径，前端进入后台单独跑（大库时逐条 stat 会卡死首屏）
export const checkMissing = () => invoke<number[]>("check_missing");
export const importFolder = (path: string) => invoke<number>("import_folder", { path });
// 导入前数一下文件夹里多少媒体文件（给体量确认用，不入库）
export const countFolderMedia = (path: string) => invoke<number>("count_folder_media", { path });
// 按需生成单张缩略图+配色（网格卡片可见时调）
export interface ThumbOut { thumb: string; colors: string[] }
export const ensureThumb = (id: number) => invoke<ThumbOut>("ensure_thumb", { id });
export const importPaths = (paths: string[]) => invoke<number>("import_paths", { paths });
export interface ImportedBlob {
  path: string;
  name: string;
  width: number;
  height: number;
}
export const importBlob = (name: string, dataB64: string) =>
  invoke<ImportedBlob>("import_blob", { name, dataB64 });
export const removeAsset = (id: number) => invoke<void>("remove_asset", { id });
export const removeAssets = (ids: number[]) => invoke<number>("remove_assets", { ids });
// 回收站：列出 / 恢复 / 彻底删除 / 清空（软删除"移除"进回收站，可恢复；彻底删除不可逆，均不动原图）
export const listTrashed = () => invoke<Asset[]>("list_trashed");
export const restoreAssets = (ids: number[]) => invoke<number>("restore_assets", { ids });
export const purgeAssets = (ids: number[]) => invoke<number>("purge_assets", { ids });
export const emptyTrash = () => invoke<number>("empty_trash");
// 文件夹实时监听开关 + 列表
export const getAutoSync = () => invoke<boolean>("get_auto_sync");
export const setAutoSync = (on: boolean) => invoke<void>("set_auto_sync", { on });
export const listWatched = () => invoke<string[]>("list_watched");
export const unwatchFolder = (root: string) => invoke<void>("unwatch_folder", { root });
export const removeFolder = (folder: string) => invoke<number>("remove_folder", { folder });
export const setFavorite = (id: number, fav: boolean) =>
  invoke<void>("set_favorite", { id, fav });
export const setTags = (id: number, tags: string[]) => invoke<void>("set_tags", { id, tags });
export const renameTag = (from: string, to: string) =>
  invoke<number>("rename_tag", { from, to });
export const deleteTag = (name: string) => invoke<number>("delete_tag", { name });
export const addTagBulk = (ids: number[], tag: string) =>
  invoke<void>("add_tag_bulk", { ids, tag });
export const exportMetadata = (path: string, format: string) =>
  invoke<number>("export_metadata", { path, format });

// ===== 库备份 / 迁移（数据库 + 缩略图整包，不含原图）=====
export const exportLibrary = (destDir: string) =>
  invoke<string>("export_library", { destDir });
export const importLibrary = (srcDir: string) =>
  invoke<string>("import_library", { srcDir });

// ===== 拖出到外部应用（PS / 资源管理器等）=====
// item = 要拖的原文件绝对路径数组；icon = 拖动时跟随光标的预览图（缩略图优先，回退原图）。
export const dragOutFiles = (paths: string[], icon: string) =>
  startDrag({ item: paths, icon, mode: "copy" });

// ---- 缩略图 ----
export const buildThumbnails = () => invoke<number>("build_thumbnails");
/** 前端渲染的封面写回（3D 查看器首帧）：PNG base64 → 400px 缩略图 + 主色 */
export const setThumb = (id: number, dataB64: string) =>
  invoke<string>("set_thumb", { id, dataB64 });

// ---- AI（视觉） ----
export const aiRun = (id: number, mode: string) => invoke<string>("ai_run", { id, mode });
export const aiRunCustom = (id: number, prompt: string) =>
  invoke<string>("ai_run_custom", { id, prompt });
export const aiTagBulk = (ids: number[]) => invoke<number>("ai_tag_bulk", { ids });
export const listAiCommands = () => invoke<AiCmd[]>("list_ai_commands");
export const saveAiCommand = (name: string, prompt: string) =>
  invoke<void>("save_ai_command", { name, prompt });
export const deleteAiCommand = (id: number) => invoke<void>("delete_ai_command", { id });
export const aiStatus = () => invoke<AiStatus>("ai_status");
export const pullModel = (model: string) => invoke<void>("pull_model", { model });

// ---- 检索（CLIP 向量目前由前端 src/clip.ts 计算；下沉 Rust 时只动这两个文件） ----
export const clipTargets = () => invoke<ClipTarget[]>("clip_targets");
export const setClipEmbedding = (id: number, vector: number[]) =>
  invoke<void>("set_clip_embedding", { id, vector });
export const clipSearch = (vector: number[], top: number) =>
  invoke<number[]>("clip_search", { vector, top });
export const clipSimilar = (id: number, top: number) =>
  invoke<number[]>("clip_similar", { id, top });
export const findDuplicates = (threshold = 0.93) =>
  invoke<number[][]>("find_duplicates", { threshold });

// ---- 合集 ----
export const listCollections = () => invoke<Collection[]>("list_collections");
export const createCollection = (name: string, assetIds: number[]) =>
  invoke<number>("create_collection", { name, assetIds });
export const addToCollection = (id: number, assetIds: number[]) =>
  invoke<number>("add_to_collection", { id, assetIds });
export const removeFromCollection = (id: number, assetIds: number[]) =>
  invoke<void>("remove_from_collection", { id, assetIds });
export const deleteCollection = (id: number) => invoke<void>("delete_collection", { id });
export const renameCollection = (id: number, name: string) =>
  invoke<void>("rename_collection", { id, name });
export const collectionAssetIds = (id: number) =>
  invoke<number[]>("collection_asset_ids", { id });

// ---- 设置 ----
export const getSettings = () => invoke<AiCfg>("get_settings");
export const setSettings = (settings: AiCfg) => invoke<void>("set_settings", { settings });

// 素材保存路径（粘贴/拖入/落盘导入存哪；默认 图片\Nobi）
export const getImportDir = () => invoke<string>("get_import_dir");
export const setImportDir = (path: string) => invoke<void>("set_import_dir", { path });

// ---- 翻译 / 术语库 ----
export const translateText = (req: TranslationRequest) =>
  invoke<TranslationResult>("translate_text", { req });
export const closeSelectionTranslateWindow = () =>
  invoke<void>("close_selection_translate_window");
export const listGlossaryTerms = () => invoke<GlossaryTerm[]>("list_glossary_terms");
export const saveGlossaryTerm = (term: GlossaryTermInput) =>
  invoke<number>("save_glossary_term", { term });
export const deleteGlossaryTerm = (id: number) => invoke<void>("delete_glossary_term", { id });
export const listTranslationHistory = (limit = 30) =>
  invoke<TranslationHistoryItem[]>("list_translation_history", { limit });
// 离线翻译包（OPUS-MT 神经模型）按需下载
export const nmtStatus = () => invoke<{ enZh: boolean; zhEn: boolean }>("nmt_status");
export const downloadNmtModels = () => invoke<void>("download_nmt_models");

// ---- 画板（快照权威副本在 SQLite，localStorage 只是快取；多画板） ----
export interface BoardMeta {
  id: number;
  name: string;
  updated_at: number;
}
export const listBoards = () => invoke<BoardMeta[]>("list_boards");
export const createBoard = (name: string) => invoke<number>("create_board", { name });
export const renameBoard = (id: number, name: string) =>
  invoke<void>("rename_board", { id, name });
export const deleteBoard = (id: number) => invoke<void>("delete_board", { id });
export const saveBoard = (id: number, snapshot: string) =>
  invoke<void>("save_board", { id, snapshot });
export const loadBoard = (id: number) => invoke<string | null>("load_board", { id });
export const saveFile = (path: string, dataB64: string) =>
  invoke<void>("save_file", { path, dataB64 });

// ---- 文档（Word 式富文本，内容是 TipTap 的 HTML；权威副本在 SQLite docs 表） ----
export interface DocMeta {
  id: number;
  name: string;
  updated_at: number;
}
export const listDocs = () => invoke<DocMeta[]>("list_docs");
export const createDoc = (name: string) => invoke<number>("create_doc", { name });
export const renameDoc = (id: number, name: string) =>
  invoke<void>("rename_doc", { id, name });
export const deleteDoc = (id: number) => invoke<void>("delete_doc", { id });
export const saveDoc = (id: number, name: string, content: string) =>
  invoke<void>("save_doc", { id, name, content });
export const loadDoc = (id: number) => invoke<string | null>("load_doc", { id });

// ---- 采集 / 接入 ----
// MCP 语义搜索回填：前端算完 CLIP 检索结果交回给等待中的 /api/search 请求
export const mcpSearchResult = (id: number, ids: number[]) =>
  invoke<void>("mcp_search_result", { id, ids });

// ===== 桌宠 Agent 中转（codex/claude CLI）=====
export interface AgentOpts {
  agent: string; // "codex" | "claude"
  bin: string; // 可执行名/路径，空=默认
  cwd: string; // 工作目录
  sandbox: string; // "read-only" | "workspace-write" | "full"
  prompt: string;
}
export const agentCheck = (agent: string, bin: string) =>
  invoke<string>("agent_check", { agent, bin });
export const agentRun = (opts: AgentOpts) => invoke<void>("agent_run", { opts });
export const agentCancel = () => invoke<void>("agent_cancel");

// ===== Winky API 聊天（不以 / 开头说话走这条；OpenAI 兼容流式）=====
// 流式 token 经 "chat-delta"({text}) 事件回；chatSend 的 Promise 在整段说完后才 resolve。
// 纯文本=字符串；看图说话=图文段数组（OpenAI vision 格式）
export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };
export interface ChatMsg {
  role: "system" | "user" | "assistant";
  content: string | ChatContentPart[];
}
export interface ChatOpts {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMsg[];
}
export const chatSend = (opts: ChatOpts) => invoke<void>("chat_send", { opts });
export const chatCancel = () => invoke<void>("chat_cancel");

// Winky 取外部资料：读链接（抓网页正文）/ 联网搜索（无 key，DuckDuckGo）
export const fetchUrlText = (url: string) => invoke<string>("fetch_url_text", { url });
export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}
export const webSearch = (query: string) => invoke<SearchHit[]>("web_search", { query });

// Winky 查 Nobi 素材库（关键词 LIKE 匹配 名字/标签/说明/作者/文件夹）
export interface LibHit {
  id: number;
  name: string;
  tags: string[];
  caption: string;
  folder: string;
}
export const winkySearchLibrary = (query: string, limit = 12) =>
  invoke<LibHit[]>("winky_search_library", { query, limit });

// Winky 看文件：抽 PDF/Word/Excel/PPT/纯文本 的文字。优先 path（文件选择器），否则 dataB64（拖入）
export const extractFileText = (name: string, path: string, dataB64: string) =>
  invoke<string>("extract_file_text", { name, path, dataB64 });

// Winky 皮肤：列出用户已装的 Petdex 宠物 / 读某只的 spritesheet（自定义皮肤；内置预设走 public/pets）
export interface PetInfo {
  id: string;
  displayName: string;
  dir: string;
}
export const winkyListPets = () => invoke<PetInfo[]>("winky_list_pets");
export const winkyReadPetSheet = (dir: string) => invoke<string>("winky_read_pet_sheet", { dir });
// 在设置里直接装宠物：后台跑 npx petdex install <slug>
export const winkyInstallPet = (slug: string) => invoke<string>("winky_install_pet", { slug });
export const winkyDeletePet = (id: string) => invoke<void>("winky_delete_pet", { id });
export const openPetWindow = () => invoke<void>("open_pet_window");
export const winkyGetAutoshow = () => invoke<boolean>("winky_get_autoshow");
export const winkySetAutoshow = (on: boolean) => invoke<void>("winky_set_autoshow", { on });

export const exportExtension = () => invoke<string>("export_extension");
export const exportMcpScript = () => invoke<string>("export_mcp_script");
