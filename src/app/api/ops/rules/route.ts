import { NextResponse } from "next/server";
import { getAdminSupabase } from "@/lib/billing";
import { isMissingRelation, requireUser } from "@/lib/social/http";
import { isValidTimeZone } from "@/lib/social/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(request: Request) {
  const { user, error } = await requireUser(request);
  if (!user) return error;
  const body = await request.json().catch(() => null) as {
    timezone?: unknown;
    maxPerDay?: unknown;
    weekdays?: unknown;
    windowStart?: unknown;
    windowEnd?: unknown;
    paused?: unknown;
  } | null;
  const timezone = typeof body?.timezone === "string" && isValidTimeZone(body.timezone) ? body.timezone : null;
  const maxPerDay = typeof body?.maxPerDay === "number" ? Math.round(body.maxPerDay) : null;
  const weekdays = Array.isArray(body?.weekdays) ? body.weekdays.filter((day): day is number => Number.isInteger(day) && day >= 0 && day <= 6) : [];
  const windowStart = typeof body?.windowStart === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(body.windowStart) ? body.windowStart : null;
  const windowEnd = typeof body?.windowEnd === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(body.windowEnd) ? body.windowEnd : null;
  if (!timezone || !windowStart || !windowEnd || maxPerDay == null || maxPerDay < 1 || maxPerDay > 50 || !weekdays.length) {
    return NextResponse.json({ error: "頻度、曜日、時間帯、タイムゾーンを確認してください。" }, { status: 400 });
  }
  const db = getAdminSupabase();
  const saved = await db.from("posting_rules").upsert({
    user_id: user.id,
    network: "tiktok",
    timezone,
    max_per_day: maxPerDay,
    weekdays,
    window_start: windowStart,
    window_end: windowEnd,
    paused: body?.paused === true,
    updated_at: new Date().toISOString(),
  }, { onConflict: "user_id,network" }).select("timezone,max_per_day,weekdays,window_start,window_end,paused").single();
  if (isMissingRelation(saved.error)) return NextResponse.json({ error: "投稿キューのマイグレーションが未適用です。" }, { status: 503 });
  if (saved.error) return NextResponse.json({ error: "投稿ルールの保存に失敗しました。" }, { status: 500 });
  return NextResponse.json({ ok: true, rule: saved.data });
}
