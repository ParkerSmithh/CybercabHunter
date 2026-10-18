# Social tab audit: planned vs. implemented

- **Date of audit:** 2026-10-18 (requested as the 2026-10-15 audit).
- **Code audited:** `main` at `e023871` (Oct 17, 2026).
- **Kind of audit:** read-only. No code was changed, no migration was run, and the production database was not touched.

## How this audit was done

- **Code.** Every verdict below cites the code on `main`. The Social tab lives at `/community` (the SOCIAL tab, the default one). There is no `/social` route.
- **Tests run for this audit.** All on local, in-memory databases; nothing touches production.

  | Test file | Result |
  |---|---|
  | `tests/social.test.mjs` | 76/76 |
  | `tests/social-v2.test.mjs` | 100/100 |
  | `tests/reviews.test.mjs` | 87/87 |
  | `tests/e2e/social-browser.mjs` (real Chromium against the real Worker code) | 98/98 |

- **Git history.** Social shipped in three commits on 2026-10-15:

  | Commit | Time (UTC) | What it added |
  |---|---|---|
  | `9b9977b` | 18:42 | First version: posts, photos, likes, comments, reports. The Cybercab picker was a plain plate dropdown. |
  | `0183d56` | 19:10 | Cybercab search and card, share links, Saved, notifications, pins, ranks in Top Contributors. |
  | `8bb7078` | 19:48 | Stable sort row, live character counter, browser tests. |

  Later commits on `main` touching Social: `62abea0` (a Moderation "Social" tab with `GET /api/moderation/social/overview`) and `03f6b8f` (share and SEO tags).

**About the live read.** The live-read findings match `9b9977b` exactly: a plate dropdown, and no share, bookmark, bell or pin. So the live read almost certainly saw the site before `0183d56` deployed. Where the live read and the code disagree, this audit trusts the code and the browser tests.

**What can't be confirmed from code.** Production has zero Social posts (confirmed by read-only queries on Oct 15: `social_posts = 0`, `cybercab_reviews = 0`). So no path that needs real posts or comments has been seen working on production. Those paths are verified only by the automated tests above. Confirming them on production needs a real post (or an approved seed post) and two real accounts.

**One reference file was not found.** `claude-prompt-community-reviews.txt` is not in the repo. The privacy rule was audited against the rule the old Reviews section used, `publicPerson()` in `worker/reviews.js:70-79`. The Social code reuses that same function.

---

## 1. Attach Cybercab to Post: FULLY IMPLEMENTED

**Evidence**
- **Search endpoint:** `GET /api/social/vehicles?q=` at `worker/social.js:960-983`, routed at `worker/index.js:534`.
  - It matches plate (normalized, partial), VIN (partial, any case) and the vehicle id (prefix).
  - It returns public registry vehicles only (`ELIGIBLE_V`, `worker/social.js:88`), at most 8.
- **Picker in the composer:**
  - Search box: `public/community.html:312`; toolbar button "Attach Cybercab": `public/community.html:331`.
  - Debounced search: `public/js/social.js:797` and `:825` (200 ms).
  - Selecting and the preview card with Change / Remove: `public/js/social.js:806`.
- **Published card:** `vehicleCardHtml` at `public/js/social.js:220`. It is a link to `/vehicle/<id>` and shows plate, VIN, city, id and a generic Cybercab image.
- **Server side:**
  - Vehicle JSON: `worker/social.js:147` (`vehicleJson`).
  - Check that the vehicle is public when posting: `readPostForm`, `worker/social.js:382`.
  - Card dropped if the vehicle later becomes non-public: `worker/social.js:182`.
- **Tests:** `tests/social-v2.test.mjs` §1; `tests/e2e/social-browser.mjs` §4 (search by plate and by VIN, publish, card, click through to the vehicle page, change, remove).

**Notes**
- The registry has no separate "vehicle number" field. The searchable identifier is the vehicle's id, the one in its `/vehicle/<id>` link. Searching by an informal "car number" would need a new registry field.
- The live read's "plain plate dropdown" is the pre-`0183d56` version.

