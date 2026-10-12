# Moderator forwarding aggregates — 2026-10-11

Preview: https://moderation-linking-stats-cybercabhunter.contactjoeclos.workers.dev/moderation

Worker version: `74981221-290f-4b55-9d69-c586a28fa6ca`.

The preview uses the existing isolated lifetime-preview D1 database, preview KV namespace, and preview R2 buckets. Production was not deployed or modified by this feature.

`GET /api/moderation/forwarding-stats` uses `requireModerator`. Its response contains exactly six integer counts. Setup completion and receipt-arrival evidence are separate, and revoked addresses are excluded from address/linking/receiving counts. All receipt-ingestion audit rows contribute to Receipts processed, including duplicates and failed processing.

The panel starts after the existing moderation queue authorization succeeds. It has six skeleton placeholders, distinct error/retry and number states, and refreshes on return to a visible tab. Only validated numeric fields are rendered. Denied access clears previously displayed numbers.

## Validation

- Five new automated tests cover backend authentication/authorization, empty counts, revoked/active rows, independent setup/receiving evidence, inclusive 7-day and 30-day boundaries, all receipt statuses, skeleton/numbers, failure/retry, unexpected identifying fields, visibility refresh, and denied-access clearing.
- All focused moderation API/UI tests pass (7 test entries).
- Full suite: 81 passed, 3 failed. Existing failures remain in `mobile-density.test.mjs`, `motion.test.mjs`, and `ui-effects.test.mjs`; these files and their associated UI were not changed by this feature. Calculation tests pass.
- Live preview verification compared endpoint values with a direct D1 aggregate query, then ran the served moderation HTML/JavaScript in JSDOM against real preview endpoints. A synthetic moderator rendered all six labels/counts; an ordinary synthetic user received 403, and signed-out requests received 401. Both denied UI states contained no numbers. See `preview.json` (fixture counts, not production adoption metrics).

Preview lacked the previously shipped `0037_forwarding_setup_completion.sql`. With explicit user approval, preview was backed up and that sole pending migration was applied. No new migration file was added. No production schema was touched.

Synthetic test users, forwarding rows, receipt rows, and expiring test sessions were removed after verification. No credentials are included in these artifacts.
