import type { AcquisitionAnalysis, PageSnapshot, SellingPoint, CustomerCandidate, AppealCandidate, ChannelRecommendation, PostScenario } from "./types";
import { buildAcquisitionPrompt } from "./prompts";
import { openAiJson } from "@/lib/ai/openai-json";
import type { WebSearchResult } from "./search-web";
import type { SocialSignal } from "./social-search";
import type { ShopSignal } from "./shop-search";

function normalizeEvidenceText(value: string) {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("ja-JP");
}

function evidenceMatchesCorpus(value: string, corpus: string[]) {
  const candidate = normalizeEvidenceText(value);
  if (!candidate || candidate.length < 6) return false;
  return corpus.some((item) => {
    const source = normalizeEvidenceText(item);
    return source === candidate || source.includes(candidate);
  });
}

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
    preferredChannel: "未確定（媒体適合性は追加検証が必要）",
    resonantWords: source.headings.slice(0, 2),
    avoidWords: [],
    reason: "現時点で確認できる商品文脈を起点にした仮説",
  }];
  const appealCandidates: AppealCandidate[] = [
    { name: "共感型", copy: "悩み起点で商品が必要になる場面を示す", customerLabel: customerCandidates[0].label, emotion: "共感", funnelStage: "awareness", channelFit: "未確定（媒体適合性は追加検証が必要）", strengthScore: 0.5, riskScore: 0.3, validationPriority: 1, reason: "顧客課題の反応を最初に検証する" },
    { name: "比較・発見型", copy: "選択時に比較すべき違いを示す", customerLabel: customerCandidates[0].label, emotion: "納得", funnelStage: "consideration", channelFit: "未確定（媒体適合性は追加検証が必要）", strengthScore: 0.5, riskScore: 0.3, validationPriority: 2, reason: "差別化がクリックにつながるか検証する" },
    { name: "購入動機型", copy: "今買う理由と利用シーンを示す", customerLabel: customerCandidates[0].label, emotion: "安心", funnelStage: "purchase", channelFit: "未確定（媒体適合性は追加検証が必要）", strengthScore: 0.4, riskScore: 0.4, validationPriority: 3, reason: "購入導線への近さを検証する" },
  ];
  const scenarios: PostScenario[] = [
    {
      id: "scenario-empathy",
      archetype: "empathy",
      hypothesis: "顧客が実際に困っている場面への共感が、最初の反応を生むか検証する",
      targetCustomer: customerCandidates[0].label,
      painOrDesire: customerCandidates[0].pain,
      hook: "その悩み、まずここを確認してください。",
      beats: ["悩みを一言で提示", "困る具体的な場面を示す", "確認できる商品価値を1つ提示", "過度な断定を避けて利用場面を示す", "次の行動を1つCTA"],
      proof: source.description ? [source.description] : [],
      cta: "詳しい条件を確認する",
      channel: "未確定",
      format: "短尺・共感型",
      primaryMetric: "視聴維持率",
      secondaryMetric: "クリック率",
      variableToChange: "悩み起点のフック",
      variablesToHold: ["商品", "尺", "構成", "CTA"],
      risk: "顧客の悩みが仮説段階のため、共感表現が実際の需要と一致しない可能性がある",
      evidence: evidence.slice(0, 3),
    },
    {
      id: "scenario-comparison",
      archetype: "comparison_discovery",
      hypothesis: "比較時に重視される違いを示すことで、検討意図を引き出せるか検証する",
      targetCustomer: customerCandidates[0].label,
      painOrDesire: "比較・選択時の不安",
      hook: "似た商品を選ぶ前に、確認したいポイントがあります。",
      beats: ["比較対象を明示", "確認項目を1つ提示", "確認できる商品情報を提示", "差がある場合の利用文脈を示す", "比較詳細へのCTA"],
      proof: source.headings.slice(0, 2),
      cta: "比較ポイントを確認する",
      channel: "未確定",
      format: "比較・発見型短尺",
      primaryMetric: "クリック率",
      secondaryMetric: "保存率",
      variableToChange: "比較軸",
      variablesToHold: ["商品", "尺", "CTA", "配信条件"],
      risk: "比較対象や優位性が十分に確認できていないため、断定比較は避ける必要がある",
      evidence: evidence.slice(0, 3),
    },
    {
      id: "scenario-purchase",
      archetype: "purchase_motivation",
      hypothesis: "購入直前の不安を減らす情報が、購入行動につながるか検証する",
      targetCustomer: customerCandidates[0].label,
      painOrDesire: customerCandidates[0].desire,
      hook: "買う前に、ここだけ確認してください。",
      beats: ["購入前の不安を提示", "商品ページで確認できる条件を提示", "利用シーンを提示", "不明点は不明と明示", "商品詳細へのCTA"],
      proof: [source.description, ...source.headings].filter(Boolean).slice(0, 3) as string[],
      cta: "商品条件を確認する",
      channel: "未確定",
      format: "購入検討型短尺",
      primaryMetric: "クリック率",
      secondaryMetric: "購入率",
      variableToChange: "購入不安の訴求",
      variablesToHold: ["商品", "尺", "CTA", "配信条件"],
      risk: "購入率を直接観測できない場合、クリック以降の効果は未確定になる",
      evidence: evidence.slice(0, 3),
    },
  ];
  const channelRecommendation: ChannelRecommendation = {
    recommended: "未確定",
    reason: "商品ページだけでは媒体適合性を十分に確認できないため、媒体を断定しません。実績・商品特性・顧客接点を追加取得してから決定します。",
    comparison: [],
    confidence: 0.05,
  };

  return {
    sellingPoints,
    scenarios,
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
      "媒体適合性を確認したうえで、異なる訴求を3本テストする",
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
      channel: "未確定",
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
        channel: "未確定",
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

export function normalizeAcquisitionScenarios(value: unknown, evidenceCorpus?: string[]): PostScenario[] {
    const items = Array.isArray(value) ? value : [];
    const archetypes = new Set<PostScenario["archetype"]>([
      "empathy",
      "comparison_discovery",
      "purchase_motivation",
    ]);
    const seen = new Set<PostScenario["archetype"]>();
    const normalized: PostScenario[] = [];

    for (const raw of items) {
      if (!raw || typeof raw !== "object") continue;
      const x = raw as Record<string, unknown>;
      const archetype = x.archetype as PostScenario["archetype"];
      if (!archetypes.has(archetype) || seen.has(archetype)) continue;

      const beats = Array.isArray(x.beats)
        ? x.beats.filter((v): v is string => typeof v === "string" && v.trim().length > 0).slice(0, 6)
        : [];
      const rawProof = Array.isArray(x.proof)
        ? x.proof.filter((v): v is string => typeof v === "string" && v.trim().length > 0).slice(0, 6)
        : [];
      const rawEvidence = Array.isArray(x.evidence)
        ? x.evidence.filter((v): v is string => typeof v === "string" && v.trim().length > 0).slice(0, 6)
        : [];
      const enforceGrounding = Array.isArray(evidenceCorpus);
      const corpus = (evidenceCorpus ?? []).filter((v): v is string => typeof v === "string" && v.trim().length > 0);
      const proof = enforceGrounding ? rawProof.filter((v) => evidenceMatchesCorpus(v, corpus)) : rawProof;
      const evidence = enforceGrounding ? rawEvidence.filter((v) => evidenceMatchesCorpus(v, corpus)) : rawEvidence;
      const hypothesis = typeof x.hypothesis === "string" ? x.hypothesis.trim() : "";
      const hook = typeof x.hook === "string" ? x.hook.trim() : "";
      const variableToChange = typeof x.variableToChange === "string" ? x.variableToChange.trim() : "";
      const primaryMetric = typeof x.primaryMetric === "string" ? x.primaryMetric.trim() : "";

      // A scenario is executable only when it has a real hypothesis, a
      // 3-6 step execution plan, one test variable, one primary metric,
      // and explicit evidence. Otherwise the deterministic fallback wins.
      if (!hypothesis || !hook || beats.length < 3 || !variableToChange || !primaryMetric || !evidence.length) {
        continue;
      }

      normalized.push({
        id: typeof x.id === "string" && x.id.trim() ? x.id : `scenario-${normalized.length + 1}`,
        archetype,
        hypothesis,
        targetCustomer: typeof x.targetCustomer === "string" && x.targetCustomer.trim() ? x.targetCustomer.trim() : "未特定",
        painOrDesire: typeof x.painOrDesire === "string" && x.painOrDesire.trim() ? x.painOrDesire.trim() : "未検証",
        hook,
        beats,
        proof,
        cta: typeof x.cta === "string" && x.cta.trim() ? x.cta.trim() : "未検証",
        channel: typeof x.channel === "string" && x.channel.trim() ? x.channel.trim() : "未確定",
        format: typeof x.format === "string" && x.format.trim() ? x.format.trim() : "未確定",
        primaryMetric,
        secondaryMetric: typeof x.secondaryMetric === "string" && x.secondaryMetric.trim() ? x.secondaryMetric.trim() : "未確定",
        variableToChange,
        variablesToHold: Array.isArray(x.variablesToHold)
          ? x.variablesToHold.filter((v): v is string => typeof v === "string" && v.trim().length > 0).slice(0, 8)
          : [],
        risk: typeof x.risk === "string" && x.risk.trim() ? x.risk.trim() : "未評価",
        evidence,
      });
      seen.add(archetype);
      if (normalized.length === 3) break;
    }

    return normalized;
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
  const prompt = buildAcquisitionPrompt(
    source,
    webResults,
    socialSignals,
    shopSignals
  );

  const content = await openAiJson({
    system:
      "あなたはB2C/B2Bの顧客獲得戦略を分析する慎重なマーケティングアナリストです。",
    user: prompt,
  });

  // AI provider failures should degrade to a deterministic, evidence-backed
  // result instead of turning the whole analysis request into HTTP 502.
  if (!content) {
    return fallback(source, webResults, socialSignals, shopSignals);
  }

  let parsed: Partial<AcquisitionAnalysis>;
  try {
    parsed = JSON.parse(content) as Partial<AcquisitionAnalysis>;
  } catch {
    return fallback(source, webResults, socialSignals, shopSignals);
  }
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
  const evidenceCorpus = [
    source.productName,
    source.title,
    source.description,
    source.text,
    ...source.headings,
    ...source.productSignals,
    ...webResults.results.flatMap((item) => [item.title, item.snippet]),
    ...socialSignals.flatMap((item) => [item.title, item.description]),
    ...shopSignals.map((item) => item.title),
  ].filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  const scenarios = normalizeAcquisitionScenarios(parsed.scenarios, evidenceCorpus).map((scenario) => ({
    ...scenario,
    channel:
      channelRecommendation.recommended && channelRecommendation.recommended !== "未確定"
        ? scenario.channel === "未確定" || scenario.channel === "unknown"
          ? channelRecommendation.recommended
          : scenario.channel
        : "未確定",
  }));

  return {
    ...base,
    ...parsed,

    sellingPoints: sellingPoints.length ? sellingPoints : base.sellingPoints,
    customerCandidates: customerCandidates.length ? customerCandidates : base.customerCandidates,
    appealCandidates: appealCandidates.length ? appealCandidates : base.appealCandidates,
    scenarios: scenarios.length ? scenarios : base.scenarios,
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
