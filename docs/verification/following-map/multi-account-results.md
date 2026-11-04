# Followers, Following and the Following map: multi-account results

Nov 4, 2026. Local only: the real Worker over an isolated in-memory database, with test accounts. Nothing here touched production.

**Accounts.** `tests/following-map.test.mjs`: alice (A, public, follows several), bob (B, public, publishes sightings), carol (C, private), dave (D, public, no sightings), erin (E, removal and deletion), mod (moderator). `tests/follows.test.mjs`: alice, bob, carol, dave, mod. iOS UI and browser runs: alice, bob, carol_c (private), dave, erin, plus `s-expired`, an ended session.

## Follow actions (4.2)

Tested in `tests/follows.test.mjs` (121 checks) unless noted.

| # | Scenario | Result |
|---|---|---|
| 1-2 | Follow and unfollow a public account | Pass |
| 3-6 | Private request, accept, decline, cancel | Pass |
| 7 | Remove a follower | Pass; access ends at once |
| 8 | Follow Back state | Pass; also in `FollowUITests` |
| 9-10 | Follower and following counts; pending never counted | Pass |
| 11-12 | No self-follow; no duplicate request | Pass |
| 13 | Rapid repeats | Pass: one row, and the per-pair limit applies |
| 14 | Deleted accounts | Pass. Restricted accounts: **not testable, the site has no block or suspension system** |

## Community feed (4.3)

Tested in `tests/follows.test.mjs` and `tests/social-v2.test.mjs`. All pass: followed posts shown, pending grants nothing, approved followers see only what they may, unfollowing removes content, moderated and deleted posts stay hidden, the other filters still work, pagination works.

## Map (4.4)

Tested in `tests/following-map.test.mjs` (78 checks), `FollowingMapUITests` (8 tests) and a Chromium run (40 checks). All pass except where noted below.

| Scenario | Evidence |
|---|---|
| Following shows only followed accounts | API, iOS, browser |
| Austin and Dallas | API, browser. iOS: Austin only in UI tests; the same request with a different city |
| A new approved sighting appears after refresh | API |
| Unfollowing removes it | API, iOS, browser |
| Pending and declined requests reveal nothing | API, iOS |
| Accepted requests grant only permitted visibility; removal revokes | API; acceptance also iOS (bob, seeded through the API) |
| Marker details link to the right vehicle and profile | API; browser (both links); iOS (profile link tapped, vehicle link present in the screenshot, not tapped) |
| Clustering | Same grouping code, used unchanged. Following markers were not seen clustered in a test, because the seeded points are far apart |
| Empty states; signed out; ended session; offline | iOS, browser |
| No polling; cancellation | Browser: 65 s on Following, no requests. Cancellation checked in code only |

## Cross-platform (4.5)

| Step | How it was tested |
|---|---|
| Follow on the website, see it in the app | Simulated: the same HTTP request the site sends, then the real app (`FollowUITests`) |
| Unfollow in the app, website updates | Real app taps, then the same HTTP read the site makes (`FollowUITests`) |
| Unfollow elsewhere, Following map updates | Simulated request, then the real browser and the real app, separately |
| Approve a private request in the app, verify on the website | **Manual check needed.** The app's requests screen is tested, but approval there isn't followed through to the website. The API path is tested |
| Submit a sighting on one platform, see it on the other | **Manual check needed.** Positions in the UI seed are set directly; the real submit path is tested at the API with a stubbed place search |
| Same results on both platforms | Both call the same endpoint, and the same fixture data was checked on each |

## Not run

Real production accounts, a physical iPhone, real push notifications. The Live Activity, Siri, widget-tap and push UI suites weren't re-run; none of their code changed, and the unit suite covers their logic.
