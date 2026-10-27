# Siri Reliability Update — diagnostic Release 0.1 (5)

## Baseline evidence

Build 0.1 (4) source (482 files), prior verification evidence, and signed app were preserved in baseline-build4. All three archive hashes and every source fingerprint matched before implementation; see baseline-current-check.json. Existing uncommitted work was preserved. The owner supplied baseline-device-trace.log and confirmed that its first request was the Dallas-camera question and its second was the Austin rolling-seven-day question.

Confirmed for these attempts:

- Dallas camera request: FleetStatsIntent received activity=austinCamerasToday, city absent, metric=overview; it delegated to CityActivityIntent for Austin/cameras/today and composed an answer. The wrong city-specific activity was supplied before the app's answer path. Why Siri supplied Austin is not established. The earlier Austin-zone response was not reproduced in this trace.
- Austin seven-day request: RecentSightingsIntent first received no selection/city/period, then received city=austin with question and period absent. The app defaulted to last24Hours and reached answer_ready. This confirms the unsafe fallback executed. The trace does not explain why Siri omitted the requested period.
- An earlier separate trace received austinThisWeek and executed thisWeek. Its spoken-request association remains unknown and it is not used to infer seven-day routing.

No Siri transcript or spoken-answer text was captured by diagnostics. Answer-ready/completed means the app composed its result, not proof of Siri presentation.

## Source changes

- SiriIntents.swift: city-only RecentSightings now requests its missing period; explicit last24Hours and complete CitySightingsQuestion mappings remain supported. Sightings summary emphasizes the combined question. Received, resolved, clarification, success, and failure events preserve an invocation ID.
- SiriQuestions.swift: added camera-only CameraCityPeriod (12 finite city/period combinations), finite CityMetric display values, and ActivitySelection. CityActivity answer execution accepts a validated selection while sharing the original endpoints, response validation, speech, and calculations. The three incomplete question strings now have distinct context cases; legacy clarifyActivity remains available. The direct City Activity action exposes optional clarification fields and translates restart prompts to its own parameters while sharing Fleet validation.
- CybercabIntents.swift: FleetStatsIntent gains optional cameraQuestion, registryCity, comparisonPeriod, activityMetric, and activityPeriod bindings. Complete legacy and new selections must agree. Comparison context retains both cities and asks metric then period for time-based metrics; today comparisons retain today. Cameras-this-week context asks only city. Fleet summaries expose domain bindings. Four additive templates remain in the original Fleet/Recent Sightings slots.
- SiriDiagnostics.swift: invocation IDs can be shared across Fleet delegation, and finite supplied bindings are logged. No speech, VIN, account, precise location, endpoint payload, URL, or answer text is added to logs.
- project.pbxproj: incremented build number from 4 to 5 for app and associated targets.
- SiriNaturalLanguageTests.swift: replaced the intentionally retired city-only default expectation with clarification and explicit-24-hour preservation checks.
- SiriReliabilityTests.swift: covers all domain bindings/periods, city and metric conflicts, camera-versus-zone prevention, context clarification/restarts, and complete legacy mappings.
- Metadata scripts: preserve all 38 build-4 templates and shortcut titles, require 42 total, validate optional domain-specific bindings and the context aliases. siri-build4-contract.json was derived from the preserved signed app.

FleetGrowthIntent, GrowthPeriod, and GrowthModel source fingerprints remain protected by metadata regression tests. No backend API or data calculation was changed.

## Compatibility and limits

City-only saved sightings shortcuts now prompt for period, as explicitly approved. Explicit city/period shortcuts retain their behavior. The three formerly conflated clarification aliases retain their wording but bind to context-specific cases. All original 38 phrase templates remain; their generic semantic competition cannot be eliminated under that preservation requirement. New finite domain bindings reduce possible cross-domain selections but do not guarantee Siri recognition or prevent Siri from supplying an incorrect enum value when no contradictory parameter arrives.

The update preserves all 22 intent identifiers, 10 advertised slots/titles, existing complete activity mappings, fixed Dallas actions, and Growth implementation. New optional parameters appear in action editors. No saved shortcuts are rewritten.

## Physical retest after separately approved installation

This build must not be installed until the owner separately approves. Capture Console subsystem com.cybercabhunter.native, category SiriIntent. For each attempt record exact spoken request, time, any clarification heading/options and reply, answer wording, and corresponding trace. Do not reset Siri, clear caches, uninstall, or change permissions.

