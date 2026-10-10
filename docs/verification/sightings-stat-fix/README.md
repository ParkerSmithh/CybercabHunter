# Homepage sightings counter rendering — October 10, 2026

## Diagnosis

The monotonic change was already deployed. The homepage v8 script read
`sightings_all_time` from `/api/sightings?limit=1`, independently of the other two
headline cards. Missing/invalid fields were ignored and left the initial dash.
The city Sightings Activity section uses a different endpoint, so it could remain
healthy when the headline request failed or returned an old payload.

At diagnosis, both live API hosts returned an integer 151; the D1 counter row
existed with value 151. No current database failure or missing row was found.
The reported browser state was not reproducible from current served responses.
A pre-deployment response missing `sightings_all_time` was observed during the
previous rollout's first verification; a stale response is a plausible cause,
not a proven explanation of the user's particular browser session.

Production aggregate audit: 280 approved human submissions and one independent
camera capture; the persistent event ledger contains 281 approved events. The
151 baseline had reflected the live photo gallery, omitting expired approved
sightings and the camera capture.

## Fix

All three homepage figures now use `/api/registry/stats?lifetime=1` in one response.
The endpoint explicitly includes three integer counters, uses `no-store`, and
the frontend also requests `cache: 'no-store'`. The query and v9 script asset avoid
reusing old response/asset variants. Successful zero values render as `0`; real
request failures retain the last good totals instead of being presented as zero.
Missing counter rows already use the existing create-as-zero behavior.

Migration 0035 increases the sightings counter to the persistent approved-event
ledger count, using MAX so it never decreases. The ledger retains deleted events
and does not double count human sightings copied onto the camera map. No content
rows, feeds, map markers, or window statistics are changed or restored. Events
whose records were removed before the first lifetime migration cannot be recovered.

## Preview acceptance

https://sightings-fix-cybercabhunter.contactjoeclos.workers.dev

Preview version: `460359aa-5845-4c2f-bc0d-9d595861d96b`.
Uses the dedicated lifetime-preview D1 and isolated preview KV/R2 resources.
Applied only migration 0035 using Wrangler migrations after backup.

Served HTML/JavaScript rendered through JSDOM against the real preview APIs:

- Before approval: all three cards render `1 / 1 / 3`.
- Approve a new synthetic photo: all three render `1 / 1 / 4`.
- Delete the photo through the moderator endpoint: still `1 / 1 / 4`;
  the live photo gallery is empty.
- Exactly one uncached request supplies the three headline cards.

Local regression tests delete the sightings counter row, verify it is recreated
as zero, and verify all three cards render `0` while the gallery endpoint is
unavailable. Tests also cover historical/deleted-event backfill and preserving
an existing counter higher than the ledger count.

Seven targeted test files pass. Full suite: 71 passed, six failed; the failures
are the previously documented camera-sighting-approval, community, mobile-density,
motion, site-layout and ui-effects files. `git diff --check` passes.

Production rollout: inspect pending migrations, back up D1, apply only 0035, then
deploy and verify the live counters and rendered strip. Based on the aggregate
audit, the new sightings baseline is 281; vehicles remain 94 and rides remain 6.
