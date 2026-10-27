# Diagnostic-only Siri improvements

## Scope

Instrumented FleetStatsIntent, CityActivityIntent, ServiceZoneIntent, FleetGrowthIntent, and NearbySightingsIntent. Existing defaults, routes, endpoint selection, calculations, cache, and 10 advertised App Shortcuts are preserved. No backend requests are made by diagnostics. The only spoken-answer change is the neutral Dallas zone attribution: “Cybercab Hunter's currently listed coverage figure,” replacing the unsupported Tesla attribution. The API model supplies no verified provenance.

## Events

OSLog subsystem `com.cybercabhunter.native`, category `SiriIntent`. Each invocation has a random correlation ID and `entered`, then either `answer_ready` + `completed` or `failed`. Completed means the app composed/returned its result, not proof that Siri displayed or spoke it. Normal data limitations have explicit outcomes such as `no_count_available`, `insufficient_history`, `city_not_tracked`, or `no_nearby_detections`.

Fleet also logs `data_failed` with the underlying API category before preserving its existing generic user-facing unavailable error. The terminal failure shares the same correlation ID. Nearby preserves the underlying API failure category without emitting duplicate terminal failure events.

| Intent | Logged resolved context |
| --- | --- |
| Fleet | Optional city (including `missing`), metric, optional activity selection, and the activity's period when applicable |
| City Activity | Question selection (in `activity`), derived metric/period, and city or `austin,dallas` |
| Service Zone | City, comparison flag, and zone metric |
| Fleet Growth | Model, period, and custom-date presence flags; no date contents |
| Nearby | Permission status, camera metric, fixed 24-hour period; `not_resolved` until a supported broad city is selected, followed by `parameters_resolved` |

Parameter states use Apple's `IntentParameter.valueState`, available on iOS 18.2+: `unset` vs `set` are logged independently of resolved values. Thus `city=austin city_state=unset` differs from `city=austin city_state=set`; likewise default model=all and period=week. A set value means the framework supplied it; this is not a speech transcript or proof the user explicitly spoke it. Derived values are labelled `derived`; older OS versions without the API are labelled `unavailable`, never guessed.

Apple reference: https://developer.apple.com/documentation/appintents/intentparameter/valuestate-swift.property

## Privacy and tests

Only finite enum values, booleans/presence flags, intent/phase/outcome labels, error categories, and per-invocation correlation IDs are logged. No coordinates, radius/accuracy, addresses, custom date contents, VINs/plates/entity IDs, transcripts, answer payloads, request URLs, tokens, or server error text are logged. Logging uses the existing OSLog channel; no analytics service or new backend request is introduced.

A DEBUG-only event observer lets serialized tests assert the exact finite events sent to OSLog. DEBUG-only location test hooks simulate location errors and a known public coordinate without requesting or changing system permissions. These hooks and observer are absent from Release.

Regression tests cover unset vs supplied defaults, missing Fleet city/activity, resolved Dallas Fleet selection, comparison metric/period/cities, default City Activity selection, correlated underlying Fleet API errors, Service Zone/Growth success and error outcomes, insufficient growth history, Nearby permission failures and success, unchanged request counts, and private error payload/coordinate exclusion. Existing tests protect all working Siri behavior and the neutral Dallas attribution. Metadata checks compare all advertised phrases, enum values, and parameter defaults with the previously installed signed build.

See `validation.json` for final test/build/signature results. Installation requires separate owner approval; this change does not establish Siri voice recognition reliability.

## Final verification

188 native tests and six metadata regression tests passed. The signed Release build passed. All advertised shortcut records, enum values, intent parameters/defaults, availability, authentication, and supported modes match the previously installed artifact. Inventory remains 20 intents (all 19 originals plus Dallas), ten shortcut slots, and 22 phrase templates. Apple training assets were explicitly generated because the incremental build omitted the archived corpus; the bundle was then re-signed with the same Xcode identity and entitlements. Strict deep signature verification passed, with matching app/widget entitlements and bundle ID. Release symbols include diagnostics and exclude the DEBUG observer/location hooks. No physical installation occurred. The ready artifact and checksums are recorded in `validation.json`.

## Owner-authorized installation

The signed diagnostic Release was subsequently installed successfully in place on the connected iPhone 16 Pro. The exact bundle passed strict signature, metadata/training, entitlement, and compiled-diagnostics checks immediately before installation: 20 intents, ten advertised shortcuts, 22 templates. Preferences file metadata was identical before and after installation; no values were read, and no uninstall, reset, or permission changes were performed. Normal launch succeeded and requested the existing startup Siri parameter refresh. No private Siri registry read-back or voice recognition claim is made. The historical local-validation `installed: false` status is superseded by `iphone-installation.json`, which includes artifact hashes.
