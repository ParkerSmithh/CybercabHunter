# Location Services implementation report

> Historical validation report. Obsolete nearby-sightings directions have been removed; retained raw logs describe the build tested at that time. Current behavior is established by the latest source and regression results.

Status: four functional location features implemented; two features have explicit data dependencies and expose unavailable states. No physical-device installation or deployment authorized or performed.

## Feature behavior

1. **My Location:** Zones has a 48-point glass location control directly below the existing Search control. It requests a fresh one-shot fix, animates the existing MKMapView to a neighborhood view, and displays a distinct blue dot plus an accuracy circle. It never enables MapKit's independent user-location manager. Panning remains free; another tap obtains a new fix and recenters. Search, zone overlays, heatmaps, markers, Replay, and city selection keep their existing implementations.
2. **Zone membership:** checks the same `WebData.zones` polygon coordinates used by existing map overlays. It names Austin or Dallas, explicitly names overlapping zones, or reports outside/unavailable/uncertain. The calculation supports multiple polygon components and holes; the current data has one exterior ring per city and no holes. Invalid/empty rings produce unavailable results. The existing app-wide WebData loader still treats a missing/corrupt bundled JSON resource as a fatal packaging error; this change does not redesign that existing loader. Bundled-data decoding/synchronization is verified by the regression suite. Accuracy circles touching any boundary suppress definitive classification. Mapped coverage is explicitly distinguished from ride availability.
3. **Nearest boundary:** projects onto each actual boundary segment on a spherical Earth, clamps the projection to the segment, and chooses the shortest geographic distance. Outside-zone results name the nearest zone and show rounded approximate straight-line miles. View Nearest Zone centers that boundary point. This is neither road distance nor ETA. Boundary uncertainty suppresses distances.
5. **Nearby cameras:** the existing native app has no dedicated Cameras page. Zones now opens a Cameras sheet using `ZonesModel.loadCameras` and the existing `/data/traffic-cameras.json` inventory. Nearest Cameras obtains a one-shot fix, excludes invalid coordinates, sorts across the real inventory, and labels approximate miles and actual city. Turning it off restores alphabetical inventory order. Selecting a camera opens its inventory details and available existing capture/heat details. Where history has not been loaded for that city, the sheet says so and directs the user to that city's existing heatmap. Existing totals, hour filters, heat visuals, and marker sheets are untouched. Inventory load failure has Retry and loading has a progress state. The pre-existing inventory decoder requires latitude/longitude fields; an inventory missing required fields fails safely to unavailable rather than fabricating positions. Numerically invalid coordinates are excluded from nearest sorting. No camera proximity cutoff is implied.
6. **Submission autofill — blocked by verified-place contract:** Use Current Location explains why autofill is unavailable and leaves the form editable. `worker/sightings.js` requires a real `location_id`, revalidates it via `verifyPlace`, and stores the provider's place label. Coordinates or arbitrary rounded text cannot fill this contract safely. No GPS request or attachment occurs. Implementing a reverse-place lookup would need approval for a coordinate-bearing service request, or approval for a backend contract change. Manual selection, photos, moderation, VIN/plate, and submit behavior are untouched. No automatic submission is added.

## Files changed by this task

New:
- `ios-native/CybercabHunter/Core/Location/LocationService.swift`: shared observable Core Location service and mockable provider protocol.
- `ios-native/CybercabHunter/Core/Location/ZoneProximity.swift`: polygon membership, uncertainty, spherical boundary distance, camera ranking.
- `ios-native/CybercabHunter/Core/Location/LocationControls.swift`: shared location progress, errors, Settings/Retry, accuracy and fix timestamp.
- `ios-native/CybercabHunter/Features/Zones/NearbyCamerasView.swift`: inventory discovery and camera details sheet.
- `ios-native/CybercabHunterTests/LocationTests.swift`: deterministic geometry, permission, accuracy, timeout, cancellation, and camera tests.
- `ios-native/CybercabHunterUITests/LocationUITests.swift`: Zones control placement and gallery checks without changing permissions.
- This report and Siri verification evidence in this directory.

Modified:
- `ios-native/Config/Info.plist`: When In Use explanation.
- `ios-native/CybercabHunter.xcodeproj/project.pbxproj`: remove the two older usage-description overrides only.
- `ios-native/CybercabHunter/Features/Maps/ZoneMapView.swift`: optional location annotation/circle and explicit recenter command.
- `ios-native/CybercabHunter/Features/Zones/ZonesView.swift`: location control/status and Cameras entry.
- `ios-native/CybercabHunter/Features/Sightings/SubmitSightingView.swift`: explicit autofill dependency explanation.

