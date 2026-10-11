# Cybercab Daily endpoint verification

Checked October 10, 2026, approximately 7:41 PM CT. Production has not yet
deployed the calendar-removal branch.

The live homepage loads `js/activity.js?v=6`. That script explicitly calls
`https://cybercabhunter.contactjoeclos.workers.dev/api/activity?year=2026`
for its Daily panel. The exact endpoint returned HTTP 200, no source errors,
and today's registry/DMV/sightings/camera values were **20 / 0 / 20 / 20**.
The script treats zero as numeric. This confirms the current production data
path, not a post-rollout browser-render acceptance result.

The replacement homepage on commit `16682d7` loads `public/js/daily.js`, whose
exact fetch is same-origin `/api/daily`. `worker/index.js` registers that GET
route and `worker/daily.js` implements it. The current production `/api/daily`
404 is therefore an undeployed replacement route, not a missing endpoint
used by the current production homepage. No repair to that route is needed
before rollout based on this evidence.

## Replacement query benchmark against current production data

Read-only benchmark at `2026-10-11T00:41:06.508Z`; this executes replacement
code against production D1, not through an already deployed replacement API.
All six queries succeeded, with no writes or source errors.

| Stat/query | Rows read |
| --- | ---: |
| Eligible registry rows | 194 |
| Approved-photo aggregate | 620 |
| First camera date | 1 |
| Two-day camera range | 27 |
| DMV snapshot coverage | 3 |
| Two-day DMV additions, before production migration 0036 | 740 |
| Total per uncached response | 1,585 |

Raw SQL and D1 metadata are in `daily-production-predeploy-2026-10-10.json`.
The preview's same-fixture DMV comparison was 744 reads before the additive
partial index versus 2 after it. Production has not applied that index yet;
its post-migration cost must be measured rather than claimed as actual.
Successful replacement responses are cached for five minutes; cache hits
execute no source queries.

The expensive calendar's correlated SQL VIN/plate comparisons are gone.
However, the replacement is **not exclusively simple daily COUNT queries**:
registry fetches eligible history once and uses linear in-memory VIN/plate
sets to preserve earliest-entry accounting; sightings aggregates the approved
photo window; camera coverage and DMV coverage use auxiliary reads. At current
size the measured costs are modest, but claiming no identity deduplication at
all would be incorrect. No further optimization was performed.

Post-deployment production acceptance is **pending**, not pass or fail: confirm
the live homepage loads `daily.js`, `/api/daily` returns four numeric day values
without source errors, and the actual browser panel renders them. Repeat this
benchmark after production migration 0036 to capture actual indexed DMV cost.