1. Repeat all successful Round 1 commands verbatim from the preserved round-1-results.md, plus Dallas Service Area, Dallas Fleet Summary, Dallas Weekly Sightings, Austin Service Area, Austin sightings yesterday, and Austin camera detections today.
2. Repeat the original Dallas-camera request. Then say “Read Cybercab camera detections for Dallas today in Cybercab Hunter.” Repeat after an Austin service-area request. Require Dallas/cameras/today in the resolved and delegated trace; no zone answer.
3. Repeat “Cybercab Hunter sightings in Austin in the last seven days.” Then “Count approved Cybercab sightings for Austin in the last seven days in Cybercab Hunter.” Require last7Days, or a missing-period prompt; never a silently substituted last24Hours. Compare explicit last 24 hours and this week and inspect period wording.
4. In Shortcuts, run Show Recent Cybercab Sightings with City=Austin and Period/City-and-period empty. Expect a period prompt. Select last seven days, then run a separate explicit last-24-hours action.
5. Say “Read public registry fleet data for Austin in Cybercab Hunter.” Require Austin/registry. Say “Compare approved Cybercab sightings in Austin and Dallas today in Cybercab Hunter.” Require both cities/sightings/today.
6. Say “Compare Austin and Dallas Cybercab activity in Cybercab Hunter.” Answer approved sightings, then last seven days; require both cities retained. Say “Cybercab camera detections this week in Cybercab Hunter.” Expect only the city prompt; answer Dallas and require Dallas/cameras/thisWeek.
7. Repeat prior failed and untested Round 2 commands from the preserved matrix, including the existing explicit DMV statistic phrase. Record recognition failures separately from app execution errors.

On-device recognition and parameter-prompt restart behavior remain unvalidated for build 5 until this retest. Local fixture tests cannot establish them.

## Final local validation

Signed Release 0.1 (5) is ready locally and has not been installed on the iPhone. All 211 unit tests in 43 suites passed, with zero failures and zero skipped tests. All 17 metadata regression tests passed. The signed artifact contains 22 intents, 10 advertised shortcut slots, and 42 phrase templates, preserving all 38 build-4 templates and all working enum display bindings. There are 405 unique finite expansions, one dynamic vehicle template, no structural or finite cross-owner collisions, and a conservative suggested-vehicle budget of 415.

The final incremental build omitted training assets. Apple's local training processor regenerated the YAML and archived NLU assets from final metadata; all old and new required training phrases passed validation. The app was re-signed with the exact Xcode signing identity and preserved entitlements. Deep/strict signature verification passed. App and widget entitlements match build 4. Release binary strings contain diagnostics and exclude DEBUG test observer/location hook names. FleetGrowthIntent, GrowthPeriod, and GrowthModel fingerprints remain unchanged.

See validation.json for checksums and artifact paths, source-changes.patch for the exact delta against preserved build 4, unit-tests-summary.json for Xcode results, and signed-release-build5.tar.gz for the durable local signed app archive. Physical-device recognition remains pending. No installation, reset, cache clearing, permission change, backend edit, commit, push, merge, or deployment was performed.

Logging covers received intent/finite selections, resolved city/metric/period, finite clarification reasons, Fleet delegation, and composed/unavailable/error outcomes. Fleet and delegated City Activity share an invocation ID. Direct City Activity has its own context-aware restart parameters and diagnostic context. Siri speech and backend answer payloads are not logged.

## Owner-approved installation — October 24, 2026

The validated signed archive was installed in place over build 4 on the connected iPhone 16 Pro and launched successfully. Device app inventory reports 0.1 (5), bundle com.cybercabhunter.native. Startup executable UUID and metadata SHA-256 match the validated Release. The exact metadata contains 22 intents, 10 advertised shortcuts, and 42 templates. Both refresh_requested and refresh_call_returned were captured; system indexing completion remains unobservable. Console displayed duplicate copies of the startup events; no cause is inferred.

Preference-file size, modification time, ownership, permissions, extended attributes, and readability/writability metadata are identical before and after installation. Preference values, accounts, and keychain contents were not read. No uninstall, reset, cache clearing, permissions change, source/backend edit, commit, push, merge, or deployment was performed. Source fingerprints still match the validated candidate. See iphone-installation.json and installed-startup.log. Earlier local-validation installed=false records are superseded by this installation record. Awaiting owner physical-device Siri tests; no Siri reliability fix is claimed.
