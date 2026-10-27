# Cybercab Hunter push notifications — local implementation report

Current backend fixes and verification: [BACKEND_FIXES.md](BACKEND_FIXES.md).
Physical-device preparation (no execution approval): [PHYSICAL_DEVICE_TEST_PLAN.md](PHYSICAL_DEVICE_TEST_PLAN.md).

Prepared October 25, 2026. Source changes and synthetic tests only. Nothing has
been deployed, no remote D1 migration or secret/settings change was made, and no
physical device was accessed. The simulator app and test targets were compiled;
installation/runtime testing was stopped before installation to honor the final
“do not install anything” instruction. Existing uncommitted work was preserved.

## Implemented controls and defaults

Account → Notifications adds a dedicated native SwiftUI form, using the app's
dark background, typography, and #FFD60A controls. Sections are General, News,
DMV, Cybercab Daily, Fleet & activity, Community, and Weekly recap.

| Category | Initial preference | Available controls |
| --- | --- | --- |
| Major News | Major only | Major / all / off |
| New DMV Entries | Instant | Instant / daily summary / off |
| Cybercab Daily | On, 08:00 local | Time, four metrics, previous-day comparisons |
| New Cybercabs | Off | Every new vehicle / daily summary / off |
| Sightings | Off | Instant / daily summary / off |
| Camera Detections | Off | Instant / daily summary / off |
| Community | On when signed in | Comments, replies, mentions, likes independently |
| Weekly Fleet Recap | Off | Day, time, metrics; Sunday 09:00 when enabled |

All four report metrics start selected. At least one must remain selected.
Social models replies to posts as comments; replies to comments are separate.
Mentions and likes are existing Social features and have independent controls.
Turning every Community toggle off disables that category.

General defaults: master on (subject to iOS permission and registration), quiet
hours off (22:00–07:00 when enabled), major-news bypass off, grouping on,
frequency Standard. Reduced spaces ordinary News/Community delivery hourly;
explicit per-category instant/daily choices take precedence. Major news never
requests Apple's Critical Alerts entitlement or overrides iOS Focus.

The permission row uses UNNotificationSettings. Only the explicit Allow button
requests permission, only while status is notDetermined. Denied users get a
system-settings button. Foreground refresh handles permission changes and token
renewal; the token is kept in the device-only Keychain. Registration state is
shown separately from permission. Failed registration never claims success.

Preferences persist per account in UserDefaults, separately from the signed-out
preferences. Save synchronizes using the existing bearer-session API. Failed
sync keeps a dirty local copy rather than replacing it with the server version
on the next settings visit. Master does not erase category choices. Signed-out
users can edit locally; this implementation intentionally registers no anonymous
devices and sends no signed-out Community or public pushes.

## Existing infrastructure reused

- Native SessionStore/APIClient and existing Google/Tesla bearer-session lookup.
- D1 binding `cybercabhunter_db`; existing TESLA_SESSIONS authentication.
- News `importance >= 2`, including moderator/AI classification already used by
  News. No invented keyword classifier or “all stories are major” fallback.
- TxDMV's atomic snapshot/VIN upsert. The optional push INSERT precedes the VIN
  upsert in the same batch: one counted batch event, no VINs in previews, no
  baseline notifications, no correction/reimport notifications.
- `publicVehicleEligibleSql` for registry and linked Social content.
- `PUBLIC_PHOTO_SIGHTING_SQL`, `publicSightingJson`, public IDs, and the existing
  30-day photo-retention policy for sightings.
- Existing Social notification recipient/type/dedupe rules and visibility joins.
  Self interactions are excluded again. Names and post/comment text never enter
  push previews. Content visibility is rechecked just before delivery.
- Existing camera detections and native Zones Heatmap. No Cameras page, Nearby
  Cameras, zone camera button, Sightings Near Me, radius filtering, location
  annotations, or migration 0048 was added.
- `buildDaily` and its America/Chicago date boundaries, metrics and null/error
  semantics. The existing website Daily API and UI are unchanged.

## Backend architecture

`worker/push.js` supplies authenticated `/api/push/preferences` GET/PUT,
`/api/push/device` PUT/DELETE, and narrow read endpoints for the selected report,
news URL and public sighting. No user ID from the request body determines
ownership. Writes are bounded to 8 KiB, preference writes to one per second,
registration to 20 attempts/minute/account and five devices/account. Devices
cannot be reassigned across accounts by submitting a different user ID. Token
refresh and same-account installation-ID replacement are supported.

