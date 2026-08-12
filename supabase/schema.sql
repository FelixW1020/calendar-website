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

-- Coordinates for a location picked from search, so the pin and the map card
-- follow the event across devices. A hand-typed location leaves these null.
alter table public.events add column if not exists place_lat   double precision;
alter table public.events add column if not exists place_lon   double precision;
alter table public.events add column if not exists place_label text;

-- Recurrence exceptions. A repeating event is one row carrying an RRULE in
-- `recurrence`; the occurrences are expanded on the client. These three columns
-- hold the two ways an occurrence can differ from the rule: `exdates` lists the
-- ones that were deleted, and a row with `recurrence_id` set replaces the single
-- occurrence named by `original_start`. Both are local wall-time strings — they
-- name a slot in the rule rather than a point on the timeline.
alter table public.events add column if not exists exdates        text[];
alter table public.events add column if not exists recurrence_id  text;
alter table public.events add column if not exists original_start text;

create index if not exists events_user_series_idx
  on public.events (user_id, recurrence_id);

create index if not exists events_user_start_idx
  on public.events (user_id, starts_at);

-- Calendars subscribed to by link. Only the address travels: the events behind
-- it belong to whoever publishes them, and each device fetches its own copy
-- rather than pushing thousands of read-only rows through here. `id` matches a
-- row in `calendars`, which is where the name, colour and visibility live.
create table if not exists public.subscriptions (
  id          text        not null,
  user_id     uuid        not null references auth.users (id) on delete cascade,
  url         text        not null,
  -- Whether this feed has to be read through the public relay because the
  -- publisher sends no CORS headers. A per-feed decision the user makes.
  use_proxy   boolean     not null default false,
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  primary key (user_id, id)
);

-- Row-level security: every row is reachable only by the user who owns it.
-- Without this, the anon key would expose everyone's calendar.
alter table public.calendars     enable row level security;
alter table public.events        enable row level security;
alter table public.subscriptions enable row level security;

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

drop policy if exists "own subscriptions" on public.subscriptions;
create policy "own subscriptions" on public.subscriptions
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Realtime, so a change on your phone shows up on your laptop immediately.
-- Adding a table that is already published raises rather than doing nothing,
-- which would make this script re-runnable only the first time.
do $$
declare
  t text;
begin
  foreach t in array array['calendars', 'events', 'subscriptions'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
