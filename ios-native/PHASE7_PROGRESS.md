# Phase 7 progress (paused Oct 22, 2026; testing resumed and completed the same day)

**Status: all Phase 7 testing complete. Every test passed.** The interrupted
regression tests were rerun after the pause (`reg2.log`): Phase6UITests
`testWidgetsAreInTheHomeScreenGallery` passed, and SightingsAccountUITests
passed 5/5. Still uncommitted; nothing committed, pushed, merged or deployed.

Paused at the owner's request (Mac shutdown). Nothing was committed, pushed,
merged, deployed or reset. All work is uncommitted on the branch below.

- **Branch:** `claude/phase7-remaining-native` (created from `claude/phase6-native-extras`; keeps the uncommitted work of Phases 5.1–6)
- **Simulator:** iPhone 18 Pro `AC3027CC-AD0B-4091-8223-69DDF4364FFE`
- **Results folder:** `~/Library/Developer/CybercabHunterTestResults/20261022-phase7/` (logs and `.xcresult` bundles)
- Details of what was built: `ios-native/PLAN.md`, section "Phase 7: Remaining native features".

## Completed features (built, tested)

1. Simulation: Fleet ROI, Fleet ETA, fare report form (`Features/Simulation/`, `Core/Models/FleetEta.swift`)
2. News (`Features/News/`)
3. Texas DMV roster (`Features/DMV/`), plus Home › Explore and the Home DMV-panel link (`Features/Home/ExploreSection.swift`)
4. Rider data, and Receipt sync (Gmail *forwarding*: no Gmail OAuth, no tokens) (`Features/Rider/`), linked from Account
5. Tesla link status, link via Tesla's own page, and unlink, for moderators only, as on the website (not tested end to end with a Tesla account)

Also:
- Bug fix: the Fleet ETA demand slot was locale-dependent (`SimulationCalc.slot`).
- Test Worker seed: a test receipt domain, a Gmail code for alice, and 4 new fixtures (`scripts/community-test-server.mjs`).
- PLAN.md and README.md updated.

## Test results

| Run | Result |
| --- | --- |
| Debug build | ✅ succeeded |
| Release build (generic iOS Simulator) | ✅ succeeded |
| Unit tests, all phases (`unit2.log`) | ✅ 122/122 passed (24 new in `Phase7Tests`) |
| Phase7UITests (Simulation, News, DMV; live site, read only) (`ui6.log`) | ✅ 3/3 passed |
| Phase7AccountUITests (Rider data, Receipt sync, Tesla status; test Worker) (`ui6.log`) | ✅ 3/3 passed |
| Regression `reg.log`: CommunityUITests | ✅ 4/4 passed |
| Regression: Phase51UITests | ✅ 5/5 passed |
| Regression: Phase6UITests | ✅ 2 passed (`testSubmitSightingShortcutOpensTheForm`, `testWidgetLinksOpenTheirTabs`); ✅ `testWidgetsAreInTheHomeScreenGallery` passed on the resumed run (`reg2.log`) |
| Regression: SightingsAccountUITests | ✅ 5/5 passed on the resumed run (`reg2.log`) |

No test failed in the final runs. The Gmail test's code assertion and the
iOS 26 dialog dismissal were fixed during the work; the Simulation test's
expected value was corrected earlier.

## Outstanding

- Tesla linking was not exercised against a real Tesla account. Tesla's
  callback returns to the website, not the app.
- Still blocked from Phase 6: Live Activities and push notifications (need a
  paid Apple Developer account, an APNs key and a Worker sender).
- Cosmetic: the long forwarding address can wrap mid-token.

## Resume testing