## 2. Social Feed Filters: FULLY IMPLEMENTED

**Evidence**
- **Tabs:** For You, Latest, Photos, Reviews and Saved at `public/community.html:349-353`.
- **Server:** `apiSocialFeed`, `worker/social.js:223-289`.
  - The filter is applied at `:238`: Photos means `has_photos = 1`, Reviews means `has_review = 1`.
  - The For You ranking is at `:269-279`.
- **Front end:** `setFilter`, `public/js/social.js:349`.
- **Tests:** `tests/social-v2.test.mjs` §5; `tests/e2e/social-browser.mjs` §1 and §9.

**Notes**
- Reviews includes posts copied from the old Reviews section.
- Content behaviour is verified only on test data; production has no posts.

## 3. Comments & Replies: FULLY IMPLEMENTED

**Evidence**
- **Creating:** `apiCreateSocialComment`, `worker/social.js:659-692`. `parent_id` is accepted at `:670-677`; replies are one level deep, so a reply to a reply joins the same thread (`:674`).
- **Listing:** `apiListSocialComments`, `worker/social.js:634-657`, 10 top-level comments per page plus their replies.
- **Page:**
  - Reply button: `public/js/social.js:391`; reply form sending `parent_id`: `:635`.
  - Edit and delete on your own comments: `onCommentAction`, `:590`. Server: `worker/social.js:693`, `:710`.
- **Tests:** `tests/social.test.mjs` §3; `tests/e2e/social-browser.mjs` §5 (two accounts).

**Notes**
- Never exercised on production, which has no comments.

## 4. User Ranks & XP beside usernames: FULLY IMPLEMENTED

**Evidence**
- **Server:** `authorJson`, `worker/social.js:136-142`. It adds `rank` (Bronze to Diamond Spotter) and `level` from `user_xp` using the existing `rankFor` and `levelFor` (`worker/progression-levels.js`).
- **Page:**
  - Post headers: `public/js/social.js:240` (`rankHtml`, defined at `:112`).
  - Comments and replies: `:401`.
  - Top Contributors: `:1118`.
- **Tests:** `tests/e2e/social-browser.mjs` §3 and §5.

**Notes**
- Anonymous (private) authors get no rank or level, by design: `worker/social.js:138`.
- "Not beside usernames in the feed" in the live read reflects the empty feed.
- "Not in Top Contributors" in the live read reflects the pre-`0183d56` version.

## 5. Trending Discussions: FULLY IMPLEMENTED

**Evidence**
- **Server:** `apiSocialSidebar`, `worker/social.js:793-827`. The trending query is at `:803-805`.
  - Scope: posts from the last 7 days with at least one like or comment.
  - Ranking: likes + 2 × comments; top 5.
- **Page:** the `#socialTrending` list at `public/community.html:383`, filled by `loadSidebar`, `public/js/social.js:1070`.

**Notes**
- See the data-budget section: the sidebar's queries run live, with a 2-minute edge cache.

## 6. Top Contributors: FULLY IMPLEMENTED

**Evidence**
- **Page:** `#socialTop` at `public/community.html:387`, filled by `loadTop`, `public/js/social.js:1108-1123`. It shows the top 5 with name, avatar, Spotter rank, level and points, plus a "Full leaderboard" link.
- **Data:** the existing `GET /api/community/leaderboard`, `worker/community.js:262`, edge-cached for 5 minutes (`:48`).

**Notes**
- The ranking is the leaderboard's **Top Overall** board (discoveries and rides), not a Social-activity ranking.
- Riders with the public-profile switch off are excluded entirely (`worker/community.js:141`).
- A public rider without a display name or username appears as "Spotter" with no link. This is the "S Spotter" entry, and it is intended.

## 7. Community Statistics: FULLY IMPLEMENTED

