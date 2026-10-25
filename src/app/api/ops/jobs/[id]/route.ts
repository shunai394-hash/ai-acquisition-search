import { NextResponse } from "next/server";
import { getAdminSupabase } from "@/lib/billing";
import { requireUser } from "@/lib/social/http";
import { manualRetryPolicy } from "@/lib/social/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireUser(request);
  if (!user) return error;
  const { id } = await context.params;
  const body = await request.json().catch(() => null) as { action?: unknown; confirmDuplicateRisk?: unknown } | null;
  const action = typeof body?.action === "string" ? body.action : "";
  const db = getAdminSupabase();
  const current = await db.from("post_jobs")
    .select("id,status,publish_accepted_at,metadata,scheduled_at")
    .eq("id", id).eq("user_id", user.id).maybeSingle();
  if (current.error) return NextResponse.json({ error: "投稿の確認に失敗しました。" }, { status: 500 });
  if (!current.data) return NextResponse.json({ error: "投稿が見つかりません。" }, { status: 404 });

  const now = new Date().toISOString();
  let patch: Record<string, unknown> | null = null;
  if (action === "pause" && ["queued", "awaiting_approval"].includes(current.data.status)) {
    patch = { status: "paused", locked_at: null, locked_by: null };
  } else if (action === "resume" && current.data.status === "paused") {
    patch = { status: "queued", next_attempt_at: null, locked_at: null, locked_by: null };
  } else if (action === "cancel" && !["processing", "pending", "published", "cancelled"].includes(current.data.status)) {
    patch = { status: "cancelled", locked_at: null, locked_by: null };
  } else if (action === "approve" && current.data.status === "awaiting_approval") {
    patch = { status: "queued", next_attempt_at: null };
  } else if (action === "retry") {
    const metadata = current.data.metadata && typeof current.data.metadata === "object" && !Array.isArray(current.data.metadata)
      ? current.data.metadata as { retry_safety?: string }
      : null;
    const policy = manualRetryPolicy({
      status: current.data.status,
      publish_accepted_at: current.data.publish_accepted_at,
      metadata,
    });
    if (!policy.allowed) return NextResponse.json({ error: policy.reason }, { status: 409 });
    if (policy.confirm && body?.confirmDuplicateRisk !== true) {
      return NextResponse.json({ error: policy.reason, code: "CONFIRM_DUPLICATE_RISK" }, { status: 409 });
    }
    patch = {
      status: "queued",
      last_error: null,
      next_attempt_at: null,
      scheduled_at: now,
      locked_at: null,
      locked_by: null,
      metadata: { ...(current.data.metadata || {}), retry_safety: "safe", manual_retry_at: now },
    };
  }
  if (!patch) return NextResponse.json({ error: "この操作はこの投稿状態では実行できません。" }, { status: 409 });

  const updated = await db.from("post_jobs").update({ ...patch, updated_at: now }).eq("id", id).eq("user_id", user.id).eq("status", current.data.status).select("id,status,last_error,scheduled_at,post_url,external_post_id").maybeSingle();
  if (updated.error) return NextResponse.json({ error: "投稿状態の更新に失敗しました。" }, { status: 500 });
  if (!updated.data) return NextResponse.json({ error: "投稿状態がすでに変わっています。画面を更新してください。" }, { status: 409 });
  await db.from("post_job_events").insert({ job_id: id, user_id: user.id, event: action, detail: { status: updated.data.status } });
  return NextResponse.json({ ok: true, job: updated.data });
}
