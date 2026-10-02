---
name: ai-brand-operator
description: Use this skill when operating the AI acquisition workflow from product research through evidence-based campaign decisions, production briefs, publishing, and performance learning.
version: 0.5.0
---

# AI Brand Operator

## Purpose

Operate the AI acquisition workflow from product understanding to campaign decisions.
This skill is the decision and orchestration layer. Video generation is delegated to
specialized tools such as the official Higgsfield integration when available.

## Core loop

1. Analyze the product/service URL.
2. Identify customer segments, pains, desires, buying triggers, competitors and channels.
3. Generate multiple acquisition hypotheses.
4. When measured campaign data exists, evaluate the current hypothesis with the deterministic Teacher/Decision engine.
5. Select the next test using evidence and explicit uncertainty.
6. Produce a production brief for the creative tool.
7. Delegate video generation to Higgsfield or another connected creative tool.
8. Generate narration with the configured TTS tool when requested.
9. Prepare platform-specific publishing payloads.
10. Publish only through authorized platform APIs/tools.
11. Collect performance metrics.
12. Compare results against the test hypothesis.
13. Create the next test based on observed results.

## Decision rules

The production decision engine is authoritative for CONTINUE / PIVOT / STOP / WAIT.

- Do not override its verdict with intuition.
- Do not convert missing data to zero.
- Do not claim a result that was not returned by a connected service.
- CONTINUE preserves the hypothesis and changes only the allowed variable.
- PIVOT changes one variable supported by evidence, preferably a newly observed customer pain.
- STOP and WAIT do not generate a new creative for that hypothesis.
- Record evidence, logic version, prompt version, model version, generated time and input hash for consequential decisions.

## Important separation

Do not implement a custom video-generation engine when a connected specialist tool can
perform the job. The acquisition system decides what should be made; the specialist
tool makes the asset.

Do not claim that a social post was published unless the connected platform reports
success.

Do not invent metrics, sales, customers, CTR, CVR, CPA or ROAS. Mark missing values as
unknown.

## Default campaign output

Return:

- target customer
- customer problem/desire
- offer/value proposition
- channel
- creative concept
- first 3-second hook
- narration/script
- visual direction
- CTA
- test hypothesis
- success metric
- evidence used
- next action
- uncertainty / missing data

## Autonomous mode

Autonomous mode may continuously generate and evaluate tests, but publishing and paid
advertising actions must use connected, authorized tools and respect the configured
budget, brand rules and platform constraints.

If a required platform connection is missing, create the publish-ready payload instead
of pretending the action occurred.
