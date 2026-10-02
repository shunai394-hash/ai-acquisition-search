import type { AcquisitionAnalysis, PageSnapshot, SellingPoint, CustomerCandidate, AppealCandidate, ChannelRecommendation } from "./types";
import { buildAcquisitionPrompt } from "./prompts";
import type { WebSearchResult } from "./search-web";
import type { SocialSignal } from "./social-search";
import type { ShopSignal } from "./shop-search";

function detectEvidenceTensions(results: WebSearchResult[]) {
  const rules: { topic: string; positive: RegExp; negative: RegExp }[] = [
    { topic: "価格", positive: /安い|コスパ|お買い得|価格に満足|値段.*満足/i, negative: /高い|割高|価格.*不満|値段.*高/i },
    { topic: "品質・耐久性", positive: /丈夫|耐久|長持ち|品質.*良|しっかり/i, negative: /壊れ|耐久.*不満|脆い|すぐ.*壊|品質.*悪/i },
    { topic: "使いやすさ", positive: /使いやす|簡単|便利|操作.*簡単/i, negative: /使いにく|難しい|操作.*難|分かりにく/i },
    { topic: "サイズ", positive: /サイズ.*ちょうど|ぴったり|大きさ.*満足/i, negative: /大きすぎ|小さすぎ|サイズ.*合わ/i },
    { topic: "効果・性能", positive: /効果.*あった|性能.*良|満足.*効果|期待.*以上/i, negative: /効果.*ない|効果.*不満|性能.*悪|期待.*外れ/i },
  ];
  return rules.flatMap((rule) => {
    const positiveEvidence = results.filter((x) => rule.positive.test(x.title + " " + x.snippet)).slice(0, 4).map((x) => "[" + x.evidenceType + "] " + x.title + ": " + x.snippet);
    const negativeEvidence = results.filter((x) => rule.negative.test(x.title + " " + x.snippet)).slice(0, 4).map((x) => "[" + x.evidenceType + "] " + x.title + ": " + x.snippet);
    if (!positiveEvidence.length && !negativeEvidence.length) return [];
    return [{ topic: rule.topic, positiveEvidence, negativeEvidence, status: positiveEvidence.length && negativeEvidence.length ? "conflict" as const : "one_sided" as const }];
  });
}
function fallback(
  source: PageSnapshot,
  webResults: { query: string; results: WebSearchResult[] } = { query: "", results: [] },
  socialSignals: SocialSignal[] = [],
  shopSignals: ShopSignal[] = []
): AcquisitionAnalysis {
  const evidence = [
    source.productName,
    source.title,
    source.description,
    ...source.headings,
  ].filter(Boolean).slice(0, 8) as string[];

  const words =
    source.text.match(
      /(?:法人|企業|個人|初心者|担当者|経営者|マーケティング|開発者|店舗|EC|クリエイター)/gi
    ) ?? [];

  const segment = [...new Set(words)].slice(0, 3);
  const productName = source.productName || source.title || "この商品";
  const sellingPoints: SellingPoint[] = [
    { type: "functional_value", statement: source.headings[0] || "機能価値を特定できていません", evidence: source.headings[0] ? [source.headings[0]] : [], confidence: source.headings[0] ? 0.5 : 0.1 },
    { type: "emotional_value", statement: "感情価値は追加検証が必要です", evidence: [], confidence: 0.1 },
    { type: "comparative_advantage", statement: "競合比較による優位性は未確認です", evidence: [], confidence: 0.1 },
    { type: "customer_context", statement: source.description || "利用文脈を十分に特定できていません", evidence: source.description ? [source.description] : [], confidence: source.description ? 0.4 : 0.1 },
    { type: "reason_to_buy_now", statement: "今買う理由は未検証です", evidence: [], confidence: 0.1 },
  ];
  const customerCandidates: CustomerCandidate[] = [{
    label: segment[0] || "主要顧客候補A",
    context: "商品ページの利用文脈から検証する顧客候補",
    pain: "具体的な悩みは追加検証が必要",
    desire: "商品ページで示された便益を得たい",
    buyingTrigger: "悩みが顕在化したタイミング",
    preferredChannel: "TikTok / Instagram Reels",
    resonantWords: source.headings.slice(0, 2),
    avoidWords: [],
    reason: "現時点で確認できる商品文脈を起点にした仮説",
  }];
  const appealCandidates: AppealCandidate[] = [
    { name: "共感型", copy: "悩み起点で商品が必要になる場面を示す", customerLabel: customerCandidates[0].label, emotion: "共感", funnelStage: "awareness", channelFit: "TikTok / Instagram Reels", strengthScore: 0.5, riskScore: 0.3, validationPriority: 1, reason: "顧客課題の反応を最初に検証する" },
    { name: "比較・発見型", copy: "選択時に比較すべき違いを示す", customerLabel: customerCandidates[0].label, emotion: "納得", funnelStage: "consideration", channelFit: "TikTok / Instagram Reels", strengthScore: 0.5, riskScore: 0.3, validationPriority: 2, reason: "差別化がクリックにつながるか検証する" },
    { name: "購入動機型", copy: "今買う理由と利用シーンを示す", customerLabel: customerCandidates[0].label, emotion: "安心", funnelStage: "purchase", channelFit: "TikTok / Instagram Reels", strengthScore: 0.4, riskScore: 0.4, validationPriority: 3, reason: "購入導線への近さを検証する" },
  ];
  const channelRecommendation: ChannelRecommendation = {
    recommended: "Instagram Reels",
    reason: "視覚訴求と短尺検証を優先する暫定仮説。実績データ未接続のため確定ではありません。",
    comparison: [
      { channel: "Instagram Reels", visualFit: 4, explanationLoad: 3, purchaseIntent: 3, dataFit: 2, productionCost: 2, continuity: 4, note: "短尺・視覚訴求を検証しやすい仮説" },
      { channel: "TikTok", visualFit: 5, explanationLoad: 2, purchaseIntent: 2, dataFit: 2, productionCost: 2, continuity: 4, note: "拡散型の反応検証候補" },
      { channel: "X", visualFit: 2, explanationLoad: 4, purchaseIntent: 2, dataFit: 2, productionCost: 1, continuity: 3, note: "言語訴求の検証候補" },
      { channel: "YouTube Shorts", visualFit: 4, explanationLoad: 4, purchaseIntent: 3, dataFit: 2, productionCost: 4, continuity: 3, note: "説明量を確保しやすいが制作負荷が高い仮説" },
    ],
    confidence: 0.25,
  };

  return {
    sellingPoints,
    customerCandidates,
    appealCandidates,
    channelRecommendation,
    product: {
      summary: source.title
        ? source.title + " の公開ページから商品・サービス情報を抽出しました。"
        : "商品・サービス名を十分に特定できませんでした。",
      valueProposition: source.headings.slice(0, 5),
      evidence,
    },
    market: {
      summary: "市場規模・成長率などの外部データは未取得です。",
      signals: source.headings.slice(0, 6),
    },
    customer: {
      summary: "ページ上の訴求内容から顧客候補を抽出しました。",
      likelySegments: segment.length
        ? segment
        : ["ページ内容から顧客属性を特定できていません"],
      needs: source.headings.slice(0, 5),
    },
    competitors: {
      summary: "競合を十分に事実確認できていません。",
      signals: source.links.slice(0, 10),
    },
    performance: {
      summary: "アクセス解析・広告・売上データは未接続です。",
      availableEvidence: evidence.filter((x) =>
        /実績|導入|顧客|売上|件|%|ユーザー|利用/i.test(x)
      ),
      missingData: [
        "売上",
        "CVR",
        "CTR",
        "広告CPA",
        "アクセス数",
        "顧客獲得数",
      ],
    },
    acquisitionProblems: [
      "外部市場データと競合比較が不足している。",
      "実績データが不足している。",
    ],
    opportunities: [
      "顧客・競合・訴求を外部検索で比較する。",
      "異なる投稿仮説をテストして反応データを蓄積する。",
    ],
    priorities: [
      {
        priority: 1,
        action: "顧客・競合・訴求候補を検索して比較する",
        reason: "URLだけでは外部市場を確認できないため",
        channel: "Web検索",
      },
      {
        priority: 2,
        action: "異なる訴求の投稿を3本テストする",
        reason: "反応する訴求が未検証のため",
        channel: "SNS",
      },
      {
        priority: 3,
        action: "アクセス・CV・売上を記録して次の判断材料にする",
        reason: "実績ベースの最適化に必要なため",
        channel: "Analytics / EC",
      },
    ],
    nextActions: [
      "顧客・競合・訴求候補を検索する",
      "異なる訴求の投稿を3本テストする",
      "アクセス・CV・売上を記録する",
    ],
    decision: {
      target: segment.length
        ? segment.join(" / ")
        : "公開ページから顧客像を特定できていない",
      problem: "顧客の具体的な悩みを外部情報で追加検証する",
      desire: "商品ページで示されている便益を実際の顧客表現で検証する",
      valueProposition:
        source.headings.slice(0, 3).join(" / ") ||
        "商品ページの主要便益を検証する",
      channel: "TikTok / Instagram Reels",
      format: "悩み起点の短尺投稿",
      testPlan:
        "異なる訴求を3本出し、視聴維持率・クリック率・購入率を比較する",
      evidence: evidence.slice(0, 5),
    },
    nextPosts: [
      {
        rank: 1,
        concept: productName + "の悩み解決型",
        hook: "この商品が必要になる人は、まずここを見てください。",
        format: "15〜30秒短尺",
        channel: "TikTok / Instagram Reels",
        reason: "悩み起点の反応を検証するため",
        testMetric: "視聴維持率・クリック率",
      },
      {
        rank: 2,
        concept: productName + "の比較型",
        hook: "似た商品を買う前に、この3つを比較してください。",
        format: "比較型短尺",
        channel: "TikTok / Instagram Reels",
        reason: "比較検討層の反応を検証するため",
        testMetric: "保存率・クリック率",
      },
      {
        rank: 3,
        concept: productName + "の使用シーン型",
        hook: "実際に使うなら、この場面で違いが出ます。",
        format: "使用シーン紹介",
        channel: "TikTok / Instagram Reels",
        reason: "利用イメージの反応を検証するため",
        testMetric: "クリック率・購入率",
      },
    ],
    socialSignals,
    shopSignals,
    evidenceTensions: detectEvidenceTensions(webResults.results),
    searchEvidence: webResults.results.slice(0, 10),
    aiConnected: false,
  };
}