**Evidence**
- **Tiles:** Posts, Contributors, Posts this week and Ride reviews (average rating) at `public/community.html:173-188`.
- **Data:** `apiSocialSidebar`, `worker/social.js:800-802`; filled at `public/js/social.js:1078` onwards.

**Notes**
- These are live counts, not a precompute (see the data-budget section).

## 8. Shareable Post Links: FULLY IMPLEMENTED

**Evidence**
- **Link on every post:** `url: /community?post=<id>` at `worker/social.js:196`.
- **Share button:** in every post's action row (`public/js/social.js:251`) and "Copy link" in the ⋯ menu (`:186-196`).
  - `sharePost` (`:478-485`) uses `navigator.share` where available and falls back to `copyLink` (`:472`).
- **Opening a link directly:** `openSingle`, `public/js/social.js:1030`. A deleted post shows "This post isn't available" (`:1027`).
- **Link previews:**
  - The Worker runs first for `/community` only: `wrangler.jsonc:11`; route at `worker/index.js:677`.
  - `socialPostMeta` (`worker/social.js:1136`) fills in the Open Graph and Twitter tags for public posts.
- **Tests:** `tests/e2e/social-browser.mjs` §6 (copied link opened signed out). Preview text: `tests/social-v2.test.mjs` §7.

**Notes**
- The live read's "no share affordance" is the pre-`0183d56` version.
- The phone share sheet, and the preview rewriting itself, only run in a real phone browser and on Cloudflare respectively. Neither has been tested in either place.

## 9. Post Editing & Deletion (including attached reviews): FULLY IMPLEMENTED

**Evidence**
- **Editing (author only):** `apiUpdateSocialPost`, `worker/social.js:456-493`.
  - Keeps photos, vehicle and review unless the author changes them.
  - The review can be removed: `:477`, `:485`.
- **Deleting (author):** `deletePostCompletely`, `worker/social.js:495-519`. It removes comments, likes, saves, notifications, photos and their stored files, and the review (plus the original old review, if the post was copied from one).
- **Permissions:**
  - `can_edit` / `can_delete` flags: `worker/social.js:192-193`.
  - Server refusal: 403 at `:548`.
- **Menu:** `menuHtml`, `public/js/social.js:186-196`. Edit form: `startEdit`, `:923`.
- **Tests:** `tests/social-v2.test.mjs` §6; `tests/e2e/social-browser.mjs` §4–§6.

## 10. Feed Sorting: FULLY IMPLEMENTED

**Evidence**
- **Control:** a Newest / Most popular choice at `public/community.html:359-362`; `renderSortBar` at `public/js/social.js:370`.
- **Where it applies:** `SORTABLE = ['photos','reviews','saved']` at `:178`. The choice is kept across filters and remembered in the browser.
- **Server:** the sort is chosen at `worker/social.js:226-229`.
  - Most popular is a time-decayed engagement score, `postScore` (`:211`), over the newest 300 posts (`RANKED_WINDOW`, `:71`).
- **Tests:** `tests/e2e/social-browser.mjs` §1 (12 posts with different ages and likes, pagination, remembered choice).

**Notes**
- For You (ranked) and Latest (newest) are orders in themselves, so they show a one-line note instead of the choice.
- Before `8bb7078` the choice appeared only on Photos and Reviews; this is why the earlier audit called it intermittent.

## 11. Saved Posts: FULLY IMPLEMENTED

**Evidence**
- **Table:** `social_saves` (rider, post, saved at; primary key on the pair), `migrations/0045_social_saves_notifications_pins.sql:17`.
- **Saving:** `PUT` / `DELETE /api/social/posts/:id/save` at `worker/social.js:830`.
- **Saved feed:** `worker/social.js:234` and `:241-265`; it requires sign-in.
- **Page:** bookmark button at `public/js/social.js:252` (`savePost`, `:486`); Saved tab at `public/community.html:353`; empty message at `public/js/social.js:294`.
- **Tests:** `tests/social-v2.test.mjs` §2; `tests/e2e/social-browser.mjs` §5.

