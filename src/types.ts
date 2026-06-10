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
  | { kind: "missing" }
  | { kind: "favorite" };

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
}

export interface Menu {
  title: string;
  items: MenuItem[];
}
