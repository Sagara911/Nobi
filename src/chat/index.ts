// 聊天后端工厂 + 对外统一出口。
// 加新后端只需：写一个实现 ChatBackend 的类 → 在这里加一个分支。

import type { ChatBackend, ChatConfig } from "./types";
import { SupabaseBackend } from "./supabaseBackend";
import { CustomServerBackend } from "./customBackend";

export function createBackend(cfg: ChatConfig): ChatBackend {
  switch (cfg.provider) {
    case "supabase":
      return new SupabaseBackend(cfg);
    case "custom":
      return new CustomServerBackend(cfg);
    default:
      throw new Error(`未知的聊天后端：${cfg.provider}`);
  }
}

export * from "./types";
export * from "./config";
export * from "./setupSql";
export * from "./avatar";
