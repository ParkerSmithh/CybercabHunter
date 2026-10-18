# Social data-budget fixes: measurements (branch `claude/social-data-budget`)

**Basis:** the read-only audit in `docs/social-audit-2026-10-15.md`.
**Rules this branch had to follow:** no migration, no new public endpoint, no change to sign-in or sessions, and no change to who can see what.

## How these numbers were measured

- **Engine.** Every figure comes from Cloudflare's local D1 engine (Miniflare, via wrangler's `getPlatformProxy`). It reports `rows_read` per query the same way production meters it. These are measurements, not estimates.
- **Code.** The real Worker code ran in both cases:
  - **Before:** `main` at `e023871`, from a worktree.
  - **After:** this branch.
- **Data.** A deterministic seed: 300 riders, 400 vehicles (300 public with 2 counted rides each), and 300 / 1,000 / 3,000 posts. Of the posts, 20 % have photos and 30 % have ride reviews.
- **Re-running it:**
  ```
  node tests/budget/social-reads.mjs --repo=<checkout> --json=out.json
  ```
  Raw results: `before.json`, `after.json` (in this folder).
- **Column meanings:**
  - **Per view** is a normal request.
  - **Refresh** is the rare request that recomputes a stored result.
- **Same output.** The leaderboard JSON for all 6 boards is byte-identical before and after on the seeded data (checked with `--boards`).

## Measured rows read per request

| Path | Posts | Before: every request (on a cache miss) | After: per view | After: one refresh |
|---|---:|---:|---:|---:|
| 1. Sidebar (stats, Trending, announcement) | 300 | 1,000 | **12** | 1,013 |
| | 1,000 | 3,326 | **12** | 3,336 |
| | 3,000 | 9,971 | **12** | 9,984 |
| 2. For You, first page (signed out / in) | 300 | 346 / 347 | **56 / 49** | 350 |
| | 1,000 | 344 / 345 | **46 / 47** | 348 |
| | 3,000 | 343 / 344 | **45 / 46** | 347 |
| 2b. Photos, Most popular | 300 / 1,000 / 3,000 | 135 / 275 / 375 | **77** | 139 / 279 / 379 |
| 3. Top Contributors (`/api/community/leaderboard`) | any | 16,961 | **1** | **12,429** (was 16,961: the discovery-credit calculation now runs once, not twice) |
| 4. Cybercab search (`?q=xvf12` / empty) | any | 700 / 1,300 | **33 / 33** | 1,335 |
| *Latest, for reference (unchanged)* | 300 / 1,000 / 3,000 | 66 / 61 / 61 | 66 / 61 / 61 | — |

The For You per-view cost is now about the same as Latest's. Most of it is reading the 10 posts that are shown (author, rank, vehicle, review, photos, liked, saved).

## How each path is bounded now

All four use one mechanism, `worker/summary-cache.js`:

- **One stored row per result.** The result lives in a row of the existing `community_summary` table (the daily summary the other tabs already use). There is no migration.
- **A page view reads that one row** and never runs the aggregation.
- **Refresh budget.** Each stored result records what it cost, and stays fresh for `cost / dailyRows` of a day, clamped to a minimum and maximum. So a key's refreshes read at most about `max(dailyRows, cost)` rows a day, however busy the site is.
- **No stampede.**
  - A stale row is claimed with a compare-and-swap on `computed_at`: one request recomputes while the others keep serving the previous value.
  - A missing row is claimed with an insert; the losers wait for the winner.
  - Within one Worker isolate, concurrent callers share one computation.
- **Warm-up.** The daily cron refreshes the sidebar and leaderboard if they are stale.

| Path | Per view (fixed) | Lifetime of the stored result: min / max / daily budget |
|---|---|---|
| 1. Sidebar | the stored row + the announcement + ≤ 5 trending posts by id | 10 min / 24 h / 1,000 rows |
| 2. For You | the stored ranking + ≤ 20 posts newer than it (index range) + the 10 posts shown | 2 min / 6 h / 1,500 rows |
| 2b. Most popular (Photos, Reviews) | same | 2 min / 24 h / 300 rows each |
| 3. Leaderboard / Top Contributors | the stored figures (plus the existing 5-minute edge cache) | 5 min / 24 h / 1,500 rows |
| 4. Cybercab search | the stored index + ≤ 8 matches re-read by primary key | 15 min / 24 h / 600 rows |

