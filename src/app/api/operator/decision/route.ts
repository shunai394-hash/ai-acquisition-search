import { POST as aiDecisionPost } from "@/app/api/operator/ai-decision/route";

export const runtime = "nodejs";
// Must match /api/operator/ai-decision: its wait budget is derived from 60s.
// Route segment config has to be a literal, so it is not re-exported.
export const maxDuration = 60;

// Legacy endpoint kept for existing clients. The decision engine is unified with /api/operator/ai-decision.
export async function POST(request: Request) {
  return aiDecisionPost(request);
}
