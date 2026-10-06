import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { analyzePage } from "../lib/acquisition/analyze";
import { fetchPageSnapshot } from "../lib/acquisition/fetch-url";
import { discoverSocialSignals } from "../lib/acquisition/social-search";
import { discoverShopSignals } from "../lib/acquisition/shop-search";
import { saveNarrationFile } from "../lib/video/gemini-tts";
import { generateHiggsfieldVideo, waitForHiggsfieldVideo } from "../lib/video/higgsfield";
import { createCampaignId, loadCampaign, saveCampaign } from "../lib/campaign/store";
import { discoverAcquisitionSignals } from "../lib/acquisition/search-web";
import { decideNextCampaign } from "../lib/campaign/decision";
import type { CampaignPerformance } from "../lib/campaign/decision";
import { buildDecision } from "../lib/decision/engine";
import { getTikTokPublishStatus, getTikTokVideoMetrics, publishTikTokVideo, queryTikTokCreator, resolveTikTokVideoId } from "../lib/social/tiktok";
import { getYouTubeVideoStatus, uploadYouTubeVideo } from "../lib/social/youtube";
import { getFacebookReelMetrics, getInstagramReelMetrics, publishFacebookReel, publishInstagramReel } from "../lib/social/meta";
import { normalizeXPerformance, normalizeYouTubePerformance, normalizeTikTokPerformance, normalizeInstagramPerformance, normalizeFacebookPerformance, type NormalizedPerformance } from "../lib/analytics/performance";
import { publishXPost, getXPostMetrics } from "../lib/social/x";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

