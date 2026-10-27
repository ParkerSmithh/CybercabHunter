# Cybercab Hunter — physical iPhone APNs preparation

Prepared October 25, 2026 (America/Chicago). **Preparation only.**

**Status: READY WITH MANUAL SETUP REQUIRED.** No physical-device test is authorized
or started. Signing, provisioning, isolated hosting/resources, test-account/device
selection, fixture navigation data, and explicit send approval are prerequisites.
Do not interpret this status as an install, permission, migration, deployment,
or notification-send approval.

## 1. Readiness and confirmed evidence

Inspected the implementation report, backend fix report, Push Swift files,
AppConfig/session lifecycle, Worker planner/sources/APNs transport, migration
0049/0050, Xcode project, Info.plist, draft entitlements, and existing tests.

| Check | Evidence and disposition |
|---|---|
| Existing push checks | Fresh rerun: 40/40 passed |
| Backend blocker regressions | Fresh rerun: 48/48 passed |
| New sandbox isolation checks | 29/29 passed with mocked transport; no APNs request |
| Native unit tests | Retained successful xcresult/log: 246 tests in 47 suites; not a new 246-test run in this preparation pass |
| Previous website inventory | Confirmed saved 91/95 results, four unchanged baseline failures |
| Current website inventory | Fresh rerun: 92/96 passed; same four baseline failures. Added sandbox suite passed; its final 29-check version was rerun after fixture refinements. |
| Baseline | Saved unchanged HEAD `669f642931203cba2e39ccda6f57fd01488af5cd` results confirm identical assertions |
| Siri | Built metadata: 22 intents, 10 shortcuts, 42 phrases; no structural collisions |

Existing failures: mobile-density (34 passed/4 failed), motion (62/1), social-v2
(99/1), ui-effects (11/2). They concern existing layout/card/glow assertions,
not these notification preparation files. Prior evidence is in
`docs/verification/push-backend-fixes/`; this pass's evidence is in
`docs/verification/physical-device-preparation/`.

## 2. Existing configuration and missing Apple requirements

- App Debug/Release bundle identifier: `com.cybercabhunter.native`; this is also
  the required APNs topic. Widget bundle is `com.cybercabhunter.native.widgets`;
  do not send alert pushes to that topic.
- App/widget team configured: `JC2HZNJ623`, automatic signing. This records an
  intended team, not proof of current membership, certificates, or access.
- No `CODE_SIGN_ENTITLEMENTS`, `PUSH_ENVIRONMENT` build value, or Push capability
  entry is wired into the project. Info.plist references `$(PUSH_ENVIRONMENT)`,
  so registration correctly remains unconfigured in the current build.
- `Push.development.entitlements` contains `aps-environment=development` and
  `Push.production.entitlements` contains `production`; both are **unwired drafts**.
- Read-only signing-identity inspection returned zero valid identities in the
  current execution context. No account login, profile/certificate installation,
  profile refresh, or keychain change was attempted. This does not establish
  the state of the developer portal or identities inaccessible to this context.
- No APNs private credentials were read or supplied. No account access was used.
- App Store/TestFlight/Ad Hoc distribution is unsuitable for this sandbox-only
  first test. Use a development-signed build and a development profile whose
  signed entitlement is `aps-environment=development`. Set native
  `PushEnvironment=sandbox`; these are different strings for different purposes.

After separate approval, an authorized team member must:

1. Confirm membership/access to the intended team and ownership of the explicit
   App ID matching the bundle ID. Inspect its Push Notifications capability.
2. If absent, obtain separate approval before enabling the App ID/Xcode capability;
   shared App ID changes may affect the existing app's configuration.
3. Confirm the approved iPhone UDID is in a development provisioning profile for
   that App ID, with a valid Apple Development signing identity and push entitlement.
   Creating/updating profiles or registering a device requires separate approval.
4. In an isolated test checkout/configuration only, wire the supplied development
   entitlement draft and `PUSH_ENVIRONMENT=sandbox`. Inspect the **signed app**
   entitlements and embedded profile; project labels alone are insufficient.
