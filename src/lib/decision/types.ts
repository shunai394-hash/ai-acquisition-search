// Shared types for the decision loop:
// Evidence -> Teacher (CONTINUE / PIVOT / STOP / WAIT) -> structured Decision -> next action.

export type Verdict = "continue" | "pivot" | "stop" | "wait";

export type MetricSnapshot = {
  id?: string | null;
  measuredAt: string;
  impressions: number | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  clicks: number | null;
  conversions: number | null;
  revenue: number | null;
  grossProfit: number | null;
  adSpend: number | null;
  /** "manual" for /api/operator/metrics, otherwise the SNS network name. */
  source: string;
};

export type HistoricalResult = {
  socialPostId: string;
  network: string;
  publishedAt: string | null;
  metric: MetricSnapshot;
};

export type ProductEvidence = {
  name: string | null;
  url: string | null;
  price: number | null;
  cost: number | null;
  features: string[];
  strengths: string[];
  useCases: string[];
  salesChannels: string[];
};

export type CustomerEvidence = {
  target: string | null;
  pain: string | null;
  desire: string | null;
  valueProposition: string | null;
  buyingTriggers: string[];
  stage: string | null;
};

export type MarketEvidence = {
  status: "ok" | "unavailable" | "not_configured" | "no_data";
  error?: string;
  runId?: string | null;
  capturedAt?: string | null;
  commentsCount?: number | null;
  topPains: Array<{ pain: string; count: number; sharePercent: number }>;
  emergingPains: Array<{ pain: string; status: string; shareDeltaPercent: number }>;
  trendSignal?: string | null;
};

export type HypothesisEvidence = {
  socialPostId: string;
  network: string;
  caption: string | null;
  hook: string | null;
  angle: string | null;
  hypothesis: string | null;
  primaryMetric: string | null;
  publishedAt: string | null;
  /** Previous attempts in the same source_social_post_id chain, newest first. */
  lineageVerdicts: Verdict[];
};

export type DecisionEvidence = {
  /** Point in time the decision is made for. Nothing measured after this may be used. */
  asOf: string;
  product: ProductEvidence;
  customer: CustomerEvidence;
  market: MarketEvidence;
  hypothesis: HypothesisEvidence;
  current: MetricSnapshot | null;
  history: HistoricalResult[];
};

export type Criterion = {
  name: string;
  value: number | string | null;
  threshold: number | string | null;
  passed: boolean | null;
};

export type TeacherResult = {
  verdict: Verdict;
  status: "decided" | "insufficient_data";
  ruleId: string;
  reason: string;
  criteria: Criterion[];
  sample: { exposure: number; clicks: number | null; conversions: number | null };
  confidence: number;
  missingData: string[];
  logicVersion: string;
};

export type EvidenceItem = {
  source: "product" | "customer" | "ec_pulse" | "post_metrics" | "history" | "hypothesis";
  key: string;
  value: string | number | null;
  asOf?: string | null;
};

export type StructuredDecision = {
  action_type: "reinforce_hypothesis" | "pivot_hypothesis" | "stop_hypothesis" | "wait_for_data";
  verdict: Verdict;
  target_customer: string;
  hypothesis: string;
  reason: string;
  expected_outcome: string;
  primary_metric: string;
  learning_objective: string;
  priority: "high" | "medium" | "low";
  evidence: EvidenceItem[];
  confidence: number;
  next_action: {
    generate_creative: boolean;
    description: string;
    hook: string | null;
    angle: string | null;
    change_variable: "none" | "hook" | "angle" | "target" | "offer" | null;
  };
  teacher: TeacherResult;
  logic_version: string;
  prompt_version: string;
  model_version: string;
  generated_at: string;
  input_hash: string;
};
