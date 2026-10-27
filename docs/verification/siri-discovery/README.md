# Siri web routing and intermittent Dallas selection

## Evidence and limits

The metadata of the exact signed Release bundle installed on the iPhone matches the recorded SHA-256 `f794b32f08c0ae0a93de1848f54cd67602adbe78b607ebf77976434d4fe6b5fd`. It contains all 19 original intents plus DallasWeeklySightingsIntent, ten advertised shortcuts, and 22 templates. DallasWeeklySightingsIntent is discoverable, background-capable, alwaysAllowed, and has an empty parameters array. The literal `${applicationName} Dallas weekly sightings` appears only on that shortcut and under `DallasWeeklySightingsIntent_4` in Apple's generated English training corpus. The old reverse-order general sightings template is absent. The Austin and weekly comparison templates remain unchanged.

This verifies the source bundle actually installed, not a read-back of Apple's private Siri registration database. The owner subsequently reported all three commands working, demonstrating successful device use on those occasions, not consistent routing on every attempt.

The exact error "Choose Austin or Dallas for the sightings action in Shortcuts, then try again" is emitted only by RecentSightingsIntent.resolvedSelection when both its question and explicit city are missing. The fixed Dallas action never calls that method: it calls answer(city: .dallas, period: .thisWeek) directly. Therefore that error identifies the general sightings code path, not a missing required parameter in the Dallas wrapper. The installed diagnostics log parameters_received on the general path and entered/answer_ready/data_failed for the dedicated path. A missing-parameter failure occurs before any data request, not after a Dallas/Austin cache collision.

Previously captured pre-wrapper Dallas tests explicitly showed the general intent's Austin/last24Hours default branch. Those are historical evidence and must not be represented as new captures of the dedicated build's failure. On opening Console for this investigation, only previous FleetStatsIntent success events were retained. No recording file or historical capture of the reported web-search attempt was available in the supplied message. A fresh filtered capture and exact-wording/manual-Dallas/voice-Dallas reproduction were requested. Until those results arrive, whether the original web attempt generated any App Intent event is unknown, and stale registration remains a hypothesis.

## Apple-supported discovery

The app already calls AppShortcutsProvider.updateAppShortcutParameters() in App.init. Apple documents this startup registration/parameter refresh in its sample. App Shortcuts use semantic similarity as well as registered phrases; an exact exported owner does not give an app exclusive control of Siri's semantic router.

The existing VehicleEntity, SightingEntity, DMVSnapshotEntity, ServiceZoneEntity, and FleetSummaryEntity use IndexedEntity. Home, Sightings, and DMV views index bounded public data they already fetched. This aids discoverability; it does not create a generic query engine or guarantee statistical question routing. The twelve indexed sightings per city are examples of content, never a denominator for aggregate counts. The aggregate intents continue using the existing public statistics endpoints, with no additional indexing-related network requests.

Current metadata adopts no generic in-app search schema. The source documents a prior withdrawal of that schema after loose requests were routed into search and background execution was unsuitable. Siri's generic "cannot search in the app" response is not evidence that the advertised statistical intents are unavailable. No generic search feature, whole-registry index, new assistant schema, or speculative phrase change was added.

Sources:
- https://developer.apple.com/documentation/appintents/acceleratingappinteractionswithappintents
- https://developer.apple.com/videos/play/wwdc2023/10102/
- https://developer.apple.com/documentation/appintents/making-app-entities-available-in-spotlight

## Smallest safe response

Keep the user-confirmed short Austin, fixed Dallas, comparison, fleet and briefing commands. Do not change their templates on speculation. An app can fix incorrect mappings, missing parameters, wrong endpoints, error handling and discovery metadata. It cannot force Siri to use its data for arbitrary natural-language questions or invalidate Apple's private semantic cache through a public reset API identified here.

If registration seems stale, first inspect the Dallas Weekly card in Shortcuts and run it manually. To request the existing supported refresh without reinstall/reset/permission changes, close and reopen Cybercab Hunter so App.init runs, then reopen its App Shortcuts page and test the exact phrase again. This is a refresh request, not a guaranteed purge of old Siri associations. Do not clear Spotlight, reset Siri/Shortcuts, delete personal shortcuts, or toggle permissions. Inspect personal shortcut names for duplicate names without changing them. An optional user-created shortcut with a unique name and only DallasWeeklySightingsIntent can provide an explicit route; Siri must still recognize that chosen name.

## Local regression changes

Only tests and metadata tooling changed. Added an actual perform() test proving unresolved general sightings fails with cityRequired before any API request. Added six metadata tests proving the current contract, Dallas discoverability and zero parameters, rejected legacy template, rejected cross-intent enum-synonym collision, rejected Dallas parameters, and distinction between exact registration and arbitrary semantic variations. The metadata guard now protects Austin, Dallas and weekly comparison ownership across primary enum titles and synonyms. No production app behavior, phrase, backend, permissions, installation or indexing policy changed.

Results and fresh device evidence, when available, are recorded separately in this directory.

## Completed validation

181 native tests passed, including the new missing-parameter perform test; six metadata regression tests passed. The unsigned local Release build passed. Because the incremental build omitted archived SSU assets, Apple’s training processor was explicitly run against the completed local Release; its resulting corpus and exported phrase metadata passed validation. No new invocation events arrived during the fresh filtered capture, and no owner-confirmed reproduction or exact recorded wording was received before it stopped. This does not establish absence of invocation in the original recording. No new installation or production app changes were made.