## Projected worst-case daily totals (caches in place)

**Refreshes.** These don't depend on traffic: at most about one per stored result per day at this size, often less.

| Stored result | 300 posts | 1,000 posts | 3,000 posts |
|---|---:|---:|---:|
| Sidebar | 1,013 | 3,336 | 9,984 |
| For You ranking | ≤ 1,500 | ≤ 1,500 | ≤ 1,500 |
| Photos + Reviews Most popular | ≤ 600 | ≤ 600 | ~760 |
| Leaderboard | 12,429 | 12,429 | 12,429 |
| Vehicle index | 1,335 | 1,335 | 1,335 |
| **Refresh total** | **~16,900** | **~19,200** | **~26,000** |

**Page views.** A Social tab load reads about 60 rows: about 12 for the sidebar (also edge-cached 2 min), about 50 for For You, and 1 for the leaderboard (also edge-cached 5 min). So:

| Social tab loads per day | Rows from views |
|---:|---:|
| 100 | about 6,000 |
| 400 | about 24,000 |
| 1,000 | about 60,000 |

Signed-out visitors and riders hitting the edge caches cost less.

**Before, for comparison:**
- Every cache miss cost about 1,000–10,000 rows (sidebar), 17,000 (leaderboard) and about 345 (For You, never cached).
- The edge caches allowed up to about 720 and 288 misses per data centre per day.

So a busy day could reach millions of rows: the Oct 10 pattern.

## Where the 5,000-row target is NOT met, and the tradeoffs

Every path is now bounded and the totals sit under the 50,000-row hard limit at these sizes. But **the 5,000-row target is not met**, for three reasons. None can be fixed without a visible change or work outside this brief, so the owner needs to choose:

1. **Leaderboard: about 12,400 rows a day, from one refresh.** One recompute of the standings costs about 12,400 rows on this data. Under any budget that therefore means at most about one refresh a day.

   **Visible change:** standings (new rides and discoveries) update about once a day, not within 5 minutes. Privacy changes stay immediate (see below).

   Options:
   - (a) Keep daily (as built).
   - (b) Refresh every 2–3 days: about 4–6k/day, with staler standings.
   - (c) Make the aggregation itself cheaper. That needs indexes on the ride and sighting tables (a migration, out of scope here) or per-rider counters kept up to date as rides and sightings are approved. **Recommended follow-up.**

2. **Sidebar counts grow with posts.** Each refresh costs about 3.3 rows per post, about once a day at scale, so about 50,000/day at 15,000 posts.

   **Visible change:** the Posts, Contributors, This week and Ride reviews tiles update when the stored figures refresh. That's every 10 minutes while small, slowing to daily at scale (it was 2 minutes before).

   Option: exact running counters updated when posts are created, deleted or removed, which would make refreshes nearly free.

3. **Per-view cost of showing posts: about 50 rows.** This is the price of loading the 10 posts on screen. It's unchanged in kind, and equal to Latest's.

   Option: cache the first page for signed-out visitors at the edge for about 60 seconds. **Policy change:** a post a moderator removes could then stay visible to signed-out visitors for up to 60 seconds. That needs the owner's yes.

Other visible effects of the stored results:

- **For You:** a new post appears at once, because posts newer than the ranking are merged in. Reordering as posts gain likes follows within the ranking's lifetime (2 minutes while small, up to 6 hours at scale).
- **Most popular:** reordering follows within up to 24 hours. New posts appear at once.
- **Cybercab search:**
  - Partial matches for a car made public since the last refresh (≤ 24 h) wait for the next refresh.
  - The car's **full plate or ID** finds it at once (an indexed lookup).
  - **VIN-only** search of a brand-new car waits for the refresh: there's no VIN index, and adding one would be a migration.

## Privacy and moderation: unchanged and immediate (tested)

- **Removed or deleted posts** leave the feed, For You and Trending at once. Stored rankings and trending lists hold ids only, and each view re-checks the posts live by primary key.
- **A rider who turns their public profile off** leaves every board at once. The stored figures are edited in place by `leaderboardRiderChanged`. A new display name, username or photo also shows at once.
- **A deleted account** is removed at once, and the next view recomputes so its discovery credit moves to the next rider.
- **A vehicle made private** is never shown in the Cybercab search. Search matches are re-read live by primary key with the public rule.
- **Untouched:** the Anonymous rule, photo location-stripping and hide-on-delete. There are no new endpoints, no sign-in or session changes, and no migration. Stored values are server-side only.

