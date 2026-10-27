# Siri Natural Language Update

Locally implemented after owner approval. Candidate version: **0.1 (4)**. The signed build was subsequently installed with owner approval; see the installation and Round 1 evidence below. Existing unrelated workspace edits were retained.

## Behavior

All 22 intent identifiers, all ten advertised shortcut owners, and all 22 original phrase templates are retained. Sixteen additional templates cover fixed Dallas fleet/zone/week requests, approved sightings, explicit city camera/comparison requests, DMV questions, and Daily Briefing. Finite activity vocabulary adds Austin registry and service-area queries without consuming a shortcut slot. New aliases include complete questions for Dallas cameras today, today's sightings comparison, Austin fleet/zone, and Texas Cybercab DMV VIN counts.

The three fixed Dallas actions retain parameter-free execution. Their existing phrases keep their unique owners. Growth's complete intent source, GrowthPeriod, GrowthModel, and two advertised phrase templates are unchanged; source fingerprints are checked against the pre-update baseline. Its missing Shortcuts action remains a separate unresolved investigation. Startup registration diagnostics are unchanged.

Sightings requests with a missing city now request a city. Conflicting combined-question and explicit city/period inputs request clarification before any network request. The period parameter is now optional without a metadata default: absence can be distinguished from an explicit conflicting 24-hour choice even before iOS 18.2. A legacy shortcut supplying only a city still resolves to its existing last-24-hours behavior. Existing saved period values and enum identifiers remain supported.

City Activity no longer defaults to Austin cameras. Its required question requests a complete city, metric, and period; explicitly ambiguous finite questions also request clarification. Fleet rejects a conflicting city or statistic before fetching. The existing global Fleet overview remains available and now announces that its scope is global. Open Zones and Open Sightings also request a missing city instead of defaulting to Austin.

Camera/comparison/sightings payloads must have both the requested city identifier and matching display name. City-specific briefings require valid city data; a failed city request cannot silently degrade to a global briefing. Registry, approved photos, traffic-camera detections, and DMV VINs remain distinct. No backend, API calculation, cache behavior, Growth calculation, dependency, permission, or service changed.

Existing calendar calculations are unchanged: America/Chicago, Monday-based calendar weeks, today/yesterday based on local dates, and separate API rolling seven-day sightings. Exact rolling seven-day camera counts remain unavailable rather than being estimated from daily buckets. Growth's “Last seven days” remains relative to the latest snapshot, not a new Monday-based calendar-week feature.

## Registration and validation

See `validation.json` for final results, counts, signed artifact identity, and paths. `phrase-inventory.json` lists the compiled templates and finite expansion counts by owner. The automated metadata guard verifies:

- All original intent identifiers, ten owners, original templates, protected Dallas owners, background support, and authentication contracts.
- One dynamic parameter per template and an application-name token in every template.
- Structural template collisions and exact cross-intent collisions after expanding finite enum titles and synonyms; case, punctuation, and whitespace are normalized.
- Expanded phrase budget, including a conservative allowance of ten suggested vehicles for the dynamic vehicle-history template. VehicleQuery already caps suggestions at ten. Arbitrary spoken entity names and semantic collisions are not exhaustively enumerable.
- No Austin defaults on City Activity, map opening, or sightings opening; no sightings-city default; distinct omitted sightings period.
- DMV vocabulary stays explicitly DMV-related or names Texas VINs.
- Unchanged Growth source and vocabulary fingerprints, visibility/default metadata, and advertised phrases.
- All explicitly registered rows in the 40-case matrix match compiled metadata.

Tests use offline stubs and frozen public fixtures. No UI tests against production are run. The complete unit suite is separate from Python metadata mutation tests and from physical Siri testing. An initial unit run exposed a test-stub override that prevented a simulated Dallas outage; that fixture was corrected before the final run.

## Limits and device approval

Registration and local training assets do not prove Siri recognition or acceptance in the private Shortcuts index. Adding phrases does not fix or certify Growth discovery. The provider's existing startup refresh remains unchanged and has no completion signal.

All advertised phrases retain the app-name token. App-name-free wording in the matrix is experimental. No app-name synonyms, artificial schema adoption, transcript parser, or claim of overriding Siri's general knowledge routing was added.

The app receives resolved parameters, not a dependable original transcript or phrase identifier. It cannot recover a city, metric, or time period discarded by Siri before invocation. Fixed Dallas actions avoid a resolvable city entirely; new city-specific finite activity values carry the requested scope. Explicit city selections never fall back to global data. The intentional existing global Fleet action remains, so an upstream misroute to that action with all city information lost cannot be detected; its answer explicitly labels global scope. Automatic checks cannot guarantee against that upstream behavior.

Missing/conflicting-parameter errors use Apple's restart/clarification API. Prompts and retries require physical validation, particularly with saved shortcuts that contain contradictions. On iOS 18.0/18.1, required nonoptional city/activity inputs rely on system parameter resolution; explicit unset-state guards use valueState on iOS 18.2 and later.

The [40-case matrix](device-test-matrix.md) and [CSV results sheet](device-test-matrix.csv) now include six owner-reported Round 1 results; 34 cases remain NOT RUN. Registered examples and experimental desired behavior are clearly separated, including unchanged Growth limitations. No installation, uninstall, reset, cache clearing, permissions change, backend modification, commit, push, merge, or deployment was performed. Installation on the owner's iPhone requires separate approval.

