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
  | { kind: "favorite" };

export interface Collection {
  id: number;
  name: string;
  count: number;
  createdAt: number;
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
