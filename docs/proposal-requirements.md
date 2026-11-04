# Proposal requirements checklist

Source: the Semester Project Proposal, "Cybercab Hunter" (`Parker_Smith_Proposal_cbedits.docx`), sections 3a, 3c, 4 and 5. The file was read on Nov 3, 2026 and is no longer in `~/Downloads`; this was checked against the text saved then. No approved amendments are on file. The README's removed "My Spike Test" section describes changing the receipt plan, but that is the author's note, not an approved amendment.

Evidence was checked on Nov 4, 2026, locally, against the test Worker. "Website" and "iOS" name the main files. "Verified" means tested here, not that it has been checked on production.

| # | Proposal says | Website | iOS | Evidence | Status | Remaining |
|---|---|---|---|---|---|---|
| 1 | Community-based database tracking Cybercabs across multiple cities and service areas | `vehicles.html`, `worker/vehicles.js`, `worker/service-areas.js` | `Features/Registry` | `vehicle-registry`, `vehicles-api`, `registry-stats` tests | Complete and verified | None |
| 2 | Data used to track expansion across the country | Fleet stats, `dmv.html`, `/replay`, Austin and Dallas zones | `Features/DMV`, Replay, Zones | `fleet-stats`, `txdmv`, `fleet-timelapse` tests | Complete and verified | Only two service areas exist today; adding one is one config entry |
| 3 | Interactive map for each service area | `infrastructure.html`, `js/austin-map.js` | `Features/Zones`, `Features/Maps` | `camera-sightings`, `dallas-copy`, `map-search` tests; browser run | Complete and verified | None |
| 4 | Map shows charging stations | `js/austin-map.js`, Dallas hub in `infrastructure.html` | `ZoneMapView` | `camera-sightings` tests; screenshots | Complete and verified | None |
| 5 | Map shows locations cars were last seen | Camera detections (last 24 h); Following sightings | Same | `camera-sightings`, `following-map` tests | **Partially implemented** | **Decision needed.** All Sightings shows camera detections, which don't identify a car, and only for 24 hours. A car's approved rider sightings appear on the map only for its spotter's followers. See below. |
| 6 | Potential investors see what a fleet could earn | `simulation.html` Fleet ROI, PDF export | `Features/Simulation` | `simulation-page` test; browser PDF export | Complete and verified | Figures are a model with stated assumptions, not a forecast |
| 7 | Link your Tesla account and get ride stats | Fleet API OAuth links the account and vehicles; ride stats come from forwarded or Gmail-read receipts (`link-gmail.html`) | Account, Receipt sync | `tesla-oauth`, `tesla-rides`, `gmail-sync`, `receipt-pipeline` tests | **Blocked** as written | Tesla has no official ride-history API (`worker/tesla-ride-provider.js`). Receipts deliver the stats a different way, but that is a change from the proposal. Needs your sign-off or your instructor's. |
| 8 | Stats: vehicles used | `rider-data.html` | Rider Data | `rider-data-ui`, `trips-query` tests | Complete and verified | None |
| 9 | Stats: where you've gone | City breakdown only | Same | `rider-data-ui` test | **Partially implemented** | Rider Data shows cities, not pickup and drop-off places, though they are stored. Showing a rider their own places is a small change, but it is a privacy decision (`/api/trips` deliberately leaves addresses out). |
| 10 | Stats: how much you've spent, and more | `rider-data.html` | Rider Data | `rider-data-ui`, `phase2-stats` tests | Complete and verified | None |
| 11 | Global accounts to track users across the platform | Google sign-in, `/rider/:handle`, rider search | Same | `google-auth`, `rider-search`, `profile` tests | Complete and verified | None |
| 12 | Users can check each other's profile stats | `rider.html` | `RiderProfileView` | `profile`, `profile-sync` tests; `FollowUITests` | Complete and verified | None |
| 13 | Comment on and like each other's posts | `community.html`, `worker/social.js` | `Features/Community/Social` | `social`, `social-v2` tests; `CommunityUITests` | Complete and verified | None |
| 14 | Following others | `worker/follows.js`, `js/follows.js` | `FollowViews` | `follows` (121 checks), `following-map`; `FollowUITests` | Complete and verified | Signed-in use on production not yet exercised |
| 15 | See cars of users they follow on the map | `js/zones-following.js`, `GET /api/sightings/following` | `ZonesView`, `FollowingSpotSheet` | `following-map`; `FollowingMapUITests`; browser run | Implemented but not fully tested | Works locally on both platforms. **Not deployed.** Older sightings have no position until the backfill runs |
| 16 | A board of recent Cybercab sightings in cities | `sightings.html` | `Features/Sightings` | `sightings-gallery`, `sightings-api`, `sightings-stats` tests | Complete and verified | None |
| 17 | Anyone riding can help build the registry | Sighting submission, receipts, moderator approval | Submit a sighting, Share extension | `photo-sightings-api`, `moderation-api`, `registry-review-approval` tests | Complete and verified | None |
| 18 | Vehicle pages and growth data (the Texas database's gap, per section 4) | `vehicle.html`, `dmv.html` | `VehicleDetailView`, `DMVRosterView` | `vehicle-page`, `txdmv-activity` tests | Complete and verified | None |
| 19 | People feel safe tracking their personal data | `privacy.html`, private accounts, Remove data | Account, Privacy | `account-delete`, `follows`, `following-map` tests | Implemented but not fully tested | "Feels safe" can't be measured by a test. The privacy controls themselves are tested. |
| 20 | Long-term, maintainable platform; accurate data; users keep coming back | Tests, `docs/`, migrations | Same | 99 test files, `docs/deployment-and-migrations.md` | Implemented but not fully tested | Return visits are not tracked anywhere, so that part of section 5 has no evidence |

Not features, so not listed: the proposal's context, bibliography and format notes. It has an unresolved "(citation needed?)" beside the Texas Robotaxi Database and calls the project "Cybercab Tracker" once.

## Decisions needed

1. **Last-seen locations (5):** should All Sightings also show approved rider photo sightings? They would be anonymous, as in the gallery. This was left alone because the Following spec says All Sightings must stay as it was. The position data for it now exists.
2. **Tesla account stats (7):** accept receipts in place of a Tesla ride-history link. No code can close this while Tesla offers no official API.
3. **Where you've gone (9):** show riders their own pickup and drop-off places?
