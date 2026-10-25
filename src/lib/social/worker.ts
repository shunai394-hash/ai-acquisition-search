import {
  backoffMs,
  classifyPublishError,
  isInsideWindow,
  localDateKey,
  MAX_AUTO_ATTEMPTS,
  networkCapability,
  nextOpenInstant,
  parseRule,
  redactError,
  STALE_LOCK_MS,
  type ErrorClass,
  type PostingRule,
} from "@/lib/social/queue";

type Row = Record<string, unknown>;

// The Supabase client and the in-memory test double share this call shape.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type QueueDb = { from: (table: string) => any };

export type PublishOutcome =
  | { outcome: "published"; externalPostId: string; postUrl: string | null; metadata?: Row }
  | { outcome: "pending"; externalPostId: string; postUrl: string | null; metadata?: Row };

export type PollOutcome =
  | { outcome: "published"; externalPostId: string; postUrl: string | null }
  | { outcome: "pending" }
  | { outcome: "failed"; error: string };

type JobRow = {
  id: string;
  user_id: string;
  asset_id: string;
  network: string;
  caption: string;
  status: string;
  scheduled_at: string;
  timezone: string;
  attempt_count: number;
  publish_accepted_at: string | null;
  external_post_id: string | null;
  metadata: Row;
  locked_by?: string | null;
};

type AssetRow = {
  id: string;
  user_id: string;
  kind: string;
  upload_status?: string | null;
  storage_bucket?: string | null;
  storage_path?: string | null;
  mime_type?: string | null;
  byte_size?: number | null;
  duration_seconds?: number | null;
  ai_generated?: boolean | null;
};

export type DispatchHooks = { markAccepted: (publishId: string) => Promise<void> };

const SENT = new Set(["published", "pending", "processing"]);

function meta(job: JobRow, patch: Row) {
  return { ...(job.metadata || {}), ...patch };
}

async function recordEvent(db: QueueDb, job: JobRow, event: string, detail: Row) {
  const { error } = await db.from("post_job_events").insert({
    job_id: job.id,
    user_id: job.user_id,
    event,
    detail,
  });
  if (error) console.error("post_job_events insert failed", error.code || "unknown");
}

async function mirrorSocialPost(db: QueueDb, job: JobRow, status: string, externalPostId: string | null, postUrl: string | null) {
  const source = job.id;
  const { data: existing, error: readError } = await db.from("social_posts")
    .select("id")
    .eq("user_id", job.user_id)
    .eq("network", job.network)
    .filter("metadata->>source_social_post_id", "eq", source)
    .maybeSingle();
  if (readError) return;
  const patch = {
    status,
    external_post_id: externalPostId,
    post_url: postUrl,
    published_at: status === "published" ? new Date().toISOString() : null,
    caption: job.caption,
    metadata: { source_social_post_id: source, origin: "post_queue" },
    updated_at: new Date().toISOString(),
  };
  if (existing?.id) {
    await db.from("social_posts").update(patch).eq("id", existing.id).eq("user_id", job.user_id);
    await db.from("post_jobs").update({ social_post_id: existing.id }).eq("id", job.id).eq("user_id", job.user_id);
    return;
  }
  const inserted = await db.from("social_posts").insert({
    user_id: job.user_id,
    network: job.network,
    ...patch,
  }).select("id").maybeSingle();
  if (inserted.error?.code === "23505") return;
  if (!inserted.error && inserted.data?.id) {
    await db.from("post_jobs").update({ social_post_id: inserted.data.id }).eq("id", job.id).eq("user_id", job.user_id);
  }
}

