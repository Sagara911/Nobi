-- Nobi 聊天机器人 · 数据库 Webhook（messages 每插一行就通知 Edge Function）
-- ---------------------------------------------------------------------------
-- 用法：先部署好 chat-bot Edge Function（见 docs/chat-bot-edge-function.md），
--       再把下面两个占位符替换后，整段粘进 Supabase SQL Editor → Run：
--         <PROJECT_REF>  你的项目引用（项目 URL 里 https://<ref>.supabase.co 的 ref）
--         <SECRET>       你设的 BOT_WEBHOOK_SECRET（没设就把这个头删掉）
-- 可重复跑（带幂等保护）。pg_net 你已在用（pg_cron 阅后即焚那套）。

create extension if not exists pg_net;

-- 触发函数：把新行作为 record POST 给 Edge Function（异步、非阻塞）
create or replace function public.nobi_chat_bot_notify()
returns trigger language plpgsql security definer as $$
begin
  perform net.http_post(
    url     := 'https://<PROJECT_REF>.functions.supabase.co/chat-bot',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-bot-secret', '<SECRET>'        -- 没设 BOT_WEBHOOK_SECRET 就删这行
               ),
    body    := jsonb_build_object('type', 'INSERT', 'table', 'messages', 'record', to_jsonb(NEW))
  );
  return NEW;
end; $$;

drop trigger if exists nobi_chat_bot on public.messages;
create trigger nobi_chat_bot
  after insert on public.messages
  for each row
  execute function public.nobi_chat_bot_notify();

-- 卸载机器人（要关掉时跑这两行）：
-- drop trigger if exists nobi_chat_bot on public.messages;
-- drop function if exists public.nobi_chat_bot_notify();