A dedicated **draft-only** cron, `2-59/10 * * * *`, calls `runPushTick` separately
from Gmail/news ingestion so APNs does not share their external-subrequest
budget. It has NOT been added to wrangler.jsonc. Both feature switches default
to absent/off:

- `PUSH_ENABLED=true`: API, event collection, report snapshots and planning.
- `PUSH_DELIVERY_ENABLED=true`: additionally permits APNs, only with all required
  credentials/topic present. Leave false for a preview pilot.

Collection uses indexed recent discovery/approval windows, stable source IDs,
unique event rows and no website polling. It takes at most 25 recent records
per source per tick. DMV uses one ingestion event per new snapshot batch.
Initial activation excludes earlier data; preferences also record their first
initialization time so a newly registered account does not receive earlier
queued events. Registry approvals consult the first public review so returning
an old vehicle to public does not create a second discovery. Existing records
updated under the same source ID do not create new events.

Per tick the planner visits five accounts with a persistent fair cursor, up to
60 instant events/account. Daily category summaries use a single indexed range
aggregate per category and local reporting period; they do not use that page
limit or materialize every event ID. Disabled/current-partial-day summaries cannot
block unrelated active categories. Similar instant pending events merge up to 60 event
IDs; major and ordinary news stay separate for quiet-hours bypass. Delivery
revalidates authorization, device age, preferences and public content. A global
lease, per-delivery leases, consumed event keys and per-device success receipts
protect overlapping invocations and retries.

At most five deliveries × five devices = 25 APNs fetches per invocation.
APNs requests time out after ten seconds. Confirmed 429/5xx responses retry
with exponential backoff, at most five attempts per device (5xx waits at least
15 minutes). Permanent rejections never retry. Ambiguous transport failures
and interrupted sends become terminal unknown outcomes to avoid duplicate alerts.
Only HTTP 200 creates an acceptance receipt; acceptance is not device delivery.
Durable per-device outcomes retain HTTP status, reason and APNs ID, and protect
accepted/rejected devices during partial-fanout retries. Invalid-token responses
disable only the matching unchanged registration; stale 410 timestamps cannot
disable a refreshed registration. 401/403 stop that tick's send loop. JWTs use Web Crypto ES256
and are cached for 50 minutes. Sandbox/production hosts depend on the explicit
build environment, not DEBUG. Payloads use ordinary alert/thread/collapse IDs,
never critical alerts. Payload length is bounded. No token, private key, account
name, post body or comment body is logged by the new code.

## Reports and navigation

Snapshots contain only completed website reporting dates. Missing/null source
data prevents snapshot creation; retry is at most hourly, not every tick. Weekly
reports require all seven snapshots, so a fresh install cannot generate a full
weekly recap until seven complete days have accumulated. Comparison-enabled
daily reports also require the comparison date. No historical totals are
fabricated, and no repeated seven-day registry scans were introduced.

Delivery clock uses the user's saved IANA timezone; report boundaries remain
America/Chicago as on the website. Local midnight resolution handles DST rather
than subtracting a fixed 24 hours. The content date is the latest completed
Chicago date at the configured local delivery instant, frozen across later
Chicago midnight changes. Daily uniqueness uses the local reporting date; weekly
uniqueness uses the local calendar week (Monday start). Database unique keys
enforce one report per account/category/period atomically. Repeated DST hours use
the earliest occurrence; a missing delivery minute advances to the first valid
minute after the gap. Users' saved delivery times remain unchanged.

See [backend blocker fixes and verification](BACKEND_FIXES.md) for the current
implementation, migration requirements, regression results and remaining limits.

Taps open the original News article in Safari, the existing DMV roster, the
specific native public-sighting photo viewer, a native vehicle detail, Zones in
Heatmap mode, the exact Social post/comment route, or a dated native Cybercab
Daily snapshot view (seven dated sections for recaps). Removed/expired sightings
and unavailable articles show an unavailable state. Cold-launch notification
links are retained until the root view consumes them. Links are restricted to
the app's own site; no arbitrary remote destination is trusted from a payload.

## Migration and exact configuration, awaiting separate approval

The local draft `0050_push_delivery_safety.sql` is also required alongside 0049.
It adds period uniqueness, summary boundaries and durable per-device outcomes.
Neither migration has been applied to production.

`migrations/0049_push_notifications.sql` is a local draft. 0048 remains untouched.
It adds preferences (including initialization time), devices, activation/cursor
state, events, deliveries, consumed event keys, device success receipts, daily
snapshots and registration rate counters, with indexes on discovery windows.
Foreign keys cascade account/device-related records. No new Cloudflare binding
or queue service is required.

