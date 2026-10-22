# Cybercab Hunter — native SwiftUI app: plan and feature-parity checklist

The native app lives in `ios-native/` (Xcode project `CybercabHunter.xcodeproj`).
It talks only to the existing Cloudflare Worker APIs (never to D1 directly),
with the same accounts and sessions as the website. The Capacitor app in
`app/` stays as the reference / fallback until the native app reaches parity.

| | Capacitor app (`app/`) | Native app (`ios-native/`) |
| --- | --- | --- |
| Bundle id | `com.cybercabhunter.app` | `com.cybercabhunter.native` (both can be installed during the migration) |
| Home-screen name | Cybercab Hunter | Cybercab β (renamed at cut-over) |
| UI | the website in a web view | SwiftUI |

## Architecture

```
CybercabHunter/
  App/            entry point, root tab view, app-wide state (SessionStore)
  Core/
    Config        base URL, OAuth callback scheme
    Networking    APIClient (URLSession, async/await, Codable, bearer auth), APIError
    Models        Codable API models (snake_case → camelCase)
    Auth          Keychain, PKCE, GoogleSignIn (ASWebAuthenticationSession), SessionStore
  DesignSystem/   colors, typography, reusable components (stat tiles, section headers), haptics
  Features/       one folder per area (Home, Zones, Registry, Sightings, Community, Account, …)
CybercabHunterTests/  unit tests (PKCE, model decoding, request building, Keychain)
```

* **Networking**: `APIClient` builds requests against `https://cybercabhunter.com`,
  adds `Authorization: Bearer <session>` when signed in, decodes with
  `convertFromSnakeCase`, maps 401 to "signed out". Every call is cancellable
  (`async`, tied to the SwiftUI `.task` that started it).
* **Authentication**: Google is the website's only sign-in method. The app uses
  the Worker's existing app flow: `GET /oauth/google/start?app=ios&challenge=<S256>`
  in Apple's system sign-in sheet (`ASWebAuthenticationSession`, never a
  web view) → `cybercabhunter://oauth/callback?code=…` → `POST /oauth/app/exchange`
  with the verifier → the same 90-day session token the website uses, stored in
  the Keychain. Same user, same account, no separate account database. No
  backend secret is in the app.
* **State**: `@Observable` stores injected through the SwiftUI environment;
  views own their loading with `.task` (cancelled when the view goes away).
* **Design**: dark appearance, the site's gold (`#FAE030`) as the tint, system
  `TabView` (Liquid Glass on iOS 26+, standard material before), native
  navigation stacks, sheets, `.refreshable`, Dynamic Type and VoiceOver labels.
* **Future Apple integrations** (Phase 6): App Intents / Siri and widgets will
  read through the same `APIClient` + models (moved into a shared framework
  target when the first extension is added); Live Activities and push need an
  APNs key (paid developer account) and a Worker endpoint to send them.

## Phases

1. **Foundation** — app, networking, auth, navigation, Liquid Glass tab bar, theme. *(done)*
2. **Core** — Home dashboard, fleet stats, vehicle registry, vehicle details. *(done)*
3. **Maps** — Zones (MapKit polygons, markers, cameras), heatmap, city switch, Replay, predictions, Home maps. *(done)*
4. **Community** — Social (feed, compose, photos, likes, comments, saves, reports, pins, notifications), Streaks, Leaderboard, Progress, profiles. *(done)*
5. **Sightings, Account, Privacy, Moderation** — sighting gallery and submission, profile and privacy, account deletion, sighting and Social moderation. *(done)* Still to do: News, Simulation (Fleet ROI, Fleet ETA), DMV roster, Rider data / Gmail link.
5.1. **Device fixes** — every moderation section native, place autocomplete, profile pictures, Zones legend, minimaps, the name "Cybercab Hunter", display-name sync. *(app side done; Worker and website deployed and verified Oct 21, 2026)*
6. **Native extras** — App Intents/Siri, widgets, Live Activities, push, Apple Intelligence.

Until a screen is native, its tab shows what is coming and opens that page of
the website in Safari (an honest fallback, never a fake native screen).

## Phase 1 acceptance (Oct 20, 2026)

| Criterion | How it was checked | Result |
| --- | --- | --- |
| Builds for the simulator and for a real iPhone (arm64, Release) | `xcodebuild` (simulator; `generic/platform=iOS`, signing off) | ✅ no warnings |
| Unit tests | 10 Swift Testing tests: PKCE equals the Worker's own S256 result, Worker regex rules, start/callback URLs, Keychain round-trip, bearer header rules, decoding of real API responses, 401/400/decoding error mapping, exchange request | ✅ 10/10 |
| Real backend data | Home shows `/api/registry/stats` (182 / 8 / 483) and `/api/service-areas` (Austin, Dallas) in the simulator, identical to the website | ✅ |
| Native navigation + Liquid Glass tab bar | System `TabView` (five tabs, a stack each), Liquid Glass on iOS 27 in the simulator, gold selection, minimizes on scroll (iOS 26+) | ✅ |
| Sign-in architecture | The app's start URL redirects to Google on the live Worker (302); exchange + Keychain + `/api/me` covered by tests | ✅ server side · ⏳ a real Google sign-in on the iPhone (needs your account) |
| ProMotion permitted | `CADisableMinimumFrameDurationOnPhone = true` in the built Info.plist | ✅ · frame rate not measured (needs the device + Instruments) |
| Installable on the iPhone | Signing needs your Apple ID in Xcode | ⏳ your step (README) |

## Phase 2 acceptance (Oct 20, 2026)

