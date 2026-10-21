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
5. **Remaining** — sighting submission (camera, library, optional location), News, Simulation (Fleet ROI, Fleet ETA), DMV roster, Rider data / Gmail link, profile settings, account deletion, moderation.
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
| Sightings gallery + stats | sightings.html · `/api/sightings` | 🌐 | 3/5 |
| Social feed, compose, photos, vehicle attach, reviews, likes, comments, replies, saves, share, reports, pins, announcement, notifications | community.html · `/api/social/*` | ✅ | 4 |
| Streaks, Leaderboard, Progress (XP, levels, ranks, missions) | `/api/streaks/*`, `/api/community/*`, `/api/xp/*` | ✅ | 4 |
| Public rider profiles, Find riders | rider.html · `/api/riders/:handle`, `/api/rider-search` | ✅ | 4 |
| Submit a sighting (photo, city, place, camera, plate) | drawer on every page · `/api/vehicle-sightings/photo`, `/api/places` | ⏳ | 5 |
| News | news.html · `/api/news` | ⏳ | 5 |
| Simulation: Fleet ROI, Fleet ETA, fare reports | simulation.html · `/api/fleet-eta`, `/api/fare-reports` | ⏳ | 5 |
| Texas DMV roster | dmv.html · `/api/dmv-registrations` | ⏳ | 5 |
| Rider data (rides, sync), Link Gmail | rider-data.html, link-gmail.html · `/api/trips`, `/api/receipt-ingestion/*`, `/api/rides/*` | ⏳ | 5 |
| Profile settings, avatar, account deletion | profile.html · `/api/profile*`, `/api/account` | ⏳ | 5 |
| Tesla account link | `/oauth/tesla/*` | ⏳ | 5 |
| Moderation (all tabs) | moderation.html · `/api/moderation/*` | ⏳ | 5 |
| Privacy policy | privacy.html | ⏳ | 5 |
| Siri / App Intents, widgets, Live Activities, push, Apple Intelligence | — | ⏳ | 6 |
