/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 聊天内置后端：Supabase 项目 URL（见 .env.local） */
  readonly VITE_CHAT_SUPABASE_URL?: string;
  /** 聊天内置后端：Supabase publishable/anon key（见 .env.local） */
  readonly VITE_CHAT_SUPABASE_ANON_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
