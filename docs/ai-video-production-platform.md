# AI Video Production Platform — Product Contract

## Product promise
AI Acquisition Search is an AI-directed video production platform for the web app and Claude Code extension. It should deliver the workflow a world-class video studio provides—briefing, creative direction, pre-production, generation, edit planning, sound, delivery, publishing and learning—through connected specialist engines. It is not merely a product-URL analyzer and it must not claim to replace human craft where the connected tools cannot yet deliver it.

## User entry points
- **Prompt-first:** the user describes the video they want in natural language.
- **Assets:** optional product photos, reference images, footage, audio, brand assets and a public URL/Shopify product link.
- **Video types:** ads/commerce, social shorts, music videos, brand films, explainers, product demos, event recaps and cinematic concepts. The director selects an appropriate format rather than forcing every brief into an ad.
- **Production controls:** goal, audience, channel, aspect ratio, duration, resolution, visual references, voice, narration, music, captions, budget/quality preference and rights/brand constraints.
- **Output:** a production brief and shot plan before generation; generated assets; status/provenance; final playable/downloadable output where the configured engines support it; channel-specific publish payloads.

## Director pipeline
1. Validate brief and asset rights; ask only for missing information that materially blocks production.
2. Turn the brief into a creative treatment, audience promise, hook/opening, scene-by-scene shot list, camera/motion, pacing, on-screen text and sound plan.
3. Choose a suitable connected generation provider/model using capability, quality, aspect ratio, duration, latency and configured cost limits. Never pretend a provider is configured when it is not.
4. Generate video/image/audio assets and track provider job IDs, state, retries, and errors.
5. Assemble the final deliverable with narration, BGM/SFX, captions and edit decisions only where the implementation can actually perform them. Validate duration, dimensions, audio track and playable bytes.
6. Let the user preview and revise; persist jobs so reloads can recover them.
7. Prepare or publish platform-specific outputs only with user authorization and valid OAuth scopes. Record external IDs/URLs and distinguish queued, processing, published, failed and manual-action-required states.
8. Collect permitted analytics, compare results against the stated hypothesis, and propose the next test. Do not promise virality or fabricate performance.

## Shopify and commerce
Treat Shopify as an optional commerce source, not a required entry point. A future/connected Shopify integration should use OAuth and least-privilege scopes, let the merchant choose products, and import only approved product fields and media. Do not ask users to paste Admin API secrets, scrape authenticated stores, or publish product claims that are not supported by supplied/catalog evidence. Product URL and Shopify are optional inputs; prompt-only and image-only briefs remain first-class.

## SNS automation guardrails
- A creative can be prepared without posting.
- Auto-publish requires a connected account, platform permission, explicit per-account consent and a user-configured scope/budget/schedule.
- Use platform APIs and respect rate limits, disclosure/AI-content rules, music and image rights, and platform review status.
- Never guarantee that a video will go viral. Optimize testable leading indicators (retention, completion, shares, saves, CTR and conversions) using actual returned data.
- Do not silently retry a non-idempotent publish after an ambiguous timeout; first reconcile the provider status to avoid duplicate posts.

## Quality gates
- **Brief:** clear objective, audience, format, promise, CTA and evidence/assumptions.
- **Creative:** intentional opening, coherent visual language, shot variety, pacing, readable text, continuity and no unsupported claims.
- **Media:** generated files are non-empty and playable; duration/aspect ratio are checked; audio track is present when requested; narration/music are mixed at intelligible levels when mixing is supported.
- **Delivery:** preview, download, job recovery, meaningful errors, accessible controls, responsive UI, reduced-motion support and clear cost/usage state.
- **Publishing:** per-platform preflight, consent/scope check, duplicate protection, provider-confirmed status and recovery path.
- **Trust/security:** ownership checks, private asset storage, signed URL expiry, SSRF defenses, secret isolation, RLS, retention/deletion policy and audit trail.
- **Learning:** distinguish measured facts from estimates; no made-up views, sales, ROI or virality.

## Revenue goal
Business target: ¥160,000,000 in revenue. This is a target, not a forecast or current result. Build a measurable plan with paid conversion, ARPA, churn, generation/provider cost, gross margin, CAC, retention and expansion revenue. Do not claim the target is achieved without billing/finance evidence.

## Ten-pass improvement protocol
Each pass must record: (1) scope, (2) evidence inspected, (3) defect/risk, (4) code or test change, (5) test result, (6) remaining blocker. A pass is complete only after evidence is captured. A review checklist or plan alone does not count as a completed pass.