```sh
cd ~/Downloads/Website
git branch --show-current          # expect claude/phase7-remaining-native
xcrun simctl boot AC3027CC-AD0B-4091-8223-69DDF4364FFE; xcrun simctl bootstatus AC3027CC-AD0B-4091-8223-69DDF4364FFE -b
cd ios-native
R=~/Library/Developer/CybercabHunterTestResults/20261022-phase7

# The interrupted regression tests (starts the isolated test Worker on 127.0.0.1:8799 itself):
ONLY="CybercabHunterUITests/SightingsAccountUITests CybercabHunterUITests/Phase6UITests/testWidgetsAreInTheHomeScreenGallery" \
  DESTINATION="id=AC3027CC-AD0B-4091-8223-69DDF4364FFE" scripts/test-community.sh \
  -derivedDataPath ~/Library/Developer/CybercabHunterTestResults/dd -parallel-testing-enabled NO \
  -resultBundlePath $R/reg2.xcresult > $R/reg2.log 2>&1
grep -E "Test Case.*(passed|failed)|\*\* TEST" $R/reg2.log

# Optional full re-check of Phase 7 (unit, then UI):
xcodebuild -project CybercabHunter.xcodeproj -scheme CybercabHunter -destination "id=AC3027CC-AD0B-4091-8223-69DDF4364FFE" \
  -derivedDataPath ~/Library/Developer/CybercabHunterTestResults/dd -parallel-testing-enabled NO -only-testing:CybercabHunterTests test
ONLY="CybercabHunterUITests/Phase7AccountUITests CybercabHunterUITests/Phase7UITests" \
  DESTINATION="id=AC3027CC-AD0B-4091-8223-69DDF4364FFE" scripts/test-community.sh \
  -derivedDataPath ~/Library/Developer/CybercabHunterTestResults/dd -parallel-testing-enabled NO
```

Run one test session at a time. If xcodebuild hangs after a failure:
`pkill -f "xcodebuild.*CybercabHunter"; pkill -f community-test-server.mjs`.

---

# Website-parity audit (Oct 22, 2026; in progress)

Reference: the live mobile website, captured with WebKit at 393×852 (and a
small iPhone width) from the website's own source/assets; native compared on
the iPhone 18 Pro simulator. Uncommitted on `claude/phase7-remaining-native`.

## Batch 1 (done, verified in ParityUITests)

