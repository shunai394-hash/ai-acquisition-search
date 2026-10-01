-- AI Decision / Teacher / operator-loop の冪等性と同時実行防止。

-- operator-loop・巡回AIの実行リース（同時に2つのCronが走っても片方だけが処理する）。
create table if not exists public.operator_leases (
  name text primary key,
  holder text not null,
  acquired_at timestamptz not null default now(),
  expires_at timestamptz not null
);
alter table public.operator_leases enable row level security;

-- 同じ投稿・同じ入力（実績・根拠・ロジック版）の Decision を二重保存しない。
create unique index if not exists operator_runs_decision_idempotency_uidx
on public.operator_runs (user_id, run_type, ((input->>'idempotency_key')))
where input->>'idempotency_key' is not null;

-- 巡回対象（未完了の投稿）を素早く取り出す。
create index if not exists social_posts_operator_patrol_idx
on public.social_posts (status, published_at)
where external_post_id is not null;
