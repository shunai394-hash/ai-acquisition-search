import { NextResponse } from "next/server";
import { getAdminSupabase, getUserFromBearer } from "@/lib/billing";
import type { StructuredDecision } from "@/lib/operator/decision";

export const runtime = "nodejs";
export const maxDuration = 60;

function makePrompt(input: {
  title: string; originalHook: string; changedAngle?: string; changedHook?: string;
  nextAction: string; network: string;
}) {
  return [
    "Create the next short-form advertising video for iterative acquisition testing.",
    "Product/creative: " + input.title,
    "Original hook: " + input.originalHook,
    "Network: " + input.network,
    "Decision: " + input.nextAction,
    input.changedAngle ? "Changed angle: " + input.changedAngle : "",
    input.changedHook ? "Changed hook: " + input.changedHook : "",
    "Use natural UGC-style visuals, 9:16, clear first 3 seconds, no fake claims, no watermark, no platform UI.",
    "Keep the product recognizable and make the change from the previous creative explicit in the hook or angle.",
  ].filter(Boolean).join("\n");
}

export async function POST(request: Request) {
  let userId = "";
  let jobId = "";
  let nextCreativeId = "";
  let nextPostId = "";
  let operatorRunId = "";
  let claimId = "";
  let sourcePostId = "";
  try {
    const user = await getUserFromBearer(request);
    if (!user) return NextResponse.json({ error: "ログインが必要です。" }, { status: 401 });
    userId = user.id;

    const body = await request.json() as {
      socialPostId?: string;
      verdict?: "continue" | "pivot" | "stop" | "wait";
      nextAction?: string;
      changedAngle?: string;
      changedHook?: string;
      testMetric?: string;
      autoGenerate?: boolean;
    };
    if (!body.socialPostId) return NextResponse.json({ error: "socialPostIdが必要です。" }, { status: 400 });
    sourcePostId = body.socialPostId;
    if (body.verdict === "stop" || body.verdict === "wait") {
      return NextResponse.json({ error: body.verdict === "stop" ? "STOP判定では次Creativeを自動生成しません。" : "データ不足（WAIT）のため次Creativeは生成しません。" }, { status: 409 });
    }

    const db = getAdminSupabase();
    const { data: post, error: postError } = await db.from("social_posts")
      .select("id,user_id,creative_id,network,caption,metadata").eq("id", body.socialPostId).eq("user_id", user.id).maybeSingle();
    if (postError) throw postError;
    if (!post) return NextResponse.json({ error: "対象投稿が見つかりません。" }, { status: 404 });

    // 呼び出し側の verdict だけを信用せず、保存済みの最新 Decision でも STOP / WAIT を拒否する。
    const lastDecisionRef = (post.metadata as Record<string, unknown> | null)?.operator_last_decision as Record<string, unknown> | undefined;
    let structured: StructuredDecision | null = null;
    if (lastDecisionRef?.run_id) {
      const { data: decisionRun } = await db.from("operator_runs")
        .select("id,output").eq("id", String(lastDecisionRef.run_id)).eq("user_id", user.id).maybeSingle();
      structured = ((decisionRun?.output as Record<string, unknown> | null)?.decision as StructuredDecision | undefined) ?? null;
    }
    const latestVerdict = structured?.verdict ?? (typeof lastDecisionRef?.verdict === "string" ? lastDecisionRef.verdict : null);
    if (latestVerdict === "stop" || latestVerdict === "wait") {
      return NextResponse.json({
        error: latestVerdict === "stop" ? "最新のAI判定がSTOPのため次Creativeを生成しません。" : "最新のAI判定がWAIT（データ不足）のため次Creativeを生成しません。",
        verdict: latestVerdict,
      }, { status: 409 });
    }

    const { data: existingPosts } = await db.from("social_posts")
      .select("id,creative_id,network,status,metadata")
      .eq("user_id", user.id)
      .eq("metadata->>source_social_post_id", post.id)
      .eq("network", post.network)
      .limit(1);
    if (existingPosts?.[0]) {
      const existingPost = existingPosts[0];
      const { data: existingJob } = await db.from("production_jobs")
        .select("id,status,request_id").eq("social_post_id", existingPost.id).eq("user_id", user.id)
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      const { data: existingCreative } = await db.from("creatives")
        .select("id,title,hook,scenario").eq("id", existingPost.creative_id).eq("user_id", user.id).maybeSingle();
      return NextResponse.json({
        ok: true,
        reused: true,
        creative: existingCreative,
        socialPost: existingPost,
        video: existingJob ? { jobId: existingJob.id, requestId: existingJob.request_id, status: existingJob.status } : null,
      });
    }

    // 競合するCron/リクエストが同じ元投稿を同時処理しないよう、元投稿を原子的にclaimする。
    // claimは30分で期限切れにし、途中失敗時は次回巡回で再取得できるようにする。
    claimId = crypto.randomUUID();
    const claimNow = new Date();
    const claimCutoff = new Date(claimNow.getTime() - 30 * 60 * 1000).toISOString();
    const claimMetadata = {
      ...(post.metadata || {}),
      operator_next_creative_claim_id: claimId,
      operator_next_creative_claimed_at: claimNow.toISOString(),
    };
    const { data: claimedPost, error: claimError } = await db.from("social_posts")
      .update({ metadata: claimMetadata, updated_at: claimNow.toISOString() })
      .eq("id", post.id)
      .eq("user_id", user.id)
      .or(
        "metadata->>operator_next_creative_claimed_at.is.null,metadata->>operator_next_creative_claimed_at.lt." + claimCutoff,
      )
      .select("id")
      .maybeSingle();
    if (claimError) throw claimError;
    if (!claimedPost) {
      return NextResponse.json(
        { ok: true, reused: true, processing: true, reason: "next creative generation is already claimed" },
        { status: 202 },
      );
    }

    const { data: creative, error: creativeError } = await db.from("creatives")
      .select("id,product_id,plan_id,title,variation,hook,scenario,generation_provider,generation_model")
      .eq("id", post.creative_id).eq("user_id", user.id).maybeSingle();
    if (creativeError) throw creativeError;
    if (!creative) return NextResponse.json({ error: "元クリエイティブが見つかりません。" }, { status: 404 });

    const verdict = body.verdict || (latestVerdict === "continue" ? "continue" : "pivot");
    const nextAction = body.nextAction || structured?.next_action.instructions || "前回と異なるHookと訴求で再テストする";
    const hook = body.changedHook || structured?.next_action.hook || (
      verdict === "continue"
        ? (creative.hook || "この商品の別の使い方、知っていますか？")
        : "前の広告とは違う視点で、この商品を見てください。"
    );
    const angle = body.changedAngle || structured?.next_action.angle || (
      verdict === "continue" ? "同一訴求の別Hook" : "前回と異なる顧客課題・訴求"
    );

    const { data: nextCreative, error: nextCreativeError } = await db.from("creatives").insert({
      product_id: creative.product_id,
      plan_id: creative.plan_id,
      user_id: user.id,
      title: String(creative.title || "Next Creative") + " / Iteration",
      variation: "operator-" + verdict,
      hook,
      scenario: {
        type: "iterative_ad",
        source_creative_id: creative.id,
        verdict,
        angle,
        next_action: nextAction,
        test_metric: body.testMetric || structured?.primary_metric || "CTR / CVR / ROAS",
        decision_run_id: lastDecisionRef?.run_id ?? null,
        decision: structured ? {
          action_type: structured.action_type,
          target_customer: structured.target_customer,
          hypothesis: structured.hypothesis,
          expected_outcome: structured.expected_outcome,
          primary_metric: structured.primary_metric,
          learning_objective: structured.learning_objective,
          change_axis: structured.next_action.change_axis,
          logic_version: structured.logic_version,
          input_hash: structured.input_hash,
        } : null,
        scenes: [
          { order: 1, role: "hook", text: hook },
          { order: 2, role: "problem", text: structured?.next_action.change_axis === "angle" || structured?.next_action.change_axis === "target" ? angle : "前回と異なる顧客課題を具体化する" },
          { order: 3, role: "solution", text: "商品による解決を実演する" },
          { order: 4, role: "proof", text: "確認可能な事実・使用感だけを示す" },
          { order: 5, role: "cta", text: "次の行動を1つだけ提示する" }
        ]
      },
      status: "planned"
    }).select("id,title,hook,scenario").single();
    if (nextCreativeError || !nextCreative) throw new Error(nextCreativeError?.message || "次のクリエイティブ作成に失敗しました。");
    nextCreativeId = nextCreative.id;

    const { data: nextPost, error: nextPostError } = await db.from("social_posts").insert({
      creative_id: nextCreative.id,
      user_id: user.id,
      network: post.network,
      status: "scheduled",
      caption: post.caption || hook,
      metadata: {
        source_social_post_id: post.id,
        source_creative_id: creative.id,
        operator_verdict: verdict,
        iteration_angle: angle,
        test_metric: body.testMetric || structured?.primary_metric || "CTR / CVR / ROAS",
        hypothesis: structured?.hypothesis ?? null,
        decision_run_id: lastDecisionRef?.run_id ?? null,
        operator_patrol_status: "active",
        auto_publish: true,
      }
    }).select("id,network,status,caption,metadata").single();
    if (nextPostError || !nextPost) throw new Error(nextPostError?.message || "次の投稿レコード作成に失敗しました。");
    nextPostId = nextPost.id;

    let video = null;
    if (body.autoGenerate !== false) {
      const prompt = makePrompt({
        title: String(nextCreative.title || creative.title || "広告"),
        originalHook: String(creative.hook || ""),
        changedAngle: angle,
        changedHook: hook,
        nextAction,
        network: post.network,
      });

      const { data: job, error: jobError } = await db.from("production_jobs").insert({
        user_id: user.id,
        social_post_id: nextPost.id,
        creative_id: nextCreative.id,
        provider: "higgsfield",
        model: process.env.HF_VIDEO_MODEL || "alibaba/wan-3.0/text-to-video",
        status: "queued",
        prompt,
        duration: 5,
        resolution: "1080p",
        aspect_ratio: "9:16",
        generate_audio: false
      }).select("id").single();
      if (jobError || !job) throw new Error(jobError?.message || "動画生成ジョブの作成に失敗しました。");
      jobId = job.id;

      // Higgsfieldはここでは開始しない。
      // next-creativeはproduction_jobs=queuedまででHTTP処理を終了し、
      // operator-loopのWorker処理がqueued Jobを取得してHiggsfieldを開始する。
      video = { jobId, requestId: null, status: "queued" };
    }

    const { data: run, error: runError } = await db.from("operator_runs").insert({
      product_id: creative.product_id,
      user_id: user.id,
      run_type: "next_creative",
      status: "completed",
      input: { source_social_post_id: post.id, source_creative_id: creative.id, verdict },
      output: { next_creative_id: nextCreative.id, next_social_post_id: nextPost.id, video, angle, hook, nextAction },
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString()
    }).select("id").single();
    if (runError) throw runError;
    operatorRunId = run.id;

    // 元投稿は次の投稿へ引き継いだので、以後の巡回・判定対象から外す。
    const { data: latestSource } = await db.from("social_posts").select("metadata").eq("id", post.id).eq("user_id", user.id).maybeSingle();
    await db.from("social_posts").update({
      metadata: {
        ...((latestSource?.metadata as Record<string, unknown> | null) || {}),
        operator_patrol_status: "superseded",
        operator_superseded_by: nextPost.id,
      },
      updated_at: new Date().toISOString(),
    }).eq("id", post.id).eq("user_id", user.id);

    return NextResponse.json({ ok: true, runId: run.id, creative: nextCreative, socialPost: nextPost, video }, { status: 201 });
  } catch (error) {
    try {
      const db = getAdminSupabase();
      // 途中生成物を残すと、次回Cronが「既に生成済み」と誤認するため、
      // このリクエストで作った行だけをロールバックする。
      if (jobId) await db.from("production_jobs").delete().eq("id", jobId).eq("user_id", userId);
      if (operatorRunId) await db.from("operator_runs").delete().eq("id", operatorRunId).eq("user_id", userId);
      if (nextPostId) await db.from("social_posts").delete().eq("id", nextPostId).eq("user_id", userId);
      if (nextCreativeId) await db.from("creatives").delete().eq("id", nextCreativeId).eq("user_id", userId);
      if (userId && sourcePostId && claimId) {
        const { data: claimed } = await db.from("social_posts").select("metadata").eq("id", sourcePostId).eq("user_id", userId).maybeSingle();
        const metadata = claimed?.metadata && typeof claimed.metadata === "object" ? { ...(claimed.metadata as Record<string, unknown>) } : null;
        if (metadata?.operator_next_creative_claim_id === claimId) {
          delete metadata.operator_next_creative_claim_id;
          delete metadata.operator_next_creative_claimed_at;
          await db.from("social_posts").update({ metadata, updated_at: new Date().toISOString() }).eq("id", sourcePostId).eq("user_id", userId);
        }
      }
    } catch (cleanupError) {
      console.error("next creative rollback failed", cleanupError);
    }
    console.error("next creative error", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "次の広告生成に失敗しました。" }, { status: 500 });
  }
}