Xcode synchronized folders include new source and tests automatically. Two existing usage-description build-setting overrides were removed from the project file so Debug and Release use the updated Info.plist text. Other pre-existing workspace changes, including Siri work and all other project-file edits, have been preserved.

## Permission, battery, privacy

The pre-existing Siri `OneShotLocation` and Siri Settings `LocationPermission` implementations remain byte-for-byte unchanged to honor the Siri preservation requirement. The shared service introduced here serves all new feature controls; consolidating the older Siri managers is intentionally outside scope. No request occurs at launch or on opening a screen. Only My Location and Nearest Cameras initiate requests. The new feature controls share one manager, which requests When In Use only, at hundred-meter desired accuracy. It respects reduced accuracy without asking for a temporary precise override. Denied/restricted states offer an optional Settings link; disabled services, failure, and 20-second timeout offer Retry. Permission changes are refreshed on returning to an active feature, without automatically starting GPS. Changes to Precise Location invalidate the old fix and require an explicit refresh, so a formerly precise fix is never relabeled as a reduced-accuracy result.

Requests are one-shot, stop after success/failure/cancellation, and cancel when leaving the consuming surface or backgrounding. No background mode, Always key, continuous tracking, location polling, persistence, analytics, logging, reverse geocoding, new endpoint, database change, or coordinate-bearing backend request was introduced. Retained fixes are session-only and timestamped in the UI; every user refresh asks for a fresh fix. The map dot represents that recorded fix, not a continuously updated position. Existing MapKit tile fetching remains part of the existing map.

One-shot/cancellation behavior follows Apple's [requestLocation documentation](https://developer.apple.com/documentation/corelocation/cllocationmanager/requestlocation()). Calculations run on demand for the bundled 42 Austin + 23 Dallas vertices rather than on map gestures or timers. The source has no runtime geometry update mechanism; a future data release automatically uses the same bundled geometry for drawing and classification. The membership algorithm is intended for these local Texas polygons, not global polar or antimeridian-crossing polygons. Spherical distances are approximate; location accuracy is an estimate, not a guaranteed confidence bound.

## Validation results

- Xcode 27.1 (27A9275), iOS Simulator SDK 27.1, iPhone 18 Pro running iOS 27.0; no physical-device destination used.
- Final signed simulator run: **219 unit tests in 44 suites passed**, including **all eight new location/camera tests**, and all existing Siri/data/model tests. The final command exited 0 with `TEST SUCCEEDED`; the app and widget simulator builds succeeded. Earlier complete runs also passed 218/218 before the added Settings-accuracy regression.
- First unsigned run: the unchanged Keychain round-trip test failed with `-34018`; rerunning with normal simulator signing passed. This was a validation-signing issue, not a source regression.
- Initial focused UI run: **7 of 8 passed**. Both new UI tests passed, as did existing registry navigation and all four Zones/minimap/heatmap/Replay/legend tests. The unchanged live search test timed out at `ZoneSearchUITests.swift:56` waiting for suggestions. A separate read-only endpoint check returned HTTP 200 and six real Zilker places. The unchanged search test passed on rerun, including live suggestions, selection, recents, keyboard handling and city switching. The timeout is recorded as transient, not a proven pre-existing source failure. Both new UI tests also passed on rerun: 3/3 confirmation UI cases reported passed in the console; all eight selected UI cases have passed across the runs. Xcode then stalled while finalizing the confirmation result bundle and was stopped after all cases completed; that command ended with signal/exit 143 and did not produce a finalized result bundle. The original 7/8 UI run has a finalized bundle. This toolchain issue is separate from test-case assertions.
- Siri exported metadata: **22 App Intents, 10 advertised shortcut slots, 42 phrase templates**; **17 metadata contract tests passed**. `siri-before.sha256` verifies every Intents source file is identical to this task's starting workspace, including FleetGrowthIntent and the user's existing uncommitted Siri work. Actual spoken Siri recognition and private system indexing were not reset or tested.
- `plutil -lint` passed for Info.plist and project.pbxproj; `git diff --check` passed. Static checks found no backend changes, no submission-model/payload changes, no new coordinate networking, Always authorization, continuous updates or background mode. Evidence is in `static-checks.json` and the Siri text reports.
- Full unit suite and focused read-only UI regressions were run. The complete write-heavy Community/Account/Moderation UI suite was not run; it requires the isolated Worker harness, and no production write tests were performed.
- Final source validation: the built permission description names zones/sightings/cameras and has no Always keys or background modes. The final unit-only run passed the eighth new test proving that changing Precise Location in Settings invalidates the old fix without starting GPS. Finalized result bundle: `/tmp/cch-location-units-final.xcresult`; full final log: `/tmp/cch-location-units-final.log`. `test-results.txt` retains the case summaries for this report.

