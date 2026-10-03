import { NextResponse } from "next/server";
import { getAdminSupabase, getUserFromBearer } from "@/lib/billing";
import { DECISION_RUN_TYPE, isProcessingRun, reservationLeaseExpiry } from "@/lib/decision/reservation-store";

export const runtime = "nodejs";
export const maxDuration = 60;

function makePrompt(input: {
  title: string; originalHook: string; changedAngle?: string; changedHook?: string;
  nextAction: string; network: string; hypothesis?: string; beats?: string[];
  proof?: string[]; cta?: string; primaryMetric?: string; holdConstant?: string[];
}) {
  return [
    "Create the next advertising video strictly from this locked experiment contract.",
    "Product/creative: " + input.title,
    "Original hook: " + input.originalHook,
    "Network: " + input.network,
    input.hypothesis ? "Hypothesis: " + input.hypothesis : "",
    input.changedAngle ? "Changed angle: " + input.changedAngle : "",
    input.changedHook ? "Changed hook: " + input.changedHook : "",
    input.beats?.length ? "Beats: " + input.beats.join(" → ") : "",
    input.proof?.length ? "Proof: " + input.proof.join(" / ") : "",
    input.cta ? "CTA: " + input.cta : "",
    input.primaryMetric ? "Primary metric: " + input.primaryMetric : "",
    input.holdConstant?.length ? "Hold constant: " + input.holdConstant.join(", ") : "",
    "Use natural UGC-style visuals, 9:16, clear first 3 seconds, no fake claims, no watermark, no platform UI.",
    "Do not invent product facts, evidence, testimonials, prices, or performance claims.",
  ].filter(Boolean).join("\n");
}

