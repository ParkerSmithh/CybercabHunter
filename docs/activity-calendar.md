# Cybercab Daily / Activity Calendar

Homepage placement: immediately after `#serviceBanner`. Entry link: `/calendar`.
The existing desktop, mobile and footer navigation are unchanged. The calendar
reuses the homepage header, account/sighting drawers, footer, Inter font and
shared styles; its feature styles are isolated in `css/activity.css`.

## API

- `GET /api/activity?year=2026`: one year's aggregates, coverage, source errors,
  available years and the current America/Chicago date.
- `GET /api/activity?date=2026-10-10`: the same daily accounting, plus public
  vehicle links, recent approved photo identifiers and camera highlights.

Both use `worker/activity.js`. The frontend refreshes at the site's five-minute
cadence while visible, immediately on a Central date rollover and when returning
to a stale tab. Successful responses are edge/browser cached for 60 seconds;
partial failures are not cached. Selecting a category performs no request;
selecting a year performs one; selecting a day performs one highlight request.
SQL groups timestamped events by UTC hour, then uses the existing DST-aware
`usLocalParts` helper to combine them into Central dates. Timestamp bounds use
the source's native format so the camera observed_at index remains usable.

## Counting and coverage

- Registry: publicly eligible Cybercabs, using the existing eligibility helper.
  Known Model Ys are excluded even when they have legacy approval metadata.
  Rows sharing a normalized plate or VIN are counted at their earliest eligible
  registry creation date, with an ID tie breaker. No private vehicle is exposed.
- Sightings: existing approved public photo predicate, with additional exclusion
  of observations linked to private/ineligible vehicles. Occurrence timestamps
  decide the day. Photo retention means older counts are not reconstructible;
  days before the retained coverage window are null, not zero. Newly submitted
  backdated sightings can support a highlight without establishing complete
  historical coverage. This feature does not change photo retention/privacy.
- Cameras: actual camera_detections timestamps. The existing camera/time unique
  constraint prevents retried captures from being counted twice.
- DMV: non-baseline VINs first observed on successful snapshot days, split by
  Cybercab/Model Y. These are observation dates, never official registration
  dates. The initial baseline, failed/missing polls and approximate imported
  historical counts cannot establish daily additions and are unavailable.
- For registry/cameras/sightings, coverage begins with the earliest available
  qualifying record. A successfully queried empty source establishes zero only
  for today; it does not invent historical collection coverage.
- Future days and source failures are null. Current approved/public status is
  respected when queries run; totals may change after moderation.

Combined scores equal the mean of available categories' log-scaled counts,
normalized against each category's positive-day 90th percentile for the selected
year and capped at 100. Partial days are visibly dashed and labeled. Category
colors use positive-day quantiles. Averages exclude unavailable/future days.

## Verification

Run `node tests/activity.test.mjs`. It exercises the real migrations/SQLite SQL,
privacy, deduplication, model exclusions, DST boundaries, baseline exclusion,
unavailable states, validation, matching daily/year totals, homepage placement,
navigation and jsdom filtering/day interactions. Relevant existing regression
suites: homepage-stats, txdmv, public-sightings.

For visual review, `node tests/activity.test.mjs --serve` starts a localhost-only
fixture server on port 8787. `/review` embeds the actual calendar at 390px and
1100px widths. Fixtures and the API override exist only in this test server and
are never included in public assets or production Worker code.

Cloudflare serves `/calendar` directly from `public/calendar.html` through its
existing static asset handling. Verified locally with Wrangler: HTTP 200 and the
calendar page title/body. No schema migration or new scheduled job is required.

Deployment uses the existing project deployment command. This implementation
has been built locally and has not been deployed to production.