Reproduce final unit validation (Simulator only):

```sh
xcodebuild -project ios-native/CybercabHunter.xcodeproj -scheme CybercabHunter \
  -destination 'platform=iOS Simulator,id=AC3027CC-AD0B-4091-8223-69DDF4364FFE' \
  -derivedDataPath /tmp/cch-location-build -parallel-testing-enabled NO \
  -only-testing:CybercabHunterTests test
```

UI scopes exercised: `LocationUITests`, `NavigationUITests`, `ZonesUITests`, `ZoneSearchUITests`. Physical-device authorization, GPS, reduced accuracy and spoken Siri behavior remain manual validation items. No claim is made that simulator success certifies a physical iPhone.

## Simulator screenshot

[Zones controls capture](zones-controls.png) was visually reviewed at 1206 × 2622 pixels (402 × 874 points). It shows the added location control below Search, existing map overlays/markers, and the Cameras entry without overlapping the tab bar. It contains no user GPS fix.

## iPhone 16 Pro physical-device checklist — only after separate installation approval

The installed 0.1 (5), its data, permissions, Siri indexing, and signed archive have not been changed. These instructions describe future manual validation, not actions performed here. Do not uninstall/reset the existing app or reset Siri/caches. Installation of this source must wait for explicit approval.

1. After an approved install, launch Cybercab Hunter. Verify no permission alert appears at launch. Check Home, registry, Sightings, Account, and Zones still navigate normally.
2. In Zones, confirm Search stays in its existing position and My Location is immediately below it, clear of the Account button, city picker, Replay and tab bar. Test both normal/heat modes, larger text, and VoiceOver. Search for a place; verify pin/camera movement and existing markers.
3. Tap My Location. If authorization is undetermined, select Allow While Using App manually. Verify a blue dot, accuracy circle, timestamp/accuracy text, animated neighborhood camera and preserved zone boundaries. Pan away; verify the map stays where panned. Tap again to recenter. Confirm the location-use indicator stops after the fix.
4. Validate actual Austin and Dallas inside positions and an outside position when physically available. For repeatable nonphysical coordinates, use a separately approved Xcode simulated-location session: Austin (latitude 30.27, longitude -97.75), Dallas (latitude 32.80, longitude -96.80), outside (latitude 31.00, longitude -100.00). Example positions must be checked against the currently bundled polygons; deterministic unit fixtures are the authoritative algorithm tests. Verify uncertainty near a boundary and the outside straight-line miles/View Nearest Zone behavior. A simulation is not physical GPS validation.
5. In Zones > Cameras, enable Nearest Cameras, verify ascending distances and true city names, open multiple camera details, and turn the option off. In Dallas, do not assume a Dallas camera inventory exists; the list may include distant real Austin cameras. Open the matching city's heatmap to inspect existing totals/hour/range filters.
7. While signed in, open Submit a sighting. Tap Use Current Location; verify the dependency explanation, no GPS attachment or automatic submission, and unchanged city/place/manual editing and photo fields. Do not submit test data to production.
8. If separately willing to change permissions for testing, manually test Deny, Precise Location off, and Settings reauthorization; no automated permission reset is included. Under Deny, normal map/search and manual submission remain usable; Settings/Retry recovery is present. With Precise off, verify approximate accuracy and uncertainty text. Restricted authorization and timeout are covered with mocks; do not change device management for a test.
9. Background during a location request, return, retry, and check that no continuous location indicator remains. Test poor reception and system Location Services unavailable only if manually authorized to change that setting.
10. Exercise the existing Dallas Service Area, Dallas Fleet Summary, Dallas Weekly Sightings, Dallas sightings today, camera detections, DMV, daily briefing, and comparison shortcuts without resetting indexing. Voice recognition and physical permissions cannot be certified from simulator tests. Do not alter FleetGrowthIntent or attempt the unrelated Austin routing fix.
