export type AcquisitionEvidenceTension = { topic: string; positiveEvidence: string[]; negativeEvidence: string[]; status: "conflict" | "one_sided" };

export type AcquisitionDecision = { target: string; problem: string; desire: string; valueProposition: string; channel: string; format: string; testPlan: string; evidence: string[] };

export type ShopSignal = { platform: "tiktok_shop"; title: string; url: string; price: number | null; currency: string; sales: number | null; rating: number | null; reviewCount: number | null; seller: string; query: string };

export type SocialSignal = { platform: "tiktok"; title: string; url: string; author: string; views: number | null; likes: number | null; comments: number | null; shares: number | null; description: string; query: string };

export type SellingPoint = {
  type: "functional_value" | "emotional_value" | "comparative_advantage" | "customer_context" | "reason_to_buy_now";
  statement: string;
  evidence: string[];
  confidence: number;
};

export type CustomerCandidate = {
  label: string;
  context: string;
  pain: string;
  desire: string;
  buyingTrigger: string;
  preferredChannel: string;
  resonantWords: string[];
  avoidWords: string[];
  reason: string;
};

export type AppealCandidate = {
  name: string;
  copy: string;
  customerLabel: string;
  emotion: string;
  funnelStage: "awareness" | "consideration" | "purchase";
  channelFit: string;
  strengthScore: number;
  riskScore: number;
  validationPriority: number;
  reason: string;
};

export type ChannelRecommendation = {
  recommended: string;
  reason: string;
  comparison: Array<{
    channel: string;
    visualFit: number;
    explanationLoad: number;
    purchaseIntent: number;
    dataFit: number;
    productionCost: number;
    continuity: number;
    note: string;
  }>;
  confidence: number;
};

export type AcquisitionAnalysis = {
  product: { summary: string; valueProposition: string[]; evidence: string[] };
  sellingPoints: SellingPoint[];
  customerCandidates: CustomerCandidate[];
  appealCandidates: AppealCandidate[];
  channelRecommendation: ChannelRecommendation;
  market: { summary: string; signals: string[] };
  customer: { summary: string; likelySegments: string[]; needs: string[] };
  competitors: { summary: string; signals: string[] };
  performance: { summary: string; availableEvidence: string[]; missingData: string[] };
  acquisitionProblems: string[];
  opportunities: string[];
  priorities: { priority: number; action: string; reason: string; channel: string }[];
  nextActions: string[];
  nextPosts: { rank: number; concept: string; hook: string; format: string; channel: string; reason: string; testMetric: string }[];
  decision: AcquisitionDecision;
  socialSignals: SocialSignal[];
  shopSignals: ShopSignal[];
  searchEvidence: { query: string; category: "customer_pain" | "customer_desire" | "competitor" | "market" | "channel"; title: string; url: string; snippet: string }[];
  evidenceTensions: AcquisitionEvidenceTension[];
  aiConnected: boolean;
};
export type PageSnapshot = { url: string; title: string; description: string; headings: string[]; text: string; links: string[]; productSignals: string[]; productName?: string; productBrand?: string; productCategory?: string };
export type EcPulseProduct = {
  title: string;
  url: string;
  price: number | null;
  currency: string;
  marketplace?: string | null;
  product_id?: string | null;
};

export type EcPulsePainPoint = {
  pain: string;
  count: number;
  share_percent: number;
  examples: string[];
};

export type EcPulseResearch = {
  url: string;
  source?: string;
  title?: string;
  comments_count?: number;
  comments?: string[];
  analysis?: {
    comments_analyzed: number;
    pain_points: EcPulsePainPoint[];
    top_terms: string[];
    recommended_angle: string | null;
    ad_copy_candidates?: string[];
    next_action?: string;
  };
};

export type EcPulseOpportunity = {
  run_id: string;
  top_pain?: { pain: string; count: number; share_percent: number } | null;
  emerging_pains?: Array<{ pain: string; count_delta: number; share_delta_percent: number; status: string }>;
  product_directions?: Array<{ pain: string; product_direction: string; validation: string[] }>;
  ad_test_angles?: Array<{ pain: string; hook: string; proof: string }>;
  next_actions?: string[];
};

export type EcPulseResearchBundle = {
  connected: boolean;
  research: EcPulseResearch | null;
  products: EcPulseProduct[];
  opportunity?: EcPulseOpportunity | null;
  error?: string;
};

export type AcquisitionAnalyzeResult = {
  source: PageSnapshot;
  analysis: AcquisitionAnalysis;
  ecPulse?: EcPulseResearchBundle;
};

export type EcPulseResearchRun = {
  run_id: string;
  url: string;
  source_type?: string | null;
  market?: string | null;
  locale?: string | null;
  title?: string | null;
  comments_count: number;
  captured_at: string;
  top_pain?: { pain: string; count: number; share_percent: number } | null;
  trend?: {
    previous_run_id?: string | null;
    previous_captured_at?: string | null;
    signal?: string;
    emerging_pains?: Array<{
      pain: string;
      count_delta: number;
      share_delta_percent: number;
      status: string;
      current_count: number;
      previous_count: number;
      current_share_percent: number;
      previous_share_percent: number;
    }>;
  };
};

