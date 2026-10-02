#!/usr/bin/env bash
# Applies the AI decision idempotency migrations to a throwaway PostgreSQL
# database and checks their behaviour with existing operator_runs data:
#   - existing rows (completed decisions, other run types) survive untouched
#   - the user-scoped unique index replaces the global one
#   - every migration can be re-run
#   - legacy duplicate decision keys make the index migration fail (and the
#     documented cleanup query fixes it)
#   - unique (user_id, decision_key): A/A conflicts, A/B does not
#   - lease takeover: two concurrent conditional UPDATEs, exactly one wins
#
# Usage: PGURL=postgres://user@host:port/postgres scripts/verify-decision-migrations.sh
# Never point this at a real project: it creates and drops its own databases.
set -euo pipefail
: "${PGURL:?set PGURL to a disposable PostgreSQL server}"
cd "$(dirname "$0")/.."

M1=supabase/migrations/20261002000000_operator_leases_and_decision_idempotency.sql
M2=supabase/migrations/20261003000000_scope_decision_idempotency_to_user.sql
M3=supabase/migrations/20261004000000_decision_reservation_lease.sql

admin() { psql "$PGURL" -v ON_ERROR_STOP=1 -qAt "$@"; }
db_url() { echo "${PGURL%/*}/$1"; }
q() { psql "$(db_url "$DB")" -v ON_ERROR_STOP=1 -qAt "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok   $*"; }

fresh_db() {
  DB=$1
  admin -c "drop database if exists $DB" -c "create database $DB"
  # Minimal stand-in for the Supabase roles and the operator_runs columns the app uses.
  q <<'SQL'
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
end $$;
create table public.operator_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  product_id uuid,
  run_type text not null,
  status text not null default 'running',
  input jsonb not null default '{}',
  output jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);
SQL
}

U1=00000000-0000-0000-0000-000000000001
U2=00000000-0000-0000-0000-000000000002

# --- 1. Existing data, no duplicates -----------------------------------------
fresh_db decision_mig_ok
q <<SQL
insert into operator_runs (user_id, run_type, status, input, output, completed_at) values
  ('$U1', 'ai_performance_verdict', 'completed', '{"social_post_id":"p1","decision_key":"p1:m1:r1:v1"}', '{"verdict":"pivot","decision":{}}', now()),
  ('$U1', 'ai_performance_verdict', 'completed', '{"social_post_id":"p0"}', '{"verdict":"stop"}', now()),
  ('$U1', 'acquisition_test_plan', 'completed', '{"decision_key":"p1:m1:r1:v1"}', '{}', now()),
  ('$U2', 'ai_performance_verdict', 'running', '{"social_post_id":"p9","decision_key":"p9:k"}', '{"state":"processing"}', null);
SQL
snapshot() { q -c "select md5(string_agg((to_jsonb(t) - 'lease_expires_at')::text, ',' order by id)) from operator_runs t"; }
before=$(snapshot)
for m in $M1 $M2 $M3; do q -f "$m"; done
pass "migrations apply on existing operator_runs data"
for m in $M1 $M2 $M3; do q -f "$m"; done
pass "migrations are re-runnable"
# M1 re-run must not resurrect the global index: M2 then replaces it again.
def=$(q -c "select indexdef from pg_indexes where indexname = 'operator_runs_decision_key_uidx'")
[[ "$def" == *"(user_id, ((input ->> 'decision_key'::text)))"* ]] || fail "unexpected index: $def"
[[ $(q -c "select count(*) from pg_indexes where tablename = 'operator_runs' and indexdef ilike '%decision_key%'") == 1 ]] || fail "more than one decision_key index"
pass "only the user-scoped unique index exists: $def"
after=$(snapshot)
[[ "$after" == "$before" ]] || fail "existing rows changed"
[[ $(q -c "select count(*) from operator_runs where lease_expires_at is not null") == 0 ]] || fail "lease backfilled unexpectedly"
pass "existing rows unchanged (lease_expires_at added as null) [$before]"

# --- 2. Unique semantics --------------------------------------------------------
q -c "insert into operator_runs (user_id, run_type, input) values ('$U1', 'ai_performance_verdict', '{\"decision_key\":\"X\"}')"
if q -c "insert into operator_runs (user_id, run_type, input) values ('$U1', 'ai_performance_verdict', '{\"decision_key\":\"X\"}')" 2>/dev/null; then
  fail "user A + key X twice was accepted"
