# AI Acquisition Search — AI Video Production Platform

**Prompt-first AI video studio for the web app and Claude Code extension.** Describe the video you want, optionally add images/assets, and let an AI director prepare the production brief and orchestrate connected specialist generation tools. Product URLs, Shopify data and acquisition research are optional modules—not the main entry point.

Production target: deliver a reliable studio workflow from creative brief → direction/shot plan → connected generation → narration/sound → preview/exports → authorized SNS publishing → measured iteration.

See [the platform contract](docs/ai-video-production-platform.md) for the scope, quality gates, Shopify boundary, SNS guardrails, and ten-pass review protocol.

## What the platform is intended to support

- **Many genres:** ads and product films, social shorts, music videos, brand films, explainers, product demos, event recaps and cinematic concepts.
- **Prompt-first production:** text-only briefs are valid; images, footage, audio, brand assets and public product URLs are optional.
- **AI direction:** treatment, shot list, opening, camera/motion, lighting, pacing, captions, narration and sound plan.
- **Connected specialist engines:** Higgsfield video generation and Gemini TTS where configured. The app must show provider/job status honestly and never claim an unconfigured engine produced an asset.
- **Delivery and recovery:** persistent production jobs, saved assets, preview/download, audio validation and meaningful failure states.
- **SNS workflow:** authorized platform connections, consent and publish status. A post is only reported as published after provider confirmation.
- **Learning loop:** permitted analytics inform the next test; missing data remains unknown.
- **Optional commerce intelligence:** product analysis, market/customer research, Shopify integration when an authorized integration is implemented.

## Current implementation surfaces

- Web app: Next.js App Router
- Authentication and data: Supabase
- Billing: Stripe
- Video: provider router → Higgsfield adapter
- Narration/audio: Gemini TTS and WAV/BGM mixing utilities
- Social publishing: platform-specific adapters for TikTok, Instagram, Facebook, YouTube, X and LinkedIn where credentials/scopes are configured
- Claude Code extension/MCP: `.claude-plugin/plugin.json`, `.mcp.json`, `src/mcp/server.ts`, `skills/ai-brand-operator/SKILL.md`, `commands/ai-acquire.md`

These are code integration points, not a guarantee that every provider account, OAuth review, production secret or live publish path has been configured and end-to-end verified.

## Local development

```bash
npm install
npm run dev
npm run typecheck
npm run lint
npm test
npm run build
```

MCP server:

```bash
npm run mcp
```

## Environment configuration

Configure secrets in the hosting provider, never in client code or committed files.

### Core application
```text
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
OPENAI_API_KEY=...
``

### Video and narration
```text
HF_API_KEY_ID=...
HF_API_KEY_SECRET=...
HF_VIDEO_MODEL=...
HF_I2V_MODEL=...
GEMINI_API_KEY=...
GEMINI_TTS_MODEL=...
GEMINI_TTS_VOICE=Kore
VIDEO_ENGINE=higgsfield
``

Use model identifiers supported by the provider account. Keep server-only keys private. If a provider is not configured, generation should fail clearly rather than simulate success.

### TikTok OAuth/publishing
```text
TIKTOK_CLIENT_KEY=...
TIKTOK_CLIENT_SECRET=...
TIKTOK_REDIRECT_URI=https://<production-host>/api/tiktok/callback
TIKTOK_TOKEN_ENCRYPTION_KEY=...
``

TikTok publishing requires the app to be registered with the relevant API products/scopes, OAuth callback URLs to match, a user-authorized account and any platform review required for public posting. Unreviewed clients may be limited to private/test visibility. AI-generated content and music must follow platform and rights rules.

### Commerce/Shopify
Shopify is **not currently advertised as a connected integration** unless and until an OAuth implementation, least-privilege scopes, product selection UI, webhook/token lifecycle and tests are added. Never request a merchant's Admin API secret in chat or scrape authenticated stores.

## SNS and autonomy safety

- Require explicit authorization before public posting or paid spend.
- Honor platform scopes, budgets, schedules, rate limits and content policies.
- Reconcile ambiguous publish status before retrying non-idempotent requests.
- Track actual provider IDs, URLs, errors and metrics.
- Do not promise virality or invent views, conversions, sales, CTR, CPA or ROAS.

## Business goal

Target revenue: **¥160,000,000**. This is an objective, not a forecast or achieved result. Evaluate the plan using paid conversion, ARPA, churn, provider cost, gross margin, CAC, retention and expansion revenue.

## Deployment

Production deployment is driven from the `main` branch through the connected Vercel project. A Vercel build marked Ready verifies deployment/build status only; OAuth, billing, generation and real SNS publishing still require live end-to-end tests.
