# Lifetime homepage counters — October 10, 2026

Implemented on `fix/lifetime-site-stats`. Production database and production
traffic were not changed. The branch has not been merged.

## Counting and backfill

`0034_site_stat_counters.sql` seeds the current headline queries during migration.
The public production APIs read before implementation returned **94 vehicles,
6 rides, 151 sightings**; none of these constants appear in the migration.
The existing homepage's sightings source actually counts the live photo gallery,
not camera detections. Its baseline is preserved exactly. Existing approved
submissions and standalone camera captures are remembered in the event ledger
without inflating that baseline. After migration, newly approved human sightings
and new independent camera captures increment the same lifetime total.

Counters use atomic SQLite triggers within the content write transaction. Event
identities survive deletions and reversals. A human sighting's map copy is not a
second event. Independent camera identities use `(camera_id, observed_at)`, so
retries with a different UUID still count once after deletion. Vehicle eligibility
and accepted, non-superseded physical ride counting retain the existing public
registry rules. A per-trip ledger prevents receipt edits from counting again,
and physical ride identities deduplicate different riders' receipts.

There are no deletion triggers and no ledger foreign keys into live content.
Missing counter rows are created as integer zero; CHECK constraints reject null,
negative and fractional values.

## Display audit

- Homepage: existing registry API fields now read the counters; existing sightings
  API adds `sightings_all_time`. The homepage reads that field directly. Card
  design and `All cities · live` label are preserved. Script asset versions bumped.
- Sightings: `All time · all cities` uses the global lifetime counter. Toolbar
  count, grid, today, last seven days, month, peak hour and best day remain live.
- Zones (`infrastructure.html`): summaries use `/api/fleet-stats?city=…`, representing
  each city's current fleet and fares, not these global headline totals. They and
  the live map markers remain unchanged.
- Community and Fleet ROI already consume `/api/registry/stats`, so their shared
  registry figure now uses the counter too. Fleet ROI's explanatory copy identifies
  the lifetime count. No city-specific model or fare statistics changed.

## Preview deployment

Final preview:
https://lifetime-stats-cybercabhunter.contactjoeclos.workers.dev

Worker version: `1da57681-50f9-49a5-a987-67179fc6d42c`.

Isolated bindings:

- D1: `cybercabhunter-lifetime-preview`, `4aabd82c-e86d-4a6b-925b-77de2c5d1f5b`.
- KV: preview namespace `2a443ef29b2a40ec83e46cf0fccd6557`.
- Evidence R2: `cybercabhunter-evidence-preview`.
- News thumbnails R2: `cybercabhunter-news-thumbs-preview`.

All 34 migrations applied using Wrangler migrations on the newly created empty
D1. The local ignored `wrangler.preview.jsonc` retains these isolated bindings.
An initial rehearsal used the existing news-preview database after backup;
its tracker lacked 0032/0033 despite the schema/config being applied. Full column
schema comparison through 0033 and configuration checks confirmed both migrations
before their preview tracker entries were reconciled. The final rehearsal uses
the dedicated lifetime database and does not depend on that reconciliation.

Verified through the deployed API with disposable synthetic data:

1. Pending photo: zero change. Approval: sightings +1. Re-approval: existing 409
   `already_reviewed` response, with no increment.
2. Delete approved photo: live gallery and month count return zero; lifetime stays.
3. Approve vehicle: vehicles +1. Record accepted ride: rides +1.
4. Independent camera: sightings +1. Delete and retry same camera/time under a new
   UUID: no additional increment. Delete the retry: totals remain unchanged.
5. Delete registry vehicle through moderator API: vehicle and ride rows disappear,
   both counters remain unchanged.
6. Served HTML/JavaScript rendered in JSDOM on two fresh loads: exact counters
   **1 / 1 / 2**, dash placeholders until data arrives, no intermediate old live
   counts. A native browser was unavailable in this environment.

Synthetic live records and test session were cleaned up. Lifetime test events
remain in the dedicated preview counters by design. No production migration,
production deployment, or merge was performed.

## Validation

- Nine targeted test files passed: lifetime counters, registry stats, homepage
  stats, sightings stats, vehicle registry, sightings gallery, camera sightings,
  moderator ride logging, and account deletion.
- Full suite: **71 passed, 6 failed**. A separate clean HEAD archive baseline had
  **69 passed, 7 failed**. All six remaining failures also occur at unchanged HEAD:
  camera-sighting-approval, community, mobile-density, motion, site-layout and
  ui-effects. The registry-stats file's pre-existing markup inspection failure was
  corrected by limiting its assertion to the actual stats section.
- Calculator tests passed. `git diff --check` passed.

Production rollout order remains: inspect pending migration list, back up D1,
apply only the intended migration, then deploy. No historic deleted content can
be reconstructed from this migration; the lifetime baseline begins from current
live counts, as requested.