| Page | Website element | Native before | Severity | Fix | Verified |
| --- | --- | --- | --- | --- | --- |
| Fleet ROI / Fleet ETA | Interactive Cybercab (js/cybercab-doors.js: 108 frames, 1.5 s ease-in-out, tap car or "Open doors", reverses mid-swing, reduced motion jumps) | missing | P0 | `CybercabDoorsView` (DesignSystem/FrameSequence.swift) from the same frames (Resources/Frames/CybercabDoors, the site's 480 px set), in a shared `SimHero` header | ✅ opens/closes (screenshots roi-closed/roi-open) |
| Fleet ROI | "Inputs · Results · Breakeven / FLEET ECONOMICS"; one gold card with dmv-cybercab.webp, icon groups Network & fare / Fleet / Energy, full-width Export; three glow result tiles; Breakeven card title | metrics grid, no car, export at the bottom | P1 | rebuilt to the site's structure (SimulationComponents.swift) | ✅ |
| Fleet ETA | mix card with per-model cards and car pictures; "RIDE, HOURS & WAIT" heading; trip card; model cards with car top-right, icon labels, status capsule | no pictures, one big card | P0/P1 | rebuilt; estimates/calculations unchanged | ✅ |
| News | "CYBERCAB NEWS" (NEWS gold), Stories-tracked cell with CybercabFlipped.png, hairline stats bar, pill pair, gold-rule section heads, major cards with gold left bar, outlined PRESS chip, disclosure at the end | no Cybercab, different hierarchy | P0/P1 | rebuilt to css/style.css (mobile rules) | ✅ |
| Home hero | film once, then scroll-driven door frames (hero pinned while the doors open); reduced motion: poster | static poster | P0 | `HomeHeroMedia` (film from /videos/cybercab-animation-web, frames bundled from images/hero-frames/m), pin over 300 pt | ✅ (film, half-open, open) |
| Home buttons / avatar | — | — | — | done earlier (compact buttons, no glass bubble) | ✅ |

## Batch 2 (done)

| Page | Website element | Native before | Severity | Fix | Verified |
| --- | --- | --- | --- | --- | --- |
| Home · Fleet Growth | "In the registry" featured tile with CybercabFlipped.png; gold "Timelapse ▶" replaying the line (4/6/8 s, ease-in-out, pause/resume/replay, "N Cybercabs · date" readout, reduced motion → finished view); title "FLEET GROWTH · CYBERCAB" | plain metric, no timelapse, title "· Austin" | P1 | featured tile + native timelapse in `FleetGrowthSection` | ParityUITests.testFleetGrowthTimelapseAndRegistryButton |
| Home · Texas DMV | gold "View Registry · N VINs · from TxDMV" button above the source note | "Every VIN on the roster →" text link | P1 | the website's button (same `dmvEveryVin` id, same destination) | ✅ opens the roster |
| Home · Live now | car bobbing over a scrolling gold dashed road (sb-bob 2.6 s, sb-road 0.8 s); parked: grey, no road | static car | P1 | `LiveCar` (TimelineView + Canvas); reduce motion: still | build + screenshots |
| Community | hero car slides in (cch-car-in 0.9 s) | static | P2 | `CommunityHeroCar` | build |
| Fleet ROI | "$" shown in grey before the electricity rate; values white | gold values, no "$" | P2 | `SliderRow` | screenshots |

## Page-by-page result

| Page | Checked against the mobile site | Result |
| --- | --- | --- |
| Home | hero, buttons, stats bar, Live now, Daily, Service zones, minimap, Fleet growth, Texas DMV, US sightings, Ride stats, Sightings activity | fixed above; the rest matched |
| Zones | map, zone polygon, markers, controls, legend, Replay, Normal/Heatmap | matches (native MapKit; the site uses MapLibre/CARTO tiles, so base-map styling differs by platform) |
| Cars | header, city pills, search, sort, cards with dmv-cybercab image, stats rows | matches (search above the pills on iOS: native placement) |
| Sightings | header, Replay Map, six stat cards, city/sort pills, photo grid | matches; the sort is a saved preference (a test had picked "Least recent") |
| Community | tabs, hero with car, stats, sign-in prompt, feed tabs, Trending, Top contributors, Rules | matches; the site shows the 4 stats in one row on phones without notes, the app 2×2 with notes (kept: notes explain each number) |
| Simulation | Fleet ROI, Fleet ETA, fare report | fixed (batch 1) |
| News | everything on news.html | fixed (batch 1) |
| Texas DMV | roster, filters, search, table | matches |
| Account / Rider data | rider-data hero car is desktop-only (`hidden lg:block`); stats, rides, Gmail forwarding | matches the phone layout |

## Verification (Oct 22, 2026)

- Debug build ✅; Release build ✅ (108 door frames + 73 hero frames bundled; app 52 MB).
- iPhone 18 Pro (402 pt): unit 122/122; UI 19/19 — ParityUITests 4/4, Phase7UITests 4/4,
  HomeButtonsAvatarUITests 2/2, NavigationUITests 1/1, RefinementUITests 4/4, ZonesUITests 4/4 (`audit1.log`).
- iPhone 17e (390 pt, the narrowest iPhone the iOS 27 simulator offers; SE / mini are
  "Incompatible device"): ParityUITests 4/4, HomeButtonsAvatarUITests 2/2 (`small.log`,
  `small2.log`; one height check needed a 0.5 pt rounding tolerance: 43.99999 vs 44).

## Remaining differences (with reasons)

- Zones base map: MapKit on iOS vs MapLibre/CARTO tiles on the site (platform).
- Community stats: 2×2 with explanatory notes in the app; the site shows 4 in a row without notes on phones (kept for clarity, P2).
- Small pulse effects on the site (map marker rings, US-map city pulses, chart end-dot glow) are not reproduced (P2).
- The hero pin is 300 pt in the app (the site pins for 70% of the screen height) so Home stays quick to scroll.
- The Home film streams the website's own video (8.6 MB); offline or in Low Data Mode the app goes straight to the frames.

---

# iPhone polish pass (Oct 22, 2026, from the owner's device screenshots)

| # | Issue | Cause | Fix | Verified |
| --- | --- | --- | --- | --- |
| 1 | Home: blank band under the hero buttons | the hero pin reserved 300 pt of empty scroll room (`padding(.bottom, openDistance)` + offset) | no pin, no reserved space; the doors open over 200 pt as the hero scrolls out (the site's flow mode), with a 0.5× parallax so they're seen | PolishUITests.testHomeStatsFollowTheHero (stats < 120 pt under the buttons, on the first screen) |
| 2 | Sighting description placeholder against the top edge | multi-line field used the single-line `inputBox` (no vertical inset) | `inputBox(multiline:)`: 12 pt inset all round, top-leading | screenshots empty/typed; other multi-line fields already inset |
| 3–4 | Simulation pictures cropped / hanging off cards | offset + clipped backgrounds | one size (128 pt), aspect-fit, wholly inside each card at its inset; headings leave room (`TintCard.headingInset`); mix cards centre the car on the right | screenshots |
| 5 | Car cards too tall | stacked labels and a 24 pt ride count | header row (badge + plate · car), "City · N rides" line, one-line facts (`ViewThatFits` falls back to two lines) | card height < 200 pt (was ~260) |
| 6 | Community tabs overflow | fixed padding in a horizontal ScrollView; larger Dynamic Type | `ViewThatFits`: normal → tighter → equal-width with a 0.7 minimum scale; ≥ 44 pt targets | all four inside the screen |
| 7 | News All/Major uneven | 44 pt button frame around a 34 pt pill in a 3 pt-padded capsule | both segments 38 pt, capsule outline as background, gold selection via `matchedGeometryEffect` | equal heights/centres in both states |
| 8 | Zones capture zoomed in | `scaledToFill` in a vertical ScrollView (unbounded height) | aspect-fit, max 420 pt, centred on dark; also exposed to VoiceOver as one image | the full photo (screenshot) |
| 9 | Heatmap panel covers the map | always-expanded panel | collapsed bar (summary + expand), expands to the full panel; collapse keeps mode/range | ZonesUITests + PolishUITests |
| 10 | Replay Day/Dusk/Night | — | the website has no selector: its Replay washes the map with a sky that follows the replay's clock. Added that sky (js/replay.js TINT_KEYS) and phase chip colours, plus Map: Auto · Day · Dusk · Night (Auto = website) | screenshots of each |

## Oct 22 (late): keyboard, Zones header, Apple Maps-style search

- Cars keyboard: focus was handed between the header and floating search fields as they swapped while scrolling (re-opening the keyboard), going back from a car restored focus, and nothing dismissed it. Now: `.scrollDismissesKeyboard(.immediately)`, Search/Done (keyboard toolbar), taps on the header/empty space, focus cleared before a car opens and on appear/disappear, the filter is a UIKit menu button whose `menuActionTriggered` resigns, and any tab change resigns app-wide. KeyboardZonesUITests passes.
- Zones header strip: iOS 26's scroll edge effect (applied to every tab's stack) drew a band over the map. Zones now hides it (`scrollEdgeEffectHidden`); other tabs keep the soft fade.
- Zones search: a sheet (medium/large detents, map interactive behind at medium) with recents (on-device, ≤6 per city), Austin/Dallas, charging locations, and live `/api/places/map` results limited to the selected city. ZoneSearchUITests passes.

## Compact Home (below the Austin minimap)

Measured with HomeHeightUITests (Debug-only `homeHeights` element), iPhone 18 Pro:
total 6,440 → 4,820 pt (−25%); below the minimap 4,576 → 2,956 pt (−35%, −1,620 pt ≈ 2 screens).
iPhone 17e: total 4,824, below 2,961.

- Fleet growth: key number + three one-line stats; timespan + Predict on one row (horizon only when predicting); chart 190→140, bars 36→22; explanations behind ⓘ.
- Texas DMV: compact 3-metric row; Cybercab / Model Y side by side; controls on one row; chart 200→140; source note behind ⓘ; View Registry kept.
- US sightings: totals + Dots/Heatmap on one row; map ≤190 pt; top 3 states; "All 27 states and 211 cities" opens a sheet with every state, city and the credited sources.
- Ride stats / weekly fare: chart 150→110; method note behind ⓘ.
- Sightings activity: 2-column metrics, chart 160→110, top spots inline, the 3 newest sightings (See all → Sightings).

## Texas DMV tracker expansion + Austin zone expansion (Oct 23, 2026) — not committed, not deployed

**Backend** (`worker/txdmv-activity.js`, `migrations/0047_dmv_activity.sql` — NOT applied to production):
change detection per snapshot (new / missing / returned; baseline; truncated rosters held, never events),
NHTSA vPIC decoding cached in D1 (cross-checked with TxDMV's label; conflicts stay unknown), milestones,
and `GET /api/dmv/{overview,growth,activity,activity/:date,vins,vins/:vin}`. The cron runs it after each poll.
`tests/txdmv-activity.test.mjs` 39/39.

**Website**: `public/dmv.html` + `js/dmv-tracker.js` (overview, new-VINs chart, activity, insights,
milestones, dataset, history with filters, VIN directory, update/VIN dialog); `js/dmv-panel.js` v16
("View DMV Tracker · +N newly detected"). Checked in WebKit at 1440 and 393 px against the local dev
server (real snapshots, read-only copy): no console errors, no horizontal scroll.

**Native**: `Features/DMV/DMVTracker.swift` (models) + `DMVRosterView.swift` (tracker, history,
update detail, VIN sheet); Home DMV button → "View DMV Tracker · +N newly detected".
| Run | Result |
|---|---|
| Unit: DMVRosterTests, DMVTrackerTests, WebDataSyncTests | ✅ 9/9 |
| DMVTrackerUITests on iPhone 18 Pro (dev server :8791) | ✅ 3/3 (`dmv-ui-pro2.log`) |
| DMVTrackerUITests on iPhone 17e | ✅ 3/3 (`dmv-ui-17e.log`) |
| Release build (simulator) | ✅ |
| Website node suite | 90 files pass; the 4 pre-existing failures unchanged |

**Austin zone**: south-east edge expanded (traced from the owner's screenshots; 35 → 42 vertices,
264 → 272 mi²) in `js/austin-map.js`, `index.html`, `infrastructure.html`, `WebData/zones.json`
(sync script), `worker/service-areas.js`, `js/calc.js` and `SimulationCalc.swift` (ETA area).

### Workers Free safeguards (Oct 23, 2026) — not deployed; migration 0047 not applied
Official Free limits verified today: 100k requests/day; 10 ms CPU per request and per cron; 50 subrequests
per invocation (fetch + D1 + KV + Cache API together); D1 50 queries/invocation, 5M rows read and 100k rows
written per day; 5 cron triggers per account; KV 100k reads / 1k writes per day.
- Processing = bounded steps (`runDmvStep`): the snapshot comparison runs in SQL (one guarded, all-or-nothing
  batch per snapshot), 3 snapshots and 3 vPIC calls of 20 VINs per step, an explicit subrequest budget.
  Off until `txdmv:activity:mode` (KV) is `on` or `backfill`; no new cron, no public trigger.
- Decode queue with backoff (1 h → 7 days, max 10 attempts); TxDMV labels meanwhile; never "verified" unless both agree.
- Reads: `dmv_summary` row instead of counting the roster; directory total/years on page 1 only; registry VIN index;
  Home's "+N newly detected" rides on /api/dmv-registrations (no second request).
- Clients: website 3 API requests per load, none idle/resize, lazy history/directory, cancelled stale searches;
  iOS 5-minute response cache (no refetch on reappear or sheet reopen), pull-to-refresh forces.
- Tests: txdmv-activity 57/57, txdmv 29/29, real-data verify all PASS, iOS unit 9/9, DMV UI 3/3 on 18 Pro and 17e,
  website suite 90 files (same 4 pre-existing failures, identical lines). Free simulation of the real cron handler:
  daily-only finishes in ~22 days (worst invocation 40 subrequests / 4 ms CPU); backfill mode ~10 h (worst 31 / 1.5 ms).

### Production deployment (Oct 23, 2026, owner-approved)
- Backup: D1 export `~/Downloads/cybercabhunter-backups/cybercabhunter-db-pre0047.sql` (restores: 49 tables) + Time Travel
  bookmark `0000169d-00000002-0000510d-3d25a6038d8b3e49fa47638da664eae9`.
- Migration 0047 applied (12 commands). dmv_snapshots / dmv_av_vehicles row hashes identical before and after.
- Worker + site deployed: version 79384469-5b5c-4369-b2d1-8fcb7e0bf62b (same 4 crons). Live checks: all pages 200, no JS
  errors, Austin 272 mi² + new boundary, DMV 858 / 351 / 507, "activity being processed" state.
- `txdmv:activity:mode` = backfill at 17:20 UTC. First step 17:25 UTC: Oct 9 baseline 739, Oct 10–11 unchanged
  (10 subrequests). News kept running (17:45 UTC tick). Backlog expected done ≈ 03:30 UTC Oct 24, then mode → on.
- iOS: Release build OK; installed on iPhone 16 Pro (in place). Live DMV UI test passed against production.
