# Notification backend blocker fixes — October 25, 2026

All changes and verification were local. No deployment, production migration,
production setting/credential change, live APNs request, physical-device install,
simulator reset, permission change, or Git commit/push/merge was performed.

## Defects and fixes

### Duplicate daily/weekly reports

Previously, delivery eligibility followed the user's clock while the dedupe ID
used Chicago's date **at each worker run**. In Tokyo, for example, Chicago
midnight changed that ID during the same eligible local Sunday, allowing another
daily report and weekly recap.

The planner now resolves the configured local delivery instant, then freezes the
Chicago content date at that instant. It retains the website's completed-day
accounting and selected metrics. Daily period identity is the previous local
calendar date; weekly identity is the local calendar week starting Monday.
A database UNIQUE index on account/category/period and INSERT OR IGNORE enforce
atomic deduplication independently of the worker lease. IDs persist after expiry.
Saved delivery times are unchanged. Repeated DST minutes resolve to their first
occurrence; missing minutes resolve to the first valid minute after the gap.
Previous-day summary bounds resolve each midnight separately (23/25-hour days).

### Daily category summaries above 60 events

Previously, daily summaries shared the instant-event LIMIT 60 query and derived
IDs from each page's event IDs. A second invocation created a second summary
for the remaining events.

Daily modes for DMV, registry, sightings, and cameras now use separate indexed
range aggregation over the complete previous local day. SQL returns the total
count and one navigation sample, with current source visibility, recipient,
enrollment, and already-consumed-event filtering. DMV sums batch event counts.
One atomic period row represents the complete category summary, regardless of
its size; thousands of IDs are never materialized or written. The aggregate is
revalidated before sending. If its contents change after an attempted send,
remaining delivery is cancelled rather than changing an already attempted alert.
Instant batches cannot merge into period summaries, and switching to instant
mode cannot replay events already covered by a summary. Group/thread preferences
and all existing source gates remain in effect.

The existing collector's 25-record/source/tick intake limit remains unchanged.
Aggregation includes every eligible **captured push event** in the period; this
fix does not claim unlimited source ingestion or catch-up after outages.

### Permanent APNs rejection incorrectly marked sent

Previously, the aggregate status was `sent` whenever no response requested a
retry, including permanent rejections and invalid tokens with zero acceptances.

Only HTTP 200 creates a receipt and `accepted` outcome. This acknowledges APNs
acceptance, not device receipt or presentation. Durable per-device records keep
status, attempt count, HTTP status, error reason, and returned APNs ID. Permanent
rejections are terminal; confirmed 429/5xx responses retry at most five times
with bounded exponential backoff, and 5xx waits at least 15 minutes. Expired
provider JWTs clear the cache and retry; other authentication failures are
terminal and stop that tick's delivery loop. Signing errors are explicit
configuration rejections before any HTTP request.

Accepted/rejected targets are skipped on retries, including partial fanout.
An atomic device-outcome claim precedes HTTP. Interrupted requests and transport
errors with an unknowable acceptance result become terminal `unknown` outcomes
and are not resent automatically. This conservative policy can omit an alert;
it avoids claiming success or duplicating a potentially accepted request.
Exactly-once human receipt cannot be proven through APNs. Mixed fanout is
`partial`; wholly unsuccessful fanout is `failed`, with error information.

