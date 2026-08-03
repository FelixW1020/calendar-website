-- Run this once in the Supabase SQL editor (Dashboard → SQL Editor → New query).
-- Safe to re-run.

-- Text primary keys rather than uuid: the client already generates ids, and the
-- three starter calendars use readable ids ("personal", "work", "health").

create table if not exists public.calendars (
  id          text        not null,
  user_id     uuid        not null references auth.users (id) on delete cascade,
  name        text        not null,
  color       text        not null,
  visible     boolean     not null default true,
  updated_at  timestamptz not null default now(),
  -- Tombstone. A row is never hard-deleted, so other devices can learn about
  -- the deletion instead of re-uploading their stale copy.
  deleted_at  timestamptz,
  primary key (user_id, id)
);

create table if not exists public.events (
  id           text        not null,
  user_id      uuid        not null references auth.users (id) on delete cascade,
  calendar_id  text        not null,
  title        text        not null,
  description  text,
  location     text,
  starts_at    timestamptz not null,
  ends_at      timestamptz not null,
  all_day      boolean     not null default false,
  recurrence   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  primary key (user_id, id)
);

create index if not exists events_user_start_idx
  on public.events (user_id, starts_at);

-- Row-level security: every row is reachable only by the user who owns it.
-- Without this, the anon key would expose everyone's calendar.
alter table public.calendars enable row level security;
alter table public.events    enable row level security;

drop policy if exists "own calendars" on public.calendars;
create policy "own calendars" on public.calendars
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "own events" on public.events;
create policy "own events" on public.events
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Realtime, so a change on your phone shows up on your laptop immediately.
alter publication supabase_realtime add table public.calendars;
alter publication supabase_realtime add table public.events;
