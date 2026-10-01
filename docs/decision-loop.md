# Decision loop (AI Decision / Teacher / next action)

```
product + plan (Supabase) ─┐
EC-Pulse research history ─┼─> evidence (as of T) ─> Teacher (deterministic) ─> structured decision ─> next-creative
post_metrics (Results) ────┘                          CONTINUE/PIVOT/STOP/WAIT                       (only CONTINUE/PIVOT)
```

- `src/lib/decision/evidence.ts` collects product, customer, EC-Pulse, the post's latest metric, comparable history and the
  hypothesis lineage. Only data measured at or before `asOf` is used. Metrics an SNS API does not provide (e.g. TikTok
  clicks/sales) are `null` ("unknown"), never `0`.
- `src/lib/decision/teacher.ts` decides the verdict from explicit, versioned rules (`TEACHER_THRESHOLDS`):
  sample size, CTR/CVR with 95% Wilson intervals against the user's own baseline (default benchmark until 3 comparable
  posts exist), gross profit after ad cost, lineage of previous attempts. STOP requires repeated poor results;
  engagement-only networks never STOP on one result. Too little data returns `wait` (`insufficient_data`) for up to 7 days.
- `src/lib/decision/engine.ts` builds the structured decision (`action_type`, `target_customer`, `hypothesis`, `reason`,
  `expected_outcome`, `primary_metric`, `learning_objective`, `priority`, `evidence`, `confidence`, `logic_version`,
  `prompt_version`, `model_version`, `generated_at`, `input_hash`). The optional LLM pass only rewrites the hook/angle
  wording; it cannot change the verdict.
- `/api/operator/ai-decision` stores one decision per `post + input_hash` (unique index) and reuses it for repeated or
  concurrent calls. `/api/operator/next-creative` refuses STOP/WAIT, including when the stored verdict disagrees with
  the request body.
- `/api/cron/operator-loop` and `/api/cron/patrol-ai` hold a DB lease (`operator_leases`) so concurrent invocations skip.

## Required production configuration

| Variable | Notes |
|---|---|
| `CRON_SECRET` | Same value Vercel Cron sends. Surrounding whitespace is ignored. |
| `VERCEL_PROJECT_PRODUCTION_URL` | Set by Vercel; used for internal calls. |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | Needed if Deployment Protection is on. |
| `EC_PULSE_API_URL` | EC-Pulse **production** domain. Without it a pinned old deployment URL is used. |
| `EC_PULSE_API_KEY` | EC-Pulse key. |

Apply `supabase/migrations/20261002000000_operator_leases_and_decision_idempotency.sql`. Without it the loop still runs,
but concurrent-run prevention falls back to per-post claims only (`lease: "unavailable"` in the cron response).

## Verification

```
npm run typecheck && npm test && npm run backtest:decision && npm run build
curl -H "Authorization: Bearer $CRON_SECRET" https://<production>/api/health   # commit, DB, EC-Pulse, config
npm run backtest:decision -- --supabase   # replay real history (read-only, needs service-role env)
```
