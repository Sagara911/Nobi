-- Nobi 聊天 · Supabase 初始化脚本
-- 用法：登录 supabase.com → 你的项目 → 左侧 SQL Editor → 新建查询 →
--       把本文件**整段**粘进去 → Run。跑一次即可，可重复跑（带幂等保护）。
--
-- 跑完后，在 Nobi 聊天窗口的「设置」里填：
--   · Supabase URL      = 项目 Settings → API → Project URL
--   · anon key          = 项目 Settings → API → anon public
--   · 昵称 / 房间号       = 你和朋友约定（房间号填一样才能聊到一起）
--
-- ⚠️ 安全说明（MVP）：下面的策略允许"任何拿到 anon key 的人"读写消息、传图。
--    对你和朋友的小圈子够用；要更严（如按房间口令、登录鉴权）后续再收紧。

-- ===== 1. 消息表 =====
create table if not exists public.messages (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  room        text        not null,
  sender      text        not null,
  client_id   text        not null,
  kind        text        not null default 'text',   -- 'text' | 'image' | 'video'
  body        text,                                   -- 文本内容 / 图注
  asset_url   text,                                   -- 图片/视频消息的公开 URL
  asset_name  text,
  avatar      text,                                   -- 发送者头像 emoji
  bubble      text                                    -- 发送者气泡颜色 #rrggbb
);

-- 老表升级：加头像列 / 气泡色列（已存在则跳过）
alter table public.messages add column if not exists avatar text;
alter table public.messages add column if not exists bubble text;

create index if not exists messages_room_created_idx
  on public.messages (room, created_at);

-- ===== 2. 行级安全（RLS）=====
alter table public.messages enable row level security;

drop policy if exists "chat anon read"   on public.messages;
drop policy if exists "chat anon insert" on public.messages;
create policy "chat anon read"   on public.messages for select using (true);
create policy "chat anon insert" on public.messages for insert with check (true);

-- ===== 3. 开启 Realtime（让 INSERT 实时推送给订阅方）=====
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;
end $$;
-- 机器人流式回复靠 UPDATE 事件推送；要让 realtime 的 room 过滤在 UPDATE 上生效，需整行复制标识
alter table public.messages replica identity full;

-- ===== 4. 存图用的 Storage 桶（公开读）=====
insert into storage.buckets (id, name, public)
values ('chat-assets', 'chat-assets', true)
on conflict (id) do update set public = true;

drop policy if exists "chat assets anon upload" on storage.objects;
drop policy if exists "chat assets public read" on storage.objects;
create policy "chat assets anon upload"
  on storage.objects for insert to anon
  with check (bucket_id = 'chat-assets');
create policy "chat assets public read"
  on storage.objects for select
  using (bucket_id = 'chat-assets');

-- ===== 5. 12 小时自动清理（阅后即焚，记录不累积 → 长期卡在免费额度内）=====
-- 超过 12h 的消息和图片每小时自动删一次。改保留时长 = 改下面两个 interval；
-- 改频率 = 改 '0 * * * *'（每小时整点）。代价：超过 12h 的历史对所有人消失。
create extension if not exists pg_cron;

create or replace function public.nobi_chat_cleanup()
returns void language plpgsql security definer as $$
begin
  delete from public.messages
    where created_at < now() - interval '12 hours';
  delete from storage.objects
    where bucket_id = 'chat-assets'
      and created_at < now() - interval '12 hours';
end; $$;

select cron.unschedule('nobi-chat-cleanup')
  where exists (select 1 from cron.job where jobname = 'nobi-chat-cleanup');
select cron.schedule('nobi-chat-cleanup', '0 * * * *',
  $$ select public.nobi_chat_cleanup(); $$);
