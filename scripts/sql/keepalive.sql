-- Anti-pause heartbeat for the Free-plan Supabase project.
--
-- Supabase pauses a Free project after ~7 days of insufficient *user* database
-- activity. Its own internal services (health checker, PostgREST idle
-- connections) do not count, so the project needs real queries on a schedule.
--
-- This gives the scheduled ping a target that is both a write and a read, and
-- leaves an auditable trace without the table ever growing: one row, updated in
-- place. `hits` and `seen_at` let you prove the heartbeat ran — and spot the gap
-- if it stopped.
--
-- Apply once, in the SQL editor of the new project.

create table if not exists public.heartbeat (
  id      integer     primary key default 1,
  seen_at timestamptz not null default now(),
  hits    bigint      not null default 0,
  constraint heartbeat_single_row check (id = 1)
);

insert into public.heartbeat (id) values (1)
on conflict (id) do nothing;

-- security definer so the caller needs no table privileges of its own;
-- search_path is pinned because a definer function must not resolve names
-- through the caller's path.
create or replace function public.keepalive()
returns timestamptz
language sql
security definer
set search_path = public
as $$
  update heartbeat
     set seen_at = now(),
         hits    = hits + 1
   where id = 1
  returning seen_at;
$$;

-- Only the service role may call it. The anon key is a public credential —
-- nothing that writes should be reachable with it.
revoke all on function public.keepalive() from public;
revoke all on function public.keepalive() from anon, authenticated;
grant execute on function public.keepalive() to service_role;

-- The table is never read through the Data API, so keep RLS on with no policies:
-- anon/authenticated get nothing, service_role bypasses RLS anyway.
alter table public.heartbeat enable row level security;
