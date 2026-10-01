-- Global lease for Cron / AI patrol so concurrent invocations do not run the
-- same loop at the same time. Rows expire and are reclaimed by the next run.
create table if not exists public.operator_leases (
  name text primary key,
  holder text not null,
  acquired_at timestamptz not null default now(),
  expires_at timestamptz not null
);

alter table public.operator_leases enable row level security;
revoke all on public.operator_leases from anon, authenticated;
grant all on public.operator_leases to service_role;

-- One AI decision per (post, metric snapshot, logic version). Concurrent
-- ai-decision calls for the same input reuse the stored decision.
create unique index if not exists operator_runs_decision_key_uidx
on public.operator_runs ((input->>'decision_key'))
where run_type = 'ai_performance_verdict' and input->>'decision_key' is not null;
