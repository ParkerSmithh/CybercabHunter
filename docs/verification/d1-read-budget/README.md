# Calendar removal and D1 read budget — October 10, 2026

Branch: `fix/remove-activity-calendar`.

## Measurement before changes

Sources: Wrangler production D1 insights (rolling last 24 hours), D1 database
info and account GraphQL analytics. Raw SQL groups, aggregate metrics and exact
removed-query attribution are attached in this directory. Insight strings omit
bound parameter values. These are measured totals, not guesses based on returned
row counts.

| Top query | Reads in last 24h | Executions | Average reads |
| --- | ---: | ---: | ---: |
| Activity registry hourly buckets, with duplicate checks | 1,754,979 | 97 | 18,092 |
| Activity first registry date, with duplicate checks | 1,329,679 | 92 | 14,453 |
| Sightings hourly buckets by city | 272,492 | 448 | 608 |
| Sightings feed by city | 252,865 | 417 | 606 |
| Sightings count by city | 197,590 | 372 | 531 |

The top 100 groups total 4,946,380 reads. All measured news SQL groups total
82,365, including ingest, feeds and diagnostics; news was not the dominant
driver. Production database info reports 5,156,816 reads in its rolling 24-hour
window. The account-wide UTC-day guardrail later reports 5,184,854, including
24,013 preview reads; time windows and capture timestamps differ.

Exact matching of the old Activity handler's SQL to insights attributes
**3,299,762 reads** to seven calendar/shared-Daily query groups. This includes
the two dominant registry queries plus historical sighting, camera and DMV
aggregation. It is a lower bound if additional query groups fall outside the
top 100 or historical-detail variants were used.

## Overlap identified before deletion

Cybercab Daily is the homepage's four-stat briefing, not a separate page.
It originally fetched a whole year through the same `worker/activity.js` and
`public/js/activity.js` as the calendar. Its shared stats renderer, source
predicates, identity accounting, date rollover and styling were preserved in
Daily-only replacements. The calendar link and its grid column were removed.

| Shared table | Other consumers retained |
| --- | --- |
| `robotaxi_vehicles` | Registry, fleet/homepage stats, moderation, rides |
| `trips` | Ride history, ingestion, fleet stats, vehicle eligibility |
| `submissions` | Submission flow, receipts, moderation, public photos |
| `vehicle_observations` | Sightings feed/photos, moderation, registry sightings |
| `camera_detections` | Zones map, Replay, camera history, homepage activity |
| `dmv_snapshots` | DMV widget and registration API |
| `dmv_av_vehicles` | DMV widget, VIN matching and roster history |

**Calendar-exclusive tables: none.** Calendar removal deletes no source table
or content row, and production has received no data writes or migration. Original
feature code is preserved in Git at the branch base `34da243` and additionally
archived at `/tmp/cch-calendar-code-backup-2026-10-10.tar.gz`. No backup was
represented as a data export, and no Time Travel availability was assumed.

Before the additional preview-only index migration, the full preview D1 was
exported to `/private/tmp/cch-preview-before-daily-index-2026-10-10.sql` (34,809
bytes, mode 0600). Its SQL was restored successfully in local SQLite: 31 tables.
SHA-256: `32379149b8d84e22e1cfa8749ac7ea0492647fefa62d5dec474879898712bfad`.
This is the actual data backup; a production backup remains required before
the morning additive-index migration.

## Resulting implementation

- Removed page, annual queries, first-date queries, historical highlights,
  tooltip/dialog/filter/year UI, shared calendar assets and documentation.
- Explicit 404 tombstones prevent old calendar/API URLs reaching D1.
- New `/api/daily` returns only today/yesterday. Registry records are read
  once and deduplicated in memory; no vehicle-by-vehicle SQL comparisons remain.
- Daily keeps existing public eligibility, photo retention and privacy rules,
  Model Y exclusions, earliest eligible identities, Central time/DST, missing
  coverage, successful zeros, comparison notes and refresh/retry behavior.
- Daily alone uses a five-minute normalized cache. Other features' SQL and
  cache policies are retained. The superseded calendar indexes and broad cache
  changes were discarded. Only a small additive DMV partial index remains:
  production's initial Daily query read all 740 baseline rows for zero additions;
  the new index excludes baseline records. It has been applied only to preview.
- The Worker outer fetch error boundary prevents escaping asynchronous route
  errors from producing 1101. Logs exclude tokens and OAuth query parameters.
- `scripts/d1-read-budget.mjs` checks account UTC-day analytics without reading
  D1 tables. It logs a warning at 3M reads. Tested against the exhausted account.
  Run with `--watch` for a 10-minute monitor or `--top` for production's top five
  rolling query groups. This is a CLI monitor; no persistent host scheduler or
  new Worker analytics secret was installed.

## Preview and tests

https://backend-recovery-cybercabhunter.contactjoeclos.workers.dev

Version: `620e34aa-17e7-4647-abba-d98bc1ddffb5`.
Separate lifetime-preview D1/KV/R2 bindings. Google callback and frontend URL
both point to this alias, using the registered preview callback URI.

