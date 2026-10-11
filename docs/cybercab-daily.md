# Cybercab Daily

The branded four-stat briefing remains on the homepage immediately below the
service-status banner. It shows new Cybercabs, DMV additions, approved photo
sightings and camera detections for the current Central date, with yesterday's
comparison when that source has coverage.

`GET /api/daily` returns `today`, `generated_at`, `timezone`, `day`, `previous`
and source-specific `errors`. It cannot request a year or historical highlights.
Successful responses are cached for five minutes under one key per origin and
Central date. Query-string variants cannot bypass this cache. Partial failures
remain uncached and unavailable sources are null, never manufactured zeros.

`worker/daily.js` reuses the shared public eligibility and photo predicates.
Registry rows are read once; a linear pass preserves the briefing's earliest
eligible VIN/plate accounting. There are no correlated duplicate-identity SQL
queries. Sightings use one aggregate; camera queries use the existing date
index. Additive migration `0036_daily_dmv_index.sql` gives DMV additions a
partial date/model index that excludes baseline roster rows. No source records
are removed or rewritten by this migration.

The homepage loads `public/js/daily.js` and `public/css/daily.css`. The script
uses the same-origin `/api/daily`, refreshes every five minutes while visible,
refreshes immediately on a Central date rollover, and supports retry after
failure. Test with `node tests/daily.test.mjs`.

The Activity calendar page, annual/historical API implementation, highlights,
dialogs, category filters and year controls were removed. `/calendar`,
`/calendar.html` and `/api/activity` return 404 without querying D1.
All registry, trip, submission, sighting, camera and DMV tables remain intact.
