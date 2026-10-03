import { NextResponse } from "next/server";
import { getAdminSupabase, getUserFromBearer } from "@/lib/billing";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const user = await getUserFromBearer(request);
  if (!user) return NextResponse.json({ error: "ログインが必要です。" }, { status: 401 });
  try {
    const body = await request.json() as {
      socialPostId?: string; impressions?: number; views?: number; clicks?: number;
      conversions?: number; revenue?: number; grossProfit?: number; adSpend?: number;
      likes?: number; comments?: number; shares?: number; saves?: number;
    };
    if (!body.socialPostId) return NextResponse.json({ error: "投稿IDが必要です。" }, { status: 400 });
    const db = getAdminSupabase();
    const post = await db.from("social_posts").select("id,user_id").eq("id", body.socialPostId).eq("user_id", user.id).maybeSingle();
    if (post.error) throw post.error;
    if (!post.data) return NextResponse.json({ error: "対象投稿が見つかりません。" }, { status: 404 });
    const optionalNumber = (value: unknown) => {
      if (value === undefined || value === null || value === "") return null;
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : Number.NaN;
    };
    const values = {
      impressions: optionalNumber(body.impressions),
      views: optionalNumber(body.views),
      clicks: optionalNumber(body.clicks),
      conversions: optionalNumber(body.conversions),
      revenue: optionalNumber(body.revenue),
      grossProfit: optionalNumber(body.grossProfit),
      adSpend: optionalNumber(body.adSpend),
      likes: optionalNumber(body.likes),
      comments: optionalNumber(body.comments),
      shares: optionalNumber(body.shares),
      saves: optionalNumber(body.saves),
    };
    if (Object.values(values).some((value) => Number.isNaN(value))) {
      return NextResponse.json({ error: "実績値は空欄または0以上の数値で入力してください。" }, { status: 400 });
    }
    const { impressions, views, clicks, conversions, revenue, grossProfit, adSpend, likes, comments, shares, saves } = values;
    if (clicks != null && impressions != null && clicks > impressions) {
      return NextResponse.json({ error: "クリック数はインプレッション数を超えられません。" }, { status: 400 });
    }
    if (views != null && impressions != null && views > impressions) {
      return NextResponse.json({ error: "再生数はインプレッション数を超えられません。" }, { status: 400 });
    }
    if (conversions != null && clicks != null && conversions > clicks) {
      return NextResponse.json({ error: "コンバージョン数はクリック数を超えられません。" }, { status: 400 });
    }
    const exposure = Math.max(impressions ?? 0, views ?? 0);
    if (exposure > 0 && [likes, comments, shares, saves].some((value) => value != null && value > exposure)) {
      return NextResponse.json({ error: "いいね・コメント・シェア・保存数は露出数を超えられません。" }, { status: 400 });
    }
    const ctr = impressions != null && impressions > 0 && clicks != null ? clicks / impressions : null;
    const cvr = clicks != null && clicks > 0 && conversions != null ? conversions / clicks : null;
    const cpa = conversions != null && conversions > 0 && adSpend != null && adSpend > 0 ? adSpend / conversions : null;
    const roas = adSpend != null && adSpend > 0 && revenue != null ? revenue / adSpend : null;
    const { data, error } = await db.from("post_metrics").insert({
      social_post_id: body.socialPostId, impressions, views,
      likes, comments, shares,
      saves, clicks, conversions, revenue, gross_profit: grossProfit,
      ad_spend: adSpend, ctr, cvr, cpa, roas, raw: body,
    }).select("id,ctr,cvr,cpa,roas").single();
    if (error) throw error;
    return NextResponse.json({ ok: true, metrics: data });
  } catch (error) {
    console.error("operator metrics error", error);
    return NextResponse.json({ error: "実績の保存に失敗しました。" }, { status: 500 });
  }
}