The following are instructions only; none have been executed:

1. Review this implementation and the local migration. In a separately approved
   staging setup, apply **only** 0049 after checking already-applied migration
   versions. Do not blindly run every pending migration: 0048 is reserved.
   The targeted command after approval would be:
   `wrangler d1 execute cybercabhunter-db --remote --file migrations/0049_push_notifications.sql`
   (For an isolated local database, substitute `--local --persist-to <temporary-directory>`.)
2. Use a paid Apple Developer team with Push Notifications enabled for
   `com.cybercabhunter.native`. Create an APNs signing key in that team. Never
   paste its private key into source control, a report, or chat.
3. Add Worker secrets with `wrangler secret put <NAME>` for `APNS_TEAM_ID`,
   `APNS_KEY_ID`, and `APNS_PRIVATE_KEY` (the complete `.p8` PEM). Set
   `APNS_TOPIC=com.cybercabhunter.native` as a Worker variable. No credentials
   were invented or read from the existing `keys` directory.
4. After signing approval, set the native Debug user-defined build setting
   `PUSH_ENVIRONMENT=sandbox` and Release `PUSH_ENVIRONMENT=production`.
   Info.plist's `PushEnvironment` already references this setting; it is inert
   until set. Wire CODE_SIGN_ENTITLEMENTS to the corresponding supplied draft:
   `../docs/notifications/Push.development.entitlements` for Debug and
   `../docs/notifications/Push.production.entitlements` for Release, relative
   to ios-native. Development entitlements use `development`; the APNs host
   selection value is `sandbox`. Ad Hoc/TestFlight/App Store use production.
   Regenerate provisioning profiles through the approved paid team. Do not
   enable Critical Alerts or remote-notification background mode.
5. After separate Worker-settings/deployment approval, add only the draft
   `2-59/10 * * * *` cron while preserving all four existing cron strings.
   Verify account-wide Cron limits first. Set PUSH_ENABLED=true with
   PUSH_DELIVERY_ENABLED=false. Deploy only after the migration is approved
   and applied, since the DMV hook references the new table when enabled.
6. Inspect preview-only event/queue counts, CPU and D1 rows read/written using
   approved aggregate diagnostics. Confirm first-activation suppression and
   completed-date snapshots. Keep delivery disabled during this review.
7. Separately approve simulator installation/runtime tests and an APNs sandbox
   test build/device. Test permission denied/revoked, sign-out/account switching,
   token refresh, exact links, Focus, timezone travel and DST. Test with explicit
   sandbox test devices only; never enable real production recipients merely
   to verify wiring. macOS local workerd APNs transport has known differences
   from deployed Workers, so local HTTP mocks do not prove live HTTP/2 delivery.
8. After sandbox results and budget review, separately approve any production
   settings, migration, deployment, iPhone build installation and limited
   recipient pilot. Each remains outside current authorization. To stop the
   pilot, set PUSH_DELIVERY_ENABLED=false; to stop all push work/API writes,
   set PUSH_ENABLED=false. Disabling delivery does not erase user preferences.

## Operational limits and remaining validation

This is a conservative small-pilot implementation, not a throughput claim for
an unlimited fleet of users. Ten-minute cron cadence means “instant” means the
next processing run, normally within ten minutes for a small pilot. Five-account
pagination adds delay as enrollment grows; five deliveries/tick caps throughput
at 720 account deliveries/day before retries. Recent-source capture windows are
24 hours. An outage or sustained input rate beyond those caps can safely skip
alerts rather than replay historical data. Delivery expires after 24 hours.
Missing days are not backfilled automatically, so a gap delays weekly recaps.

CPU and row budgets need measurement in an approved staging Worker before
rollout. Free-plan CPU is particularly restrictive; local bundle success does
not certify production CPU safety. The report reuses buildDaily's registry
accounting, which still reads the eligible registry once per snapshot attempt.
If staging exceeds budget, keep the flags off and split snapshot computation
from delivery or reconsider the plan; do not increase polling frequency.

iOS itself suppresses alerts after permission revocation. The server learns the
new authorization state on app foreground. Sign-out unregisters locally and
attempts authenticated device removal with the captured old credential; if
network removal fails, server cleanup is best effort and the device expires
after 30 days without refresh. Account deletion cascades device ownership.
Device registration/foreground refresh synchronizes the current IANA timezone
without changing category choices. With multiple devices, the last active
registered device determines the account-level report delivery timezone. Exact-once human receipt cannot
be guaranteed after an ambiguous network timeout at APNs; successful responses
have per-device receipts and retries use stable collapse IDs.

