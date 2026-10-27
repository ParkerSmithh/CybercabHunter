# Remove the Zones Cameras control

> Historical validation report. Obsolete nearby-sightings directions have been removed; retained raw logs describe the build tested at that time. Current behavior is established by the latest source and regression results.

## Scope clarified by the user

The native Cameras page had no separate tab or Home route: its only entry was the Zones button. The user clarified to **remove the button and page**, and to **retain the independent Heatmap/Replay controls and camera markers**. No website Cameras page, backend service, or shared camera functionality was removed.

## Changes

- Removed the Zones Cameras button, its `camerasOpen` state, and its sheet route.
- Deleted `CamerasView.swift`, the page opened exclusively by that button, including its inventory/detail-sheet wrapper.
- Preserved shared camera models, APIs, statistics, Heatmap/Replay, existing map-marker detail sheets, and Home analytics. The removed button did not activate an overlay; there was no button-specific overlay to delete.
- Preserved Austin/Dallas selection, search, My Location and blue-dot/recentering code, compact uppercase badge, zone detection, boundary distances and View Nearest Zone.
- Updated the existing UI test to assert the Cameras button/page route is absent while location controls retain their layout. Its startup check waits for My Location to be hittable rather than reading that transient property immediately after launch; the assertion was retained.

## Files changed

1. `ios-native/CybercabHunter/Features/Zones/ZonesView.swift`: exactly three removed lines (button, presentation state, sheet).
2. `ios-native/CybercabHunter/Features/Zones/CamerasView.swift`: deleted, as explicitly requested in clarification.
3. `ios-native/CybercabHunterUITests/LocationUITests.swift`: replace obsolete camera-page navigation assertions with absence checks and preserve the badge/control geometry checks; add an explicit startup readiness wait.
4. This verification report, preserved-source checksums and screenshot.

All other application source/configuration files match the installed refinements build snapshot. In particular the location service, geometry engine, map renderer, search, zone presentation helper, camera models and every Siri source file are unchanged. The previously modified repository files unrelated to this request were preserved.

## Validation

- Full unit suite: **221 tests in 45 suites passed**, command exit 0; `/tmp/cch-zones-remove-cameras-units.xcresult` and `/tmp/cch-zones-remove-cameras-units.log`.
- Final-source UI checks use the isolated **iPhone 16 Pro Simulator** (402 × 874 points / 1206 × 2622 pixels), iOS 27.0 and Xcode 27.1. No physical-device commands or permission changes were used.
- Outside-zone distance / View Nearest Zone test passed. Existing Zones Heatmap / Replay test passed, confirming those independent features remain available.
- Initial Dallas removal/layout test: all absence and layout assertions passed, but the immediate My Location `isHittable` check failed during startup. The test now explicitly waits for hittability, retaining the same requirement. A predicate-based readiness retry also timed out. The final test polls the actual hittability getter and retains its assertion; it passed in 22.6 seconds, with command exit 0 (`/tmp/cch-zones-remove-cameras-final-ui.xcresult`). App behavior was not modified to address these test-readiness failures. All three selected UI cases have therefore passed across the runs.
- Source checksum preservation and `git diff --check` passed; backend/migrations unchanged.
- **Final Simulator build succeeded**, exit 0 (`/tmp/cch-zones-remove-cameras-build.log`).
- **17 Siri metadata contract tests passed**; exported inventory remains **22 App Intents, 10 advertised shortcut slots and 42 phrase templates**. Every Siri source checksum matches the starting workspace. No shortcut/indexing reset was performed.
- The initial completed UI process was stopped during prolonged verbose failure-diagnostic/result collection (exit 143); no finalized bundle is claimed for that run. The predicate retry finalized with its test failure (exit 65). The final direct-readiness retry finalized normally with `TEST SUCCEEDED` (exit 0). `test-results.txt` retains all case results and failures.
- No relevant unit failures remain. The initial UI readiness failures are documented above rather than omitted.

The UI uses the existing Debug-only Dallas fixture for screenshots. It does not request or modify GPS authorization. Actual physical-device GPS/permission behavior was not exercised; its service and map implementation are unchanged and mock tests pass.

## Screenshot

[Updated Dallas Zones map](zones-dallas.png): Cameras is absent; the city selector, compact status badge, Search, My Location, Replay and Heatmap remain. The screenshot uses a deterministic fixture and is not a physical-device location capture.

No iPhone installation, uninstall, reset, cache clearing, permission change, Siri reset, backend/database edit, commit, push, merge or deployment was performed. Awaiting installation approval after validation.