| Criterion | How it was checked | Result |
| --- | --- | --- |
| Looks like cybercabhunter.com | Tokens from public/css/style.css (canvas #08090A, carbon #0F1011, graphite hairlines, gold #FAE030), Inter + Geist Mono bundled from public/fonts, the site's panels, eyebrows, metric blocks, city pills, range pills, licence plates, CYBERCAB badge, car renders; compared screen by screen with the live site at phone width | ✅ |
| Home, Cars and vehicle details are native, with real data | UI test on the live backend: Home loads the real registry count and scrolls every section; Cars lists the registry; a vehicle opens; search "XVF" returns real results | ✅ |
| Never opens the website | The same UI test asserts no web view and no Safari at every step | ✅ |
| Real data decoding | 4 tests decode saved live responses (homepage-stats, daily, DMV, registry, vehicle) and check the _24h/_30d/_7d fields | ✅ |
| Builds clean | Swift 6, no warnings | ✅ · 15/15 tests |

## Phase 3 acceptance (Oct 20, 2026)

All 12 checklist rows below are native. No web view or Safari is used for any of them.

| Criterion | How it was checked | Result |
| --- | --- | --- |
| Zones: Austin and Dallas zones, charging pins, camera-spotted Cybercabs, Zone details, place search, city switch | UI test `testZonesHeatmapAndReplayAreNative` on the live backend, with screenshots: the Austin zone, Zone details, a switch to Dallas | ✅ |
| Zone coordinates equal the website's | `WebDataSyncTests` regenerates zones.json and us-map.json from the site's JS and compares them with the bundled copies | ✅ |
| Heatmap: 24H/7D/30D/All, hour filter, legend, status, camera dots, the site's gold→red ramp | The UI test switches ranges; screenshots show gold-to-red heat and "70 detections at 26 cameras · the last 7 days". `MapDataTests` checks `statsFor` parity on 40 cases | ✅ |
| Replay: windows, paged history, playback 1/4/16/60×, ribbon scrub, no invented movement | The UI test plays Replay and checks that the count rises. `MapDataTests` decodes paged history | ✅ |
| Fleet and DMV predictions | `ForecastTests`: 18 cases produced by the site's forecast.js, matched exactly, plus invariants. UI test `testHomePredictionsAndMinimap` toggles predictions | ✅ |
| Home minimaps open the native Zones tab | `testHomePredictionsAndMinimap` taps the minimap and waits for the Zones controls | ✅ |
| US sightings map (Dots / Heatmap, states, sources) | Screenshot from the same UI test. The data is generated from js/us-sightings-data.js | ✅ |
| Tests | 25 unit tests + 3 UI tests | ✅ 28/28 |
| Builds | Simulator, and `generic/platform=iOS` with signing off | ✅ |

Fixes found through the screenshots:
- Apple's muted dark map looked teal. A dark wash overlay now brings it to the site's #0F1011 base.
- The heat colour table had its bytes in the wrong order, which made it pink. It is now gold to red, as on the site.
- Tapping the minimap didn't navigate. Its map is now non-interactive and the card handles the tap.
- The minimap's title overlapped map labels. It now sits on a scrim.
- The "Explore map" pill covered the Apple Maps logo. It moved to the bottom-right corner.

Known limits:
- The heat panel covers the lower part of the map. Pan the map to see heat underneath it.
- Camera markers are camera detections, not vehicle positions, and the sheets say so.
- Frame rate on a ProMotion iPhone has not been measured. That needs the device and Instruments.

## Phase 3 checklist (from the website's code, Oct 20, 2026)

What the website's maps actually do, and how each is rebuilt natively:

| # | Website feature (source) | Data | Native approach |
| --- | --- | --- | --- |
| 1 | Zones map: Austin + Dallas service zones, gold wash + glow + outline (js/austin-map.js, infrastructure.html) | zone polygons are fixed data in the site's JS | MKMapView, MKPolygon overlays (fill, glow, line); same coordinates, kept equal by a test that reads the site's JS |
| 2 | City switch, camera framed on the zone | — | MKMapView camera animation; old markers/overlays replaced, stale requests cancelled |
| 3 | Charging locations (gold pins, popup) | fixed data in the site's JS | MKAnnotation + native sheet |
| 4 | Camera-spotted Cybercabs: one marker per camera with a detection in the last 24 h, refreshed every 60 s, reconciled by camera id, popup with the capture image, camera, time | /api/camera-sightings[?city=], /api/camera-sightings/:id/image | Cybercab overhead icon annotations, diffed by camera id; native sheet with the capture. These are camera detections (no vehicle id), so no vehicle link: the sheet says "seen by camera", never a live position |
| 5 | Zone details panel: zone name, Operating, map key, coverage, description, in service since, Fleet & Fares (Cybercabs, median, avg, per mile, basis) | /api/homepage-stats, /api/fleet-stats?city= | native bottom panel / sheet |
| 6 | Place search (3+ letters, city places, fly + pin) | /api/places/map?v=2&q=&area= | native search field + suggestions, pin annotation |
| 7 | Heatmap mode: hides Cybercab icons, gold→red-orange heat per camera (sqrt weights), all cameras as small dots, range 24H/7D/30D/All (refetch, cached per city+range), hour-of-day filter (instant, from the 7×24 grid), legend, status line, empty state, tap a camera → detections / most recent / busiest hour / busiest day | /api/camera-sightings/heat?city=&range=, /data/traffic-cameras.json | custom MKOverlayRenderer heatmap (density → the site's colour ramp, zoom-scaled radius), camera dots, native controls + camera sheet |
| 8 | Replay: This Month / 24h / 7d windows, Austin time, paged history, chronological playback at 1/4/16/60×, activity ribbon (scrub), odometer count, camera dots that light up, Cybercab vs spotter marks; never invented movement | /api/camera-sightings/history?from=&to=&limit=1000&cursor=[&city=] | native screen: MKMapView + Canvas layer for pings/dots, Swift Charts ribbon with drag-to-scrub |
| 9 | Fleet growth predictions: Actual / Actual + Predictions, horizon 7D/30D/90D, projected line + 80% band, 4 tiles, "How predictions work" (js/forecast.js) | the registry series | exact Swift port of forecast.js, checked against the JS on the same inputs |
| 10 | DMV predictions (Cybercab and Model Y each forecast, total = sum) (js/dmv-panel.js) | /api/dmv-registrations | same port |
| 11 | Homepage Austin/Dallas minimaps (zone, + / −, "Explore map") | fixed zones | small MapKit map, tap → Zones tab on that city |
| 12 | Homepage "Cybercab sightings across the US" (Dots / Heatmap, states list, sources) (js/us-sightings-map.js) | fixed Census paths + community counts in js/us-sightings-data.js | SwiftUI Canvas from the same data (bundled JSON, generated from the site's file) |

## Phase 4 acceptance (Oct 21, 2026)

Community is native: Social, Streaks, Leaderboard and Progress, post screens,
the composer, rider profiles, Find riders and notifications. The Community
tab no longer has a website fallback. Every row of the checklist below is
native except row 18 (the moderation dashboard, Phase 5).

**How it was tested.** Production had 0 Social posts, and the tests write
(likes, comments, posts), so they don't run against production. They run
against the real Worker code over an isolated in-memory database
(`scripts/community-test-server.mjs`, built on the website's
`tests/e2e/harness.mjs`), seeded through the Worker's own API by test riders:
alice, bob, a moderator, and carol, a private rider. The unit-test fixtures
are that Worker's real responses.

| Criterion | How it was checked | Result |
| --- | --- | --- |
| Community opens natively, Social first, four sections switch and keep their own scroll | `testSocialFeedPostProfileVehicleAndSectionsAreNative`; no web view and no Safari at any step | ✅ |
| Feed filters, sort, pins, pagination, likes, saves | UI test (Photos filter, a like in place); unit tests: paging without duplicates, the like rolls back on a 429, Saved needs sign-in, sort is sent only where the site sends it | ✅ |
| Post screen, comments, replies, adding a comment | UI test | ✅ |
| Rider profile, attached Cybercab → the native vehicle screen | UI test | ✅ |
| Notifications, opening one at its post | UI test; unit test of the notification types and links | ✅ |
| Composer: text counter, Cybercab search and attach, ride review (rating required), publish, duplicate refused with the site's message | `testComposerPostsWithCybercabAndReview`; unit tests: counter messages, the multipart form field by field, edit with `keep_photos` / `remove_review` | ✅ |
| Photos: the system picker (only what the rider picks), re-encoded ≤ 2048 px JPEG, GPS / EXIF removed | `testPhotoPickerAddsAPhoto`; unit test: a photo carrying GPS comes out with none, at most 2048 px, at most 5 MB | ✅ |
| Signed out: read only | `testSignedOutIsReadOnly`: no composer and no bell; Saved, a like, Streaks and Progress ask to sign in | ✅ |
| Streaks, Leaderboard, Progress use the server's numbers | UI test (weekly 5, daily 4, the leaderboard rows, Top XP, level and rank); unit tests decode them and check the site's next-milestone date and the Top Overall points | ✅ |
| Privacy | Unit test: the private rider appears in no feed, board or search; a private profile is a 404 exactly like an unknown one; who liked a post is never sent | ✅ |
| Rate limits and errors in the site's words | Unit tests on real 429 / 409 / 403 / 400 / 401 responses | ✅ |
| Tests | 46 unit + 7 UI (4 Community, 3 Phase 2–3 regression), one run | ✅ 53/53 |
| Builds | Simulator (Debug) and `generic/platform=iOS` Release, signing off; no warnings. The Release binary contains no test hook (`-apiBase`, 127.0.0.1) | ✅ |

**Native screens:** CommunityView (sections, tiles, toolbar), SocialSection,
PostCard, PostDetailView (comments), ComposerView (PhotosPicker, review,
Cybercab, link), ReportSheet, PhotoViewer, NotificationsView,
RiderSearchView, RiderProfileView, StreaksSection (cards, calendar,
milestones, boards), LeaderboardSection, ProgressSection (missions, ladder,
recent XP).

**Models:** `Core/Models/Social.swift` (posts, comments, sidebar,
notifications, vehicle search, report reasons, links) and
`Core/Models/Community.swift` (leaderboard, summary, streaks, XP and rules,
rider profile and search).

**Endpoints used:** `/api/social/feed`, `/api/social/posts[/:id]` (GET, POST,
PATCH, DELETE), `…/like`, `…/save`, `…/pin`, `…/comments`,
`/api/social/comments/:id`, `/api/social/reports`, `/api/social/sidebar`,
`/api/social/photos/:id`, `/api/social/vehicles`,
`/api/social/notifications` and `/read`, `/api/community/leaderboard`,
`/api/community/summary`, `/api/streaks/me`, `/api/streaks/leaderboard`,
`/api/xp/me`, `/api/xp/rules`, `/api/riders/:handle`, `/api/rider-search`.
No backend change was needed.

**Authentication and privacy:**
- The Phase 1 session (Keychain, bearer token) is used, with the same accounts as the website.
- Signed out, Community is read only; any write opens the sign-in sheet.
- A 401 on a write signs the rider out on this device.
- The app shows exactly what the server sends, so private riders arrive as "Anonymous".
- XP is never computed or awarded in the app. Social actions earn 0 XP on the server.

**Known limits:**
- The moderation dashboard (reports queue, announcement editor, moderation
  history) is Phase 5. Pin, unpin and remove are native in the post menu for
  moderators, as on the Community page.
- Shared cybercabhunter.com links open the app's native screens only when they
  reach the app: when tapped inside it, or once universal links exist. Universal
  links need an `apple-app-site-association` file on the website and an
  Associated Domains entitlement on a paid team, so they aren't set up.
- There's no push. Notifications are in-app, as on the website; the unread
  count refreshes every 3 minutes while Community is open.
- "Submit the sighting", in the Cybercab attachment note, is text only, because
  sighting submission is Phase 5.
- The privacy switch ("Community leaderboard & public profile") stays on the
  website's Profile page until profile settings are native (Phase 5).
- There's no view of a vehicle's Social posts. The website has none, and the
  API can't filter posts by vehicle.
- Frame rate and hitches haven't been measured on a ProMotion iPhone. Images
  are decoded at their displayed size and cached, the feed is lazy and paged,
  and each action updates only its own post.

## Phase 4 checklist: Community (from the website's code, Oct 20, 2026)

Sources: public/community.html, js/social.js, js/streaks.js, js/progress.js,
js/community.js, js/community-stats.js, js/rider.js, css/community.css;
worker/social.js, community.js, community-summary.js, streaks.js,
progression*.js, reviews.js (`publicPerson`); docs/social-audit-2026-10-15.md.
Production had **0 Social posts** on Oct 20, 2026 (`/api/social/sidebar`).

| # | Website feature (source) | API | Native approach |
| --- | --- | --- | --- |
| 1 | Four sections SOCIAL / STREAKS / LEADERBOARD / PROGRESS, Social first; hero "COMMUNITY" with an intro per section; at-a-glance tiles per section (community.html, community-stats.js) | `/api/social/sidebar`, `/api/community/summary`, `/api/community/leaderboard` | pill selector (the site's `city-filter`), state kept per section |
| 2 | Feed: For You / Latest / Photos / Reviews / Saved; Newest / Most popular on Photos, Reviews, Saved; the note on For You / Latest; pins above For You and Latest; 10 per page with a cursor; empty / error / sign-in states (social.js) | `GET /api/social/feed` | LazyVStack, paging on scroll, stable ids |
| 3 | Post card: pinned label, avatar, name → profile, Spotter rank + level, relative time, "edited", category chip (colour per category), body with links, ride review box, 1–4 photos grid, registry vehicle card → vehicle, link card, like / comments / share / save, ⋯ menu (edit, delete, copy link, report, pin, remove for moderators) | — | SwiftUI card, Menu, ShareLink |
| 4 | Likes (optimistic with rollback), saves, pins (moderators, max 3) | `PUT/DELETE …/like`, `…/save`, `…/pin` | in-place update of the one post |
| 5 | Comments: 10 top-level per page + replies (one level), add, reply, edit own, delete own, moderator remove, report, removed placeholder (social.js) | `GET/POST …/comments`, `PATCH/DELETE /api/social/comments/:id` | thread in the post screen |
| 6 | A post's own page (`/community?post=<id>&comment=<id>`), "isn't available" state | `GET /api/social/posts/:id` | native post screen; notification opens it at the comment |
| 7 | Composer: 2,000-char counter with near / over messages, up to 4 photos (re-encoded ≤ 2048 px JPEG, metadata dropped), category, ride review (1–5 stars, Cybercab / Model Y / not sure, fare $1–250, wait 0–120 min, ride date ≥ 2025-06-01, not future), Attach Cybercab (search plate / VIN / id, preview, change, remove), link; edit keeps photos (`keep_photos`), `remove_review` | `POST /api/social/posts`, `PATCH /api/social/posts/:id` (multipart), `GET /api/social/vehicles?q=` | sheet, PhotosPicker, ImageIO re-encode, multipart upload |
| 8 | Report post / comment: Spam, Harassment, Off-topic, Misleading information, Privacy concern, Other + details ≤ 500 | `POST /api/social/reports` | sheet |
| 9 | Sidebar: announcement, Trending this week (top 5), Top contributors (top 5 of Top Overall, rank + level + points), Community rules | `/api/social/sidebar`, `/api/community/leaderboard` | cards under the feed |
| 10 | Notifications bell: unread count, list (like, comment, reply, mention, announcement), mark all read, opening one marks it read and opens the post | `GET /api/social/notifications`, `POST …/read` | toolbar bell + sheet (in-app only; no push) |
| 11 | Find riders (public profiles only) | `GET /api/rider-search?q=` | searchable list |
| 12 | Rider profile `/rider/<handle>`: name, @handle, joined, bio, rides / vehicles ridden / cities / discovered / reviews + average, cities bars, recent reviews, discovered vehicles; private = "not available" (rider.js) | `GET /api/riders/:handle` | native screen |
| 13 | Streaks: weekly + daily cards (ring, next milestone, today / this week counts), activity calendar, milestones (3…100 days, 2…52 weeks), How it works, Community streaks boards (weekly / daily / longest), crown, privacy note; signed-out prompt (streaks.js) | `GET /api/streaks/me`, `/api/streaks/leaderboard` | Swift Charts-free custom views from the server's numbers only |
| 14 | Leaderboard: 6 boards (Top Overall, Most Vehicles Discovered, Most Miles, Most Rides, Most Vehicles Ridden, Top XP), medals 1–3, ties, row expands to metrics + Top Overall points math + profile link, totals line, privacy note (community.js) | `GET /api/community/leaderboard?board=` | native list |
| 15 | Progress: level, rank, XP bar, XP to next level / rank, daily + weekly missions (states), rank ladder, recent XP, How XP works; signed out: prompt, ladder, missions, link to Top XP (progress.js) | `GET /api/xp/me`, `/api/xp/rules` | native; XP is never computed or awarded in the app |
| 16 | Privacy: private riders are "Anonymous" with no photo / rank; never on boards or search; who liked is never shown | server-side (`publicPerson`) | the app shows exactly what the server sends |
| 17 | Rate limits: posts 10/h and 40/day, comments 30/h, reports 20/day, one report per item, duplicate text 24 h | 429 `rate_limited`, 409 `duplicate_post` / `already_reported` | the website's messages; buttons disabled while sending |
| 18 | Moderation queue, announcement editor, reports review (moderation.html) | `/api/moderation/social/*` | **Phase 5** (moderation dashboard). Community already honours removals; pin / remove from the post menu are native for moderators |

Not on the website (so not built, and not invented): Social posts on a
vehicle's page (no API filters posts by vehicle), push notifications (no APNs),
universal links (needs `apple-app-site-association` on the site + an Associated
Domains entitlement on a paid team).

## Phase 5 acceptance (Oct 21, 2026)

Sightings, Account, Privacy and Moderation are native. All five tabs are
native, and `NotNativeYetView` is gone. Nothing is committed: Phases 1–4 are
in `db494cd`, and Phase 5 is uncommitted on `claude/ios-native`, inside
`ios-native/` only.

**Results** (iPhone 18 Pro simulator, one simulator, `-parallel-testing-enabled NO`, one run):

| Suite | Result |
| --- | --- |
| All unit tests (Phases 1–5; 22 new for Phase 5) | ✅ 66/66 |
| UI: Community (Phase 4), 4 tests, the photo picker included | ✅ 4/4 |
| UI: Sightings / Account / Moderation (Phase 5), 5 tests | ✅ 5/5 |
| UI regression: Home + Cars (Phase 2), Zones + predictions + minimap (Phase 3) | ✅ 3/3 |
| **Total** | **✅ 78/78, 0 failed, 0 skipped** |
| Simulator Debug build | ✅ no warnings |
| iPhone Release build (`generic/platform=iOS`, signing off) | ✅ succeeded. The binary contains neither `-apiBase` nor `127.0.0.1` (the test hooks are Debug only) |

The test results are kept outside the temp folder, in
`~/Library/Developer/CybercabHunterTestResults/20261021-1404/`
(`final.xcresult`, `full.xcresult`, `release.log`, and `shots/` with the
Phase 5 screenshots s01–s15).

**How each check was made:**

- **Sightings:**
  - Browsing: the server's count, the viewer, plate → vehicle, Dallas, oldest first, Replay Map.
  - Submitting: "add a photo" validation, Location locked until a city is chosen, a photo from the picker, success, then the new sighting pending in My sightings.
  - Signed out: browse only; Submit opens sign-in.
- **Account:**
  - Name edit saved.
  - Privacy off: the server returns 404 for the profile, and Find riders doesn't list the rider.
  - Privacy back on: 200.
  - Every save sends the full set. The switch locks while saving, so it can't be flipped twice.
- **Moderation:**
  - A rider sees no link, and the Worker answers 403.
  - The moderator sees the link, approves (the queue shrinks), and dismisses a report.
  - Unit tests: conflicts (409 already reviewed), the required reject reason, revoked access (403 → "Moderators only"), every request body.
- **Privacy on the server, not only in SwiftUI:** the UI tests ask the test Worker directly.

**Fixed while testing:**
- The `reviewActionsAndConflicts()` crash was a race in the test stubs (one
  table shared by suites running in parallel). Each test now has its own
  `StubServer`, and `#require` comes before every index.
- Fixture assumptions corrected: counts, the order of comments made in the
  same second, missions that depend on the date, and an empty-streak rider.
- App: the privacy switch now locks synchronously while it saves (a fast
  second flip could otherwise race the first). Unit test `privacySwitchLocksWhileSaving`.
- UI tests:
  - Never swipe down on a sheet.
  - Scroll lazy lists to their rows.
  - Use the visible Account button (`accountButton`).
  - Close Find riders until its sheet is gone.
  - Look for the 2.6 s toast as any element type.
  - Ask the server directly, bypassing the HTTP cache: the Worker caches a profile's 404 for 60 s.
- Unit tests start from the default sort, because the sort preference is
  remembered on the device and the UI tests change it.
- Simulator stability: PosterBoard and Calendar crashed while a new simulator
  and a parallel clone were doing first-boot work (load average about 210).
  Runs now use one settled simulator, one at a time.

**Remaining website fallbacks:**
- Rider data and Link Gmail (Account › "Rider data (website)").
- The privacy policy, a legal document shown as published.
- Moderator tools not built in this phase: registry vehicles, News, Gmail Link stats, fare reports, moderator receipt import. Reached from a labelled link in Moderation.
- Not part of the app yet: News, Simulation, the DMV roster, Tesla link.

**Known limits:**
- **Server behaviour, reported and not changed:**
  - Turning the profile off removes a rider from the streak rankings only at the next daily refresh.
  - A profile's 404 or 200 is cached for up to 60 s, in the app as in browsers.
- **Not on the website, so not built:**
  - A map pin or "use my location" for a sighting.
  - A moderation history list (no API serves one).
  - Withdrawing a submitted sighting.
- **The sighting plate:** it opens the vehicle only when the public registry has exactly that plate. The gallery API carries no vehicle id.
- **Needs your iPhone:**
  - Google sign-in.
  - The photo picker with your library.
  - Moderator access on your account.
  - Frame rate on ProMotion.

## Phase 5.1: fixes from the physical iPhone (Oct 21, 2026)

Uncommitted on `claude/ios-native`, inside `ios-native/` only. No website,
Worker, D1 or Capacitor change; production data untouched.

1. **Moderation parity.** Native screens for every section of moderation.html,
   on the same APIs (the Worker checks the role on every request):
   - Vehicles: the sighting queue plus **Registry Vehicles** (Private / Public /
     No VIN, plate search, the server's state badge, blocking reasons, notes,
     rides attached, provenance, record, last review, duplicate plate; Approve
     Cybercab, Return to Private, Save / Clear VIN with the auto VIN-verify,
     Delete with an inline confirmation; a 409 shows the vehicle's current facts).
   - Images and Social, as in Phase 5.
   - **News**: run status, Run the next ingest step, stories with Hide / Feature,
     Load older, the allow / block / publisher / Major-keyword / thumbnail lists.
   - **Gmail Link**: linking counts, setup funnel, forwarded receipts by period
     and outcome, last 14 days, Gmail API connections (aggregate counts only).
   - **Import Receipt** (header button): rider by display name, .eml/.txt files
     or pasted text, per-receipt results, "Open in Registry Vehicles".
   - Fare reports are not on moderation.html (they belong to Simulation), so
     they come with Simulation.
2. **Location autocomplete.** The backend works (Photon; "Barton" → Barton
   Springs Pool). The app problem was presentation: suggestions sat under the
   keyboard. The form now scrolls the field to the top while typing, shows
   "Searching…", the suggestions, "no matching places" and errors, and says to
   pick a City first. No GPS. MapKit can't be used: the server re-checks the
   Photon place id.
3. **Profile pictures.** Root cause: in Edit profile, "Change photo" and
   "Remove photo" were in one Form row, so a tap on the row ran both, and
   Remove had no confirmation. The server's own data shows the sequence
   (Google photo → uploaded photo → removed). Fixed: one control per row and a
   confirmation. Also fixed: the account button asked for the custom photo
   without its size suffix (a 404, so initials). Saving a name never touches
   the photo (server-side too). The Google picture isn't stored separately, so
   it can't come back automatically (proposal below).
4. **Zones legend**: only in Zone details now.
5. **Minimaps**: the website's card (height 0.92 × width, fit padding
   70/24/54/24) for Austin and Dallas.
6. **Name**: "Cybercab Hunter" in Debug and Release; bundle id, icon, signing unchanged.
7. **Display-name sync.** In the app: leaderboards, rider profiles, streak
   boards, top contributors and `/api/me` now skip the device's HTTP cache;
   Community reloads everything after a profile save; the account button is
   fetched again. On the server (not changed, needs approval): the leaderboard
   response is edge-cached 5 min, rider profiles 60 s, and the **streak boards
   are a daily snapshot that is never patched** (names, photos and privacy can
   be up to ~24 h old there).

**Proposed Worker changes (awaiting approval):**
- Patch the community_summary streak boards when a rider's name, photo or
  privacy changes (as `leaderboardRiderChanged` already does for the main board).
- Purge the edge-cached leaderboard / streak / rider-profile responses on a
  profile change (or shorten their TTL).
- Keep the Google picture in its own column so "Remove photo" can fall back to it.
- Optionally restore the owner's photo in production (a data write: only on your word).

**Results** (iPhone 18 Pro simulator, one simulator, `-parallel-testing-enabled NO`):

| Suite | Result |
| --- | --- |
| Unit tests (Phases 1–5.1; 16 new) | ✅ 82/82 |
| UI: Phase 5.1 (registry vehicles; News, Gmail Link, Import Receipt; autocomplete Austin + Dallas; avatar kept; name sync) | ✅ 5/5 |
| UI: Zones legend closed/open, Home minimaps Austin + Dallas | ✅ 2/2 |
| UI regression: Community 4, Sightings/Account/Moderation 5, Home + Cars 1, Zones/predictions/minimap 2 | ✅ 11/12 in the final full run, plus the 12th on rerun (below) |
| Simulator Debug build | ✅ no Swift warnings |
| iPhone Release build (`generic/platform=iOS`, signing off) | ✅ display name "Cybercab Hunter", bundle id `com.cybercabhunter.native`, AppIcon present, no `-apiBase` / `-session` / `127.0.0.1` in the binary; DEVELOPMENT_TEAM unchanged |

Final full run (`final.xcresult`): 82 unit tests and 18 of 19 UI tests passed.
`test3ProfileEditAndPrivacy` (Phase 5) lost its first tap on the privacy
switch: the tap landed during the pop-back animation from Edit profile. The
app code is the same; the test now waits until the switch can take the tap,
and the whole Sightings/Account class then passed 5/5 (`sa.xcresult`).
Results: `~/Library/Developer/CybercabHunterTestResults/20261021-51/`
(`final.xcresult`, `sa.xcresult`, `release.log`, `shots/`).

**Also fixed while testing:**
- After Submit with no photo, the "add a photo" message was off screen above
  the form; the form now scrolls to it.
- After a profile save, the signed-in account (the Account button's name and
  photo) is fetched again.

## Phase 5.1 backend fixes (Oct 21, 2026; approved, not deployed)

Worker changes 1–3 from the Phase 5.1 report, approved by the owner. Local
only: no deploy, no production D1 write, migration 0046 not applied.
Full design: `docs/profile-freshness-and-avatars.md`.

- **Streak boards** store each board's order only (rider ids + streak
  numbers); every response reads the riders' current name, photo and privacy
  by primary key. Renames, new photos, privacy off/on and deleted accounts
  show on the next request; streak numbers and order are unchanged.
- **Cache freshness**: profile-bearing responses (leaderboards, streak boards,
  rider profiles, signed-out feed) are edge-cached under a key carrying a
  profile epoch (KV), bumped on every public profile change; browsers and the
  app get `private, no-store`. Fixes the per-location `cache.delete` limit
  and the zone's 4-hour browser TTL on cybercabhunter.com. Turning privacy
  back on lists the rider on the main leaderboard at once (one recompute,
  only on that transition).
- **Pictures**: `users.google_avatar_url` (migration 0046) keeps the Google
  picture; upload > Google > initials; removing an upload brings Google
  back; sign-in never replaces an upload. New response fields
  `avatar_source`, `has_google_avatar` (additive).
- **Native**: decodes the new fields (optional, so an older server still
  works); "Remove photo" only for an upload; the dialog says what replaces
  it; after removal the app shows the server's fallback.
- **Owner's picture**: not restored. The Google picture on record before the
  upload (Oct 21 streak snapshot) is Google's generated letter avatar (a blue
  "P", still served by Google), not a photo. The uploaded photo's files were
  deleted when it was removed (`apiDeleteAvatar`), so it can't be recovered
  from the app's storage. After 0046 + deploy, the owner's next Google sign-in
  would show their current Google picture automatically (the designed
  fallback); a manual production write is not needed.

**Results:**
- Website/Worker suite (91 files, `node tests/*.test.mjs`): 5,539 checks passed,
  8 failed. The 8 are the same layout checks that failed before any change
  (mobile-density, motion, social-v2, ui-effects; verified identical by diff).
  New `tests/profile-sync.test.mjs`: 56/56; with the epoch bump disabled 11
  of its checks fail, so it detects stale data. Three existing tests were
  updated to the new contract (community, community-polish, avatars).
- `wrangler deploy --dry-run`: bundles; nothing uploaded.
- Native: unit 83/83. UI full run 17/19; `test3PlaceAutocomplete` skipped
  (OpenStreetMap unreachable from the test Worker while the machine was
  overloaded) and `test4` failed on a new test step (it didn't reopen Edit
  profile after saving); both passed on rerun. Release build: name, bundle
  id, no test hooks.
- Simulator: a SpringBoard abort (Apple's RunningBoardServices assertion
  during a Home Screen poster snapshot, 20:21:34) happened during a cold
  simulator boot at load ~415; Cybercab Hunter wasn't running. xcodebuild
  boots the shut-down simulator at the start of every run and shuts it down
  after, so each run starts with first-boot background work. Booting it once
  beforehand (`xcrun simctl boot` + `bootstatus -b`) and letting it settle
  avoids that.

## Phase 5.1 production deployment (Oct 21, 2026)

With the owner's explicit approval, migration 0046 was applied after a verified
production backup, followed by the Worker and website deployment. Version
`e8d46c9d-b23b-4fd3-a087-35bcb54b8901` was verified at 100% traffic.
The full hour of production observation and read-only smoke tests passed.
No native app was deployed. Authenticated write tests remain unperformed.
See [the production verification report](../docs/verification/phase-5-1-production.md)
for exact results and limitations. The sections below record the earlier review.

## Phase 5.1 production-readiness review (Oct 21, 2026)

Nothing deployed, committed or applied. Details and the deployment runbook:
`docs/profile-freshness-and-avatars.md`.

- Fixed in review: the stored streak row keeps the previous Worker's `boards`
  shape too (a rollback to the old Worker would otherwise fail on
  `/api/streaks/leaderboard`); KV unreadable -> profile-bearing endpoints serve
  from the database and store nothing; a refused epoch write is retried and
  logged; epoch values use 48 random bits (no repeat within a millisecond).
- New tests: `tests/migration-0046.test.mjs` (the migration on today's
  production schema: only the new column changes), profile-sync sections
  10-12 (KV failure, concurrency, the 10-step picture sequence, rollback
  shape), avatars section 7 (the profile page with a Google picture).
- Previous Worker + migration 0046: the old code's whole suite passes
  (same 8 baseline failures; `dallas-camera-plan` needs a git checkout and
  was the only other difference); the old streak endpoint serves a row
  written by the new code.
- The 8 website failures are pre-existing and are test problems, not site
  bugs: 7 stale layout assertions written before later redesigns (soft-panel
  styling 2044b21 / c417898, Community redesign 3d0516e), and social-v2's
  harness passing jsdom's FormData to the Worker (`invalid_form_data`;
  converting it makes all 100 checks pass). Left unchanged (out of scope).
- Native, complete run on one pre-booted simulator: unit 83/83, UI 18/19;
  `testHomeMinimapsMatchTheWebsite` lost its Dallas tap during scrolling
  (test made to wait for the selection) and passed on rerun. Release build OK.

## Phase 5 checklist: Sightings, Account, Privacy, Moderation (from the website's code, Oct 21, 2026)

Sources: public/sightings.html + js/sightings.js; the sighting drawer
(js/main.js initSightingDrawer, index.html #sightingDrawer); profile.html
(inline script); moderation.html + js/moderation.js and moderation-social.js;
worker/sightings.js, sightings-public.js, submissions.js, places.js,
profile.js, avatars.js, account.js, moderation.js, social.js.
Auth: **S** = signed in (bearer session), **M** = moderator (`users.role`,
checked by the Worker's `requireModerator` on every request), **P** = public.

| # | Website feature | API | Auth | Native approach | Test |
| --- | --- | --- | --- | --- | --- |
| S1 | Sightings gallery: approved **photo** sightings only, newest or oldest first (remembered), 24 a page, cursor paging, city filter (the service areas), photo viewer with caption, a photo that fails to load is dropped | `GET /api/sightings?city=&order=&limit=&cursor=` | P | Sightings tab: 2-column grid, LazyVGrid, paging on scroll | UI + unit (decode, cursor) |
| S2 | Six stat tiles (all time · all cities, last 7 days, today, this month, peak hour with "not enough data yet", all-time best day) and the feed count | same, `stats=1` | P | tiles from the server's figures; "—" when missing | unit |
| S3 | Re-checked every minute while visible; new sightings added without a reload | same | P | 60 s refresh while the tab is active | — |
| S4 | Replay Map button (this month, the chosen city) | — | P | the native Replay (Phase 3) | UI |
| S5 | Card: photo, city (when not the filtered one), CYBERCAB pill, "5h ago", plate, approximate place, local time with zone | — | P | native card; the plate opens the native vehicle when the registry has exactly that plate (`/api/robotaxi-vehicles?q=`; the sighting API has no vehicle id) | UI |
| S6 | Moderators: Delete on each gallery photo | `GET /api/moderation/access`, `DELETE /api/moderation/sightings/:publicId/photo` | M | photo menu, confirmation | UI (moderator) |
| S7 | Submit a sighting: required photo (JPEG/PNG/WebP, re-encoded ≤ 2560 px JPEG, metadata dropped, ≤ 10 MB); City (optional, a service area); Location (optional, needs a City, a **real place picked from search**: `location_id` + `location_query`); Date spotted (optional, not future; the time is recorded by the server); Traffic camera (optional, that city's cameras); Description (≤ 280); License plate (optional, ≤ 20); `time_zone`; the site's error messages; double-submit guard; duplicate → "already submitted"; success screen (Submit another / Done); a network failure keeps every field | `POST /api/vehicle-sightings/photo` (multipart), `GET /api/places?q=&area=`, `GET /api/service-areas`, `/data/traffic-cameras.json` | S | sheet with PhotosPicker; no location permission: the website has no map pin or "current location" (`/api/places` never returns coordinates) | UI + unit |
| S8 | Sightings are pending and private until a moderator approves them; an unknown plate becomes a **private** registry vehicle for review | server | S | the success text says so; the app never sets a status | unit |
| S9 | The rider's own submissions and their status (pending / approved / rejected / needs review) | `GET /api/submissions` (own rows: type, status, dates; no reasons) | S | "My sightings" in Account. The website has no page for this; the API is the rider's own and existing | UI + unit |
| A1 | Settings: profile photo (square crop and zoom, saved as 512 and 128 px; remove), display name (≤ 60), username (3–20, a–z 0–9 _, unique), bio (≤ 280); errors `invalid_handle`, `handle_taken` | `GET /api/profile`, `PATCH /api/profile` (the full set, always), `POST/DELETE /api/profile/avatar` | S | native editor; the account and Community refresh after a save | UI + unit |
| A2 | Privacy: "Community leaderboard & public profile" switch (`leaderboard_opt_in`); `profile_visibility` is sent back unchanged | `PATCH /api/profile` | S | switch in Account (sends the full current set) | UI + unit |
| A3 | Account: joined date, sign out | `/api/me` | S | Account | UI |
| A4 | Delete account: what goes, type DELETE, `last_moderator` (409), `rate_limited` (429) | `DELETE /api/account { confirm: "DELETE" }` | S | native two-step screen; **tested only on a throwaway account in the isolated test database** | unit |
| M1 | Moderation link only for moderators | `GET /api/moderation/access` | S | Account shows "Moderation" when the server says so; every action is still checked by the Worker | UI (both roles) |
| M2 | Sighting review queue (the Vehicles tab's sightings without a photo, the Images tab's photo sightings): plate, submitted / observed, city, linked registry vehicle or "unrecognized plate", model, color, place, traffic camera, notes, photo (moderator-only, with the session); Approve, Add to registry (a plate and no vehicle yet), Reject (reason required); 409 already reviewed → removed from the queue | `GET /api/moderation/vehicle-sightings`, `PATCH …/:id {action, rejection_reason}`, `POST …/:id/promote`, `GET/DELETE …/:id/photo` | M | native queue | UI + unit |
| M3 | Recently approved images: on the Zones map / off it (24 h) / Add to map (camera of that city); delete photo | `GET /api/moderation/approved-photo-sightings`, `POST …/:id/map {camera_id}` | M | native list | unit |
| M4 | Social: counts, pinned posts (unpin), open reports grouped per item with reasons, details, the author and their history (earlier removals, posts in 24 h), Remove / Dismiss with an optional note; announcement (≤ 280, link, notify) set / clear | `GET /api/moderation/social/overview`, `…/reports`, `POST …/resolve`, `PUT/DELETE …/announcement`, `DELETE /api/social/posts/:id/pin` | M | native tab | UI + unit |
| M5 | Registry vehicles (approve as Cybercab / manually, verify VIN, return to private, set VIN, delete, log a ride), moderator receipt import, News, Gmail Link stats, fare reports | `/api/moderation/robotaxi-vehicles*`, `…/receipt-import`, `/api/moderation/news*`, `…/forwarding-*`, `…/fare-reports*` | M | **not in Phase 5**: these stay on the website's moderation page (documented) | — |

**Not on the website, so not built:** a map pin or "use my location" for
sightings; a moderation history list (no API lists `social_mod_actions`);
withdrawing a submitted sighting (the API refuses anything but `pending`, and
the website offers no button).

**Privacy behaviour found on the server (reported, not changed):** turning
the public profile off removes a rider from the main leaderboards and Top
contributors at once, and from Find riders, Social and notifications. The
public profile page is edge-cached for up to 60 seconds. The **streak
rankings are a daily snapshot** (worker/community-summary.js), so a rider who
just turned their profile off can stay listed there until the next daily run.
Public sightings never name the submitter.

## Feature-parity checklist

Status: ✅ native · 🌐 website fallback in the app · ⏳ not started

| Area | Website page / API | Native | Phase |
| --- | --- | --- | --- |
| Sign in with Google | signin.html · `/oauth/google/*`, `/oauth/app/exchange` | ✅ | 1 |
| Signed-in account (name, avatar) | `/api/me` | ✅ | 1 |
| Sign out | (client-side, as on the web) | ✅ | 1 |
| Headline stats (registered Cybercabs, rides, sightings) | `/api/registry/stats` | ✅ | 1 |
| Home dashboard: hero, live stats bar, service status, Cybercab Daily, Service Zones facts, Fleet Growth, Texas DMV, Ride Stats, Sightings Activity | index.html · `/api/registry/stats`, `/api/daily`, `/api/homepage-stats`, `/api/dmv-registrations`, `/api/robotaxi-vehicles` | ✅ | 2 |
| Home: fleet-growth predictions, DMV predictions toggle | js/forecast.js | ✅ | 3 |
| Home: Austin/Dallas minimaps, US sightings map | index.html | ✅ | 3 |
| Vehicle registry (list, search by plate/VIN, city, sort, paging) | vehicles.html · `/api/robotaxi-vehicles` | ✅ | 2 |
| Vehicle details (plate, VIN, ride history, verified sightings, share) | vehicle.html · `/api/robotaxi-vehicles/:id`, `…/sightings` | ✅ | 2 |
| Post → vehicle (attached Cybercab opens the native vehicle screen) | `/api/social/*` | ✅ | 4 |
| Vehicle → its Social posts | none: the website has no such view and the API can't filter posts by vehicle | — (needs a new API) | — |
| Zones map (zones, charging, cameras, search, city switch, fleet & fares) | infrastructure.html · `/api/camera-sightings`, `/api/places/map`, `/api/fleet-stats` | ✅ | 3 |
| Heatmap (ranges, hour filter, camera stats) | `/api/camera-sightings/heat`, /data/traffic-cameras.json | ✅ | 3 |
| Replay | replay.html · `/api/camera-sightings/history` | ✅ | 3 |
| Sightings gallery + stats, moderator photo delete | sightings.html · `/api/sightings` | ✅ | 5 |
| Social feed, compose, photos, vehicle attach, reviews, likes, comments, replies, saves, share, reports, pins, announcement, notifications | community.html · `/api/social/*` | ✅ | 4 |
| Streaks, Leaderboard, Progress (XP, levels, ranks, missions) | `/api/streaks/*`, `/api/community/*`, `/api/xp/*` | ✅ | 4 |
| Public rider profiles, Find riders | rider.html · `/api/riders/:handle`, `/api/rider-search` | ✅ | 4 |
| Submit a sighting (photo, city, place, camera, plate), My sightings | drawer on every page · `/api/vehicle-sightings/photo`, `/api/places`, `/api/submissions` | ✅ | 5 |
| News | news.html · `/api/news` | ⏳ | 5 |
| Simulation: Fleet ROI, Fleet ETA, fare reports | simulation.html · `/api/fleet-eta`, `/api/fare-reports` | ⏳ | 5 |
| Texas DMV roster | dmv.html · `/api/dmv-registrations` | ⏳ | 5 |
| Rider data (rides, sync), Link Gmail | rider-data.html, link-gmail.html · `/api/trips`, `/api/receipt-ingestion/*`, `/api/rides/*` | 🌐 (Account link) | later |
| Profile settings, avatar, privacy switch, account deletion | profile.html · `/api/profile*`, `/api/account` | ✅ | 5 |
| Tesla account link | `/oauth/tesla/*` | ⏳ | 5 |
| Moderation: sighting review, approved images and Zones map, Social reports, pins, announcement | moderation.html · `/api/moderation/vehicle-sightings*`, `/api/moderation/social/*` | ✅ | 5 |
| Moderation: Registry Vehicles, News, Gmail Link, Import Receipt | moderation.html, moderation/import-receipt.html · `/api/moderation/robotaxi-vehicles*`, `…/news*`, `…/forwarding-*`, `…/riders`, `…/receipt-import` | ✅ | 5.1 |
| Moderation: fare reports | simulation.html's moderator view · `/api/moderation/fare-reports*` (not on moderation.html) | ⏳ with Simulation | later |
| Privacy policy | privacy.html | 🌐 (legal document, shown as published) | — |
| Siri / App Intents, widgets, Live Activities, push, Apple Intelligence | — | ⏳ | 6 |
