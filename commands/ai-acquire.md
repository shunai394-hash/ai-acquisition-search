---
name: ai-acquire
description: Direct an AI video production brief, optionally connect commerce context, and run authorized publishing and evidence-based iteration.
---

# AI Video Director

Use this command as the entry point to the AI video-production platform. A product URL is optional.

## Input
Accept any natural-language video brief. Optional inputs include:
- video purpose: ad, social short, music video, brand film, explainer, product demo, event recap, cinematic concept, or other
- target audience, message, mood, references and CTA
- uploaded product images, reference images, footage, voice/audio or brand assets
- optional public product URL or authorized Shopify product selection
- delivery channel, aspect ratio, target duration and resolution
- narration, voice, music/SFX, captions and language
- quality/latency preference, budget, rights constraints and brand rules
- preferred SNS channels, schedule and explicit publishing consent

## Workflow
1. Classify the request as video production, commerce research, campaign optimization, or a combination. Do not force non-commerce briefs through product analysis.
2. Summarize the brief and ask only for blockers. For commerce work, use `analyze-acquisition` and available market/shop signals when useful.
3. Create a director's treatment and shot-by-shot production brief before invoking generators.
4. Select configured creative engines based on the requested task. Use Higgsfield or another connected provider for visuals when available; use `generate-narration` when Gemini TTS is configured. Never claim an unavailable engine was used.
5. Generate the requested assets and track provider/job IDs. Persist enough state to resume after a reload.
6. Validate the output: playable file, requested duration/aspect ratio, audio-track presence, narration/music status, subtitles, and export status. If a check fails, fix it or clearly report the degraded/missing deliverable.
7. Offer targeted revisions based on the actual result rather than claiming the first output is final.
8. Prepare channel-specific exports. Publish only when the user requests it and the account is authorized, consented, and within configured limits.
9. If publication times out or is ambiguous, check provider status before retrying to avoid duplicates.
10. Collect real available performance metrics on later runs and use the decision engine to choose CONTINUE / PIVOT / STOP / WAIT. Keep missing values unknown.
11. If a provider or platform is not connected, return a production/publishing plan and clearly state what remains pending.

## Decision discipline
- Do not fabricate generation, publication, metrics, sales, CTR, CVR, CPA, ROAS or virality.
- Distinguish provider-confirmed facts from estimates and assumptions.
- Prefer the user's own comparable history when sufficient samples exist.
- Preserve the winning hypothesis on CONTINUE; on PIVOT change one evidence-backed variable; on STOP/WAIT do not launch another creative for that hypothesis.
- Include the evidence and timestamp for consequential campaign decisions.

## Quality review
Use the checks in `docs/ai-video-production-platform.md`. A pass counts as complete only when the inspected scope, actual defect, change, test result and remaining blockers are recorded. Do not report ten completed passes without ten evidence-backed reviews.
