# AI Acquisition Search — SNS Auto-Publishing Platform

AI Acquisition Search helps creators and businesses publish existing media to connected social accounts, on a controlled schedule, and learn from real post results.

**Primary product: SNS publishing operations.** Video generation is out of scope for the active product direction. Users bring an existing MP4, image, caption, or approved creative asset; the platform manages account authorization, preflight checks, queueing, scheduled publishing, provider-confirmed status, retries/reconciliation, and performance tracking. Never present a mock state as a successful post.

## Product priorities

1. **Connect accounts safely:** platform-specific OAuth, least-privilege scopes, token protection, revocation/expiry handling, and clear connection state.
2. **Prepare a post:** select existing media, review platform-specific caption and visibility, check media requirements and rights, and preview what will be sent.
3. **Schedule and queue:** persist scheduled jobs, display timezone and next-run time, prevent duplicate queue items, and make pause/cancel/retry states explicit.
4. **Publish and reconcile:** use official APIs; store external post IDs/URLs and provider response; if a request times out ambiguously, reconcile before retrying.
5. **Learn from real results:** save available impressions, views, retention, clicks, conversions, and revenue with timestamps and source provenance. Missing metrics remain unknown.
6. **Operate with confidence:** responsive, accessible dashboard; clear errors; activity history; deletion and disconnect controls; audit trail.

## Supported integrations

Platform adapters may exist for TikTok, Instagram, Facebook, YouTube, X and LinkedIn. An adapter in code does **not** mean the provider is configured or approved for live public posting. Show per-platform readiness and block unsupported actions. TikTok may restrict visibility until app review and scopes are approved.

## Safety and trust

- Require explicit account authorization and per-account consent before automated public posting.
- Honor platform scopes, disclosure requirements, rate limits, scheduling settings and user-defined limits.
- Never ask users to paste platform secrets into chat or client-side fields.
- Never fabricate post URLs, IDs, analytics, conversions, sales, ROI or successful publish states.
- Do not blindly retry a non-idempotent publish after an ambiguous timeout; reconcile provider state first.
- Validate media type/size and platform constraints before enqueueing.
- Keep server-only credentials private; use ownership checks, RLS, private storage, expiring signed URLs and auditable state transitions.

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

Configure secrets in the hosting provider, never in committed files or client code.

### Core application
```text
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
OPENAI_API_KEY=...
```

### TikTok OAuth/publishing
```text
TIKTOK_CLIENT_KEY=...
TIKTOK_CLIENT_SECRET=...
TIKTOK_REDIRECT_URI=https://<production-host>/api/tiktok/callback
TIKTOK_TOKEN_ENCRYPTION_KEY=...
```

TikTok publishing requires a registered app with the relevant products/scopes, matching callback URL, user-authorized account, and any required platform review. Unreviewed clients may be limited to private/test visibility.

### Optional media providers
Existing media is the product input. Any legacy video-generation provider integration is not part of the primary product workflow and must not be presented as the main feature.

## Quality standard

The UI should aim for award-caliber craft inspired by Awwwards, The Webby Awards and FWA, without claiming awards or guaranteed outcomes. Visual quality must be matched by working behavior, accessibility, performance, truthful status, and robust error recovery.

Every improvement cycle must inspect real implementation evidence, make a concrete change, run the relevant checks, inspect the result, and record unresolved blockers. A checklist alone is not a completed cycle.

## Business goal

Target revenue: **¥160,000,000**. This is an objective, not a forecast or achieved result. Evaluate progress using paid conversion, ARPA, churn, provider cost, gross margin, CAC, retention and expansion revenue.

## Deployment

Production deployment is driven from the `main` branch through the connected Vercel project. A Vercel build marked Ready verifies deployment/build status only; OAuth and real social publishing still require live end-to-end tests.
