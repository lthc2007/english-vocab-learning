-- 通义千问（Qwen-Turbo）每日调用计数
-- 所有用户共享站长的 DASHSCOPE_API_KEY，此表用于限制每日调用次数，防止公开站点刷爆账单。
-- 每用户限额 + 全局限额共用一张表：全局行使用固定零 UUID 作为 user_id。
-- 应用方式：supabase db push 或在 Supabase 控制台 SQL Editor 中执行。

create table if not exists qwen_usage (
  day date not null,
  user_id uuid not null default '00000000-0000-0000-0000-000000000000',
  calls integer not null default 0,
  primary key (day, user_id)
);

alter table qwen_usage enable row level security;

-- 原子递增并判断是否超过上限（Edge Function 通过 service_role 调用）
-- p_day: 'YYYY-MM-DD'（UTC），p_user_id: 用户 ID 或全局零 UUID，p_limit: 当日允许的最大调用次数
create or replace function increment_qwen_usage(p_day date, p_user_id uuid, p_limit integer)
returns table (used integer, allowed boolean)
language sql
security definer
as $$
  insert into qwen_usage(day, user_id, calls) values (p_day, p_user_id, 1)
  on conflict (day, user_id) do update set calls = qwen_usage.calls + 1
  returning calls as used, (calls <= p_limit) as allowed;
$$;
