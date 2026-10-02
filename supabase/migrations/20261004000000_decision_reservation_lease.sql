-- Lease for AI decision reservations.
--
-- /api/operator/ai-decision inserts an operator_runs row with
-- output = {"state": "processing", "holder": <token>} before running the
-- decision; operator_runs_decision_key_uidx (user_id, input->>'decision_key')
-- makes that insert the race arbiter. If the request dies before completing or
-- releasing the row (function timeout, crash), the reservation must not block
-- the key forever: the row carries a lease, and once it has expired the next
-- request for the same key takes the row over with a conditional UPDATE
-- (... where lease_expires_at < now()), which only one request can win.
--
-- Additive and nullable: existing rows are untouched. Reservations created
-- before this column existed have lease_expires_at = null; the application
-- treats them as expiring at started_at + lease TTL.
alter table public.operator_runs
  add column if not exists lease_expires_at timestamptz;

comment on column public.operator_runs.lease_expires_at is
  'AI decision reservation lease. Only meaningful while output->>''state'' = ''processing'' and completed_at is null.';

-- Lets operators find (and the API sweep) abandoned reservations cheaply.
create index if not exists operator_runs_decision_reservation_idx
on public.operator_runs (user_id, (input->>'social_post_id'), lease_expires_at)
where run_type = 'ai_performance_verdict' and completed_at is null;