## Reproduce local checks

```sh
xcodebuild -project ios-native/CybercabHunter.xcodeproj -scheme CybercabHunter -configuration Debug -destination 'platform=iOS Simulator,id=AC3027CC-AD0B-4091-8223-69DDF4364FFE' -derivedDataPath /tmp/cch-natural-tests -resultBundlePath /tmp/cch-natural-final-tests.xcresult -only-testing:CybercabHunterTests -parallel-testing-enabled NO -collect-test-diagnostics never -jobs 2 test
xcodebuild -project ios-native/CybercabHunter.xcodeproj -scheme CybercabHunter -configuration Release -destination 'generic/platform=iOS' -derivedDataPath /tmp/cch-natural-release -jobs 2 build
PYTHONDONTWRITEBYTECODE=1 python3 ios-native/scripts/test_siri_metadata.py /tmp/cch-natural-release/Build/Products/Release-iphoneos/CybercabHunter.app/Metadata.appintents/extract.actionsdata
PYTHONDONTWRITEBYTECODE=1 python3 ios-native/scripts/check-siri-metadata.py /tmp/cch-natural-release/Build/Products/Release-iphoneos/CybercabHunter.app/Metadata.appintents/extract.actionsdata
codesign --verify --deep --strict /tmp/cch-natural-release/Build/Products/Release-iphoneos/CybercabHunter.app
git diff --check
```

Use a new result-bundle path when rerunning tests; do not delete an existing result bundle. The simulator invocation is local test execution, not installation on the owner's iPhone. `-collect-test-diagnostics never` affects that invocation only and avoids lengthy verbose diagnostic collection after a test failure; it changes no device permissions or persistent settings.


## Approved iPhone installation — October 24, 2026

The owner separately approved installing the validated signed Release on the connected iPhone 16 Pro. Installation succeeded in place over 0.1 (3), with the same bundle ID; device inventory now reports **0.1 (4)**. Launch succeeded. These results supersede the earlier not-installed status above.

Live startup diagnostics reported executable UUID `D67B4F0E-C163-3C93-AA7A-AD79A63B1BC7` and bundled metadata SHA-256 `dfc4d2b6ea3b151b8ba2af5442ff563b171b7fe79a01cfec779e134e4976480f`, both matching the validated signed Release. Metadata was readable, Growth present, and action count 22. The matching metadata fingerprint establishes that the installed bundle contains the validated **22 intents / 10 advertised shortcuts / 38 templates**.

Both refresh_requested and refresh_call_returned were observed. System indexing completion remains unobservable; no claim of Siri recognition or Growth discovery is made. Capture stopped after the three startup events. See [startup log](device-startup.log) and [installation record](iphone-installation.json).

iOS relocated the data container and added a containermanagerd data-protection extended attribute. The preference file retained its size, modification time, ownership, access mode, and readability/writability across installation. Account/preference contents were not inspected or exported. No uninstall, reset, cache clearing, keychain/account edits, permissions changes, backend edits, commit, push, merge, or deployment was performed. No installation or launch error was reported.

The subsequent Round 1 owner report is recorded below. No further Siri changes are proposed.


## Physical-device Round 1 and Round 2 plan

Owner-reported Round 1: **5/6 worked**, including all four new registered phrase variations tested. The existing Dallas Service Area control worked. “How big is the Dallas Cybercab zone?” did not invoke the app. Treat that result as a Siri routing limitation unless further evidence indicates otherwise; no source or phrase changes are warranted from this result alone. Actual runtime intent parameters and numeric responses were not captured.

See [exact Round 1 results](round-1-results.md), [Round 2 test plan](round-2-test-plan.md), and [Round 2 results sheet](round-2-test-results.csv). Round 2 covers Austin, camera detections, city comparisons, DMV VIN counts, clarification prompts/retries, and an owner-created personal shortcut named **Dallas Cybercab Zone** using the existing **Dallas Service Area** action. All Round 2 cases are NOT RUN.

Build **0.1 (4)** and its **22 intents / 10 advertised shortcuts / 38 phrase templates** remain unchanged, including all Dallas actions and registered phrases. This follow-up changed verification documents only. Source and signed artifact fingerprints were checked read-only; no source changes, rebuild, installation, device access, reset/cache clearing, permissions/backend changes, commit, push, merge, or deployment occurred. Growth discovery remains separate. Awaiting owner test results.


## Round 2 — Siri Reliability investigation (no source changes)

Owner-reported Round 2: **3 worked, 2 wrong results, 6 failed, 1 not tested** (11 attempted). The owner clarified the three pickers “gave me every shortcut.” Exact outcomes are in [Round 2 CSV](round-2-test-results.csv). The personal Dallas Cybercab Zone shortcut outcome remains unreported.

See the [read-only investigation and approval proposal](siri-reliability-investigation.md) for each expected binding, confirmed source facts versus unconfirmed runtime causes, same-owner semantic ambiguity, the surviving missing-period 24-hour fallback, context-preserving clarification, regression coverage, and targeted retests. No source changes/build/install/device changes were performed. All working build-4 actions and phrases, 22 intent identifiers, ten advertised slots, and Growth remain protected. Awaiting approval before implementation. Earlier NOT RUN statements describe the state before the subsequent owner reports; the CSVs and round-specific reports are current.