export async function processDueJobs(db: QueueDb, options: {
  now?: Date;
  limit?: number;
  holder?: string;
  onlyJobId?: string;
  publish: (job: JobRow, asset: AssetRow, hooks: DispatchHooks) => Promise<PublishOutcome>;
  poll?: (job: JobRow) => Promise<PollOutcome>;
}) {
  const now = options.now ?? new Date();
  const holder = options.holder ?? crypto.randomUUID();
  const limit = options.limit ?? 3;
  const summary = { claimed: 0, published: 0, failed: 0, deferred: 0, pending: 0, results: [] as Array<{ id: string; status: string; error?: string }> };

  await recoverStale(db, now);

  let query = db.from("post_jobs")
    .select("id,attempt_count")
    .eq("status", "queued")
    .lte("scheduled_at", now.toISOString())
    .or(`next_attempt_at.is.null,next_attempt_at.lte.${now.toISOString()}`)
    .order("priority", { ascending: false })
    .order("scheduled_at", { ascending: true })
    .limit(limit);
  if (options.onlyJobId) query = query.eq("id", options.onlyJobId);
  const due = await query;
  if (due.error) throw due.error;

  for (const candidate of due.data || []) {
    const claimed = await db.from("post_jobs").update({
      status: "processing",
      locked_at: now.toISOString(),
      locked_by: holder,
      attempt_count: Number(candidate.attempt_count || 0) + 1,
      updated_at: now.toISOString(),
    }).eq("id", candidate.id).eq("status", "queued").select("id,user_id,asset_id,network,caption,status,scheduled_at,timezone,attempt_count,publish_accepted_at,external_post_id,metadata,locked_by").maybeSingle();
    if (claimed.error) throw claimed.error;
    if (!claimed.data) continue;
    summary.claimed += 1;
    const job = claimed.data as JobRow;
    const result = await runClaimed(db, job, holder, now, options.publish);
    summary.results.push(result);
    if (result.status === "published") summary.published += 1;
    else if (result.status === "pending") summary.pending += 1;
    else if (result.status === "queued") summary.deferred += 1;
    else summary.failed += 1;
  }

  if (options.poll) {
    const pending = await db.from("post_jobs")
      .select("id,user_id,asset_id,network,caption,status,scheduled_at,timezone,attempt_count,publish_accepted_at,external_post_id,metadata")
      .eq("status", "pending")
      .not("external_post_id", "is", null)
      .order("updated_at", { ascending: true })
      .limit(limit);
    if (pending.error) throw pending.error;
    for (const row of (pending.data || []) as JobRow[]) {
      if (options.onlyJobId && row.id !== options.onlyJobId) continue;
      try {
        const polled = await options.poll(row);
        if (polled.outcome === "published") {
          await db.from("post_jobs").update({
            status: "published",
            external_post_id: polled.externalPostId,
            post_url: polled.postUrl,
            last_error: null,
            locked_at: null,
            locked_by: null,
            updated_at: new Date().toISOString(),
          }).eq("id", row.id).eq("status", "pending");
          await mirrorSocialPost(db, row, "published", polled.externalPostId, polled.postUrl);
          summary.published += 1;
          summary.results.push({ id: row.id, status: "published" });
        } else if (polled.outcome === "failed") {
          await db.from("post_jobs").update({
            status: "failed",
            last_error: redactError(polled.error),
            metadata: meta(row, { retry_safety: "blocked_after_accept" }),
            updated_at: new Date().toISOString(),
          }).eq("id", row.id).eq("status", "pending");
          summary.failed += 1;
          summary.results.push({ id: row.id, status: "failed", error: redactError(polled.error) });
        } else {
          summary.pending += 1;
        }
      } catch (error) {
        const message = redactError(error instanceof Error ? error.message : "状態確認に失敗しました。");
        await recordEvent(db, row, "poll_failed", { error: message });
      }
    }
  }

  return summary;
}

async function recoverStale(db: QueueDb, now: Date) {
  const cutoff = new Date(now.getTime() - STALE_LOCK_MS).toISOString();
  const stale = await db.from("post_jobs")
    .select("id,user_id,publish_accepted_at,metadata")
    .eq("status", "processing")
    .lt("locked_at", cutoff);
  if (stale.error) throw stale.error;
  for (const job of stale.data || []) {
    if (job.publish_accepted_at) {
      await db.from("post_jobs").update({
        status: "pending",
        locked_at: null,
        locked_by: null,
        updated_at: now.toISOString(),
      }).eq("id", job.id).eq("status", "processing");
    } else {
      await db.from("post_jobs").update({
        status: "failed",
        locked_at: null,
        locked_by: null,
        last_error: "処理が中断されました。外部APIへ到達したかが不明なため、自動では再投稿しません。",
        metadata: { ...(job.metadata || {}), retry_safety: "confirm_no_duplicate" },
        updated_at: now.toISOString(),
      }).eq("id", job.id).eq("status", "processing");
    }
  }
}

