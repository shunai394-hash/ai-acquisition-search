import { NextResponse } from "next/server";
import { getAdminSupabase, getUserFromBearer } from "@/lib/billing";
import type { AcquisitionAnalyzeResult } from "@/lib/acquisition/types";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const user = await getUserFromBearer(request);
  if (!user) return NextResponse.json({ error: "ログインが必要です。" }, { status: 401 });

  let productId = "";
  let productCreated = false;
  let planId = "";
  let creativeId = "";
  let socialPostId = "";

  try {
    const body = await request.json() as { source?: AcquisitionAnalyzeResult["source"]; analysis?: AcquisitionAnalyzeResult["analysis"] };
    const source = body.source;
    const analysis = body.analysis;
    if (!source?.url || !analysis?.decision) return NextResponse.json({ error: "分析結果が不足しています。" }, { status: 400 });

    const db = getAdminSupabase();
    const existing = await db.from("products").select("id").eq("user_id", user.id).eq("url", source.url).maybeSingle();
    if (existing.error) throw existing.error;

    productId = existing.data?.id as string | undefined || "";
    if (productId) {
      const { error } = await db.from("products").update({
        name: source.productName || source.title || "商品・サービス",
        updated_at: new Date().toISOString(),
      }).eq("id", productId).eq("user_id", user.id);
      if (error) throw error;
    } else {
      const { data, error } = await db.from("products").insert({
        user_id: user.id,
        name: source.productName || source.title || "商品・サービス",
        url: source.url,
      }).select("id").single();
      if (error) throw error;
      productId = data.id;
      productCreated = true;
    }

    const decision = analysis.decision;
    const { data: plan, error: planError } = await db.from("acquisition_plans").insert({
      product_id: productId,
      user_id: user.id,
      target: decision.target,
      pain: decision.problem,
      desire: decision.desire,
      value_proposition: decision.valueProposition,
      channel: decision.channel,
      format: decision.format,
      angle: decision.valueProposition,
      hypothesis: decision.testPlan,
      status: "planned",
    }).select("id, created_at").single();
    if (planError) throw planError;
    planId = plan.id;

    const firstPost = analysis.nextPosts?.[0];
    const firstScenario = analysis.scenarios?.[0];
    const scenarioId = firstScenario?.id || null;
    const { data: creative, error: creativeError } = await db.from("creatives").insert({
      product_id: productId,
      plan_id: plan.id,
      user_id: user.id,
      title: firstPost?.concept || firstScenario?.hypothesis || "広告テストクリエイティブ",
      variation: "A",
      hook: firstScenario?.hook || firstPost?.hook || decision.valueProposition,
      scenario: firstScenario ?? {
        concept: firstPost?.concept,
        hook: firstPost?.hook,
        format: firstPost?.format,
        channel: firstPost?.channel,
        testMetric: firstPost?.testMetric,
      },
      status: "planned",
    }).select("id").single();
    if (creativeError) throw creativeError;
    creativeId = creative.id;
    const { data: socialPost, error: socialPostError } = await db.from("social_posts").insert({
      creative_id: creative.id,
      user_id: user.id,
      network: firstPost?.channel || decision.channel,
      status: "planned",
      caption: firstScenario?.hook || firstPost?.hook || decision.valueProposition,
      metadata: {
        plan_id: plan.id,
        hypothesis: firstScenario?.hypothesis || decision.testPlan,
        scenario_id: scenarioId,
        scenario: firstScenario ?? null,
        change_variable: firstScenario?.variableToChange || null,
        primary_metric: firstScenario?.primaryMetric || firstPost?.testMetric || null,
        variables_to_hold: firstScenario?.variablesToHold || [],
      },
    }).select("id").single();
    if (socialPostError) throw socialPostError;
    socialPostId = socialPost.id;

    const { data: run, error: runError } = await db.from("operator_runs").insert({
      product_id: productId,
      user_id: user.id,
      run_type: "acquisition_test_plan",
      status: "completed",
      input: { url: source.url },
      output: { decision, next_posts: analysis.nextPosts, priorities: analysis.priorities },
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    }).select("id").single();
    if (runError) throw runError;

    return NextResponse.json({ ok: true, planId: plan.id, runId: run.id, socialPostId: socialPost.id, message: "広告テスト仮説を保存しました。結果を入力すると次のテストにつなげられます。" });
  } catch (error) {
    // このAPIは複数テーブルへ順番に書き込むため、後段失敗時に
    // 中途半端なテスト計画だけを残さない。既存productは絶対に削除しない。
    try {
      const db = getAdminSupabase();
      if (socialPostId) await db.from("social_posts").delete().eq("id", socialPostId).eq("user_id", user.id);
      if (creativeId) await db.from("creatives").delete().eq("id", creativeId).eq("user_id", user.id);
      if (planId) await db.from("acquisition_plans").delete().eq("id", planId).eq("user_id", user.id);
      if (productCreated && productId) {
        const { count } = await db.from("products").select("id", { count: "exact", head: true }).eq("id", productId).eq("user_id", user.id);
        if (count === 1) {
          await db.from("products").delete().eq("id", productId).eq("user_id", user.id);
        }
      }
    } catch (cleanupError) {
      console.error("operator plan rollback failed", cleanupError);
    }
    console.error("operator plan error", error);
    return NextResponse.json({ error: "テスト計画の保存に失敗しました。" }, { status: 500 });
  }
}
