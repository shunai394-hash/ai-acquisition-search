---
name: ai-acquire
description: Run the evidence-based AI acquisition workflow and decide the next customer-acquisition action.
---

# AI Acquire

Run the AI acquisition workflow for a product or service.

## Input

Accept a public product/service URL and optional constraints such as:

- target market
- budget
- preferred social platforms
- brand rules
- desired number of tests

## Workflow

1. Use the `analyze-acquisition` tool first.
2. Summarize the product and the evidence actually available.
3. Identify customer segments, pains, desires, buying triggers, competitors and channels.
4. Produce up to 3 testable acquisition hypotheses.
5. Use the decision engine when measured campaign evidence is available.
6. If the decision is CONTINUE, preserve the winning hypothesis and change only the permitted variable.
7. If the decision is PIVOT, change one evidence-backed variable and state exactly what changed.
8. If the decision is STOP or WAIT, do not generate or publish a new creative for that hypothesis.
9. If a Higgsfield tool is connected, turn an approved next action into a production brief and use the connected capability for video creation.
10. If narration is requested and Gemini TTS is configured, use `generate-narration`.
11. If authorized social publishing tools are connected, execute only the requested publishing actions and record returned IDs/URLs.
12. If publishing tools are not connected, output platform-ready payloads and state that publishing is pending.
13. On later runs, collect available performance data before making another decision.
14. Never fabricate generation, publication, metrics, sales, CTR, CVR, CPA or ROAS.

## Decision discipline

- Treat missing metrics as unknown, never as zero.
- Prefer the user's own comparable history when enough samples exist.
- Keep the decision deterministic; an LLM may refine creative wording but must not override the verdict, evidence or selected change variable.
- Include the evidence and timestamp used for every consequential decision.