async function runClaimed(
  db: QueueDb,
  job: JobRow,
  holder: string,
  now: Date,
  publish: (job: JobRow, asset: AssetRow, hooks: DispatchHooks) => Promise<PublishOutcome>,
) {
  const finish = async (patch: Row) => {
    const { error } = await db.from("post_jobs").update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", job.id).eq("user_id", job.user_id).eq("locked_by", holder);
    if (error) throw error;
  };
  let acceptedPublishId: string | null = job.publish_accepted_at ? job.external_post_id : null;

  try {
    const capability = networkCapability(job.network);
    if (!capability?.executable) {
      const message = capability?.reason || "このSNSは自動投稿キューに未接続です。";
      await finish({ status: "failed", last_error: message, locked_at: null, locked_by: null, metadata: meta(job, { retry_safety: "not_supported" }) });
      await recordEvent(db, job, "unsupported_network", { network: job.network });
      return { id: job.id, status: "failed", error: message };
    }

    const assetResult = await db.from("media_assets").select("id,user_id,kind,upload_status,storage_bucket,storage_path,mime_type,byte_size,duration_seconds,ai_generated").eq("id", job.asset_id).eq("user_id", job.user_id).maybeSingle();
    if (assetResult.error) throw assetResult.error;
    const asset = assetResult.data as AssetRow | null;
    if (!asset) {
      await finish({ status: "failed", last_error: "素材が見つかりません。", locked_at: null, locked_by: null });
      return { id: job.id, status: "failed", error: "素材が見つかりません。" };
    }

    const ruleResult = await db.from("posting_rules").select("timezone,max_per_day,weekdays,window_start,window_end,paused").eq("user_id", job.user_id).eq("network", job.network).maybeSingle();
    if (ruleResult.error && !["42P01", "PGRST205"].includes(String(ruleResult.error.code))) throw ruleResult.error;
    const rule = parseRule(ruleResult.data);
    const deferred = await deferIfNeeded(db, job, rule, now);
    if (deferred) {
      await finish({
        status: "queued",
        locked_at: null,
        locked_by: null,
        attempt_count: Math.max(0, Number(job.attempt_count || 1) - 1),
        next_attempt_at: deferred.at,
        last_error: deferred.message,
      });
      return { id: job.id, status: "queued", error: deferred.message };
    }

    if (job.network === "tiktok") {
      const gate = await tiktokGate(db, job, now);
      if (gate) {
        await finish({ status: gate.status, last_error: gate.error, locked_at: null, locked_by: null, metadata: meta(job, gate.metadata || {}) });
        await recordEvent(db, job, gate.status, { error: gate.error });
        return { id: job.id, status: gate.status, error: gate.error };
      }
    }

    const outcome = await publish(job, asset, {
      markAccepted: async (publishId: string) => {
        const saved = await db.from("post_jobs").update({
          publish_accepted_at: new Date().toISOString(),
          external_post_id: publishId,
          updated_at: new Date().toISOString(),
        }).eq("id", job.id).eq("status", "processing").eq("locked_by", holder).select("id").maybeSingle();
        acceptedPublishId = publishId;
        if (saved.error || !saved.data) throw saved.error || new Error("投稿受付の保存に失敗しました。");
      },
    });

    await finish({
      status: outcome.outcome,
      external_post_id: outcome.externalPostId,
      post_url: outcome.postUrl,
      publish_accepted_at: job.publish_accepted_at || new Date().toISOString(),
      last_error: null,
      locked_at: null,
      locked_by: null,
      metadata: meta(job, outcome.metadata || {}),
    });
    await mirrorSocialPost(db, job, outcome.outcome === "published" ? "published" : "pending", outcome.externalPostId, outcome.postUrl);
    await recordEvent(db, job, outcome.outcome, { externalPostId: outcome.externalPostId });
    return { id: job.id, status: outcome.outcome };
  } catch (error) {
    const message = redactError(error instanceof Error ? error.message : "投稿に失敗しました。");
    const errorClass = (error as { errorClass?: ErrorClass }).errorClass || classifyPublishError(message);
    const accepted = Boolean(acceptedPublishId || job.publish_accepted_at);
    if (accepted || errorClass === "uncertain") {
      const status = accepted ? "pending" : "failed";
      await finish({
        status,
        external_post_id: acceptedPublishId || job.external_post_id,
        publish_accepted_at: accepted ? (job.publish_accepted_at || new Date().toISOString()) : job.publish_accepted_at,
        last_error: message,
        locked_at: null,
        locked_by: null,
        metadata: meta(job, { retry_safety: accepted ? "blocked_after_accept" : "confirm_no_duplicate" }),
      });
      await recordEvent(db, job, status, { error: message, errorClass });
      return { id: job.id, status, error: message };
    }
    if (errorClass === "reauth") {
      await finish({ status: "needs_reauth", last_error: message, locked_at: null, locked_by: null });
      await recordEvent(db, job, "needs_reauth", { error: message });
      return { id: job.id, status: "needs_reauth", error: message };
    }
    if (errorClass === "safe_retry" && Number(job.attempt_count) < MAX_AUTO_ATTEMPTS) {
      const next = new Date(now.getTime() + backoffMs(Number(job.attempt_count))).toISOString();
      await finish({ status: "queued", last_error: message, next_attempt_at: next, locked_at: null, locked_by: null });
      await recordEvent(db, job, "retry_scheduled", { error: message, next });
      return { id: job.id, status: "queued", error: message };
    }
    await finish({ status: "failed", last_error: message, locked_at: null, locked_by: null, metadata: meta(job, { retry_safety: "safe" }) });
    await recordEvent(db, job, "failed", { error: message, errorClass });
    return { id: job.id, status: "failed", error: message };
  }
}