**Notes**
- Saves are private, never duplicated, notify nobody and award no XP.

## 12. Social Notifications: FULLY IMPLEMENTED

**Evidence**
- **Table:** `social_notifications`, `migrations/0045…:26`. `dedupe_key` is UNIQUE, and rows are deleted automatically with their post or comment.
- **When they're created:**
  - Comment or reply: `worker/social.js:682-685`, inside `apiCreateSocialComment`.
  - Like: inside `apiSetSocialLike`, `:593`.
  - @mention: `mentionNotices`, `:579`; `mentionedHandles`, `:559`.
  - Announcement (only when a moderator ticks "notify"): `announcementNotice`, `:875`.
- **Reading:** list and unread count at `:899`; mark read at `:931`.
- **Bell:**
  - Markup: `public/community.html:121`.
  - Unread count, polled every 3 minutes while the page is visible: `public/js/social.js:1135`, `:1198`.
  - Panel: `loadNotes`, `:1151`.
- **Tests:** `tests/social-v2.test.mjs` §3; `tests/e2e/social-browser.mjs` §5 (two accounts, read status, no self-notification, no duplicates, privacy).

**Notes**
- **Placement.** The bell lives in the Community page toolbar, not in the site-wide header. Riders see their count only on `/community`. If the plan meant site-wide, that part is missing.
- **Likes notify too.** The plan's list didn't include likes, so the owner may want to turn that off if it feels noisy.

## 13. Pinned Posts: PARTIALLY IMPLEMENTED

**Evidence (community pins, implemented)**
- **Server:** `PUT` / `DELETE /api/social/posts/:id/pin`, `worker/social.js:844`.
  - Moderators only, at most 3 pins (`MAX_PINS`, `:74`), and each pin is logged.
  - Pinned posts lead For You and Latest without repeating below: `:237-238`, `:281-286`.
- **Database:** `pinned_at` / `pinned_by` columns, `migrations/0045…:48-49`.
- **Page:** "Pinned" label at `public/js/social.js:235`; Pin / Unpin in the ⋯ menu.
- **Moderation:** the moderation Social tab lists pins (`worker/social.js:1036`).

**What's missing (profile pins)**
- Riders cannot pin one of their own posts to their public profile.
- Public profiles do exist (`/rider/<handle>`, `apiGetRiderProfile` at `worker/community.js:281`), but they have no post history: only discoveries, rides and recent reviews.
- Profile pins need a post history on the profile first. Nothing for this is in the code.

---

## Privacy and moderation guards

| Guard | Status | Evidence | Notes |
|---|---|---|---|
| Private accounts show as "Anonymous" with the default avatar | FULLY IMPLEMENTED | `worker/reviews.js:70-79` (`publicPerson`: no name, username, photo or rank when the public-profile switch is off); used by `authorJson`, `worker/social.js:136-142` (posts, comments) and the notifications (`:919`); default avatar at `public/js/social.js:105` | Same rule as the old Reviews section. Moderators see the real name in the reports queue (`worker/social.js:1024`), by design. Tested in `tests/social.test.mjs` §3 and `tests/social-v2.test.mjs` §3. |
| Site owner can remove any post | PARTIAL (guard gap) | `worker/social.js:537-552`, `:526-535` | A moderator (`users.role = 'moderator'`, `:95`) can remove anyone's post. Removal **hides it** (status `removed`, logged in `social_mod_actions`); it does not erase it. The post, its photos and its files stay in the database and storage, readable by moderators only (`:770-791`). **Gap:** no permanent delete exists for other people's content. A privacy takedown needs a hard-delete path. |
| Site owner can remove any comment | PARTIAL (guard gap) | `worker/social.js:725`, `:734-742` | Same: hidden and logged, not erased. |
| Site owner can remove any review | PARTIAL (guard gap) | Reviews are attachments to posts, so they go when the post is removed. The old review write routes now answer 410 (`worker/index.js:500`). | Same hide-not-erase caveat. |
| Photo uploads have location (EXIF/GPS) data removed | FULLY IMPLEMENTED | **Server:** `readPhotos`, `worker/social.js:361-373`, identifies the real file type (`sniffImage`) and calls `stripMetadata` (`worker/avatars.js:82` onwards). It removes JPEG metadata segments (APP1–APP15, comments), PNG `tEXt`/`zTXt`/`iTXt`/`eXIf`/`tIME`, and WebP `EXIF`/`XMP `. **Browser:** the composer also redraws each photo on a canvas before upload (`public/js/social.js:851`), which drops all metadata. | Tested: `tests/social.test.mjs` §2; `tests/e2e/social-browser.mjs` §3 (stored file contains no `GPS`/`Exif`). |
| No XP for social actions | FULLY IMPLEMENTED | No XP code in `worker/social.js` (header rule at `:29-31`) | Tests check that the XP ledger stays empty. |