## Tests

- **`tests/summary-cache.test.mjs` (new, 26 checks).** It covers:
  - stored values served within their lifetime;
  - one recompute when expired;
  - no stampede on concurrent refreshes or first misses;
  - a failed refresh serving the old value;
  - lifetimes derived from cost;
  - privacy and moderation staying immediate;
  - new posts and cars still showing.
- **Existing suites pass:**

  | Suite | Result |
  |---|---|
  | `tests/social.test.mjs` | 77/77 |
  | `tests/social-v2.test.mjs` | 100/100 |
  | `tests/community.test.mjs` | 96/96 |
  | `tests/account-delete.test.mjs` | 47/47 |
  | `tests/e2e/social-browser.mjs` (real Chromium) | 98/98 |

- **Three tests were updated.** They read results right after changing data and now expire the stored copy first, as its lifetime would: the leaderboard checks in `community.test.mjs`, the sidebar check in `social.test.mjs`, and 2 browser checks.
- **Full suite (89 files):** the only failures are 8 checks in 4 files. All of them fail identically on `main`: mobile-density 4, motion 1, ui-effects 2, moderation-gmail-tab 1.

## Preview URL: not available from this session

- This environment has no Cloudflare credentials, and its network policy blocks Cloudflare, so no preview could be deployed or checked here.
- **Caution:** `wrangler.jsonc` binds only the production D1 database. A branch preview built from it as-is would read (and write `community_summary` rows to) **production**. The Oct 10 preview used separate preview-only bindings (`docs/verification/d1-read-budget/README.md`), and that configuration is not in the repo.
- **To preview safely:** deploy with those preview bindings from the owner's machine, for example `npx wrangler versions upload --preview-alias social-data-budget` with a config pointing at the preview D1, KV and R2. Then check the alias URL on a phone.

## Addendum: 60-second edge cache for signed-out feed page 1 (owner-approved)

### What's cached

- **Cached:** page 1 of the feed for requests with **no session** (no `Authorization: Bearer` header). There is one shared copy per feed (filter, sort, page size) in each Cloudflare data centre's cache, kept for 60 seconds.
- **Never cached:**
  - anyone with a session;
  - later pages (with a cursor);
  - Saved.

  Moderation stays immediate for signed-in visitors.
- **The browser always receives `Cache-Control: private, no-store`.** So a visitor who then signs in never sees a stale signed-out page from their own browser.
- **The cache key holds only filter, sort and page size**, so unknown URL parameters can't bypass it.

**Accepted tradeoff:** a post a moderator removes can stay visible to signed-out visitors for up to 60 seconds.

### Measured rows read

The same harness, with `--edge=1` simulating one data centre's cache, and the same seeded data. "Before" is commit `648e760`; "after" is this change. Raw data: `edge-before.json` and `edge-after.json`.

| Signed-out page-1 view, within 60 s of the last miss | 300 posts | 1,000 posts | 3,000 posts |
|---|---:|---:|---:|
| For You: before | 48 | 46 | 45 |
| For You: **after** | **0** | **0** | **0** |
| Latest: before / **after** | 66 / **0** | 61 / **0** | 61 / **0** |
| Photos newest: before / **after** | 86 / **0** | 86 / **0** | 86 / **0** |
| Photos, Most popular: before / **after** | 77 / **0** | 77 / **0** | 77 / **0** |
| Signed-in views (For You / Latest): unchanged | 49 / 67 | 47 / 62 | 46 / 62 |

**Cost of a miss.** A miss (the first signed-out view per feed per data centre per minute) costs the same as before: about 45–86 rows, plus the stored ranking's refresh when that is due.

**Worst case per day.** Signed-out page-1 reads are at most `min(signed-out views, 1,440) × ~50` per feed and sort per data centre. In practice it is one miss per active minute rather than one per view: at 400 signed-out views a day it's at most about 20,000 rows, versus about 400 × 50 = 20,000 before. At busier traffic, the 1,440 misses a day per feed per data centre cap it, however many views there are.

### Tests

`tests/summary-cache.test.mjs` §4 (9 checks) covers:
- served from the edge with 0 database reads;
- `no-store` sent to the browser;
- junk parameters sharing the same copy;
- a removed post staying for signed-out visitors up to 60 s and gone after;
- signed-in, cursor pages and Saved never cached.
