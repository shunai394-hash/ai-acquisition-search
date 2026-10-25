import { NextResponse } from "next/server";
import { suggestCaptions, type CaptionPurpose } from "@/lib/social/captions";
import { requireUser } from "@/lib/social/http";
import { NETWORKS, type AssetKind, type Network } from "@/lib/social/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const { user, error } = await requireUser(request);
  if (!user) return error;
  const body = await request.json().catch(() => null) as {
    body?: unknown;
    purpose?: unknown;
    network?: unknown;
    kind?: unknown;
    historyNote?: unknown;
  } | null;
  const text = typeof body?.body === "string" ? body.body.trim() : "";
  const purpose: CaptionPurpose = body?.purpose === "awareness" || body?.purpose === "traffic" ? body.purpose : "product";
  const network = typeof body?.network === "string" && (NETWORKS as readonly string[]).includes(body.network) ? body.network as Network : "tiktok";
  const kind: AssetKind = body?.kind === "image" || body?.kind === "text" ? body.kind : "video";
  if (!text) return NextResponse.json({ error: "素材の本文または説明を入力してください。" }, { status: 400 });
  const result = await suggestCaptions({
    body: text,
    purpose,
    network,
    kind,
    historyNote: typeof body?.historyNote === "string" ? body.historyNote : undefined,
  });
  return NextResponse.json({ ...result, executed: false });
}
