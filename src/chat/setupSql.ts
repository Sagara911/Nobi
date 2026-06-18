// 内嵌的 Supabase 建表脚本，供应用内"教程"一键复制。
// 发布版用户没有仓库里的 docs/chat-supabase-setup.sql，所以把它带进 app。
// 与 docs/chat-supabase-setup.sql 内容保持一致（建表 + RLS + Realtime + 存储桶 + 24h 阅后即焚）。

export const SUPABASE_SETUP_SQL = `-- Nobi 聊天 · Supabase 初始化（SQL Editor 里整段粘贴 → Run，可重复跑）

-- 1. 消息表
create table if not exists public.messages (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  room        text not null,
  sender      text not null,
  client_id   text not null,
  kind        text not null default 'text',
  body        text,
  asset_url   text,
  asset_name  text,
  avatar      text,
  bubble      text
);
create index if not exists messages_room_created_idx on public.messages (room, created_at);
-- 老表升级：加头像列 / 气泡色列（已存在则跳过）
alter table public.messages add column if not exists avatar text;
alter table public.messages add column if not exists bubble text;

-- 2. 行级安全（任何拿到 anon key 的人可读写——小圈子够用）
alter table public.messages enable row level security;
drop policy if exists "chat anon read"   on public.messages;
drop policy if exists "chat anon insert" on public.messages;
create policy "chat anon read"   on public.messages for select using (true);
create policy "chat anon insert" on public.messages for insert with check (true);

-- 3. 开启 Realtime
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;
end $$;

-- 4. 存图的 Storage 公开桶
insert into storage.buckets (id, name, public)
values ('chat-assets','chat-assets', true)
on conflict (id) do update set public = true;
drop policy if exists "chat assets anon upload" on storage.objects;
drop policy if exists "chat assets public read" on storage.objects;
create policy "chat assets anon upload" on storage.objects for insert to anon
  with check (bucket_id = 'chat-assets');
create policy "chat assets public read" on storage.objects for select
  using (bucket_id = 'chat-assets');

-- 5. 24 小时自动清理（阅后即焚，记录不累积 → 长期免费）
create extension if not exists pg_cron;
create or replace function public.nobi_chat_cleanup()
returns void language plpgsql security definer as $$
begin
  delete from public.messages where created_at < now() - interval '24 hours';
  delete from storage.objects
    where bucket_id='chat-assets' and created_at < now() - interval '24 hours';
end; $$;
select cron.unschedule('nobi-chat-cleanup')
  where exists (select 1 from cron.job where jobname='nobi-chat-cleanup');
select cron.schedule('nobi-chat-cleanup','0 * * * *', $$ select public.nobi_chat_cleanup(); $$);
`;