async function deferIfNeeded(db: QueueDb, job: JobRow, rule: PostingRule, now: Date) {
  if (!isInsideWindow(now, rule)) {
    const next = rule.paused ? new Date(now.getTime() + 30 * 60 * 1000) : nextOpenInstant(now, rule);
    const message = rule.paused
      ? "投稿ルールが一時停止中のため、送信せず待機に戻しました。"
      : "投稿可能な曜日・時間帯の外のため、送信せず次の枠まで待機に戻しました。";
    await recordEvent(db, job, "deferred", { reason: rule.paused ? "paused" : "outside_window" });
    return { at: (next ?? new Date(now.getTime() + 30 * 60 * 1000)).toISOString(), message };
  }
  const recent = await db.from("post_jobs")
    .select("id,status,scheduled_at")
    .eq("user_id", job.user_id)
    .eq("network", job.network)
    .in("status", ["published", "pending", "processing"]);
  if (recent.error) throw recent.error;
  const today = localDateKey(now, rule.timezone);
  const used = (recent.data || []).filter((row: Row) => row.id !== job.id && SENT.has(String(row.status)) && row.scheduled_at && localDateKey(new Date(String(row.scheduled_at)), rule.timezone) === today).length;
  if (used >= rule.maxPerDay) {
    const next = nextOpenInstant(new Date(now.getTime() + 20 * 60 * 60 * 1000), rule) ?? new Date(now.getTime() + 24 * 60 * 60 * 1000);
    await recordEvent(db, job, "deferred", { reason: "daily_cap", used, max: rule.maxPerDay });
    return { at: next.toISOString(), message: `1日の投稿上限（${rule.maxPerDay}件）に達したため、次の枠まで待機に戻しました。` };
  }
  return null;
}

async function tiktokGate(db: QueueDb, job: JobRow, now: Date) {
  const account = await db.from("tiktok_accounts")
    .select("scope,refresh_token_expires_at")
    .eq("user_id", job.user_id)
    .maybeSingle();
  if (account.error) throw account.error;
  if (!account.data) return { status: "needs_reauth", error: "TikTokアカウントを先に接続してください。" };
  const refreshExpiry = account.data.refresh_token_expires_at ? Date.parse(account.data.refresh_token_expires_at) : null;
  if (refreshExpiry != null && refreshExpiry <= now.getTime()) {
    return { status: "needs_reauth", error: "TikTokの再認証が必要です。リフレッシュトークンの有効期限が切れています。" };
  }
  const scope = String(account.data.scope || "");
  if (!scope.split(/[,\s]+/).includes("video.publish")) {
    return { status: "needs_reauth", error: "TikTokの video.publish 権限がありません。接続し直してください。" };
  }
  const consent = await db.from("tiktok_publish_consents").select("consented_at").eq("user_id", job.user_id).maybeSingle();
  if (consent.error) throw consent.error;
  if (!consent.data) {
    return { status: "failed", error: "TikTok自動投稿には、画面上の公開同意が必要です。", metadata: { retry_safety: "safe" } };
  }
  return null;
}
