# Cybercab Hunter Phase 5.1 production verification

Result: successfully deployed and verified within the approved read-only scope.

Active Worker: e8d46c9d-b23b-4fd3-a087-35bcb54b8901 at 100% traffic, reconfirmed after the observation.
Migration: 0046 was successfully applied before deployment; prior verification found no pending migrations, preserved all original fields of all 11 users, and correctly backfilled 6 Google picture URLs. No additional migration or deployment occurred during verification.

Observation: October 21, 2026, 9:44:03–10:44:03 PM America/Chicago (3600 seconds).
- 175 timestamped events during the hour; 178 events in the complete tail capture (including earlier deployment verification).
- Every captured event had outcome ok; zero exceptions, warning/error console logs, HTTP 5xx responses, or profile_epoch_bump_failed logs.
- 12 scheduled Profile probes: 12 HTTP 200 responses, all identified edge responses from DFW.
- Dashboard near completion: 240 new-version invocations, 0 new-version errors, 0 asset 5xx responses. Dashboard data can lag.
- KV last-hour window near completion: 178 reads, 19 writes, 0 lists, 0 deletes. This shared namespace includes normal session/background traffic; these are not exclusively Phase 5.1 operations. No KV outage was induced.

Smoke checks: 37 requests with expected status codes (31 HTTP 200, 5 HTTP 401, 1 HTTP 404), plus 5 final checks with expected results (3 HTTP 200, 1 HTTP 401, 1 HTTP 404). Covered Home, Community, service areas, registry statistics, all six leaderboards, all three streak boards, feed/sidebar, public profile, rider search, signed-out protected APIs, and missing-profile behavior. Profile-bearing API responses carry private, no-store. Board handles matched opted-in users; streak entries contained no internal rider ids. Signed-out moderation endpoints returned 401.

Profile HTML investigation: reproduced with complete response evidence. Python smoke-client responses were 54563 bytes, versus 54196 local bytes; the sole difference was a 367-byte Cloudflare Web Analytics script inserted immediately before the closing body tag. Removing that exact script restores a byte-for-byte match. Curl returned the unmodified 54196-byte file. Both variants were DFW cache hits with public, max-age=0, must-revalidate. No response matched the previous application file. This supports request-dependent Cloudflare transformation rather than stale application content or regional propagation. The first failing response was not retained, so its exact bytes cannot be retrospectively proven. All available direct probes used DFW; multi-region consistency was not independently tested.

An additional diagnostic with generic Python-urllib/3.9 received HTTP 403 / Cloudflare error 1010, a browser-signature denial. This was separate from the Worker and was not counted as a successful smoke test. No security setting was changed.

Privacy limitations: seven accounts had public handles and none had private handles. Public controls, response fields, opted-in listings, signed-out 401s, and a missing-profile 404 were verified; an existing private-profile 404 and off/on propagation could not be exercised without changing account state. Authenticated profile edits, uploads/removal, sign-in, cache invalidation after writes, KV outage handling, and cross-region propagation remain untested in production. The pre-deployment isolated regression suite covered those behaviors, 73/73.

Restrictions observed: no authenticated testing, account mutations, source edits, deployments, rollback, commits, pushes, merges, restores, or migrations during this verification. The owner separately authorized the normal GET-triggered derived streak snapshot refresh; both new board_order and legacy boards shapes were verified afterward. Tracked diff and untracked file list match the pre-deployment state.

Reference: https://developers.cloudflare.com/web-analytics/get-started/ documents automatic beacon injection. https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1010/ documents browser-signature denial.
