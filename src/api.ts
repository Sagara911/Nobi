// ============================================================
// 后端命令边界层：所有 invoke 调用必须经过这里（见 docs/ARCHITECTURE.md）。
// 价值：前端其余代码不知道"实现在哪"。将来把某能力下沉到 Rust /
// 换云端 API / 换模型，只改这一个文件（或它调用的实现），UI 零改动。
// ============================================================

import { invoke } from "@tauri-apps/api/core";
import type { AiCfg, AiCmd, AiStatus, Asset, ClipTarget } from "./types";

// ---- 素材库 ----
export const listAssets = () => invoke<Asset[]>("list_assets");
export const importFolder = (path: string) => invoke<number>("import_folder", { path });
export const importPaths = (paths: string[]) => invoke<number>("import_paths", { paths });
export const importBlob = (name: string, dataB64: string) =>
  invoke<void>("import_blob", { name, dataB64 });
export const removeAsset = (id: number) => invoke<void>("remove_asset", { id });
export const setFavorite = (id: number, fav: boolean) =>
  invoke<void>("set_favorite", { id, fav });
export const setTags = (id: number, tags: string[]) => invoke<void>("set_tags", { id, tags });
export const addTagBulk = (ids: number[], tag: string) =>
  invoke<void>("add_tag_bulk", { ids, tag });
export const exportMetadata = (path: string, format: string) =>
  invoke<number>("export_metadata", { path, format });

// ---- 缩略图 ----
export const buildThumbnails = () => invoke<number>("build_thumbnails");

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

// ---- 设置 ----
export const getSettings = () => invoke<AiCfg>("get_settings");
export const setSettings = (settings: AiCfg) => invoke<void>("set_settings", { settings });

// ---- 采集 ----
export const exportExtension = () => invoke<string>("export_extension");
