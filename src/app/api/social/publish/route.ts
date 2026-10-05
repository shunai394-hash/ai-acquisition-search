import { NextResponse } from "next/server";
import { publishTikTokVideo } from "@/lib/social/tiktok";
import { publishInstagramReel, publishFacebookReel } from "@/lib/social/meta";
import { uploadYouTubeVideo } from "@/lib/social/youtube";
import { publishXPost } from "@/lib/social/x";
import { createLinkedInVideoPost, decryptLinkedInToken } from "@/lib/linkedin";
import { getAdminSupabase, getUserFromBearer } from "@/lib/billing";
import { assertPublicUrl, fetchPublicUrl } from "@/lib/security/public-url";
import { writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export const runtime = "nodejs";
export const maxDuration = 300;

type Platform = "tiktok" | "instagram" | "facebook" | "youtube" | "x" | "linkedin";

export async function POST(request: Request) {
  try {
    const user = await getUserFromBearer(request);
    if (!user) return NextResponse.json({ error: "ログインが必要です。" }, { status: 401 });
    const body = await request.json();
    const socialPostId = typeof body.socialPostId === "string" ? body.socialPostId.trim() : "";
    const videoUrl = typeof body.videoUrl === "string" ? body.videoUrl.trim() : "";
    const caption = typeof body.caption === "string" ? body.caption.trim() : "";
    const platforms = Array.isArray(body.platforms)
      ? body.platforms.filter((v: unknown): v is Platform => ["tiktok","instagram","facebook","youtube","x","linkedin"].includes(String(v)))
      : [];
    if (!socialPostId) return NextResponse.json({ error: "socialPostIdが必要です。" }, { status: 400 });
    if (!videoUrl.startsWith("https://")) return NextResponse.json({ error: "完成動画のHTTPS URLが必要です。" }, { status: 400 });
    try {
      await assertPublicUrl(videoUrl, ["https:"]);
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "動画URLを検証できませんでした。" }, { status: 400 });
    }
    if (!caption) return NextResponse.json({ error: "投稿本文が必要です。" }, { status: 400 });
    if (!platforms.length) return NextResponse.json({ error: "投稿先を1つ以上選択してください。" }, { status: 400 });

    const supabase = getAdminSupabase();
    const { data: source, error: sourceError } = await supabase.from("social_posts")
      .select("id,creative_id").eq("id", socialPostId).eq("user_id", user.id).maybeSingle();
    if (sourceError) throw sourceError;
    if (!source) return NextResponse.json({ error: "対象のテスト投稿が見つかりません。" }, { status: 404 });

    if (platforms.includes("tiktok")) {
      const { data: tiktokConsent, error: tiktokConsentError } = await supabase
        .from("tiktok_publish_consents")
        .select("consented_at")
        .eq("user_id", user.id)
        .maybeSingle();
      if (tiktokConsentError) throw tiktokConsentError;
      if (!tiktokConsent) {
        return NextResponse.json({
          error: "TikTok自動投稿には、先に明示的な公開同意が必要です。",
          code: "TIKTOK_PUBLISH_CONSENT_REQUIRED",
        }, { status: 403 });
      }
    }

    const results: Array<{platform:string;ok:boolean;postId?:string;url?:string;error?:string;manualRecoveryRequired?:boolean}> = [];
    let tempFile = "";
    let videoBuffer: Uint8Array | null = null;
    const getVideoBuffer = async () => {
      if (videoBuffer) return videoBuffer;
      const response = await fetchPublicUrl(videoUrl);
      if (!response.ok) throw new Error(`動画取得失敗: HTTP ${response.status}`);
      videoBuffer = new Uint8Array(await response.arrayBuffer());
      if (!videoBuffer.byteLength) throw new Error("完成動画が空です。");
      return videoBuffer;
    };

    // Reserve one publishing row per (source post, network) BEFORE calling the external API.
    // This prevents two workers from publishing the same creative to the same network concurrently.
    // A row left in "publishing" after a process crash is deliberately not auto-retried,
    // because retrying without provider-side idempotency could create a duplicate external post.
    const findExistingReservation = async (network: Platform) => {
      const { data: snakeCase, error: snakeError } = await supabase.from("social_posts")
        .select("id,status,external_post_id,post_url")
        .eq("user_id", user.id).eq("network", network)
        .filter("metadata->>source_social_post_id", "eq", socialPostId)
        .maybeSingle();
      if (snakeError) throw snakeError;
      if (snakeCase) return snakeCase;

      const { data: camelCase, error: camelError } = await supabase.from("social_posts")
        .select("id,status,external_post_id,post_url")
        .eq("user_id", user.id).eq("network", network)
        .filter("metadata->>sourceSocialPostId", "eq", socialPostId)
        .maybeSingle();
      if (camelError) throw camelError;
      return camelCase ?? null;
    };

    const reserve = async (network: Platform) => {
      const metadata = { source_social_post_id: socialPostId };
      const existingBeforeInsert = await findExistingReservation(network);
      if (existingBeforeInsert) {
        if (existingBeforeInsert.status === "published" || existingBeforeInsert.status === "publishing") {
          return { claimed: false, row: existingBeforeInsert };
        }
        const { data: reclaimed, error: reclaimError } = await supabase.from("social_posts")
          .update({ status: "publishing", published_at: null, updated_at: new Date().toISOString() })
          .eq("id", existingBeforeInsert.id).eq("user_id", user.id).eq("status", "failed")
          .select("id,status,external_post_id,post_url").maybeSingle();
        if (reclaimError) throw reclaimError;
        if (reclaimed) return { claimed: true, row: reclaimed };
      }

      const { data, error } = await supabase.from("social_posts").insert({
        creative_id: source.creative_id,
        user_id: user.id,
        network,
        external_post_id: null,
        post_url: null,
        published_at: null,
        status: "publishing",
        caption,
        metadata,
      }).select("id,status,external_post_id,post_url").single();

      if (!error && data) return { claimed: true, row: data };

      if (error?.code !== "23505") throw error;

      const existing = await findExistingReservation(network);
      if (!existing) throw new Error("SNS投稿の重複予約を確認できませんでした。");

      if (existing.status === "published") return { claimed: false, row: existing };
      if (existing.status === "publishing") return { claimed: false, row: existing };

      const { data: reclaimed, error: reclaimError } = await supabase.from("social_posts")
        .update({ status: "publishing", published_at: null, updated_at: new Date().toISOString() })
        .eq("id", existing.id)
        .eq("user_id", user.id)
        .eq("status", "failed")
        .select("id,status,external_post_id,post_url")
        .maybeSingle();
      if (reclaimError) throw reclaimError;
      return reclaimed
        ? { claimed: true, row: reclaimed }
        : { claimed: false, row: existing };
    };

    const complete = async (rowId: string, network: Platform, externalId: string | null, postUrl: string | null, metadata: Record<string,unknown> = {}) => {
      const { data, error } = await supabase.from("social_posts").update({
        external_post_id: externalId,
        post_url: postUrl,
        published_at: new Date().toISOString(),
        status: "published",
        metadata: { source_social_post_id: socialPostId, ...metadata },
        updated_at: new Date().toISOString(),
      }).eq("id", rowId).eq("user_id", user.id).eq("network", network).eq("status", "publishing")
        .select("id,external_post_id,post_url").single();
      if (error || !data) throw error || new Error("SNS投稿結果の保存に失敗しました。");
      return data;
    };

    const fail = async (rowId: string, message: string) => {
      await supabase.from("social_posts").update({
        status: "failed",
        metadata: { source_social_post_id: socialPostId, publish_error: message },
        updated_at: new Date().toISOString(),
      }).eq("id", rowId).eq("user_id", user.id).eq("status", "publishing");
    };

    try {
      for (const platform of platforms) {
        let reservation: Awaited<ReturnType<typeof reserve>> | null = null;
        let externalPublishSucceeded = false;
        let externalPostId: string | null = null;
        let externalPostUrl: string | null = null;
        try {
          reservation = await reserve(platform);
          if (!reservation.claimed) {
            if (reservation.row.status === "published") {
              results.push({
                platform,
                ok: true,
                postId: reservation.row.external_post_id ?? undefined,
                url: reservation.row.post_url ?? undefined,
              });
            } else {
              results.push({
                platform,
                ok: false,
                error: "この投稿先は別の処理で予約済みです。外部SNSへの二重投稿を避けるため再実行しません。",
              });
            }
            continue;
          }

          const rowId = reservation.row.id;
          if (platform === "tiktok") {
            const r = await publishTikTokVideo({videoUrl,title:caption,isAigc:true});
            externalPublishSucceeded = true;
            externalPostId = r.publishId;
            const saved = await complete(rowId,platform,r.publishId,null,{publishId:r.publishId});
            results.push({platform,ok:true,postId:saved.external_post_id ?? r.publishId});
          } else if (platform === "instagram") {
            const r = await publishInstagramReel({videoUrl,caption});
            externalPublishSucceeded = true;
            externalPostId = r.mediaId;
            const saved = await complete(rowId,platform,r.mediaId,null,r);
            results.push({platform,ok:true,postId:saved.external_post_id ?? r.mediaId});
          } else if (platform === "facebook") {
            const r = await publishFacebookReel({videoUrl,caption});
            externalPublishSucceeded = true;
            externalPostId = r.videoId;
            const saved = await complete(rowId,platform,r.videoId,null,r);
            results.push({platform,ok:true,postId:saved.external_post_id ?? r.videoId});
          } else if (platform === "youtube") {
            const response = await fetchPublicUrl(videoUrl);
            if (!response.ok) throw new Error(`動画取得失敗: HTTP ${response.status}`);
            tempFile = path.join(os.tmpdir(),`ai-acquisition-${source.id}.mp4`);
            await writeFile(tempFile,Buffer.from(await response.arrayBuffer()));
            const r = await uploadYouTubeVideo({filePath:tempFile,title:caption,description:caption,privacyStatus:"public",containsSyntheticMedia:true});
            externalPublishSucceeded = true;
            externalPostId = r.videoId;
            externalPostUrl = r.url;
            const saved = await complete(rowId,platform,r.videoId,r.url,r);
            results.push({platform,ok:true,postId:saved.external_post_id ?? r.videoId,url:saved.post_url ?? r.url ?? undefined});
          } else if (platform === "x") {
            const r = await publishXPost({text:caption.slice(0,280),video:await getVideoBuffer()});
            externalPublishSucceeded = true;
            externalPostId = r.postId;
            externalPostUrl = r.url;
            const saved = await complete(rowId,platform,r.postId,r.url,r);
            results.push({platform,ok:true,postId:saved.external_post_id ?? r.postId,url:saved.post_url ?? r.url});
          } else {
            const {data: account,error} = await supabase.from("linkedin_accounts")
              .select("linkedin_sub,access_token_encrypted,expires_at").eq("user_id",user.id).maybeSingle();
            if (error) throw error;
            if (!account) throw new Error("LinkedInを先に接続してください。");
            if (account.expires_at && new Date(account.expires_at).getTime() <= Date.now()) throw new Error("LinkedInアクセストークンの有効期限が切れています。");
            const r = await createLinkedInVideoPost(decryptLinkedInToken(account.access_token_encrypted),"urn:li:person:"+account.linkedin_sub,caption,await getVideoBuffer());
            externalPublishSucceeded = true;
            externalPostId = r.id;
            externalPostUrl = r.id ? "https://www.linkedin.com/feed/update/"+r.id : null;
            const url = externalPostUrl;
            const saved = await complete(rowId,platform,r.id,url,{postUrn:r.id,videoUrn:r.videoUrn});
            results.push({platform,ok:true,postId:saved.external_post_id ?? undefined,url:saved.post_url ?? undefined});
          }
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          if (reservation?.claimed && !externalPublishSucceeded) {
            await fail(reservation.row.id, message);
            results.push({platform,ok:false,error:message});
          } else if (reservation?.claimed && externalPublishSucceeded) {
            // 外部SNS側では投稿済みなので、DB保存だけ失敗した場合はfailedへ戻さない。
            // failedにすると次回実行が再投稿し、二重投稿になる可能性がある。
            const { error: recoveryError } = await supabase.from("social_posts").update({
              external_post_id: externalPostId,
              post_url: externalPostUrl,
              published_at: new Date().toISOString(),
              status: "published",
              metadata: {
                source_social_post_id: socialPostId,
                external_publish_succeeded: true,
                recovered_after_persistence_error: true,
                publish_persistence_error: message,
              },
              updated_at: new Date().toISOString(),
            }).eq("id", reservation.row.id).eq("user_id", user.id).eq("status", "publishing");
            if (!recoveryError) {
              results.push({
                platform,
                ok: true,
                postId: externalPostId ?? undefined,
                url: externalPostUrl ?? undefined,
              });
              continue;
            }
            results.push({
              platform,
              ok: false,
              manualRecoveryRequired: true,
              error: "外部SNSへの投稿は成功しましたが、結果のDB保存にも失敗しました。二重投稿防止のため自動再投稿は行いません。",
            });
          } else {
            results.push({platform,ok:false,error:message});
          }
        }
      }
    } finally {
      if (tempFile) await unlink(tempFile).catch(()=>{});
    }
    return NextResponse.json({ok:results.some(r=>r.ok),results,published:results.filter(r=>r.ok).length,failed:results.filter(r=>!r.ok).length});
  } catch (e) {
    return NextResponse.json({error:e instanceof Error ? e.message : "SNS投稿に失敗しました。"},{status:500});
  }
}