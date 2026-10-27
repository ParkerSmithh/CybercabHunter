# Remaining Location Services features — implementation report

> Historical validation report. Obsolete nearby-sightings directions have been removed; retained raw logs describe the build tested at that time. Current behavior is established by the latest source and regression results.

## Status

**Use Current Location for Sighting: implemented and locally validated.**


## Files changed

New:
- `ios-native/CybercabHunter/Features/Sightings/SightingLocationModel.swift`: cancellable Apple street lookup, exact-ID matching of existing verified/map-place responses, on-device proximity checks and explicit confirmation.
- `ios-native/CybercabHunter/Features/Sightings/SightingLocationSheet.swift`: disclosure, user-initiated location lookup, suggestions/selection/confirmation, accuracy/errors, Settings recovery and manual fallback.
- `ios-native/CybercabHunterTests/SightingLocationTests.swift`: ten mocked behavior/privacy/verification tests.
- `ios-native/CybercabHunterUITests/SightingAutofillUITests.swift`: disclosure/cancel and manual-fallback UI checks against the isolated test Worker.

Modified:
- `ios-native/CybercabHunter/Features/Sightings/SubmitSightingView.swift`: replace the unavailable alert with the optional suggestion sheet. Choose a city first; manual entry remains available.
- `ios-native/CybercabHunter/Features/Sightings/SubmitSightingModel.swift`: allow `pick` to receive the exact original lookup query after explicit confirmation; its default preserves manual selection behavior. Submission fields, endpoint, validation, photo handling, moderation and other requirements are unchanged.
- This report, approval proposal, screenshot and verification evidence.

Xcode synchronized folders include the new Swift files without project edits. Other existing workspace changes were preserved.

## How verified-place autofill works