fi
pass "user A + key X twice -> 23505"
q -c "insert into operator_runs (user_id, run_type, input) values ('$U2', 'ai_performance_verdict', '{\"decision_key\":\"X\"}')"
pass "user B + key X -> accepted (no cross-user collision)"
q -c "insert into operator_runs (user_id, run_type, input) values ('$U1', 'acquisition_test_plan', '{\"decision_key\":\"X\"}')"
pass "other run_type with the same key -> accepted"
# Releasing a key (LLM failure) frees it for the next reservation.
q -c "update operator_runs set input = (input - 'decision_key') || '{\"released_decision_key\":\"X\"}', completed_at = now() where user_id = '$U1' and input->>'decision_key' = 'X' and run_type = 'ai_performance_verdict'"
q -c "insert into operator_runs (user_id, run_type, input) values ('$U1', 'ai_performance_verdict', '{\"decision_key\":\"X\"}')"
pass "released key can be reserved again"

# --- 3. Lease takeover race ---------------------------------------------------
id=$(q -c "insert into operator_runs (user_id, run_type, input, output, started_at, lease_expires_at) values ('$U1', 'ai_performance_verdict', '{\"decision_key\":\"T\"}', '{\"state\":\"processing\",\"holder\":\"dead\"}', now() - interval '5 minutes', now() - interval '1 minute') returning id")
takeover() {
  psql "$(db_url "$DB")" -qAt -c "
    begin;
    with won as (
      update operator_runs set output = '{\"state\":\"processing\",\"holder\":\"$1\"}', lease_expires_at = now() + interval '70 seconds', started_at = now()
      where id = '$id' and output->>'state' = 'processing' and completed_at is null and lease_expires_at < now()
      returning id)
    select count(*) from won;
    select pg_sleep(1);
    commit;"
}
takeover A >"${TMPDIR:-/tmp}/takeover-a" & takeover B >"${TMPDIR:-/tmp}/takeover-b" & wait
wins=$(( $(head -1 "${TMPDIR:-/tmp}/takeover-a") + $(head -1 "${TMPDIR:-/tmp}/takeover-b") ))
[[ $wins == 1 ]] || fail "takeover winners: $wins"
pass "two concurrent takeovers of an expired lease: exactly one wins (holder $(q -c "select output->>'holder' from operator_runs where id = '$id'"))"
# A live lease cannot be taken over.
n=$(q -c "with won as (update operator_runs set output = '{\"state\":\"processing\",\"holder\":\"C\"}' where id = '$id' and completed_at is null and lease_expires_at < now() returning id) select count(*) from won")
[[ $n == 0 ]] || fail "live lease was taken over"
pass "live lease is not taken over"

# --- 4. Legacy duplicate decision keys ------------------------------------------
fresh_db decision_mig_dup
q <<SQL
insert into operator_runs (user_id, run_type, status, input, output, completed_at, created_at) values
  ('$U1', 'ai_performance_verdict', 'completed', '{"decision_key":"dup"}', '{"verdict":"pivot","decision":{}}', now(), now() - interval '2 minutes'),
  ('$U1', 'ai_performance_verdict', 'completed', '{"decision_key":"dup"}', '{"verdict":"pivot","decision":{}}', now(), now() - interval '1 minute');
SQL
if q -f $M1 2>"${TMPDIR:-/tmp}/dup-err"; then fail "M1 accepted duplicate keys"; fi
grep -q "could not create unique index" "${TMPDIR:-/tmp}/dup-err" || fail "unexpected error: $(cat "${TMPDIR:-/tmp}/dup-err")"
[[ $(q -c "select count(*) from operator_runs") == 2 ]] || fail "rows lost on failed migration"
pass "duplicate legacy keys: M1 fails, no operator_runs row changed ($(head -1 "${TMPDIR:-/tmp}/dup-err"))"
# Cleanup that keeps every row: the oldest keeps the key, later ones move it aside.
q <<'SQL'
update operator_runs r set input = (r.input - 'decision_key') || jsonb_build_object('duplicate_decision_key', r.input->>'decision_key')
from (
  select id, row_number() over (partition by user_id, input->>'decision_key' order by created_at, id) as n
  from operator_runs where run_type = 'ai_performance_verdict' and input->>'decision_key' is not null
) d
where r.id = d.id and d.n > 1;
SQL
for m in $M1 $M2 $M3; do q -f "$m"; done
[[ $(q -c "select count(*) from operator_runs") == 2 ]] || fail "rows lost"
pass "after the non-destructive cleanup all migrations apply and both rows remain"

admin -c "drop database decision_mig_ok" -c "drop database decision_mig_dup"
echo "all migration checks passed"
