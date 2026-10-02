-- Decision keys are user-scoped. The previous index was global, which could
-- make an unrelated user's identical key collide and then fail the user-scoped
-- lookup in the API.
drop index if exists public.operator_runs_decision_key_uidx;

create unique index if not exists operator_runs_decision_key_uidx
on public.operator_runs (user_id, (input->>'decision_key'))
where run_type = 'ai_performance_verdict' and input->>'decision_key' is not null;
