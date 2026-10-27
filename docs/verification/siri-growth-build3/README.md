# Growth discovery diagnostic Release — build 3

Version remains 0.1; all project build-number settings are incremented from 2 to 3. Bundle IDs, signing settings and entitlements are unchanged. This candidate is for local validation and separately approved installation only.

## Startup diagnostics

Subsystem: com.cybercabhunter.native. Category: SiriRegistration. Marker: siri-growth-diagnostics-v3.

- event=refresh_requested: the existing refresh call is about to be made.
- event=refresh_call_returned: updateAppShortcutParameters returned. The event explicitly records system_completion=unobservable and error_channel=not_provided. The SDK declares a synchronous, nonthrowing Void API with no completion/error callback. This event does not claim successful indexing/registration in Siri or Shortcuts.
- event=startup_artifact: app version/build, the loaded app executable's Mach-O UUID, bundled extract.actionsdata SHA-256, parse/access status, action count, and FleetGrowthIntent presence.

The loaded image is selected by the app executable name, rather than assuming image zero is the executable. A regression compares its UUID with the actual host app file; the observed simulator log UUID also matches dwarfdump output.

The metadata resource is read and hashed once on a utility-priority background task with a 4 MiB limit. Normal metadata is approximately 80 KiB. Missing, unreadable, oversized or invalid metadata reports Growth presence as unknown; a successfully parsed action dictionary reports present or absent. Parsing describes this bundled resource, not Apple's private registry or acceptance of its schema.

Only version/build values, canonical UUIDs, fingerprints, counts and finite statuses are logged. No installation path, metadata payload, transcripts, VINs, coordinates, user identifiers, error payloads, preferences or permissions are logged or changed. There are no additional backend requests, polling, caches, or external services.

## Preserved behavior

No Growth parameter, default, calculation, endpoint or API request changed. The existing registration-refresh call still runs once at startup. All 22 intents, 10 advertised App Shortcuts and 22 phrase templates remain. Protected Dallas fleet/zone/weekly actions, sightings, comparisons, global fleet, DMV, cameras, briefing and vehicle-history registrations are unchanged.

## Validation

- 196 unit tests in 41 suites passed, including the actual bundled-resource reader and executable-file identity comparison. Result bundle: /tmp/cch-growth-build3-identity-tests.xcresult.
- Exact final Release identifiers, metadata/signature checks and readiness are recorded in release-validation.json.
- A simulator startup confirmed version=0.1 build=3, metadata_status=readable, FleetGrowthIntent=present and action_count=22. Simulator and Release UUIDs/fingerprints differ; compare device logs against the Release identifiers, not the simulator log.

After separately approved installation, capture the SiriRegistration startup events and compare all identifiers with release-validation.json before interpreting device discovery results. The build is diagnostic; it does not claim to fix Growth discovery or voice recognition.

Final signed Release verification passed: 22 intents, 10 shortcuts, 22 templates; nine metadata regression tests and training-corpus checks passed. All action/enum/shortcut metadata is semantically identical to the previous build, normalizing only generated ordering of type-specific key/value pairs and accepted input types. The incremental build omitted root.ssu.yaml, so Apple's local training tool regenerated the corpus; the candidate was re-signed using the original identity/entitlements and deep/strict verification passed again. App and widget entitlements match the prior signed build. git diff --check passed.

No iPhone installation, reset, cache clearing, permission change, backend modification, commit, push, merge or deployment was performed. The final build is ready for separately approved installation.