1. Choose the existing City/Service Area and tap Use Current Location. The sheet explains that Find nearby place will send the current fix to Apple's geocoding service and search the resulting street name and selected city with Cybercab Hunter's existing place service. Opening the sheet alone makes no GPS/geocoding request.
2. Find nearby place explicitly activates the existing shared one-shot LocationService. It requests When In Use only if needed and retains the existing denied/restricted/unavailable/timeout behavior. Settings and manual fallback remain optional. No second location manager, temporary precise-accuracy request or background tracking is added.
3. A fix must be valid, less than 60 seconds old at lookup start, and have reported horizontal accuracy of 500 meters or better. Coarser/reduced fixes safely fall back to manual search, with their reported accuracy displayed. The user is never forced to enable Precise Location.
4. Apple's CLGeocoder reverse-geocodes the fix to a street name (`thoroughfare`), not a house number. It is a network-backed Apple lookup, performed only after the disclosed Find action. The iOS 18-compatible API remains available in the current SDK but is deprecated in newer SDK documentation; [Apple's documentation](https://developer.apple.com/documentation/corelocation/clgeocoder) describes its network use and current successor APIs. No new non-Apple external provider was introduced.
5. The app searches the existing authenticated `/api/places?q=<street>&area=<city>` and public `/api/places/map?v=2&q=<street>&area=<city>` endpoints. These use the already-approved Photon/OpenStreetMap backend. Only the street query and selected city are sent, never the user's latitude/longitude. Neither endpoint was changed.
6. Offer only exact ID matches across both responses, valid existing `N:`, `W:` or `R:` IDs and usable public map coordinates. Exclude house-number-prefixed suggestions and entries more than 1,000 meters from the recorded fix. Distances use Core Location's geographic distance calculation on device and are shown as approximate straight-line miles. This identifies nearby public place anchors, not live vehicles or an exact position along a long street.
7. The user selects a suggestion and explicitly taps Use selected place. Only then is the existing verified-place field populated, with the server-provided ID/label and original street query. A changed selected city or cancelled/old lookup cannot confirm a stale suggestion. Nothing submits automatically; photo, date, plate, notes and full review remain under the user's control.
8. Editing after confirmation invalidates the selected place under the existing manual-edit behavior. The normal submission API still re-verifies the ID/query and selected area server-side and can reject a changed/unavailable place. This client does not bypass verification or construct IDs from Apple identifiers.

## Privacy and preservation

- Raw GPS is sent to Apple only after the explicit disclosed Find action. The selected street query/area is sent to existing Cybercab Hunter search; this textual location disclosure is explained before lookup. Exact GPS is not inserted into form fields, notes, photos or the submission payload by this feature.
- No raw-coordinate logging, analytics, location history, new endpoint, cache clearing, periodic polling, Always authorization, background mode or database/schema change.
- Cancellation, dismissal and backgrounding cancel the location request, lookup task and geocoder. Generation checks reject late results; no place is inserted without confirmation. A current fix remains only in the pre-existing shared in-memory service, not a history store.
- `preserved-before.sha256` verifies all Siri files, the shared location service, geometry/map/search/badge code, the latest Zones removal, existing Sightings model/view and backend place/sighting/database source are unchanged.
- CamerasView remains deleted. Nearest Cameras and the Zones Cameras button/page are not restored. Heatmap, Replay, markers, service-zone geometry, blue-dot/recentering code and View Nearest Zone are unchanged.

## Validation results

- Final full suite: **231 unit tests in 46 suites passed**, command exit 0, `TEST SUCCEEDED`. Includes ten new tests for explicit initiation, exact nearby ID compatibility, confirmation/no submission, coordinate-query/payload isolation, missing/invalid/far map positions, numeric-address/fabricated-ID exclusion, stale/coarse accuracy, lookup failure, cancellation/late results, selected-city changes, and mocked permission grant/deny/restriction/unavailability. All existing manual-place, submission, location, geometry and Siri unit regressions passed.
- **Four targeted UI tests passed**, command exit 0, on iPhone 16 Pro Simulator at 402 × 874 points / 1206 × 2622 pixels, iOS 27.0, Xcode 27.1. New disclosure/cancel/manual editing checks used the real existing Worker code in an isolated in-memory localhost harness. Preserved Zones absence/layout and outside-boundary action tests also passed.
- The UI tests did not request GPS, grant permissions, call Apple, submit photos or write production data. Lookup, matching, confirmation and permission error paths use deterministic unit mocks. Live Apple geocoding and final user-place acceptance require physical/manual validation after installation approval.
- Final local Simulator build succeeded, exit 0. **17 Siri metadata contract tests passed**, retaining **22 App Intents, 10 advertised shortcut slots and 42 phrase templates**. All Siri source hashes match the pre-task snapshot. Static checks confirm unchanged submission form serialization and no backend/migration changes, new background tracking, Always requests, coordinate logging or location history.
- Live public Austin and Dallas response shapes were checked read-only (HTTP 200, two records each), with no credentials, user coordinates or writes. Only field-name summaries are retained in `public-response-shape.json`.

Results: `/tmp/cch-sighting-autofill-final-units.xcresult`, `/tmp/cch-sighting-autofill-ui.xcresult`; logs `/tmp/cch-sighting-autofill-final-units.log`, `/tmp/cch-sighting-autofill-ui.log`, `/tmp/cch-sighting-autofill-build.log`. See `test-results.txt` and `siri-tests.txt`.

## Screenshot

[Autofill privacy and manual-fallback screen](disclosure.png), captured and visually reviewed on iPhone 16 Pro Simulator.

## Known limitations

Submission suggestions depend on Apple's network geocoder and overlapping results from the two existing place endpoints. Apple/OSM naming differences, long streets whose representative point is distant, no matching verified ID, poor accuracy, a city far from the phone, service/network failure or a changed place can require manual selection. No fabricated ID, city-center substitute or raw-GPS form fallback is used. Accuracy is an estimate; a suggested place is not a guarantee of where a historical photo was taken. Only the user's confirmation can make it the chosen place.

No live permission or GPS behavior was certified on a physical iPhone. The iOS 18-compatible geocoder may require a future version-gated migration when Apple removes deprecated APIs; no unsupported API or new minimum OS was introduced here.

## iPhone 16 Pro checklist — after separate installation approval

No new build has been installed. Do not uninstall/reset the existing app or change Siri indexing/caches. When installation is separately approved:

1. Confirm normal launch, retained account/preferences, no launch-only location prompt, the latest Zones map with no Cameras button/page, compact uppercase badge and unchanged search/My Location/Heatmap/Replay.
2. While signed in, open Submit a sighting. Without a city, confirm manual location guidance; select Austin or Dallas. Tap Use Current Location and read the Apple/street-search disclosure. Cancel: verify no place was inserted and your existing fields/photo remain intact.
3. Open it again and tap Find nearby place. Choose When In Use yourself if the system asks. Check progress and accuracy, nearby suggestions from your selected city, optional selection and approximate distances. Do not assume a suggestion is the exact location of an earlier photo.
4. Tap a suggestion without confirming: the form must not be filled yet. Use selected place explicitly: verify the canonical place appears in the existing field, while the sighting stays unsubmitted and other fields are retained. Review and edit manually if necessary; editing location must require normal verified-place selection again.
5. Cancel while looking up, or background and return: no late suggestion should fill the form. Retry manually. Try a selected city far from your real location: expect no matching nearby suggestion and a manual fallback rather than a fabricated location.
6. If you voluntarily test denied/reduced-accuracy settings, do so manually; no automated reset is included. Denied/restricted/unavailable lookup must keep manual submission possible. Coarse fixes above 500 m should show accuracy/fallback instead of a confident street suggestion. Do not change managed restrictions for a test.
7. Search manually instead returns to the existing editable form without submitting. Do not send test sightings to production; submit only a real sighting you intend to publish for moderation.

## Separate approvals

- Installation: explicit approval is still required before installing this build on the iPhone.
- No production deployment, commit, push or merge has been performed or authorized.