export async function analyzePage(
  source: PageSnapshot,
  webResults: { query: string; results: WebSearchResult[] } = {
    query: "",
    results: [],
  },
  socialSignals: SocialSignal[] = [],
  shopSignals: ShopSignal[] = []
): Promise<AcquisitionAnalysis> {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return fallback(source, webResults, socialSignals, shopSignals);
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + apiKey,
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-5-mini",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "あなたはB2C/B2Bの顧客獲得戦略を分析する慎重なマーケティングアナリストです。",
        },
        {
          role: "user",
          content: buildAcquisitionPrompt(
            source,
            webResults,
            socialSignals,
            shopSignals
          ),
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(
      "AI分析に失敗しました（HTTP " + response.status + "）。"
    );
  }

  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("AIから分析結果が返りませんでした。");
  }

  const parsed = JSON.parse(content) as Partial<AcquisitionAnalysis>;
  const base = fallback(source, webResults, socialSignals, shopSignals);

  const arr = <T,>(value: unknown, fallbackValue: T[]): T[] =>
    Array.isArray(value) ? (value as T[]) : fallbackValue;

  const clampScore = (value: unknown, fallbackValue = 0.5) => {
    const n = typeof value === "number" && Number.isFinite(value) ? value : fallbackValue;
    return Math.max(0, Math.min(1, n));
  };

  const normalizeSellingPoints = (value: unknown): SellingPoint[] => {
    const items = Array.isArray(value) ? value : [];
    const allowed = new Set<SellingPoint["type"]>([
      "functional_value", "emotional_value", "comparative_advantage",
      "customer_context", "reason_to_buy_now",
    ]);
    return items
      .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
      .filter((x) => typeof x.statement === "string" && allowed.has(x.type as SellingPoint["type"]))
      .slice(0, 5)
      .map((x) => ({
        type: x.type as SellingPoint["type"],
        statement: x.statement as string,
        evidence: Array.isArray(x.evidence) ? x.evidence.filter((v): v is string => typeof v === "string").slice(0, 5) : [],
        confidence: clampScore(x.confidence, 0.2),
      }));
  };

  const normalizeCustomerCandidates = (value: unknown): CustomerCandidate[] => {
    const items = Array.isArray(value) ? value : [];
    return items
      .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
      .filter((x) => typeof x.label === "string" && typeof x.pain === "string" && typeof x.desire === "string")
      .slice(0, 3)
      .map((x) => ({
        label: x.label as string,
        context: typeof x.context === "string" ? x.context : "未検証",
        pain: x.pain as string,
        desire: x.desire as string,
        buyingTrigger: typeof x.buyingTrigger === "string" ? x.buyingTrigger : "未検証",
        preferredChannel: typeof x.preferredChannel === "string" ? x.preferredChannel : "未検証",
        resonantWords: Array.isArray(x.resonantWords) ? x.resonantWords.filter((v): v is string => typeof v === "string").slice(0, 10) : [],
        avoidWords: Array.isArray(x.avoidWords) ? x.avoidWords.filter((v): v is string => typeof v === "string").slice(0, 10) : [],
        reason: typeof x.reason === "string" ? x.reason : "根拠未提示",
      }));
  };

  const normalizeAppealCandidates = (value: unknown): AppealCandidate[] => {
    const items = Array.isArray(value) ? value : [];
    const stages = new Set<AppealCandidate["funnelStage"]>(["awareness", "consideration", "purchase"]);
    return items
      .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
      .filter((x) => typeof x.name === "string" && typeof x.copy === "string" && stages.has(x.funnelStage as AppealCandidate["funnelStage"]))
      .slice(0, 5)
      .map((x, index) => ({
        name: x.name as string,
        copy: x.copy as string,
        customerLabel: typeof x.customerLabel === "string" ? x.customerLabel : "未特定",
        emotion: typeof x.emotion === "string" ? x.emotion : "未特定",
        funnelStage: x.funnelStage as AppealCandidate["funnelStage"],
        channelFit: typeof x.channelFit === "string" ? x.channelFit : "未検証",
        strengthScore: clampScore(x.strengthScore, 0.5),
        riskScore: clampScore(x.riskScore, 0.5),
        validationPriority: Math.max(1, Math.min(5, Number.isFinite(Number(x.validationPriority)) ? Number(x.validationPriority) : index + 1)),
        reason: typeof x.reason === "string" ? x.reason : "根拠未提示",
      }));
  };

  const normalizeChannelRecommendation = (value: unknown, fallbackValue: ChannelRecommendation): ChannelRecommendation => {
    if (!value || typeof value !== "object") return fallbackValue;
    const x = value as Record<string, unknown>;
    const comparison = Array.isArray(x.comparison) ? x.comparison : [];
    return {
      recommended: typeof x.recommended === "string" ? x.recommended : fallbackValue.recommended,
      reason: typeof x.reason === "string" ? x.reason : fallbackValue.reason,
      comparison: comparison
        .filter((v): v is Record<string, unknown> => !!v && typeof v === "object" && typeof v.channel === "string")
        .slice(0, 6)
        .map((v) => ({
          channel: v.channel as string,
          visualFit: Math.max(0, Math.min(5, Number(v.visualFit) || 0)),
          explanationLoad: Math.max(0, Math.min(5, Number(v.explanationLoad) || 0)),
          purchaseIntent: Math.max(0, Math.min(5, Number(v.purchaseIntent) || 0)),
          dataFit: Math.max(0, Math.min(5, Number(v.dataFit) || 0)),
          productionCost: Math.max(0, Math.min(5, Number(v.productionCost) || 0)),
          continuity: Math.max(0, Math.min(5, Number(v.continuity) || 0)),
          note: typeof v.note === "string" ? v.note : "根拠未提示",
        })),
      confidence: clampScore(x.confidence, fallbackValue.confidence),
    };
  };

  const obj = <T extends object>(
    value: unknown,
    fallbackValue: T
  ): T =>
    value && typeof value === "object"
      ? { ...fallbackValue, ...(value as Partial<T>) }
      : fallbackValue;

  const product = obj(parsed.product, base.product);
  const market = obj(parsed.market, base.market);
  const customer = obj(parsed.customer, base.customer);
  const competitors = obj(parsed.competitors, base.competitors);
  const performance = obj(parsed.performance, base.performance);
  const decision = obj(parsed.decision, base.decision);
  const sellingPoints = normalizeSellingPoints(parsed.sellingPoints);
  const customerCandidates = normalizeCustomerCandidates(parsed.customerCandidates);
  const appealCandidates = normalizeAppealCandidates(parsed.appealCandidates);
  const channelRecommendation = normalizeChannelRecommendation(parsed.channelRecommendation, base.channelRecommendation);

  return {
    ...base,
    ...parsed,

    sellingPoints: sellingPoints.length ? sellingPoints : base.sellingPoints,
    customerCandidates: customerCandidates.length ? customerCandidates : base.customerCandidates,
    appealCandidates: appealCandidates.length ? appealCandidates : base.appealCandidates,
    channelRecommendation,

    product: {
      ...product,
      valueProposition: arr(
        product.valueProposition,
        base.product.valueProposition
      ),
      evidence: arr(product.evidence, base.product.evidence),
    },

    market: {
      ...market,
      signals: arr(market.signals, base.market.signals),
    },

    customer: {
      ...customer,
      likelySegments: arr(
        customer.likelySegments,
        base.customer.likelySegments
      ),
      needs: arr(customer.needs, base.customer.needs),
    },

    competitors: {
      ...competitors,
      signals: arr(competitors.signals, base.competitors.signals),
    },

    performance: {
      ...performance,
      availableEvidence: arr(
        performance.availableEvidence,
        base.performance.availableEvidence
      ),
      missingData: arr(
        performance.missingData,
        base.performance.missingData
      ),
    },

    acquisitionProblems: arr(
      parsed.acquisitionProblems,
      base.acquisitionProblems
    ),

    opportunities: arr(parsed.opportunities, base.opportunities),

    priorities: arr(parsed.priorities, base.priorities),

    nextActions: arr(parsed.nextActions, base.nextActions),

    nextPosts: arr(parsed.nextPosts, base.nextPosts),

    socialSignals: arr(parsed.socialSignals, base.socialSignals),

    shopSignals: arr(parsed.shopSignals, base.shopSignals),

    evidenceTensions: arr(
      parsed.evidenceTensions,
      base.evidenceTensions
    ),

    searchEvidence: arr(
      parsed.searchEvidence,
      base.searchEvidence
    ).slice(0, 10),

    decision: {
      ...decision,
      evidence: arr(decision.evidence, base.decision.evidence),
    },

    aiConnected: true,
  };
}
