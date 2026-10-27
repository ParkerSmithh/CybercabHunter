# Dallas-bound Siri actions and Growth discovery

## Evidence and scope

The installed diagnostic build's reproduced Fleet event at 23:15:01 CDT on October 23, 2026 received city=missing/unset, metric=overview/set and completed the legitimate global branch. The Zone event at 23:18:57 received city=austin/set and completed. These establish parameter delivery problems, not a cache calculation problem. See ../siri-diagnostics/round4-findings.md for correlation IDs and exact events. Framework-set Austin does not establish how Siri obtained Austin.

The user approved replacing the advertised Find a Cybercab slot with Dallas Fleet and replacing the generic Service Zone slot with Dallas Zone. OpenVehicleIntent and ServiceZoneIntent remain discoverable manual actions; vehicle history is unchanged. Generic city fleet and service-zone voice templates are no longer advertised. Global fleet and all existing sightings/comparison/briefing/DMV/camera templates remain unchanged.

## Changes

- DallasFleetSummaryIntent is parameter-free and calls FleetStatsIntent.answer(city: .dallas, metric: .overview). Zero Dallas registry vehicles remain zero; nil-city global Fleet behavior remains valid and unchanged.
- DallasServiceZoneIntent is parameter-free and delegates to ServiceZoneIntent(city: .dallas), compare=false. Both use the existing endpoint/cache/formatting, not a hardcoded area. Dallas coverage attribution remains neutral.
- ServiceZoneIntent's city is required without an Austin default. Missing city raises the App Intents parameter clarification error before any request. A framework-supplied city remains distinguishable from missing, but logs cannot infer its speech origin.
- Fleet/zone city responses are validated against the requested city and name before speaking. Wrong-city payloads and API failures do not fall back to another city/global answer.
- Growth calculations, types, identity, default model/all, period/week and date handling are unchanged. Explicit discoverability and action-search keywords growth/Cybercab/VIN/DMV are exported.

## Growth investigation and limits

The installed artifact already exported FleetGrowthIntent as discoverable, assistantOnly=false, background/alwaysAllowed, with supported enum/date parameters. The user confirmed a full close/reopen and new-editor action search still did not reveal Growth. No manual Growth invocation has been established; no calculation bug is confirmed. Normal startup already requests updateAppShortcutParameters(). This public API is a refresh request, not a cache reset or readback of Apple's private registration database.

Apple documents IntentDescription.searchKeywords specifically for Shortcuts editor search: https://developer.apple.com/documentation/appintents/intentdescription/searchkeywords . Adding these keywords is a small supported search-metadata improvement; their previous absence is not a confirmed explanation (the title already contained Growth). No new Growth intent, voice template, Spotlight bulk index, reset or permission change was introduced. Device discovery and execution need retesting after a separately approved installation. Metadata checks cannot prove private on-device registration or voice recognition.

## Next device tests after approved installation

1. Cybercab Hunter Dallas fleet summary — Dallas registry/recent activity, including a legitimate zero; never global totals.
2. Cybercab Hunter Dallas service area — Dallas area supplied by the API, with neutral source qualification; never Austin's area.
3. Fleet summary for Dallas in Cybercab Hunter — alternative literal owned by DallasFleetSummaryIntent.
4. How big is the Dallas Cybercab service area in Cybercab Hunter — alternative literal owned by DallasServiceZoneIntent.
5. Search a new Shortcuts editor for growth, VIN, or Cybercab; choose Check Cybercab Fleet Growth, Model=Cybercab VIN, Period=Last seven days, no custom dates. Run manually before diagnosing Siri growth execution.

Preservation controls: Cybercab Hunter fleet stats; Cybercab Hunter sightings in Austin today; Cybercab Hunter Dallas weekly sightings; Cybercab Hunter weekly sightings comparison; Give me my Cybercab Hunter briefing. Repeat existing DMV/camera/history checks as needed.

No installation, device data/permission changes, backend mutation, commit, push, merge or deployment is part of this work.

## Validation results

- 191 unit tests in 41 suites passed. Result bundle: /tmp/cch-dallas-bound-tests2.xcresult.
- Nine exported-metadata regression tests passed against the signed Release artifact; training corpus checks passed.
- Release build succeeded; codesign --verify --deep --strict passed.
- 22 App Intents, 10 advertised shortcuts, 22 templates. Both new wrappers have no parameters and their exact literal phrases have exclusive exported ownership. No structural cross-intent template collisions detected. This does not exclude Siri semantic or stale-registration routing issues.
- Bundle ID com.cybercabhunter.native, version 0.1/build 2; app and widget entitlements exactly match the previously installed artifact. Signing/project identifiers were not changed for this work.
- Signed candidate: /tmp/cch-siri-dallas-bound-release/Build/Products/Release-iphoneos/CybercabHunter.app.
- git diff --check passed. Nothing was installed. Ready for separately approved installation and physical-device testing; no Siri reliability claim.