---

## Data-budget audit (limit 50,000 D1 rows read per day; target under 5,000)

**How the estimates work.** Today production has 0 posts, so actual reads are near zero. The rows-read figures below are estimates from the queries and indexes, not measurements, using these sizes:

| Symbol | Meaning |
|---|---|
| **N** | shown posts |
| **W** | posts from the last 7 days |
| **R** | ride reviews |
| **V** | registry vehicles |
| **U** | a rider's unread notifications |

**About the 2-minute and 5-minute caches.** They use Cloudflare's per-data-centre cache (`caches.default`). This works on `cybercabhunter.com` but does nothing on the `workers.dev` address. Recomputes happen at most once per cache period per data centre, and only when there is traffic.

| # | Path (when it runs) | How it loads | Where | Rows per request (est.) | Verdict |
|---|---|---|---|---|---|
| 1 | **Stats tiles + Trending + announcement**: `GET /api/social/sidebar`, on every Social tab view | **Live counts over all shown posts** (posts and contributors, the week's posts, reviews and their average, trending), cached 120 s | `worker/social.js:800-805` | about N + 2W + 2R | **⚠ BUDGET RISK as posts grow.** Fine at today's scale (0 posts). At ~1,000 posts and ~200 recomputes a day, about 200k+ rows a day. Fix: precompute into `community_summary` (the daily cron used by the other tabs, `worker/community-summary.js`), or keep running counters. Trending can stay live: it only reads the last week. |
| 2 | **For You** (the default feed): `GET /api/social/feed?filter=foryou`, on every Social tab view | **Reads the newest 300 posts** (index range, `LIMIT 300`), ranks them in code. Not cached (each rider's view is personal) | `worker/social.js:269-279` | min(N, 300) + about 40 for the 10 posts shown | **⚠ BUDGET RISK once posts pass a few hundred.** About 300 rows per view; 200 views a day is about 60k. Fix: a stored score column with an index, or a shared cached ranked list (e.g. 5-minute cache of the ranked ids), or a smaller window (50–100). |
| 3 | **Photos / Reviews / Saved, Most popular** | Same 300-post window | `worker/social.js:241-249`, `:269-279` | min(N, 300) | **⚠ Medium.** Only when someone picks Most popular; same fixes as #2. |
| 4 | **Latest; Photos / Reviews / Saved, Newest; pinned posts** | Index range, `LIMIT 11`; pins come from a small index (≤ 3) | `worker/social.js:250-268` (query at `:264`), `:281-285`; indexes `migrations/0044_social.sql:37-39`, `0045…:50` | about 11–50 | OK. |
| 5 | **Single post + comments** | By id; 10 top-level comments + replies | `worker/social.js:291`, `:634-657` | about 20–60 | OK. |
| 6 | **Bell count**: `GET /api/social/notifications?count_only=1`, every 3 min per **visible** signed-in Community tab | Index on (rider, read); counts unread (capped at 100), joined to post, vehicle and comment | `worker/social.js:892-905`; poll at `public/js/social.js:1198` (skipped while the tab is hidden, `:1136`) | about 3U (at most about 300) + 2 | **OK–Medium.** Small for typical unread counts. Watch for riders who leave the tab open with many unread. A lighter option: store the unread count on a per-rider row. |
| 7 | **Notification list**: when the bell is opened | `LIMIT 30` + joins | `worker/social.js:907-911` | about 120 | OK. |
| 8 | **Cybercab search**: each paused keystroke in the picker | **Scans every vehicle**: substring matching can't use an index, and the public check runs a lookup on trips per vehicle. 60 s browser cache only | `worker/social.js:960-983` | about 3V (about 500–1,000 at today's registry size) | **⚠ Medium.** Only while attaching a car; a 4-search attach is about 2–4k rows. Fix: cache the public plate/VIN/id list (e.g. 5–10 min at the edge, or in `community_summary`) and filter that. |
| 9 | **Top Contributors**: `GET /api/community/leaderboard`, loaded with the Social tab | **Live totals over every rider's discoveries, rides and XP**, cached 5 min | `worker/community.js:117-145`, `:262-277` | users + trips + submissions + vehicles (thousands) | **⚠ BUDGET RISK (this existed before Social).** Social now calls it on every Social tab view, not only on the Leaderboard tab. Fix: precompute the boards daily (or hourly) into `community_summary`. |
| 10 | **Other tabs' tiles** (sightings, streaks, XP) | **Precomputed daily**, one row read | `worker/community-summary.js:126-133` | 1 | OK (the model to follow). |
| 11 | **Moderation Social tab overview** | Live counts over posts, comments and reports | `worker/social.js:1036-1063` | about N + comments + reports | OK in practice (moderators only); same scaling caveat as #1. |
| 12 | **Link previews**: every `/community` request runs the Worker first | D1 is read only when the URL has a valid `?post=` (1 post + photos) | `worker/social.js:1136-1157`; `wrangler.jsonc:11` | 0 (no `?post`) or about 3 | OK for D1. It does add one Worker request per Community page view (counts toward Workers requests, not D1 rows). |
| 13 | **Writes** (post, comment, report limits) | Capped, indexed counts | `worker/social.js:105-110`, `:428-429` | ≤ 40 | OK. |

**Summary:** no live Social path scans an unbounded table per view without a cap: the biggest per-view read is the 300-post window. But **#1 (sidebar stats), #2 (For You) and #9 (Top Contributors' leaderboard)** all grow with the data, and they would pass the 5,000-row target (and eventually the 50,000 limit) at modest traffic once there are hundreds of posts. Fix them before Social gets busy.

---

## Recommended build order (missing and partial items)

The owner's top three priorities are already built and pass the browser tests on test data:

1. **Attach Cybercab to Post.** Complete (§1). Remaining: make the search budget-safe (data-budget #8: search a cached public-vehicle list instead of scanning the registry each time).
2. **Social Notifications.** Complete (§12). Optional: show the unread count in the site-wide header, and decide whether likes should notify.
3. **Saved Posts.** Complete (§11). Nothing outstanding.

Then, in order:

4. **Data budget, before traffic grows:**
   - (a) Precompute the sidebar stats (#1).
   - (b) Make For You cheap: cached ranked ids, or a stored score with an index (#2, #3).
   - (c) Precompute the leaderboard used by Top Contributors (#9).
5. **Permanent delete for the site owner** (guard gap): a moderator-only action that erases a removed post or comment (rows and stored photos), with a log entry, for privacy takedowns.
6. **Profile pinned posts** (§13): needs a post history on the rider profile first; then one pin per rider.
7. **Confirm on production:** publish one real (or approved seed) post and use two real accounts to confirm on the live site:
   - posting, the Cybercab card, likes, comments and replies
   - notifications, saves and share links
   - pins and moderator removal

   Each of these is currently confirmed only by automated tests on test data.
