# Production calendar-removal rollout

Branch `fix/remove-activity-calendar` was pushed and fast-forward merged into
`main`; main was pushed at commit `6c02a30` (implementation `16682d7`).
The owner's subsequent explicit deploy instruction superseded the earlier
morning timing. D1 was healthy; no data deletion was performed.

Before migration, the full production database was exported to
`/private/tmp/cch-production-before-calendar-rollout-2026-10-10.sql` with
restricted permissions. The 1,224,321-byte backup successfully restored all
31 tables in an in-memory SQLite database. SHA256:
`d7fac29545a412f6520f6d5b4c000a5a5d09b04528d2c4aa32daac6e1372f1ae`.
This covers every shared calendar source table; no calendar-exclusive tables
exist. Backup contents remain outside the repository.

Only `0036_daily_dmv_index.sql` was pending. Wrangler applied it successfully
before deployment; the subsequent migration list reports none pending.
Focused Daily, Worker-error and preview-auth tests all passed (three files).
The earlier full-suite baseline failures are documented in README.md.

Manual production deployment completed at `2026-10-11T00:43:04.026Z`
(October 10, 7:43:04 PM CT), version
`379c5589-2d9b-4436-8468-f0ab2b796502`. A subsequent deployment appeared at
`00:43:34.750Z`, version `7d907ded-f1e8-45f5-9970-0ae5c7ee86b9`;
this verification did not initiate that second deployment. Use that latest
timestamp for any continuous-version observation window.

## Acceptance observed directly in production

- Calendar URLs and `/api/activity`: clean 404.
- Homepage: replacement daily.js, no calendar link.
- `/api/daily`: 200, no source errors, counts **20 / 0 / 20 / 20**.
- Actual Brave homepage reload: all four Daily counts render, including +0;
  headline counters are 95 / 7 / 287. Fleet chart and DMV widget render data.
- Sightings/news APIs and pages, registry stats, homepage stats, fleet stats
  and DMV API: 200. See production-rollout-api-checks.json.
- Authenticated production moderation: news stories load; vehicle queue
  reports no sightings waiting for review and registry results load.
  No moderation actions or permission changes were made.
- A fresh Google sign-in reached the account chooser with the correct
  production callback. Browser activity interrupted completion verification;
  a completed fresh callback is not claimed. Existing authentication worked.
- Brief Worker tail: eight captured events, all outcome ok, zero exceptions.
  This does not establish a full first-hour result.
- No public HTML/JS/XML calendar-route or old-API references remain.

Post-migration read-only benchmark: registry 194, approved-photo aggregate
620, first camera date 1, camera range 27, DMV snapshot coverage 3, DMV
additions **1**: **846 rows per cold response**. Cache hits make no source
queries. Raw metadata: daily-production-postmigration-reads.json.

The full first-hour and first-24-hour analytics checks remain pending their
elapsed windows. Approximately 1.95M reads/day is still a projection.
No unattended follow-up or deployment schedule was installed.
