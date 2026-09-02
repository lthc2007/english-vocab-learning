-- 口语评测（讯飞 ISE）每日调用计数
-- 全局共享一个讯飞 Key，此表用于限制每日总调用次数，防止免费额度被刷爆。
-- 应用方式：supabase db push 或在 Supabase 控制台 SQL Editor 中执行。

create table if not exists ise_usage (
  day date primary key,
  calls integer not null default 0
);

alter table ise_usage enable row level security;

-- 原子递增并判断是否超过上限（Edge Function 通过 service_role 调用）
-- p_day: 'YYYY-MM-DD'（UTC），p_limit: 当日允许的最大调用次数
create or replace function increment_ise_usage(p_day date, p_limit integer)
returns table (used integer, allowed boolean)
language sql
security definer
as $$
  insert into ise_usage(day, calls) values (p_day, 1)
  on conflict (day) do update set calls = ise_usage.calls + 1
  returning calls as used, (calls <= p_limit) as allowed;
$$;