Old legacy Activity Alerts/Siri settings retain their original data and behavior;
the new push preferences do not silently migrate or overwrite them. The new
Notifications form is the control surface for this push pipeline.

At the initial implementation stage, no visual screenshot QA, native test execution, live APNs transport, production
CPU/D1 measurements, denied-permission device test or real push was performed.
Native test targets compile, and the local tests below cover their pure backend
counterparts. The added UI test is prepared for a separately approved simulator
installation. Do not describe these unexecuted checks as passing.

## Initial implementation verification results (superseded by BACKEND_FIXES.md)

- `node tests/push.test.mjs`: **40 checks passed**, real SQLite via the existing
  D1 adapter and synthetic data; APNs is always mocked. Covers defaults,
  validation, permission gating, independent categories, ownership/auth,
  persistence, no historical bootstrap flood, source/edit deduplication,
  exact DMV batch counts/baselines/reimports, daily/weekly arithmetic, null data,
  comparison data, DST midnight and repeated-hour quiet hours, current-day
  summary exclusion, moderation/privacy rechecks, master off, invalid tokens,
  sandbox/production routing, JWT generation, retry cap and report deduplication.
- Existing `tests/*.test.mjs`: **90/94 suites passed**. Failures in
  mobile-density, motion, social-v2 and ui-effects reproduce against HEAD in
  an isolated temporary checkout. No public website source was changed here.
  The baseline social-v2 run's final result is 99 passed / 1 failed; its first
  baseline attempt lacked wrangler.jsonc, corrected for the final rerun.
- `node tests/txdmv.test.mjs`: **29 passed / 0 failed** after ingestion changes.
- Wrangler `deploy --dry-run` builds the Worker locally; **passed**, no upload.
- Xcode generic iOS Simulator `build`: **BUILD SUCCEEDED**.
- Xcode generic iOS Simulator `build-for-testing`: **TEST BUILD SUCCEEDED**;
  app and native unit/UI test targets compile for simulator. Not executed.
- Extracted built App Intents metadata: **22 intents, 10 shortcuts, 42 phrase
  templates**, no structural phrase collisions. Voice recognition not tested.
- `git diff --check`: passed. No commit, push, merge or history change.

Evidence is in `docs/verification/push-notifications/`. Full Xcode logs and local
build products are under `/private/tmp/cybercab-push-*`.

## Source inventory

Created:

- `worker/push.js`, `worker/push-policy.js`, `worker/push-sources.js`, `worker/apns.js`
- `migrations/0049_push_notifications.sql`
- `ios-native/CybercabHunter/Features/Push/PushPreferences.swift`
- `ios-native/CybercabHunter/Features/Push/PushCoordinator.swift`
- `ios-native/CybercabHunter/Features/Push/PushSettingsView.swift`
- `ios-native/CybercabHunter/Features/Push/PushDestinationView.swift`
- `tests/push.test.mjs`, `ios-native/CybercabHunterTests/PushTests.swift`,
  `ios-native/CybercabHunterUITests/PushUITests.swift`
- This report, two draft entitlement files, verification evidence.

Modified for this feature:

- `worker/index.js`: gated API routes and separate draft-cron dispatch.
- `worker/txdmv.js`: opt-in atomic discovery batch event.
- `ios-native/CybercabHunter/App/CybercabHunterApp.swift`: delegate and lifecycle.
- `ios-native/CybercabHunter/Core/Auth/SessionStore.swift`: captured-credential
  sign-out cleanup.
- `ios-native/CybercabHunter/Features/Account/AccountView.swift`: settings route.
- `ios-native/CybercabHunter/Features/Root/RootView.swift`: deferred push routing.
- `ios-native/CybercabHunter/Features/Zones/ZonesView.swift`: optional initial
  Heatmap mode; existing location/camera behavior preserved.
- `ios-native/Config/Info.plist`: inactive environment-setting placeholder.

The Xcode project, Siri intent definitions, existing tests, production Wrangler
settings and encrypted backup storage were not edited for this feature.

## Platform references consulted

- [Apple APNs requests](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns)
- [Apple APNs response handling](https://developer.apple.com/documentation/usernotifications/handling-notification-responses-from-apns)
- [Apple APNs HTTP/2/TLS connection requirements](https://developer.apple.com/documentation/usernotifications/establishing-a-connection-to-apns)
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare workerd APNs local transport issue](https://github.com/cloudflare/workerd/issues/4841)
