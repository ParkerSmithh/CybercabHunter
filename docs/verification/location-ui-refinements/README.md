# Location Services UI refinements

> Historical validation report. Obsolete nearby-sightings directions have been removed; retained raw logs describe the build tested at that time. Current behavior is established by the latest source and regression results.

## Changes

- Removed the Location Services update's Nearest Cameras toggle, coordinate/distance sorting, camera distance labels, camera location requests/feedback, and unused camera ranking helper/test. Renamed NearbyCamerasView to CamerasView. The Cameras entry remains and lists the complete inventory alphabetically using the same default sort as before. Existing details, captures, heat statistics, maps, filters and data/API services are preserved.
- Replaced the permanent bottom location card with a content-sized, dark, subtly bordered, gold uppercase badge directly below the Austin/Dallas selector. City controls, Search and My Location retain their positions. The badge wraps within its left column on narrower layouts, leaving the right control column clear.
- Inside states name the city; outside reads `OUTSIDE SERVICE ZONES`; errors read `LOCATION UNAVAILABLE`. Uncertainty reads `ZONE BOUNDARY UNCERTAIN`; unavailable geometry reads `ZONE DATA UNAVAILABLE`; overlaps retain both zone names and the overlap label. Progress reads `FINDING LOCATION`.
- Tap the badge for the existing detailed status, approximate straight-line boundary distance, View Nearest Zone action, recorded accuracy/timestamp and optional location recovery controls. Explanatory text is no longer permanently over the map.
- Polygon membership, accuracy decisions, boundary projection/distance calculations and data are unchanged. Only the unused camera-ranking extension was removed from ZoneProximity. The geometry engine body was compared byte-for-byte before/after.

The pre-existing Siri answer text mentioning nearby cameras remains unchanged: it predates the removed UI feature and is part of the explicitly protected Siri implementation.

## Files changed

- `ios-native/CybercabHunter/Features/Zones/ZonesView.swift`: badge placement, optional details popover, CamerasView reference and Debug-only screenshot fixtures.
- `ios-native/CybercabHunter/Features/Zones/NearbyCamerasView.swift` → `CamerasView.swift`: remove proximity UI/logic; retain normal camera inventory and details.
- `ios-native/CybercabHunter/Features/Zones/ZoneStatusText.swift`: compact uppercase presentation, independent of geometry.
- `ios-native/CybercabHunter/Core/Location/ZoneProximity.swift`: delete unused camera-ranking extension only.
- `ios-native/CybercabHunterTests/LocationTests.swift`: delete the removed camera-ranking test.
- `ios-native/CybercabHunterTests/ZoneStatusTextTests.swift`: inside/outside/overlap/uncertainty/data/permission/progress presentation tests.
- `ios-native/CybercabHunterUITests/LocationUITests.swift`: badge placement/size/control-clearance checks, normal camera inventory/details and absence of proximity controls, retained nearest-boundary action. Existing Sightings test body unchanged.
- Verification evidence and screenshots in this directory.

## Validation

Environment: isolated **iPhone 16 Pro Simulator**, iOS 27.0, 402 × 874 points / 1206 × 2622 pixels, Xcode 27.1. No connected-iPhone commands or permission changes were used for this update.

- **Build succeeded**, exit 0 (`/tmp/cch-location-ui-refinement-build.log`).
- **221 unit tests in 45 suites passed**, including existing location, geometry, networking, camera-data and Siri regressions, plus the new presentation tests.
- **All three UI cases covering this request passed**: compact outside status with retained distance/action; Dallas badge placement, uppercase text, control clearance and normal Cameras inventory/details; existing Zones heatmap, overlays and Replay flow.
- The Dallas test asserts badge height below 48 points, content width below full map width, left alignment with the city selector, a small gap below it, no overlap with Search, and My Location still below Search and hittable.
- After all combined test cases completed, Xcode remained in result-bundle finalization without further progress and the completed process was stopped (exit 143). Console results and screenshots were preserved; no finalized combined bundle is claimed. The separate Sightings retry finalized with its assertion failures (exit 65). See `test-results.txt`. The separate final build completed normally (exit 0).
- **17 Siri metadata contract tests passed.** Exported definitions retain **22 intents, 10 advertised shortcut slots, 42 phrases** and match the installed build after canonicalizing compiler order of metadata key/value pairs and supported input-type collections. Phrase content/order, parameters and defaults are preserved. The supplementary standalone training-corpus check could not run because this simulator artifact did not emit `root.ssu.yaml`; no Siri source or indexing was changed.
- Source checksums verify the shared LocationService, ZoneMapView, ZonesModel, ZoneSearchSheet and all Siri files are unchanged. Permission configuration and project settings are also unchanged from the installed build. `git diff --check` passed.
- No backend/database/API changes, deployment, commit, push, merge, physical-device installation, uninstall, reset or location-permission change was performed.

My Location permission flow, blue dot and recentering retain their unchanged services/map code and passing mock tests; no real GPS or permission prompt was exercised during this refinement's simulator layout checks. Physical-device validation remains subject to installation approval.

## Screenshots

- [Dallas compact badge](zones-dallas.png)
- [Outside-zone compact badge after View Nearest Zone](zones-outside.png)

Screenshots were visually reviewed. They use Debug-only deterministic presentation fixtures derived from the existing bundled polygons, without changing location permission or system GPS. The outside screenshot was captured during the boundary camera move, so some base-map tiles had not loaded; the badge, controls and real boundary are visible.

The updated build has **not** been installed on the iPhone. Awaiting explicit approval before installation.
