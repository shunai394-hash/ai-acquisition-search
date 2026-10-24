# AI Video Production & SNS Automation Platform — Product Contract

## Product promise
AI Acquisition Search is an AI-directed video production platform integrated with reliable SNS publishing. The primary workflow turns a prompt and optional reference/product images into a creative brief, shot plan, generated video with requested sound where supported, a reviewable deliverable, and an authorized social post. Users can also publish existing media without regenerating it.

## Primary user journey
1. Accept a natural-language brief and optional product/reference images or an existing media file.
2. Build an AI-directed treatment, hook, shot plan, motion and sound plan.
3. Generate through a configured provider; persist job IDs, status, errors and usage.
4. Validate playable output, requested audio, duration and aspect ratio; allow preview/revision.
5. Prepare platform-specific caption, media and disclosure; preflight rights, scopes and limits.
6. Connect a social account through official OAuth and obtain explicit posting consent.
7. Publish now or schedule with a visible timezone; persist durable queue states.
8. Confirm publication from the provider response and save ID/URL/timestamp/visibility.
9. Reconcile ambiguous timeouts before retrying; prevent duplicate posts.
10. Use real permitted analytics to recommend the next creative test.

## Product information architecture
- **AI Video Studio:** prompt/image input, creative direction, generation status, audio options, preview and export.
- **Publish / Operations:** queue status, connected-account readiness, next scheduled posts, existing-media intake, captions, preview, schedule and preflight.
- **Queue / Calendar:** scheduled, processing, published, failed and manual-action-required states; timezone visible; edit/cancel behavior explicit.
- **Accounts:** per-platform connection state, scopes, consent, expiry/reconnect and disconnect.
- **Analytics:** only provider-returned measurements, timestamped and attributed to the correct post/account.
- **Activity / Settings:** audit history, retries, deletion, permissions and operational configuration.

## Publishing state machine
Use explicit states such as `draft`, `scheduled`, `queued`, `publishing`, `published`, `failed`, `reconciling`, `cancelled`, and `manual_action_required`. A queue entry is not a published post. A provider HTTP success is not sufficient unless the provider response confirms the resulting state. Persist idempotency keys or equivalent deduplication keys where supported.

## Authorization and safety
- Require account OAuth, valid scopes and explicit per-account consent before public auto-publishing.
- Respect platform policies, API limits, visibility restrictions, AI-content disclosure, music/image rights and user schedule settings.
- Never ask users to paste platform secrets into chat or browser-visible forms.
- Keep tokens server-side, encrypted where appropriate, and handle expiry/revocation clearly.
- Enforce ownership and RLS on media, queue records, tokens and analytics.
- Validate file MIME type, actual bytes, size, duration and dimensions; do not trust filename extensions alone.
- Never blindly retry a non-idempotent post after a timeout; reconcile remote state first.
- Never invent external IDs, URLs, analytics, conversions, revenue or a successful publish state.

## UX and design quality gates
- Distinctive, coherent visual system with clear hierarchy and polished responsive behavior.
- First screen immediately communicates the next action and current operational readiness.
- Accessible keyboard navigation, visible focus, semantic labels, sufficient contrast and reduced-motion support.
- Helpful empty/loading/success/error states; errors explain a recovery action.
- Mobile queue management and upload controls remain usable without horizontal overflow.
- Status labels reflect persisted backend/provider states, not optimistic UI assumptions.
- Avoid decorative dashboards full of invented counts or simulated success.

## Ten-pass review protocol
Each pass must record the inspected evidence, defect, concrete change, validation result and remaining blocker. Do not count a plan, visual mock, or code-only change without checks as a completed pass.

1. Product scope and navigation: make AI-directed video production and authorized SNS publishing one coherent workflow.
2. Visual hierarchy: improve information density, typography, spacing, color and focus on the main action.
3. Responsive UX: check mobile/tablet/desktop, overflow, touch targets and long content.
4. Accessibility: semantic structure, keyboard flow, focus visibility, contrast and reduced motion.
5. Media intake: validate file content, type, size, preview and safe upload failure recovery.
6. Queue/scheduling: durable states, timezone clarity, cancellation and no duplicate queue jobs.
7. OAuth and consent: per-account readiness, expired/revoked tokens, scope mismatch and disconnect.
8. Publish reliability: provider-confirmed outcomes, timeout reconciliation, retry safety and activity log.
9. Analytics/trust: only real metrics, source/time provenance, empty states and no fabricated performance.
10. Release verification: typecheck, lint, tests, production build, deployment status, then a live provider test when credentials and permissions permit.

## Live integration limitation
A repository adapter or successful deployment does not prove live public posting. Completion requires a real authorized test post, returned provider ID/URL, confirmed visibility, and a separate scheduled-post test. If platform review or credentials block that test, report the exact blocker and do not claim end-to-end completion.

## Revenue goal
Target revenue: ¥160,000,000. This is an objective, not a forecast or achieved result. Measure paid conversion, ARPA, churn, provider costs, gross margin, CAC, retention and expansion revenue.
