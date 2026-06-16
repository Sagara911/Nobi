// ============================================================
// 后端命令边界层：所有 invoke 调用必须经过这里（见 docs/ARCHITECTURE.md）。
// 价值：前端其余代码不知道"实现在哪"。将来把某能力下沉到 Rust /
// 换云端 API / 换模型，只改这一个文件（或它调用的实现），UI 零改动。
// ============================================================

import { invoke } from "@tauri-apps/api/core";
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

// ---- 素材库 ----
export const listAssets = () => invoke<Asset[]>("list_assets");
export const importFolder = (path: string) => invoke<number>("import_folder", { path });
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
export const removeFolder = (folder: string) => invoke<number>("remove_folder", { folder });
export const setFavorite = (id: number, fav: boolean) =>
  invoke<void>("set_favorite", { id, fav });
export const setTags = (id: number, tags: string[]) => invoke<void>("set_tags", { id, tags });
export const addTagBulk = (ids: number[], tag: string) =>
  invoke<void>("add_tag_bulk", { ids, tag });
export const exportMetadata = (path: string, format: string) =>
  invoke<number>("export_metadata", { path, format });

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

// ---- 采集 / 接入 ----
export const exportExtension = () => invoke<string>("export_extension");
export const exportMcpScript = () => invoke<string>("export_mcp_script");