Served preview homepage returns 200 and contains Daily and its new assets.
`/calendar` and `/api/activity?year=2026` return 404. No calendar link, asset
reference or feature client remains anywhere in public assets. There is no
existing sitemap file to update. A real browser displayed Daily's partial-source
error state during quota exhaustion. After reset, the live preview homepage
rendered all four numbers: **+0 / +2 / 0 / 0**, with no unavailable-source error.
The DMV fixture has 740 clearly synthetic baseline rows and two new rows plus
two snapshots. These are preview QA data, not production DMV records.

New Daily tests cover accounting/privacy, chained VIN/plate duplicates,
same-time ID ties, private/model exclusions, baseline/missing coverage, DST,
midnight rollover, retry, date-keyed cache normalization, zero additional D1
queries on a cache hit, source failures and removed routes. A separate old/new
parity run matches counts across 120 registry and 120 sighting records.

Full suite: **74 passing files, 3 failing files**. The failures
(`mobile-density`, `motion`, `ui-effects`) were rerun on an untouched `git archive
HEAD` checkout and fail identically. They are pre-existing expectations about
unrelated Community/Simulation/Zones/Replay UI. `git diff --check` passes.

Daily was visually reviewed at 390px and 1100px together using the actual
preview response and the preview's source assets. One clipped comparison-note
issue was fixed by placing notes in the metric's normal layout flow, then
confirmed in both widths. The standalone preview homepage was also inspected.
Preview-only sign-in links, session validation and moderation calls now use the
preview origin via the shared runtime's `apiOrigin`; production keeps its
existing API host. The same origin setting fixes the retained registry, fleet,
account and receipt clients on preview. Regression tests cover the callback
fragment handoff, authorized queue and both origin choices. The fleet chart's
real preview registry response also renders a zero-series SVG in a DOM test
without an error; its request is confirmed to use the isolated preview origin.

The real Google browser flow completed using the registered callback: account
chooser, provider redirect, D1 identity, KV session, fragment handoff, signed-in
account menu and successful landing-page reload. A temporary moderator role
was set only on the signed-in preview account for the read-only queue check;
the queue loaded empty without an error. The original ordinary-user role was
restored immediately afterward. No sightings were approved or rejected.

All retained preview public APIs return 200. Production retained public APIs
also return 200 after quota reset, without a rollout. Direct production reads
confirm migrations 0034/0035 and counter values **95 / 7 / 287**. The count of
pending sightings submitted since 6 PM CT was zero at the audit; this work did
not approve any production submission. See `api-acceptance.json`.

## Projection and remaining acceptance

Measured production total minus removed query groups is approximately
**1,857,054 reads/day before replacement Daily queries**. This is a projection
using one rolling baseline, not a measured after-deployment day. A read-only
benchmark was run: `node scripts/measure-daily-reads.mjs wrangler.jsonc`.
It records D1 `meta.rows_read` for Daily's six queries without logging query
result rows or VINs. Initial production cold cost is **1,581 reads** across six
queries, including **740** DMV reads. An existing date-index hint did not reduce
those baseline reads, so it was removed. On the identical 742-row preview
fixture, an old table scan costs **744 reads**, while the new partial-index query
costs **2** and returns the same two groups. Actual `EXPLAIN QUERY PLAN` reports
`SEARCH ... USING INDEX idx_dmv_daily_new_date_model`.

Use the production costs for the other five queries and conservatively budget
two DMV reads: **843 reads per cold Daily response**. Budget 108 cold responses
per day (the largest measured Activity source execution count), without assuming
any five-minute cache savings:

`5,156,816 - 3,299,762 + 108 × 843 = 1,948,098 projected reads/day`.

This is approximately **1.95M/day**, below the 2M target and leaving about 3.05M
below the free cap. Production still lacks the new index, so this is a measured
component-cost projection, not a claimed post-deployment production result.
It assumes comparable traffic/data and must be checked over a normal UTC day.
Other consumers may also benefit from the DMV index; no such savings are counted.
**Broader quota optimization can be deprioritized** pending that observation.

| Projected remaining top queries | Baseline/projected reads/day |
| --- | ---: |
| Sightings hourly buckets by city | 272,492 |
| Sightings feed by city | 252,865 |
| Sightings count by city | 197,590 |
| Public registry list | 130,978 |
| New Daily sightings aggregate (617 × 108) | 66,636 |

These are baseline-based projections; an actual new top-five list requires the
morning rollout and a fresh traffic window. Raw before/after query metrics,
plans and the calculation are attached in this directory.

Production is unchanged. Per the requested workflow, deploy in a healthy
**morning CT** window:

1. Confirm production is healthy and `wrangler d1 migrations list
   cybercabhunter_db --remote` lists only `0036_daily_dmv_index.sql`.
2. Export production D1 outside the repository, protect the backup and verify
   restore before migration, as required by `docs/deployment-and-migrations.md`.
3. Apply the single additive migration through `wrangler d1 migrations apply
   cybercabhunter_db --remote` and confirm nothing remains pending.
4. Deploy using `npx wrangler deploy -c wrangler.jsonc`, then verify Daily,
   removed URLs, Google sign-in, moderation, sightings/news, homepage stats,
   fleet chart and DMV widget.

No D1 content deletion is required. Never
promote a version carrying preview bindings directly into production.

Collect account analytics and top query groups after a normal UTC traffic day.
If projected or measured traffic still exceeds the 5M cap, report the remaining
drivers and let the owner choose further optimization or Workers Paid.
