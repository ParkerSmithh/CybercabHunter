# Nearby-place lookup fix

## Diagnosis

Source inspection confirmed that the installed implementation did **not** perform a MapKit nearby-place search. It reverse-geocoded one street, queried two existing place services with that street, intersected their OSM IDs, and rejected results farther than 1 km. One generic catch conflated Apple geocoding errors with verified-service HTTP errors; there were no typed failure stages or candidate counts. It also rejected otherwise legitimate numeric business/address labels.

The exact failure on the iPhone remains unverified: Zones working does not prove that this flow received a recent, sufficiently accurate fix, and no phone trace or raw coordinates were collected. The old code provides several reproducible failure paths, rather than evidence identifying which occurred on that phone.

## Lookup after this change

1. Use the unchanged shared LocationService; accept only a valid, recent fix with reported accuracy at most 500 m. Denied/unavailable location is distinguished from an insufficient fix before searching.
2. Send that exact accepted location to an all-category `MKLocalPointsOfInterestRequest`, initially requesting a 1.5 km radius. If there are no compatible verified suggestions, try 3 km, clamped to MapKit's supported maximum.
3. Try at most three distinct nearby POI-name queries across those regions. Resolve names through the unchanged authenticated `/api/places` and public `/api/places/map` services for the selected city. Only real N/W/R OSM IDs present in both responses and within 3 km plus reported accuracy are selectable. Apple IDs are never converted or fabricated.
4. If no compatible POI is found, reverse-geocode a street as a sparse/residential-area fallback and apply the same verified-ID checks.
5. Require the user to select a suggestion and tap **Use selected place** before filling the form. The original query for that suggestion is retained for existing server verification. No automatic submission occurs. Manual search remains available.

Only public place/street search text and the selected city go to Cybercab Hunter. Raw phone coordinates are neither added to queries/submissions nor logged. Apple receives the location to perform the lookup, as disclosed before starting.

## Error handling and privacy

Distinct states cover location unavailable, insufficient accuracy/recency, Apple search failure, empty Apple results, verified-place service/session failure, and incompatible verified candidates. Apple's explicit MapKit no-match and geocoder no-result errors are treated as no results; network/server errors remain failures.

An optional **Lookup details** disclosure contains only safe counts, whether a fix was accepted, fallback usage, and integer error/HTTP codes. It does not include coordinates, searched names or addresses, and is not persisted or logged.

City selection still filters both existing place services and must remain the same at confirmation. The interface makes the selected city visible and suggests checking it when no compatible nearby result exists.

## Compatibility and limits

This works within the existing verified-place contract; no backend, API, moderation or submission schema changes are required. A MapKit place without a corresponding nearby OSM ID returned by both existing services remains unavailable. The server still re-verifies the selected ID on submission.

MapKit coverage, network availability, Photon ranking/label deduplication, city boundaries and sparse OSM coverage can still prevent a compatible suggestion. The search is intentionally bounded. No location-based sightings feed is implemented. Live Apple responses and the user's exact location require a physical-device retest; deterministic tests use synthetic locations and mock responses.

## Changed implementation files

- `ios-native/CybercabHunter/Features/Sightings/SightingPlaceSearch.swift`: new MapKit POI adapter and existing street fallback.
- `ios-native/CybercabHunter/Features/Sightings/SightingLocationModel.swift`: bounded lookup, verified compatibility, distinct failures, safe transient diagnostics.
- `ios-native/CybercabHunter/Features/Sightings/SightingLocationSheet.swift`: disclosure, selected city, distinct messages and safe diagnostic details.
- `ios-native/CybercabHunterTests/SightingLocationTests.swift`: regression coverage.

## Validation results

- Full unit suite: **242 tests in 46 suites passed**, including 21 nearby-place controller tests. Covered valid POIs, exact request coordinates, sparse expansion, empty responses, Apple errors, explicit Apple/geocoder no-match, incompatible IDs, city/distance filtering, verified-service failures, location unavailable/denied, confirmation/cancellation and no automatic submission or raw-coordinate backend fields.
- Selected existing UI tests: **6 passed, zero failures**, on **iPhone 16 Pro simulator, iOS 27.0**, using Xcode 27.1 / SDK 27.1. Included disclosure/cancel, editable manual fallback, compact badge/boundary details/View Nearest Zone, control placement/Cameras removal, Siri map route and Heatmap/Replay. These tests do not request GPS or change permissions. The broader unrelated UI suite was not run.
- Siri metadata regression tests: **17 passed**. Exported actions, shortcuts and enums match the last approved device build after normalizing unordered SDK metadata: **22 intents, 10 advertised shortcuts, 42 phrase templates**. See `siri-metadata.json`.
- Simulator test builds succeeded. `git diff --check` passed.
- All protected-file SHA-256 checks passed (`preserved-check.txt`): shared Location Services/geometry, Zones/maps, existing sightings/submission and moderation/backend code, and Siri source files are unchanged from the start of this fix. No Swift references to deleted `CamerasView` remain.
- Screenshot inspection at **1206 × 2622 px / 402 × 874 points** passed for the updated disclosure and preserved Zones layout. `zones-preserved.png` uses the existing synthetic Dallas status fixture, not a live GPS fix.
- Xcode emitted existing SDK build-number/debugger warnings; neither test run failed.

Result bundles remain local at `/tmp/cch-nearby-fix-final-units.xcresult` and `/tmp/cch-nearby-fix-ui.xcresult`. Raw test logs were not copied into the report.

Screenshots: [Nearby-place disclosure](nearby-place-disclosure.png), [preserved Zones map](zones-preserved.png).

## Physical-device retest after installation approval

1. Sign in, open Submit a Sighting and choose the current city. Tap Use Current Location, review the disclosure and tap Find nearby place.
2. Confirm that legitimate nearby suggestions appear. Selecting a row alone must not fill or submit the form; tap Use selected place to fill it.
3. Confirm that the chosen label appears in the form, existing notes/photo remain, and nothing is submitted automatically. Cancel without sending a test sighting to production.
4. Try a sparse/residential area. If there is no compatible result, use Search manually instead and confirm manual selection remains available.
5. If lookup fails, report the failure title and safe counts/error codes under Lookup details. Do not send GPS coordinates. Do not change permissions just for this test.
6. Check Zones My Location, compact uppercase badge, boundary details and View Nearest Zone; check Heatmap/Replay and markers, and confirm the Cameras control remains absent.

No phone installation, permission/data reset, production write, backend change, migration, commit, push, merge or deployment is part of this validation.