function productionClipDuration(scenario: Record<string, unknown> | null) {
  const requested = Number(scenario?.durationSeconds);
  if (requested === 15 || requested === 30) return requested;
  if (requested > 30) return 30;
  const beats = Array.isArray(scenario?.beats) ? scenario.beats.length : 0;
  const proof = Array.isArray(scenario?.proof) ? scenario.proof.length : 0;
  return beats >= 3 || proof >= 2 ? 30 : 15;
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
      return NextResponse.json({ error: body.verdict === "stop" ? "STOP判定では次Creativeを自動生成しません。" : "データ不足(WAIT)のため次Creativeを生成しません。", verdict: body.verdict }, { status: 409 });
    }

    const db = getAdminSupabase();

    // The latest stored Teacher verdict wins over the request body, so a stale
    // or wrong client verdict can never generate a creative after STOP / WAIT.
    // Reservations (processing rows) carry no verdict yet: skip them, and while
    // one is live the decision may still turn into STOP / WAIT, so do not proceed.
    const { data: verdictRuns, error: verdictError } = await db.from("operator_runs")
      .select("id,output,completed_at,lease_expires_at,started_at,created_at")
      .eq("user_id", user.id)
      .eq("run_type", DECISION_RUN_TYPE)
      .eq("input->>social_post_id", body.socialPostId)
      .order("created_at", { ascending: false })
      .limit(20);
    if (verdictError) throw verdictError;
    const runs = (verdictRuns || []) as Array<Record<string, unknown>>;
    const pending = runs.find((run) => isProcessingRun(run) && reservationLeaseExpiry(run) > Date.now());
    const latestVerdict = runs.find((run) => !isProcessingRun(run));
    if (pending && (!latestVerdict || String(pending.created_at) >= String(latestVerdict.created_at))) {
      return NextResponse.json({
        error: "AI判定を処理中です。判定の完了後に再実行してください。",
        code: "decision_in_progress",
        retryable: true,
        decisionRunId: pending.id,
      }, { status: 409, headers: { "Retry-After": "5" } });
    }
    const storedOutput = latestVerdict?.output && typeof latestVerdict.output === "object"
      ? latestVerdict.output as Record<string, unknown>
      : null;
    const storedDecision = storedOutput?.decision && typeof storedOutput.decision === "object"
      ? storedOutput.decision as Record<string, unknown>
      : null;
    const storedNextAction = storedDecision?.next_action && typeof storedDecision.next_action === "object"
      ? storedDecision.next_action as Record<string, unknown>
      : null;
    const storedScenario = storedNextAction?.scenario && typeof storedNextAction.scenario === "object"
      ? storedNextAction.scenario as Record<string, unknown>
      : null;
    const storedVerdict = String(storedOutput?.verdict || storedDecision?.verdict || "");
    const storedGenerateCreative = storedNextAction?.generate_creative;
    if (storedGenerateCreative === false) {
      return NextResponse.json({ error: "最新のDecisionがクリエイティブ生成を許可していません。", code: "creative_generation_not_allowed" }, { status: 409 });
    }
    if (storedVerdict === "stop" || storedVerdict === "wait") {
      return NextResponse.json({
        error: storedVerdict === "stop" ? "最新のTeacher判定がSTOPのため次Creativeを生成しません。" : "最新のTeacher判定がWAIT(データ不足)のため次Creativeを生成しません。",
        verdict: storedVerdict,
        decisionRunId: latestVerdict?.id,
      }, { status: 409 });
    }
    const { data: post, error: postError } = await db.from("social_posts")
      .select("id,user_id,creative_id,network,caption,metadata").eq("id", body.socialPostId).eq("user_id", user.id).maybeSingle();
    if (postError) throw postError;
    if (!post) return NextResponse.json({ error: "対象投稿が見つかりません。" }, { status: 404 });

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

    const verdict = storedVerdict === "continue" || storedVerdict === "pivot"
      ? storedVerdict
      : body.verdict || "pivot";
    const lockedScenario = storedScenario;
    const lockedChangeVariable = lockedScenario && ["hook", "angle", "offer"].includes(String(lockedScenario.changeVariable))
      ? String(lockedScenario.changeVariable)
      : null;
    const changeVariable = lockedChangeVariable || (
      storedNextAction?.change_variable === "hook" || storedNextAction?.change_variable === "angle" || storedNextAction?.change_variable === "offer"
        ? storedNextAction.change_variable
        : verdict === "continue" ? "hook" : "angle"
    );
    const scenarioScenes = lockedScenario && Array.isArray(lockedScenario.scenes)
      ? lockedScenario.scenes.filter((scene): scene is Record<string, unknown> => !!scene && typeof scene === "object")
      : [];
    const scenarioScene = (purpose: string) => scenarioScenes.find((scene) => scene.purpose === purpose);
    const nextAction = typeof storedNextAction?.description === "string"
      ? storedNextAction.description
      : body.nextAction || "前回と異なる条件を1つだけ変更して再テストする";
    const hook = lockedScenario
      ? String(scenarioScene("hook")?.instruction || storedNextAction?.hook || creative.hook || "")
      : body.changedHook || String(storedNextAction?.hook || (verdict === "continue" ? creative.hook || "冒頭で顧客課題を明確に提示する" : "前回とは異なる顧客課題の視点を提示する"));
    const angle = lockedScenario
      ? String(storedNextAction?.angle || scenarioScene("solution")?.instruction || "")
      : body.changedAngle || String(storedNextAction?.angle || (verdict === "continue" ? "同一訴求の別Hook" : "前回と異なる顧客課題・訴求"));
    const scenario = storedScenario || (creative.scenario && typeof creative.scenario === "object"
      ? creative.scenario as Record<string, unknown>
      : null);
    const duration = productionClipDuration(scenario);

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
        change_variable: changeVariable,
        angle,
        next_action: nextAction,
        test_metric: lockedScenario && typeof lockedScenario.primaryMetric === "string"
          ? lockedScenario.primaryMetric
          : (typeof storedDecision?.primary_metric === "string" ? storedDecision.primary_metric : body.testMetric || "CTR / CVR / ROAS"),
        decision_scenario: scenario,
        production_clip_duration_seconds: duration,
        scenes: [
          { order: 1, role: "hook", text: hook },
          { order: 2, role: "problem", text: verdict === "continue" ? "前回と同じ顧客課題を、別の切り口で具体化する" : "前回と異なる顧客課題を具体化する" },
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
        operator_decision_run_id: latestVerdict?.id ?? null,
        iteration_angle: angle,
        test_metric: body.testMetric || "CTR / CVR / ROAS",
        // MVPでは投稿公開は人が最終確認する。AI循環は「判断→制作→計測→再判断」まで自動化し、公開操作は勝手に行わない。
        auto_publish: false,
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
        hypothesis: typeof storedDecision?.hypothesis === "string" ? storedDecision.hypothesis : undefined,
        beats: Array.isArray(scenario?.scenes) ? scenario.scenes.map((scene) => {
          if (!scene || typeof scene !== "object") return "";
          return String((scene as Record<string, unknown>).instruction || "");
        }).filter(Boolean) : [],
        proof: Array.isArray(scenario?.proof) ? scenario.proof.map(String) : [],
        cta: Array.isArray(scenario?.scenes)
          ? String((scenario.scenes.find((scene) => scene && typeof scene === "object" && (scene as Record<string, unknown>).purpose === "cta") as Record<string, unknown> | undefined)?.instruction || "")
          : "",
        primaryMetric: lockedScenario && typeof lockedScenario.primaryMetric === "string"
          ? lockedScenario.primaryMetric
          : typeof storedDecision?.primary_metric === "string" ? storedDecision.primary_metric : body.testMetric,
        holdConstant: scenario?.continuity && typeof scenario.continuity === "object" && Array.isArray((scenario.continuity as Record<string, unknown>).keep)
          ? ((scenario.continuity as Record<string, unknown>).keep as unknown[]).map(String)
          : Array.isArray(scenario?.variablesToHold)
            ? scenario.variablesToHold.map(String)
            : [],
      });

      const { data: job, error: jobError } = await db.from("production_jobs").insert({
        user_id: user.id,
        social_post_id: nextPost.id,
        creative_id: nextCreative.id,
        provider: "higgsfield",
        model: process.env.HF_VIDEO_MODEL || "alibaba/wan-3.0/text-to-video",
        status: "queued",
        prompt,
        duration,
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
      input: { source_social_post_id: post.id, source_creative_id: creative.id, verdict, decision_run_id: latestVerdict?.id ?? null },
      output: { next_creative_id: nextCreative.id, next_social_post_id: nextPost.id, video, angle, hook, nextAction },
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString()
    }).select("id").single();
    if (runError) throw runError;
    operatorRunId = run.id;

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