Invalid tokens disable only the unchanged matching registration. A 410 timestamp
older than the registration cannot disable a refreshed token. Collapse IDs use
a full SHA-256 digest rather than truncating potentially colliding long IDs.
Classification/backoff follows [Apple's APNs response documentation](https://developer.apple.com/documentation/usernotifications/handling-notification-responses-from-apns).

## Files changed for this fix

- `worker/push.js`: stable report periods, aggregate summaries, dispatch integration.
- `worker/push-policy.js`: cached timezone formatting, scheduled-instant resolution,
  weekly period identity.
- `worker/push-sources.js`: indexed SQL summary aggregation with existing public gates.
- `worker/apns.js`: explicit response/error classification and response metadata.
- `worker/push-delivery.js`: durable device outcomes, acceptance-only receipts,
  bounded retries and safe token invalidation.
- `migrations/0050_push_delivery_safety.sql`: **unapplied local draft**, period
  uniqueness, summary bounds, error data, and device outcomes. Its upgrade test
  preserves legacy receipts and removes unsupported legacy `sent` claims.
- `tests/push.test.mjs`: updates one status expectation from `sent` to `accepted`;
  retains all 40 checks.
- `tests/push-blockers.test.mjs`: 48 new regression checks.
- `docs/notifications/README.md`, this report, and evidence under
  `docs/verification/push-backend-fixes/`.

No native source, website UI, Siri, Zones, location, registry, Social, Heatmap,
Replay, sighting source functionality, or production configuration was changed
by this fix. No Sightings Near Me feature was created. Earlier unrelated working
tree changes were preserved.

## Verification results

| Check | Result |
|---|---|
| Existing push checks | 40/40 passed |
| New blocker regressions | 48/48 passed |
| Native unit tests | 246 tests in 47 suites passed |
| Website suites, including both push suites | 91/95 passed; four baseline failures below |
| Siri built metadata | 22 intents, 10 shortcuts, 42 phrases; zero structural collisions |
| JavaScript syntax for all five changed worker modules | Passed |
| `git diff --check` | Passed |
| Production delivery gates/configuration | Remain absent/off; push cron remains absent |

New coverage includes Tokyo, Kolkata, Honolulu, UTC, Chicago, New York, London,
Sydney, and Lord Howe; UTC/date/year boundaries; spring gaps, repeated autumn
hours, 23/25-hour days; configured delivery times; concurrent worker invocation
and SQL uniqueness; 0/1/60/61/100/1,000-event summaries; consumed/current-day/
pre-enrollment/missing-source filtering; preference changes; successful mocked
APNs acceptance; permanent and invalid-token rejection; 429/500/503; expired
provider tokens; backoff/recovery/exhaustion; partial fanout; stale 410; transport
ambiguity; interrupted requests; upgrade safety; and both disabled gates.

All eight categories remain independently eligible under their settings: News,
DMV, Daily Report, registry, sightings, cameras, Community Interactions, and
Weekly Recap. Defaults/settings, master off, signed-in ownership, self-interaction
exclusion, source/privacy revalidation, selected metric arithmetic, comparisons,
quiet hours, grouping, and frequency remain covered by the existing push/native
checks and new regressions. No additional permission or UI manipulation was
needed for these backend fixes.

Native tests used the existing isolated temporary simulator harness, ad-hoc
simulator signing, and localhost API defaults/matching URL expectations. The
shipping native source was unchanged. Temporary runtime-delegate tests were
excluded so the existing 246-test inventory was verified. Built Siri metadata
was inspected separately; this is not voice recognition testing.

The four failing website suites reproduce with identical failing assertions on
unchanged HEAD `669f642931203cba2e39ccda6f57fd01488af5cd` in an isolated baseline:

| Suite | Unchanged baseline and current result | Existing failure |
|---|---|---|
| mobile-density | 34 passed / 4 failed | Community stats, Fleet ETA, Zones and Replay drawer structure |
| motion | 62 passed / 1 failed | Six eyebrow targets |
| social-v2 | 99 passed / 1 failed | Published post vehicle card |
| ui-effects | 11 passed / 2 failed | Community/Fleet ETA glow scope |

No new website regression failure was found. Original website inventory was
94 suites (90 passing); adding the blocker suite yields 95 (91 passing).

Evidence: [push checks](../verification/push-backend-fixes/push-checks.log),
[new regressions](../verification/push-backend-fixes/blocker-regressions.log),
[website results](../verification/push-backend-fixes/website-suites.json),
[baseline failures](../verification/push-backend-fixes/baseline-failures.txt),
[native test summary](../verification/push-backend-fixes/native-tests.txt), and
[Siri metadata](../verification/push-backend-fixes/siri-metadata.json).
Full native logs/result bundle remain in
`/private/tmp/cch-notification-blocker-fixes/`.

## Readiness and remaining limits

The three reproduced backend blockers are fixed and pass local regression tests.
The implementation is ready for a **separately approved physical-device APNs
validation stage**, subject to that stage's separately approved signing,
entitlements, sandbox credentials, backend environment, and migration setup.
This is not approval for production rollout or activation.

Live APNs/HTTP2 transport, actual device receipt/presentation, Focus behavior,
physical-device registration/renewal, and deployed Worker CPU/D1 limits remain
untested here. Local SQLite concurrency/uniqueness tests do not measure deployed
D1 throughput. The four unrelated website baseline failures remain unresolved.
Neither draft migration has been applied to production; the new schema must be
reviewed and installed only in a separately approved test environment before
running this version there. Both push switches still fail closed and the push
cron is not configured. Stop here and await separate approval.
