# Backend outage — October 10, 2026

## Confirmed cause

Live production `wrangler tail` and a direct remote D1 table query both return:

```text
D1_ERROR: Your account has exceeded D1's free tier daily row read limit.
Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.
```

The remote API reports code 7500. A trivial `SELECT 1 AS reachable` succeeds
with zero rows read; it is insufficient to prove table reads work.

Production database `cybercabhunter-db` exists and its ID is
`1873d232-f799-4a4c-915a-615df4556841`. The active production version
`3869f4fa-e68c-4db4-941e-5aaae7f75a07` uses that exact D1 binding and production
KV/R2. No binding mismatch was found. Database size is reported as 1,646,592
bytes. Actual content and migration records cannot yet be audited because
table reads are quota-blocked; no conclusion of data loss is warranted.

## Captured production stacks

At 6:25:58 PM CT, `/api/sightings` throws the quota error above:

```text
at D1DatabaseSessionAlwaysPrimary._sendOrThrow (cloudflare-internal:d1-api:193:19)
at async cloudflare-internal:d1-api:474:19
at async Object.getPublicPhotoSightings (index.js:1236:16)
at async Promise.all (index 1)
at async apiListPublicSightings (index.js:11389:43)
at async Object.fetch (index.js:15262:23)
```

At 6:26:10 PM CT, `/api/me` throws the same error:

```text
at D1DatabaseSessionAlwaysPrimary._sendOrThrow (cloudflare-internal:d1-api:193:19)
at async cloudflare-internal:d1-api:417:19
at async Object.apiMe (index.js:2640:16)
at async Object.fetch (index.js:15054:23)
```

Vehicle listings also throw the same error from `getPublicRobotaxiVehicles`.
News returns its existing `news_unavailable` JSON. An actual Google callback
stack has not been captured; its unguarded identity lookup reads D1, so the
quota explains a plausible failure point but is not a captured OAuth stack.

## Deployment correlation

The last ten deployments occur at 4:25:59, 4:26:09, 4:33:03, 4:33:05,
4:43:48, 4:44:06, 4:54:36, 4:54:46, 5:14:54 and 5:15:09 PM CT.
Local commits in that window change logos, favicons and yellow accents.
Lifetime counters were committed at 3:29 PM and their combined request/backfill
at 3:54 PM. The deployment list alone does not map versions to git commits.
Quota exhaustion is directly established; a migration or deploy causing it is
not established. Progressive disappearance can result from cached responses
expiring while uncached reads fail, but this is an inference.

## Prepared fix and checks

The outer Worker fetch handler now awaits the complete router and catches
asynchronous rejections, including handlers returned without `await`. D1
exceptions return uncached 503 JSON; other exceptions return uncached 500 JSON.
CORS is preserved. Logs contain method/path/dependency only, never OAuth query
parameters or tokens. Existing endpoint-specific error responses remain valid.

New regression coverage: `tests/worker-errors.test.mjs`. All seven targeted files
pass: Worker errors, Google auth, registry stats, lifetime counters, moderation
API, homepage stats and sightings stats, including valid zero rendering.
These local OAuth checks mock Google; they are not live Google acceptance.

Isolated preview:
https://backend-recovery-cybercabhunter.contactjoeclos.workers.dev

Version: `b5c38241-e427-41ba-b759-612a81968e6f`.
Preview has separate lifetime-preview D1, KV and R2 bindings. Live preview
`/api/sightings` returns 503 `database_unavailable`, not 1101, during quota
exhaustion. Registry stats returns its existing uncached 503 `stats_unavailable`.
Unauthenticated moderation correctly returns 401. Account-wide quota prevents
successful live data acceptance on preview as well as production.

## Remaining acceptance before production

1. Restore account D1 read availability: approved paid-plan upgrade, or daily
   reset at midnight UTC (7:00 PM CT October 10).
2. Read production migration records, counters, and aggregate content counts.
   Verify 0034/0035 and the sighting submitted around 6:19 PM without approving it.
3. Configure a Google-registered preview redirect URI and preview frontend URL.
   Current preview config redirects Google callbacks to production, so it cannot
   prove isolated end-to-end sign-in. Use a real authorized Google login and an
   authorized moderator account to check preview queue loading.
4. Verify preview sightings/news/home stats/fleet/DMV responses and rendering.
5. Deploy from production config, never deploy the isolated preview bindings.
6. Recheck full Google login, authorized moderation, all feeds and homepage
   widgets directly on production.

Production has not been changed. No billing upgrade or data migration was made.

## Later verification after the 7 PM CT reset

Production table reads and retained public APIs recovered. Migrations 0034/0035
are recorded and the three counter rows return 95 Cybercabs, 7 rides and 287
lifetime sightings. No production data write or rollout was performed.

The registered preview Google URI is configured and the real Google flow now
completes, including a signed-in account and successful landing-page reload.
An authenticated preview moderator queue check passed; the temporary preview
role was restored. Preview Daily and retained APIs are healthy. The dominant
calendar queries were removed, with a cheap Daily-only replacement and one
additive DMV index rehearsed on a backed-up preview database. See the current
calendar-removal/read-budget report in `../d1-read-budget/README.md` for metrics,
tests, backup details and the pending morning production rollout.
