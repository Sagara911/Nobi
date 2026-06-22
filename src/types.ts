// 共享类型定义（与后端 serde camelCase 序列化一一对应）

export interface Asset {
  id: number;
  path: string;
  name: string;
  format: string;
  width: number;
  height: number;
  sizeBytes: number;
  folder: string;
  source: string;
  author: string;
  tags: string[];
  addedAt: number;
  thumb: string;
  colors: string[];
  missing: boolean;
  favorite: boolean;
}

export type Filter =
  | { kind: "all" }
  | { kind: "tag"; value: string }
  | { kind: "folder"; value: string }
  | { kind: "color"; value: string }
  | { kind: "collection"; value: string } // value = 合集 id（字符串）
  | { kind: "missing" }
  | { kind: "favorite" }
  | { kind: "type"; value: "image" | "video" | "audio" };

export interface Collection {
  id: number;
  name: string;
  count: number;
  createdAt: number;
}

/** 文件夹树节点（侧栏按目录层级展示；删除/筛选按 path 前缀级联） */
export interface FolderNode {
  path: string; // 该目录完整路径（删除/筛选的前缀依据）
  label: string; // 显示名（通常是末段目录名）
  selfCount: number; // 直接在该目录下的素材数
  total: number; // 该目录 + 所有子目录下的素材总数
  children: FolderNode[];
}

export type SortKey = "time" | "name" | "size";

export interface AiCmd {
  id: number;
  name: string;
  prompt: string;
}

export interface AiCfg {
  aiBase: string;
  aiModel: string;
  aiKey: string;
  embedModel: string;
}

export interface AiStatus {
  ollama: boolean;
  model: string;
  modelPresent: boolean;
  models: string[];
}

export interface ClipTarget {
  id: number;
  img: string;
}

export type TranslationMode = "normal" | "prompt" | "tags";
export type TranslationProvider = "auto" | "online" | "offline" | "model" | "builtin";

export interface TranslationRequest {
  text: string;
  sourceLang?: string;
  targetLang?: string;
  mode?: TranslationMode;
  provider?: TranslationProvider;
  sourceApp?: string;
  sourceUrl?: string;
  assetId?: number;
  saveHistory?: boolean;
}

export interface GlossaryHit {
  source: string;
  target: string;
  explanation: string;
  category: string;
}

export interface DictionaryEntry {
  pos: string;
  terms: string[];
}

export interface TranslationResult {
  id?: number;
  sourceText: string;
  targetText: string;
  sourceLang: string;
  targetLang: string;
  mode: string;
  provider: string;
  usedGlossary: GlossaryHit[];
  keywords: string[];
  dictionary?: DictionaryEntry[];
  phonetic?: string;
  warning?: string;
}

export interface GlossaryTerm {
  id: number;
  source: string;
  target: string;
  explanation: string;
  category: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  useCount: number;
}

export interface GlossaryTermInput {
  id?: number;
  source: string;
  target: string;
  explanation?: string;
  category?: string;
  tags?: string[];
}

export interface TranslationHistoryItem {
  id: number;
  sourceText: string;
  targetText: string;
  sourceLang: string;
  targetLang: string;
  mode: string;
  provider: string;
  createdAt: number;
}

export interface SelectionTranslatePayload {
  text: string;
  x: number;
  y: number;
  sourceApp?: string;
}

export interface MenuItem {
  label?: string;
  action?: () => void;
  sep?: boolean;
  /** 二级菜单（PS 式悬停飞出）；与 action 互斥 */
  sub?: MenuItem[];
  /** 单选勾选态（如搜索引擎选择） */
  checked?: boolean;
}

export interface Menu {
  title: string;
  items: MenuItem[];
}