5. Supply an already approved APNs signing key, key ID, team ID, and topic only
   to the isolated backend secret store. Verify the key's actual environment/topic
   scope in the portal; prefer a sandbox-restricted key if available. Some existing
   team keys can authorize both environments. Do not assume the key enforces the
   sandbox boundary; the transport guard also enforces it. Creating/rotating a key
   is not authorized by this plan.
6. Stop if access, key, profile, or identity is unavailable. Resolve with the team
   owner under a separate approval; do not bypass signing or use production tokens.

Apple references: [Push capability setup](https://help.apple.com/xcode/mac/current/en.lproj/devdfd3d04a1.html),
[APNs registration](https://developer.apple.com/documentation/usernotifications/registering-your-app-with-apns),
[token-based connection and key scope](https://developer.apple.com/documentation/UserNotifications/establishing-a-token-based-connection-to-apns),
[APNs request hosts](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns).

## 3. Native lifecycle and authorization findings

The coordinator reads real UNNotificationSettings. Only the explicit Allow button
requests alert/sound/badge authorization when not determined. Denied state opens
settings; provisional/ephemeral are recognized but the app does not request
provisional authorization. Foreground presentation deliberately returns `[]`:
**no foreground banner/sound is the expected current behavior**.

App launch assigns the notification delegate; launch, user changes, and foreground
refresh connect the coordinator and register only when signed in and authorized.
A newly issued token is hex encoded and stored in device-only Keychain storage;
registration includes account-authenticated installation ID, explicit environment,
authorization, and timezone. Missing environment cannot silently guess production.
Sign-out captures the old authenticated API, unregisters with iOS and attempts
server removal. Network removal is best effort; server device expiry is 30 days.
Verify actual removal in the isolated DB before any later send, rather than
assuming an offline sign-out removed the server token.

Preferences persist independently per account and signed-out state. Dirty local
settings survive failed synchronization. Master off retains category choices.
Notification taps accept relative same-site links only, then use existing native
navigation. Existing production-domain link parsing remains unchanged; **the API
client for the test build must still be pinned to the isolated backend**.

## 4. Isolated sandbox architecture prepared locally

The existing general backend alone is insufficient: it allows sandbox and
production device rows, fans out across accounts/devices, and has no test-device
allowlist. Do not enable its global delivery switch to conduct this test.

New local `worker/push-sandbox.js` is a **separate entry point**, never imported
by `worker/index.js`. It has no scheduled handler or source collector. Draft
`wrangler.sandbox.example.jsonc` contains placeholders, no production binding IDs,
no routes, no cron, no production buckets/KV, no secrets, and both global gates
explicitly false. It cannot be deployed as configured. Do not edit production
wrangler.jsonc to host this entry point.

The proposed separate HTTPS backend has:

- A fresh isolated D1 database and isolated session KV; never copies of production
  users, sessions, device tables, credentials, tokens, or content.
- An isolated DB sentinel whose run ID must match configuration before any API
  registration or send is permitted. Review physical resource bindings separately;
  a sentinel is a guard, not proof that an operator chose the correct resource.
- One approved test account ID, one installation UUID, one SHA-256 token pin, and
  `APNS_TOPIC=com.cybercabhunter.native`. Record approved device identity/UDID in a
  private test record, not source control. The installation UUID is generated by the app on first launch: obtain it
  via an approved Xcode debug inspection of `PushCoordinator.shared.installationID`,
  configure the UUID while unarmed, then retry registration. Do not confuse it
  with the iPhone UDID. Token pinning happens after approved
  registration, before arming; a token refresh requires renewed pin review.
- Bearer-authenticated `/api/push/*` scoped to that account. Registration rejects
  any other installation UUID or any environment except sandbox. Delete uses the
  same installation/account boundary.
- Manual-only `POST /__sandbox/send`, requiring the account's session, a separate
  approval header secret (at least 32 characters), `SANDBOX_SEND_ARMED=true`, and
  all explicit configuration. Global `PUSH_ENABLED` and `PUSH_DELIVERY_ENABLED`
  must remain false/absent; true causes this entry point to refuse service.
- Only the eight fixed, visibly labeled synthetic fixtures. Caller-supplied
  payloads/tokens/recipients are rejected. ID = run/category; repeated requests
  cannot repeat accepted fixtures. Retries retain the same ID and durable outcome.
- A final transport boundary checks account, device UUID, environment, and token
  hash again, even if extra/poisoned device rows exist. The existing APNs sender
  therefore chooses only `api.sandbox.push.apple.com`.
- At most eight accepted fixtures per approved run; confirmed transient retries
  remain bounded at five attempts per fixture, maximum 40 attempts across all
  eight in the worst case. No automatic retries/cron run: another approved manual
  request is necessary after `due_at`. A new run ID/fixture reset is a new approval.

This fixture endpoint exercises transport, native presentation, preferences,
quiet-hours suppression, selected report metrics/comparison, and receipt/retry isolation. It does **not** run the live
source collector, scheduler, summary-generation frequency, or reduced-frequency
throttling; those remain covered by the 40/48 local backend checks. Do not claim
manual fixture timing proves scheduled daily/weekly delivery.

### Required test-build and navigation setup

Before any physical install, use a separately approved isolated native checkout
whose AppConfig **compiled default** siteURL and teslaOAuthOrigin point only to
approved HTTPS test services. Merely passing `-apiBase` from Xcode is insufficient:
OS cold launches need safe compiled defaults too. No production API fallback is
permitted, including Siri/background execution. Do not ship this test configuration.
Leave the bundle ID and all Siri metadata unchanged. Review every test endpoint
before installing over an existing app with the same bundle ID; prefer an approved
spare iPhone to avoid disturbing an existing installed Cybercab Hunter app.

The new entry point serves push APIs only. Full registry, gallery, Community,
DMV, Heatmap and Replay navigation needs the existing **synthetic fixture backend**
(or an approved isolated full-app backend) in front of it, sharing the same test
data/account. There is deliberately no production proxy fallback. This integration,
HTTPS hosting, isolated authentication and fixture seeding are manual setup
prerequisites, not implemented deployment or claimed passing device tests here.

Seed only synthetic objects matching `SANDBOX_PAYLOADS.json`: news `sandbox-news`
with a synthetic HTTPS article page, vehicle
`a1b2c3d4-0000-4000-8000-000000000001`, approved photo public ID
`aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`, Community post `bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`, DMV fixture
batch, Austin camera/Heatmap/Replay data, and eight daily snapshots through
2026-10-24 (daily values 1/2/3/4, weekly sums 7/14/21/28). The Community post and sighting public ID use the native parser's required
32-hex format. Confirm fixture existence and current public eligibility through
the isolated APIs before any send.
Do not arm until every destination resolves through the isolated API. Daily/weekly fixture bodies also honor the saved metric selections and daily
comparison using synthetic values; the payload file shows the default all-metric
examples. The eight
wire payload examples are [SANDBOX_PAYLOADS.json](SANDBOX_PAYLOADS.json).

## 5. Database review and execution plan — NOT EXECUTED remotely

An isolated test DB is mandatory. Fresh DB bootstrap needs the complete ordered
existing migration chain, because 0049 adds indexes on existing app tables and
references users. Push-specific drafts are **0049_push_notifications.sql** and
**0050_push_delivery_safety.sql**; 0048 remains reserved, do not invent it.

0049 creates notification preferences/devices/events/deliveries/receipts/consumed
keys/snapshots/rate limits and indexes existing source tables. 0050 alters only
push tables, adds account/category/period uniqueness and durable per-device
outcomes, and reclassifies legacy sent rows. Running these on production would
change production schema/data; neither is authorized there.

Ordered future steps, each gated by approval:

1. Approve a new named sandbox DB and KV namespace. Record their IDs and compare
   them against production IDs; reject any match. Create a private working copy
   of the example configuration. No production bindings, routes or cron.
2. Review all SQL in order. Bootstrap only that empty isolated database using the
   full migration directory. Future command shape, **do not run now**:
   `npx wrangler d1 migrations apply <APPROVED_ISOLATED_DB> --remote --config <PRIVATE_SANDBOX_CONFIG>`.
   Confirm CLI shows the exact approved database/environment before proceeding.
3. Through separately approved isolated-DB setup, create
   `push_sandbox_identity(id TEXT PRIMARY KEY CHECK(id='isolated'), run_id TEXT NOT NULL)`
   and insert the sole `isolated` row with the approved run ID. Do not add this
   sentinel to shared production migrations.
4. Seed one synthetic account/session and the approved fixture data. Do not copy
   production tables or tokens. Start with both global gates false and send unarmed.
5. Inspect schema/indexes: `push_one_period` enforces atomic per-user/category/local
   period uniqueness; receipts identify APNs acceptances only. Device outcomes
   separately record accepted, rejected, retry, exhausted, unknown, cancelled,
   HTTP status/reason/APNs ID. Delivery status rolls up accepted/partial/failed;
   failure alone is not proof APNs never accepted an ambiguous request.
6. Verify all isolation negative tests and fixture navigation in that environment
   while unarmed. Registration happens only after a separately approved install
   and permission choice; privately pin its sandbox token hash afterward.
7. Approve activation only for the stated run, account, installation UUID, pinned
   token, categories and attempt budget. Do not add scheduled triggers.

There are no supplied down migrations. 0050's status changes cannot be losslessly
inverted without prior data. Prefer backup/restore of the isolated DB or a new
empty test instance under separate approval. Do not drop tables, erase data, or
attempt an improvised rollback against production.

## 6. Eight-category test matrix

All settings persist locally on change; signed-in Save synchronizes to the test
backend. Test relaunch persistence, failed-sync dirty-copy preservation and
account separation. Native default timezone is the device IANA zone.

| Category | Default and customization | Fixture destination / expected content |
|---|---|---|
| Major News | Major only; major/all/off | News article `sandbox-news`; labeled major title and synthetic story body |
| New DMV Entries | Instant; instant/daily/off | `/dmv`; 2 synthetic entries, one batch |
| Cybercab Daily | On, 08:00 local; four metrics, comparison/time | `/?daily=2026-10-24`; 1/2/3/4, previous complete Chicago day dataset |
| New Cybercabs | Off; instant/daily/off | Synthetic vehicle detail; one public Cybercab |
| Sightings | Off; instant/daily/off | Synthetic public photo viewer, then existing vehicle/Replay flows |
| Camera Detections | Off; instant/daily/off | `/heatmap?city=austin`; existing Zones Heatmap |
| Community Interactions | Signed-in comments/replies/mentions/likes on independently | Synthetic post; generic preview, no names/private text; fixture uses comments |
| Weekly Fleet Recap | Off; Sunday 09:00 when enabled; day/time/metrics | Seven dated snapshots through Oct 24; sums 7/14/21/28 |

The fixed Community fixture exercises comments. Independently inspect and persist
replies, mentions and likes controls; their backend eligibility is covered locally.
Additional physical subtype fixtures require separate reviewed additions/approval.

Enable off-by-default categories only for the approved test account. Master on,
quiet off, group on, Standard are defaults; optional quiet window 22:00–07:00,
major bypass off. App quiet hours suppress every fixture except major News with
bypass explicitly on. Bypass cannot override Focus or OS notification settings.
Grouping uses category thread IDs; app Group Similar controls event aggregation,
while OS notification grouping remains controlled by iOS. All fixtures use one
stable run/category key; accepted duplicates cannot be resent. Test backend
reduced-frequency spacing and complete daily aggregation with synthetic local
scheduler tests rather than asserting that manual sends implement those modes.

## 7. Future single-iPhone procedure — DO NOT EXECUTE YET

1. Approve the device, account, backend/resource IDs, build fingerprint, run ID,
   fixture set, send budget and observation window. Record existing app/permission
   state. No uninstall, reset, data deletion, or permission reset is part of this plan.
2. Finish the signing/backend/fixture prerequisites above while sends remain
   unarmed. Verify signed development entitlement, compiled API pin, sandbox
   registration environment and 22/10/42 Siri metadata.
3. With separate installation approval, install the reviewed development build
   on the single approved iPhone. Launch signed out, inspect defaults, change and
   restore local preferences, relaunch. Confirm no token row or Community send
   while signed out. No automatic permission prompt should appear.
4. Sign into the isolated test account. Separately approve pressing Allow and the
   desired system choice. If OS state is already determined, record it; do not
   try to manufacture a first-use prompt by deleting/resetting anything.
5. **Denied path:** choose Don't Allow only when separately approved and a genuine
   prompt is available. Verify Disabled UI, no accepted registration, no sends.
   To subsequently grant, obtain explicit approval for the Settings change.
   If permission changes remain prohibited, mark the alternate state untested.
   Provisional is not requested by this app; do not force it via private APIs.
6. **Granted path:** approve Allow, verify callback and `sandbox` registration
   in only the isolated DB. Confirm account, installation UUID, current token hash,
   authorization and freshness privately; never paste the raw token into reports.
   Leave unarmed if any mismatch or additional production binding appears.
7. Get explicit **real APNs send approval** for the exact run/fixture budget. Set
   only the isolated `SANDBOX_SEND_ARMED=true` and approval secret under that
   approval. Global production and global sandbox delivery switches remain false.
   Future request shape (private values; not run here):
   `POST https://<APPROVED_TEST_HOST>/__sandbox/send`,
   `Authorization: Bearer <TEST_SESSION>`,
   `X-Sandbox-Approval: <PRIVATE_APPROVAL_SECRET>`, JSON `{"fixture":"news"}`.
8. Send one approved fixture while app foregrounded. Expect APNs acceptance record
   but no foreground banner/sound (`willPresent=[]`). Record in-app state separately
   from APNs acceptance and actual display; do not change unrelated foreground UX.
9. Background/lock the device with explicit permission to operate it. Use the next
   approved fixture to check Lock Screen and Notification Center. Record Focus,
   Scheduled Summary and preview settings as observed, not silently changed.
   Do not infer failed backend delivery solely from a hidden banner.
10. Tap each approved category in background and cold-launch conditions. Verify the
    isolated synthetic destination and no production API traffic. Exercise gallery
    photo/vehicle/Replay and News presentation. Inspect exact report dates/counts.
    No nearby-sighting/camera feature should appear.
11. Verify grouping with an approved additional run only if multiple same-category
    alerts are needed. Keep category threads distinct. Repeating the same accepted
    run/category must not send another request. Check preference changes suppress
    disabled categories/master, quiet hours, and major-only bypass. Restore test
    settings afterward; do not change OS permissions without separate approval.
12. Sign out and verify DELETE/server token cleanup before another send. Verify
    signed-out/local preferences and no Community delivery. Re-sign-in/token refresh
    requires account validation and pin reapproval before further sending. Observe
    existing cleanup behavior; do not force token rotation or reinstall the app.
13. Negative APNs cases (429/503, bad tokens, permanent rejection, exhausted retries,
    ambiguous timeout) use mocked transport locally. Do not send fabricated tokens
    to Apple to manufacture failures. If a genuine failure occurs, inspect durable
    status/reason and stop according to policy: permanent no retry; temporary bounded
    delay; unknown never automatically resend; accepted target never retried.
14. Disarm sandbox sends, revoke its approval secret under the approved cleanup
    procedure, inspect isolated queues/outcomes and retain a redacted audit record.
    Verify global delivery gates and production configuration remain off/unchanged.
    No further run, deploy, permission step or rollout is implied.

Real iPhone + approved Apple/backend setup is required to validate this app's
actual development token issuance/renewal, entitlement/profile agreement, APNs
transport end to end, Lock Screen/Notification Center/Focus behavior, background
and terminated-app taps, and physical-device cleanup. Simulator payload injection
can exercise routing but is not proof of those properties. Pure scheduling,
aggregation, preferences, auth checks and mocked APNs failure classification do
not require a physical device.

## 8. Remaining simulator checks

- **Gallery → Replay passed** in the existing `SightingsAccountUITests` scenario:
  gallery/count, public viewer, native vehicle detail, Dallas/order controls, and
  Replay play control. Screenshot: `../verification/physical-device-preparation/gallery-replay.png`.
- **News presentation visually confirmed.** The automated StaticText assertion
  failed, but the exported screenshot visibly shows “Synthetic News Article” in
  the native browser at 127.0.0.1. The fixture server recorded both the news lookup
  and article request. Treat browser routing/rendering as visually verified and
  the accessibility assertion as failed, not a fully passing automated test.
  Screenshot: `../verification/physical-device-preparation/news-rendered.png`.
- **Bypass/report-control interaction remains unresolved in automation.** The
  initial combined test could not locate the dynamically shown bypass switch.
  A separate retry also could not locate the quiet-hours switch through its
  accessibility query. Report metrics/time-picker checks were retried separately;
  the report retry also failed to locate the comparison switch. No time-picker
  interaction was verified. Final disposition is in the simulator evidence summary. Do not count
  these as passing or infer a shipping app defect from selector failures.
- The runtime still emits SDK build `invalidDigitCount(94232)` and duplicate
  WebKit/WebCore accessibility-class warnings. These are simulator/tooling
  observations, not proof of the exact cause of the selector failure. No new
  app defect was demonstrated and no shipping UI fix was made. A manual review
  of bypass/report controls is required before arming physical sends.

Full local run artifacts:
`/private/tmp/cch-apns-preparation/remaining-ui.xcresult`, `remaining-ui.log`,
`controls-retry.xcresult`, and `controls-retry.log`. The first run has one passing
scenario and two failed automated scenarios (including the visually confirmed
News case). See the [final per-test summary](../verification/physical-device-preparation/simulator-results.txt).

UI attempts use only the existing isolated temporary app and localhost synthetic
server, with outbound server fetch blocked. No simulator reset/erase, permission
change, uninstall, or production request is permitted. Temporary XCTest additions
are outside the repository and restore toggled settings; no shipping UI source
was changed. Runner/OS failures must not be labeled as demonstrated app defects.

## 9. Risks, rollback and approval boundary

- A development test build sharing the production bundle ID can replace an
  existing app on the chosen phone. Review this before installation; this stage
  does not authorize it or any restore/uninstall/data deletion.
- Shared Apple App ID capability changes and dual-environment signing keys need
  owner review. Sandbox URL/allowlists are enforced independently of key scope.
- Isolated binding/compiled API misconfiguration is a hard stop. Fail closed;
  never substitute the production database, sessions, token list or API.
- APNs acceptance is not proof of delivery. Unknown transport outcomes may omit
  an alert under conservative duplicate prevention. Keep that distinction in logs.
- Local tests do not establish deployed CPU/D1/HTTP2 performance or device UX.
- Rollback begins by disarming the isolated sender and stopping manual requests.
  Preserve isolated evidence. Revert only the private sandbox config/build under
  approval. Do not change production or drop data as an automatic rollback.

Separate explicit approvals are required for: Apple team access/capability/profile
changes; use or creation of credentials; isolated resource creation and remote
migrations; backend deployment/routing/secret configuration; reviewed physical
installation; each planned permission/settings action; arming and the exact APNs
send budget/run/device/account; additional runs/token repinning; and any cleanup
that changes remote resources/device state. None was requested or executed here.

Preparation stops here. Production rollout requires its own later review and
approval after successful physical-device testing.

## 10. Local preparation file inventory

Added `worker/push-sandbox.js`, `tests/push-sandbox.test.mjs`,
`docs/notifications/wrangler.sandbox.example.jsonc`,
`docs/notifications/SANDBOX_PAYLOADS.json`, this plan and evidence files.
Updated only the notification README to link this plan. Existing production
entry point/configuration, migrations, shipping Swift, Siri and unrelated app
features were not changed in this preparation pass. Final sandbox tests were
rerun after fixture refinements; the remaining website suites were unchanged.
