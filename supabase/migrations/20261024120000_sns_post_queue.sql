-- Persistent SNS post queue. Additive only: existing tables are not dropped or reset.
-- The app writes these tables with the service role after verifying the signed-in user.

create table if not exists public.media_assets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  kind text not null check (kind in ('video', 'image', 'text')),
  title text not null default '',
  body text not null default '',
  storage_bucket text,
  storage_path text,
  mime_type text,
  byte_size bigint,
  duration_seconds numeric,
  ai_generated boolean not null default false,
  upload_status text not null default 'ready' check (upload_status in ('pending', 'ready', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists media_assets_user_created_idx
  on public.media_assets (user_id, created_at desc);

create table if not exists public.posting_rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  network text not null,
  timezone text not null default 'Asia/Tokyo',
  max_per_day integer not null default 10 check (max_per_day between 1 and 50),
  weekdays integer[] not null default '{0,1,2,3,4,5,6}',
  window_start text not null default '00:00',
  window_end text not null default '23:59',
  paused boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, network)
);

create table if not exists public.post_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  asset_id uuid not null references public.media_assets (id),
  network text not null,
  caption text not null,
  hashtags text[] not null default '{}',
  privacy_level text,
  purpose text,
  mode text not null check (mode in ('immediate', 'scheduled', 'approval', 'autopilot')),
  status text not null check (status in (
    'awaiting_approval', 'queued', 'paused', 'processing', 'pending',
    'published', 'failed', 'cancelled', 'needs_reauth'
  )),
  scheduled_at timestamptz not null,
  timezone text not null default 'Asia/Tokyo',
  priority integer not null default 0,
  idempotency_key text not null,
  attempt_count integer not null default 0,
  next_attempt_at timestamptz,
  last_error text,
  external_post_id text,
  post_url text,
  publish_accepted_at timestamptz,
  social_post_id uuid,
  locked_at timestamptz,
  locked_by text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, idempotency_key)
);

create index if not exists post_jobs_due_idx
  on public.post_jobs (priority desc, scheduled_at)
  where status = 'queued';

create index if not exists post_jobs_user_created_idx
  on public.post_jobs (user_id, created_at desc);

create table if not exists public.post_job_events (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.post_jobs (id) on delete cascade,
  user_id uuid not null,
  event text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists post_job_events_job_idx
  on public.post_job_events (job_id, created_at desc);

create table if not exists public.scheduler_runs (
  id uuid primary key default gen_random_uuid(),
  job_name text not null,
  started_at timestamptz not null,
  finished_at timestamptz,
  claimed integer not null default 0,
  published integer not null default 0,
  failed integer not null default 0,
  deferred integer not null default 0,
  pending integer not null default 0,
  error text
);

create index if not exists scheduler_runs_started_idx
  on public.scheduler_runs (job_name, started_at desc);

alter table public.media_assets enable row level security;
alter table public.posting_rules enable row level security;
alter table public.post_jobs enable row level security;
alter table public.post_job_events enable row level security;
alter table public.scheduler_runs enable row level security;

create policy "media_assets_select_own" on public.media_assets
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "media_assets_insert_own" on public.media_assets
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "media_assets_update_own" on public.media_assets
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "media_assets_delete_own" on public.media_assets
  for delete to authenticated using ((select auth.uid()) = user_id);

create policy "posting_rules_select_own" on public.posting_rules
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "posting_rules_insert_own" on public.posting_rules
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "posting_rules_update_own" on public.posting_rules
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create policy "post_jobs_select_own" on public.post_jobs
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "post_jobs_insert_own" on public.post_jobs
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "post_jobs_update_own" on public.post_jobs
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create policy "post_job_events_select_own" on public.post_job_events
  for select to authenticated using ((select auth.uid()) = user_id);

-- scheduler_runs has no authenticated policy. Only the service role (cron) can read or write it.