function createServer(): McpServer {
  const server = new McpServer({
    name: "ai-acquisition-search",
    version: "0.5.0"
  });

  server.registerTool(
    "analyze-acquisition",
    {
      description:
        "商品・サービスURLを取得し、商品・市場・顧客・競合・実績を分析して、集客課題・機会・優先順位・次にやるべき集客アクションを返します。",
      inputSchema: z.object({
        url: z.string().url().describe("分析対象の商品・サービスの公開URL")
      })
    },
    async ({ url }) => {
      try {
        const source = await fetchPageSnapshot(url);
        const productName = source.productName || source.title;
        const socialSignals = await discoverSocialSignals(productName);
        const shopSignals = await discoverShopSignals(productName);
        const analysis = await analyzePage(source, undefined, socialSignals, shopSignals);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  url,
                  source,
                  analysis
                },
                null,
                2
              )
            }
          ]
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "集客分析に失敗しました。";

        return {
          content: [{ type: "text", text: message }],
          isError: true
        };
      }
    }
  );

  server.registerTool(
    "generate-narration",
    {
      description:
        "Gemini 3.8 Flash TTSで日本語ナレーションを生成し、Claude Code拡張機能のローカルgeneratedフォルダにWAVとして保存します。",
      inputSchema: z.object({
        text: z.string().min(1).describe("読み上げるナレーション本文"),
        voice: z.string().optional().describe("Gemini TTSの音声名。既定値はKore"),
        style: z
          .string()
          .optional()
          .describe("話し方。例: 自然で明るい日本語広告ナレーション")
      })
    },
    async ({ text, voice, style }) => {
      try {
        const result = await saveNarrationFile({ text, voice, style });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "ナレーション生成に失敗しました。";
        return {
          content: [{ type: "text", text: message }],
          isError: true
        };
      }
    }
  );

  server.registerTool(
    "run-ad-cycle",
    {
      description: "商品URLから分析→次広告決定→Higgsfield動画生成→ナレーションまでを1回の広告サイクルとして実行します。SNS投稿は認可とpublishModeを確認してから実行します。",
      inputSchema: z.object({
        url: z.string().url(),
        campaignId: z.string().optional(),
        publishMode: z.enum(["draft", "approval", "autonomous"]).default("draft"),
        narrationText: z.string().optional(),
        platforms: z.array(z.enum(["tiktok", "youtube", "instagram", "facebook", "x"])).default([]),
        videoPrompt: z.string().optional(),
        confirmPublish: z.boolean().default(false).describe("SNSへ実投稿する場合は明示的にtrueを指定")
      })
    },
    async ({ url, campaignId, publishMode, narrationText, platforms, videoPrompt, confirmPublish }) => {
      try {
        const source = await fetchPageSnapshot(url);
        const productName = source.productName || source.title;
        const socialSignals = await discoverSocialSignals(productName);
        const shopSignals = await discoverShopSignals(productName);
        const search = await discoverAcquisitionSignals({
          productName,
          description: source.description,
          productSignals: source.productSignals,
          productCategory: source.productCategory
        });
        const analysis = await analyzePage(source, { query: search.queries.join(" / "), results: search.results }, socialSignals, shopSignals);
        const previousCampaign = campaignId ? await loadCampaign(campaignId) : null;
        const previousPerformance: CampaignPerformance[] = [];
        if (previousCampaign?.posts?.length) {
          const { getXPostMetrics } = await import("../lib/social/x");
          for (const post of previousCampaign.posts) {
            try {
              if (post.platform === "x") previousPerformance.push(await normalizeXPerformance(await getXPostMetrics(post.postId)));
              else if (post.platform === "youtube") previousPerformance.push(await normalizeYouTubePerformance(await getYouTubeVideoStatus(post.postId)));
              else if (post.platform === "tiktok") previousPerformance.push(await normalizeTikTokPerformance(await getTikTokVideoMetrics(post.postId)));
              else if (post.platform === "instagram") previousPerformance.push(await normalizeInstagramPerformance(await getInstagramReelMetrics(post.postId)));
              else if (post.platform === "facebook") previousPerformance.push(await normalizeFacebookPerformance(await getFacebookReelMetrics(post.postId)));
            } catch (error) {
              // stdout carries the MCP protocol; diagnostics go to stderr. The empty
              // metrics stay "unknown" for the decision instead of failing the call.
              console.error("previous performance unavailable", post.platform, post.postId, error instanceof Error ? error.message : String(error));
              previousPerformance.push({ platform: post.platform, postId: post.postId, metrics: {} });
            }
          }
        }
        const decision = decideNextCampaign({ analysis, performance: previousPerformance });
        const selected = decision.nextTests[0];
        const brief = decision.productionBrief;
        const prompt = videoPrompt ?? [selected?.concept, selected?.hook, brief?.angle, brief?.format, brief?.cta].filter(Boolean).join(". ");
        let video: unknown = null;
        let narration: unknown = null;
        let videoUrl: string | undefined;
        if (process.env.HF_API_KEY_ID && process.env.HF_API_KEY_SECRET && prompt) {
          const submitted = await generateHiggsfieldVideo({ prompt, aspectRatio: "9:16", resolution: "1080p", generateAudio: false });
          const requestId = typeof submitted.request_id === "string" ? submitted.request_id : undefined;
          if (requestId) {
            video = await waitForHiggsfieldVideo(requestId);
            const completed = video as Record<string, unknown>;
            videoUrl = typeof completed.videoUrl === "string" ? completed.videoUrl : undefined;
          } else {
            video = submitted;
          }
        }
        if (narrationText && process.env.GEMINI_API_KEY) {
          narration = await saveNarrationFile({ text: narrationText });
        }
        const publishResults: unknown[] = [];
        const posts: Array<{ platform: string; postId: string; url?: string; publishedAt?: string }> = [];
        const caption = selected?.hook || decision.productionBrief?.objective || productName;

        if (publishMode === "autonomous" && videoUrl && confirmPublish) {
          if (platforms.includes("tiktok") && process.env.TIKTOK_ACCESS_TOKEN) {
            const result = await publishTikTokVideo({ videoUrl, title: caption, isAigc: true });
            publishResults.push({ platform: "tiktok", ...result });
            if (result.publishId) { const resolved = await resolveTikTokVideoId(result.publishId); posts.push({ platform: "tiktok", postId: resolved.videoId, publishedAt: new Date().toISOString() }); publishResults.push({ platform: "tiktok-status", ...resolved }); }
          }
          if (platforms.includes("instagram") && process.env.META_ACCESS_TOKEN && process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID) {
            const result = await publishInstagramReel({ videoUrl, caption });
            publishResults.push({ ...result });
            if (result.mediaId) posts.push({ platform: "instagram", postId: result.mediaId, publishedAt: new Date().toISOString() });
          }
          if (platforms.includes("facebook") && process.env.META_ACCESS_TOKEN && process.env.FACEBOOK_PAGE_ID) {
            const result = await publishFacebookReel({ videoUrl, caption });
            publishResults.push({ ...result });
            if (result.videoId) posts.push({ platform: "facebook", postId: result.videoId, publishedAt: new Date().toISOString() });
          }
          if (platforms.includes("x") && process.env.X_ACCESS_TOKEN) {
            const result = await publishXPost({ text: caption });
            publishResults.push({ ...result });
            if (result.postId) posts.push({ platform: "x", postId: result.postId, url: result.url, publishedAt: new Date().toISOString() });
          }
          if (platforms.includes("youtube") && process.env.YOUTUBE_ACCESS_TOKEN) {
            const outputPath = path.join(process.cwd(), "generated", "campaign-video.mp4");
            await mkdir(path.dirname(outputPath), { recursive: true });
            const response = await fetch(videoUrl);
            if (!response.ok) throw new Error(`動画ファイル取得に失敗しました（HTTP ${response.status}）。`);
            await writeFile(outputPath, Buffer.from(await response.arrayBuffer()));
            const result = await uploadYouTubeVideo({ filePath: outputPath, title: caption, description: decision.productionBrief?.objective ?? "" });
            publishResults.push({ platform: "youtube", ...result });
            if (result.videoId) posts.push({ platform: "youtube", postId: result.videoId, url: result.url ?? undefined, publishedAt: new Date().toISOString() });
          }
        }

        const newCampaignId = createCampaignId();
        const record = {
          campaignId: newCampaignId, productUrl: url, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: posts.length ? "testing" as const : "planning" as const,
          hypothesis: decision, posts, performance: []
        };
        const filePath = await saveCampaign(record);
        return { content: [{ type: "text", text: JSON.stringify({ campaignId: newCampaignId, publishMode, platforms, analysis, decision, previousPerformance, video, videoUrl, narration, publishResults, filePath, publishing: publishMode === "autonomous" && confirmPublish ? "autonomous publish attempted for configured platforms" : "not published" }, null, 2) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : "広告サイクルの実行に失敗しました。";
        return { content: [{ type: "text", text: message }], isError: true };
      }
    }
  );

  server.registerTool(
    "social-connection-status",
    {
      description: "SNS・動画生成・AI検索サービスの接続状態を確認します。APIキーやトークンの値は返しません。",
      inputSchema: z.object({})
    },
    async () => {
      const services = {
        tiktok: Boolean(process.env.TIKTOK_ACCESS_TOKEN),
        instagram: Boolean(process.env.META_ACCESS_TOKEN && process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID),
        facebook: Boolean(process.env.META_ACCESS_TOKEN && process.env.FACEBOOK_PAGE_ID),
        youtube: Boolean(process.env.YOUTUBE_ACCESS_TOKEN),
        x: Boolean(process.env.X_ACCESS_TOKEN),
        higgsfield: Boolean(process.env.HF_API_KEY_ID && process.env.HF_API_KEY_SECRET),
        geminiTts: Boolean(process.env.GEMINI_API_KEY),
        scrapeCreators: Boolean(process.env.SCRAPE_CREATORS_API_KEY),
        openai: Boolean(process.env.OPENAI_API_KEY)
      };
      return { content: [{ type: "text", text: JSON.stringify({ services, configuredCount: Object.values(services).filter(Boolean).length, total: Object.keys(services).length }, null, 2) }] };
    }
  );

  server.registerTool(
    "collect-campaign-performance",
    {
      description: "保存済みキャンペーンの全投稿から最新実績を取得し、campaign recordのperformanceへ保存します。",
      inputSchema: z.object({ campaignId: z.string().min(1) })
    },
    async ({ campaignId }) => {
      try {
        const campaign = await loadCampaign(campaignId);
        if (!campaign) {
          return { content: [{ type: "text", text: `Campaign not found: ${campaignId}` }], isError: true };
        }
        const { getXPostMetrics } = await import("../lib/social/x");
        const results: NormalizedPerformance[] = [];
        for (const post of campaign.posts) {
          try {
            let normalized;
            if (post.platform === "x") normalized = await normalizeXPerformance(await getXPostMetrics(post.postId));
            else if (post.platform === "youtube") normalized = await normalizeYouTubePerformance(await getYouTubeVideoStatus(post.postId));
            else if (post.platform === "tiktok") normalized = await normalizeTikTokPerformance(await getTikTokVideoMetrics(post.postId));
            else if (post.platform === "instagram") normalized = await normalizeInstagramPerformance(await getInstagramReelMetrics(post.postId));
            else if (post.platform === "facebook") normalized = await normalizeFacebookPerformance(await getFacebookReelMetrics(post.postId));
            else {
              continue;
              continue;
            }
            results.push(normalized);
          } catch {
            // Failed metric collection is omitted from normalized performance; the caller receives only valid records.
          }
        }
        const updated = { ...campaign, updatedAt: new Date().toISOString(), performance: results };
        const filePath = await saveCampaign(updated);
        return { content: [{ type: "text", text: JSON.stringify({ campaignId, performance: results, filePath }, null, 2) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : "キャンペーン実績の取得に失敗しました。";
        return { content: [{ type: "text", text: message }], isError: true };
      }
    }
  );

  server.registerTool(
    "campaign-save",
    {
      description: "AI広告サイクルの状態をgenerated/campaignsに保存します。",
      inputSchema: z.object({
        campaignId: z.string().optional(),
        productUrl: z.string().url(),
        status: z.enum(["planning", "testing", "learning"]).optional(),
        hypothesis: z.unknown(),
        posts: z.array(z.object({
          platform: z.string(),
          postId: z.string(),
          url: z.string().url().optional(),
          publishedAt: z.string().optional()
        })).optional(),
        performance: z.array(z.unknown()).optional()
      })
    },
    async ({ campaignId, productUrl, status, hypothesis, posts, performance }) => {
      try {
        const now = new Date().toISOString();
        const id = campaignId ?? createCampaignId();
        const existing = campaignId ? await loadCampaign(campaignId) : null;
        const record = {
          campaignId: id,
          productUrl,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          status: status ?? existing?.status ?? "planning",
          hypothesis,
          posts: posts ?? existing?.posts ?? [],
          performance: performance ?? existing?.performance ?? []
        } as const;
        const filePath = await saveCampaign(record);
        return { content: [{ type: "text", text: JSON.stringify({ ...record, filePath }, null, 2) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : "キャンペーン保存に失敗しました。";
        return { content: [{ type: "text", text: message }], isError: true };
      }
    }
  );

  server.registerTool(
    "campaign-load",
    {
      description: "保存済みAI広告キャンペーンの状態を読み込みます。",
      inputSchema: z.object({ campaignId: z.string().min(1) })
    },
    async ({ campaignId }) => {
      const record = await loadCampaign(campaignId);
      if (!record) return { content: [{ type: "text", text: `Campaign not found: ${campaignId}` }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify(record, null, 2) }] };
    }
  );

  server.registerTool(
    "higgsfield-create-video",
    {
      description: "Higgsfield APIで広告動画を生成します。AI集客エンジンの制作ブリーフを動画プロンプトとして渡し、生成結果を返します。",
      inputSchema: z.object({
        prompt: z.string().min(1),
        model: z.string().optional(),
        duration: z.number().int().min(2).max(30).optional(),
        resolution: z.enum(["480p", "720p", "1080p"]).optional(),
        aspectRatio: z.enum(["16:9", "4:3", "1:1", "3:4", "9:16", "adaptive"]).optional(),
        generateAudio: z.boolean().optional()
      })
    },
    async (input) => {
      try {
        const result = await generateHiggsfieldVideo(input);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Higgsfield動画生成に失敗しました。";
        return { content: [{ type: "text", text: message }], isError: true };
      }
    }
  );

  server.registerTool(
    "tiktok-creator-info",
    {
      description:
        "認可済みTikTokアカウントの投稿可能設定を取得します。投稿前の確認に使用します。",
      inputSchema: z.object({})
    },
    async () => {
      try {
        const result = await queryTikTokCreator();
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "TikTokアカウント情報の取得に失敗しました。";
        return { content: [{ type: "text", text: message }], isError: true };
      }
    }
  );

  server.registerTool(
    "tiktok-publish",
    {
      description:
        "TikTok Content Posting APIのDirect PostでHTTPS公開動画URLを認可済みアカウントへ投稿します。公開範囲は指定された値を使用し、AI生成動画はis_aigc=trueで送信します。",
      inputSchema: z.object({
        videoUrl: z.string().url().describe("TikTokから取得可能なHTTPS公開動画URL"),
        title: z.string().min(1).max(2200).describe("TikTokキャプション"),
        confirm: z.boolean().default(false).describe("実投稿を許可する明示確認"),
        privacyLevel: z.enum([
          "PUBLIC_TO_EVERYONE",
          "MUTUAL_FOLLOW_FRIENDS",
          "FOLLOWER_OF_CREATOR",
          "SELF_ONLY"
        ]).optional(),
        disableComment: z.boolean().optional(),
        disableDuet: z.boolean().optional(),
        disableStitch: z.boolean().optional(),
        isAigc: z.boolean().optional(),
        brandOrganicToggle: z.boolean().optional(),
        videoCoverTimestampMs: z.number().int().min(0).optional()
      })
    },
    async (input) => {
      try {
        if (!input.confirm) return { content: [{ type: "text", text: "投稿は実行していません。confirm=true を明示して再実行してください。" }], isError: true };
        const result = await publishTikTokVideo(input);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "TikTok投稿に失敗しました。";
        return { content: [{ type: "text", text: message }], isError: true };
      }
    }
  );

  server.registerTool(
    "tiktok-publish-status",
    {
      description: "TikTok Direct Postのpublish_idから投稿処理状態を取得します。",
      inputSchema: z.object({
        publishId: z.string().min(1).describe("TikTok APIが返したpublish_id")
      })
    },
    async ({ publishId }) => {
      try {
        const result = await getTikTokPublishStatus(publishId);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "TikTok投稿状態の取得に失敗しました。";
        return { content: [{ type: "text", text: message }], isError: true };
      }
    }
  );

  server.registerTool(
    "youtube-publish",
    {
      description:
        "YouTube Data API v3のvideos.insertを使い、ローカルMP4を認可済みYouTubeチャンネルへアップロードします。",
      inputSchema: z.object({
        filePath: z.string().min(1).describe("アップロードするMP4ファイルのローカルパス"),
        confirm: z.boolean().default(false).describe("実投稿を許可する明示確認"),
        title: z.string().min(1).max(100),
        description: z.string().optional(),
        tags: z.array(z.string()).optional(),
        categoryId: z.string().optional(),
        privacyStatus: z.enum(["private", "unlisted", "public"]).optional(),
        madeForKids: z.boolean().optional(),
        containsSyntheticMedia: z.boolean().optional()
      })
    },
    async (input) => {
      try {
        if (!input.confirm) return { content: [{ type: "text", text: "投稿は実行していません。confirm=true を明示して再実行してください。" }], isError: true };
        const result = await uploadYouTubeVideo(input);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : "YouTube投稿に失敗しました。";
        return { content: [{ type: "text", text: message }], isError: true };
      }
    }
  );

  server.registerTool(
    "youtube-publish-status",
    {
      description:
        "YouTube動画の公開状態、処理状態、再生数・いいね等の公開統計を取得します。",
      inputSchema: z.object({
        videoId: z.string().min(1)
      })
    },
    async ({ videoId }) => {
      try {
        const result = await getYouTubeVideoStatus(videoId);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : "YouTube状態取得に失敗しました。";
        return { content: [{ type: "text", text: message }], isError: true };
      }
    }
  );

  server.registerTool(
    "instagram-reel-publish",
    {
      description: "Meta Graph APIでInstagramプロフェッショナルアカウントへReelsを公開します。",
      inputSchema: z.object({
        videoUrl: z.string().url(),
        caption: z.string().optional(),
        confirm: z.boolean().default(false).describe("実投稿を許可する明示確認")
      })
    },
    async (input) => {
      try {
        if (!input.confirm) return { content: [{ type: "text", text: "投稿は実行していません。confirm=true を明示して再実行してください。" }], isError: true };
        const result = await publishInstagramReel(input);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Instagram投稿に失敗しました。";
        return { content: [{ type: "text", text: message }], isError: true };
      }
    }
  );

  server.registerTool(
    "facebook-reel-publish",
    {
      description: "Meta Graph APIでFacebook PageへReelsを公開します。",
      inputSchema: z.object({
        videoUrl: z.string().url(),
        caption: z.string().optional(),
        confirm: z.boolean().default(false).describe("実投稿を許可する明示確認")
      })
    },
    async (input) => {
      try {
        if (!input.confirm) return { content: [{ type: "text", text: "投稿は実行していません。confirm=true を明示して再実行してください。" }], isError: true };
        const result = await publishFacebookReel(input);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Facebook投稿に失敗しました。";
        return { content: [{ type: "text", text: message }], isError: true };
      }
    }
  );

  server.registerTool(
    "x-publish",
    {
      description: "X API v2で認可済みアカウントへテキスト投稿します。",
      inputSchema: z.object({ text: z.string().min(1).max(280), confirm: z.boolean().default(false).describe("実投稿を許可する明示確認") })
    },
    async ({ text, confirm }) => {
      try {
        if (!confirm) return { content: [{ type: "text", text: "投稿は実行していません。confirm=true を明示して再実行してください。" }], isError: true };
        const result = await publishXPost({ text });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : "X投稿に失敗しました。";
        return { content: [{ type: "text", text: message }], isError: true };
      }
    }
  );

  server.registerTool(
    "x-post-metrics",
    {
      description: "X投稿の公開メトリクスを取得します。",
      inputSchema: z.object({ postId: z.string().min(1) })
    },
    async ({ postId }) => {
      try {
        const result = await getXPostMetrics(postId);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : "X投稿のメトリクス取得に失敗しました。";
        return { content: [{ type: "text", text: message }], isError: true };
      }
    }
  );


  server.registerTool(
    "collect-performance",
    {
      description: "公開SNS投稿の実績を共通形式に正規化します。XとYouTubeから取得できます。",
      inputSchema: z.object({
        platform: z.enum(["x", "youtube", "tiktok", "instagram", "facebook"]),
        postId: z.string().min(1)
      })
    },
    async ({ platform, postId }) => {
      try {
        let result: NormalizedPerformance;
        if (platform === "x") {
          result = await normalizeXPerformance(await getXPostMetrics(postId));
        } else if (platform === "youtube") {
          result = await normalizeYouTubePerformance(await getYouTubeVideoStatus(postId));
        } else if (platform === "tiktok") {
          result = await normalizeTikTokPerformance(await getTikTokVideoMetrics(postId));
        } else if (platform === "instagram") {
          result = await normalizeInstagramPerformance(await getInstagramReelMetrics(postId));
        } else {
          result = await normalizeFacebookPerformance(await getFacebookReelMetrics(postId));
        }
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : "実績取得に失敗しました。";
        return { content: [{ type: "text", text: message }], isError: true };
      }
    }
  );

  server.registerTool(
    "evaluate-next-action",
    {
      description: "本番のEvidence → Teacher → DecisionエンジンでCONTINUE/PIVOT/STOP/WAITと次アクションを決定します。LLMではなくバージョン管理された決定ロジックが判定を行い、欠損値はunknownとして扱います。",
      inputSchema: z.object({
        asOf: z.string().datetime(),
        product: z.object({
          name: z.string().nullable(), url: z.string().url().nullable(),
          price: z.number().nullable(), cost: z.number().nullable(),
          features: z.array(z.string()).default([]), strengths: z.array(z.string()).default([]),
          useCases: z.array(z.string()).default([]), salesChannels: z.array(z.string()).default([])
        }),
        customer: z.object({
          target: z.string().nullable(), pain: z.string().nullable(), desire: z.string().nullable(),
          valueProposition: z.string().nullable(), buyingTriggers: z.array(z.string()).default([]),
          stage: z.string().nullable()
        }),
        market: z.object({
          status: z.enum(["ok", "unavailable", "not_configured", "no_data"]),
          error: z.string().optional(), runId: z.string().nullable().optional(),
          capturedAt: z.string().datetime().nullable().optional(), commentsCount: z.number().nullable().optional(),
          topPains: z.array(z.object({ pain: z.string(), count: z.number(), sharePercent: z.number() })).default([]),
          emergingPains: z.array(z.object({ pain: z.string(), status: z.string(), shareDeltaPercent: z.number() })).default([]),
          trendSignal: z.string().nullable().optional()
        }),
        hypothesis: z.object({
          socialPostId: z.string(), network: z.string(), caption: z.string().nullable(),
          hook: z.string().nullable(), angle: z.string().nullable(), hypothesis: z.string().nullable(),
          primaryMetric: z.string().nullable(), publishedAt: z.string().datetime().nullable(),
          lineageVerdicts: z.array(z.enum(["continue", "pivot", "stop", "wait"])).default([])
        }),
        current: z.object({
          id: z.string().nullable().optional(), measuredAt: z.string().datetime(),
          impressions: z.number().nullable(), views: z.number().nullable(), likes: z.number().nullable(),
          comments: z.number().nullable(), shares: z.number().nullable(), saves: z.number().nullable(),
          clicks: z.number().nullable(), conversions: z.number().nullable(), revenue: z.number().nullable(),
          grossProfit: z.number().nullable(), adSpend: z.number().nullable(), source: z.string()
        }).nullable(),
        history: z.array(z.object({
          socialPostId: z.string(), network: z.string(), publishedAt: z.string().datetime().nullable(),
          metric: z.object({
            id: z.string().nullable().optional(), measuredAt: z.string().datetime(),
            impressions: z.number().nullable(), views: z.number().nullable(), likes: z.number().nullable(),
            comments: z.number().nullable(), shares: z.number().nullable(), saves: z.number().nullable(),
            clicks: z.number().nullable(), conversions: z.number().nullable(), revenue: z.number().nullable(),
            grossProfit: z.number().nullable(), adSpend: z.number().nullable(), source: z.string()
          })
        })).default([])
      })
    },
    async (evidence) => {
      try {
        const decision = buildDecision(evidence);
        return { content: [{ type: "text", text: JSON.stringify(decision, null, 2) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : "次アクションの決定に失敗しました。";
        return { content: [{ type: "text", text: message }], isError: true };
      }
    }
  );

  server.registerTool(
    "optimize-next-campaign",
    {
      description: "分析結果と接続済みSNS実績から、次に実施する集客テストと制作ブリーフを決定します。未取得データは推測で補完しません。",
      inputSchema: z.object({
        analysis: z.record(z.string(), z.unknown()),
        performance: z.array(z.object({
          platform: z.string(),
          postId: z.string(),
          metrics: z.object({
            views: z.number().nullable().optional(),
            impressions: z.number().nullable().optional(),
            likes: z.number().nullable().optional(),
            comments: z.number().nullable().optional(),
            shares: z.number().nullable().optional(),
            clicks: z.number().nullable().optional()
          })
        })).optional()
      })
    },
    async ({ analysis, performance }) => {
      try {
        const result = decideNextCampaign({
          analysis: analysis as Parameters<typeof decideNextCampaign>[0]["analysis"],
          performance
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : "次の集客施策の決定に失敗しました。";
        return { content: [{ type: "text", text: message }], isError: true };
      }
    }
  );

  return server;
}

void serveStdio(createServer);
