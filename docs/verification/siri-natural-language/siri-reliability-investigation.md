# Siri Reliability Update — read-only investigation and proposed fixes

Status: **investigation only; source changes require owner approval**. Installed and validated baseline stays **0.1 (4): 22 intents, ten advertised shortcuts, 38 phrase templates**. No build, installation, device access, reset, cache clearing, permissions change, backend edit, commit, push, merge, or deployment was performed during this investigation. Source-file fingerprints and the signed executable/metadata/training-corpus fingerprints were checked read-only and retained.

## Evidence and limits

Round 2 owner report: **three worked (1, 3, 6), two wrong results (5, 7), six failed (2, 4, 8, 10, 11, 12), and one not tested (9)**. Eleven requests were attempted. The owner clarified that the pickers in 2, 11, and 12 “gave me every shortcut.” The personal shortcut test 13 has no reported result.

This assessment uses the owner report, actual signed build-4 extracted metadata, current source matching that build, existing regression definitions, and saved diagnostics. It does not invent runtime evidence. The saved `device-startup.log` is filtered to SiriRegistration and contains three installation/startup events only. No per-request Round 2 SiriIntent trace or complete spoken answer is available. The exact invocation path for 5 and 7 therefore remains unconfirmed. No device reproduction or automated test suite was run in this investigation.

Apple documents semantic similarity matching for phrases; exact ownership cannot predict semantic routing. See [Accelerating app interactions with App Intents](https://developer.apple.com/documentation/appintents/acceleratingappinteractionswithappintents). Apple also distinguishes system parameter resolution before perform from manual prompting of optional parameters; see [Spotlight your app with App Shortcuts](https://developer.apple.com/videos/play/wwdc2023/10102/). Absence of a perform log alone does not prove that Siri never considered an intent.

## Priority 1: test 7 — Dallas camera question answered with Austin zone

Expected registered path:

`FleetStatsIntent(activity: .dallasCamerasToday)` → `CityActivityIntent.answer(.dallasCamerasToday)` → city=dallas, metric=cameras, period=today → Dallas homepage aggregate → camera daily count for today Central.

Read-only enumeration of the signed metadata finds exactly that owner and case for “How many Cybercabs did Dallas cameras detect today in Cybercab Hunter.” No exact cross-intent collision is present.

The same advertised **Check Fleet** shortcut also owns the working Austin service-area question, using **the same activity parameter** with `.austinZone`. Consequently, correct top-level FleetStatsIntent selection does not establish correct action semantics. If Siri supplies `.austinZone`, the app legitimately validates the Austin payload and speaks Austin square miles. No contradictory city parameter is necessary, because city is optional and the selected activity carries its own city/metric. Existing validation cannot compare that value against speech Siri did not forward.

Confirmed source facts:

- `.dallasCamerasToday` maps to Dallas/cameras/today. With that exact case, the answer branch cannot return zone size; it selects camera counts.
- `.austinZone` maps to Austin/zone/allTime and explicitly calls `SiriSpeech.zone`. That is a direct source path consistent with the reported answer.
- The top-level Fleet action has three independent inputs: optional city, overview-defaulted metric, optional activity. Its summary emphasizes metric/city while hiding activity in the expanded portion.
- Correct city payload validation cannot detect that the wrong city-specific request was selected upstream.

Leading hypothesis: **FleetStatsIntent was selected but its activity was misbound to austinZone**. Alternatives: direct `CityActivityIntent(question: .austinZone)`; `ServiceZoneIntent(city: .austin, compare: false)`; an existing configured personal shortcut; or a system-presented/reused result. There is no evidence to choose conclusively among these. A correct `.dallasCamerasToday` trace followed by zone output would instead indicate an execution/result-presentation problem and must be investigated rather than explained away as Siri routing.

Discriminating unchanged-build reproduction: capture category SiriIntent; say the failing camera question once; inspect Fleet entered.activity, CityActivity entered.city/metric/period, and answer_ready. Then run the existing **Check Cybercab City Activity** action manually with **Dallas camera detections today** and compare. Do not change the working Austin-zone shortcut. This reproduction is proposed, not performed.

## Priority 1: test 5 — rolling seven days returned 24 hours

Expected path:

`RecentSightingsIntent(question: .austinLast7Days)` → city=austin, period=last7Days → `s.sightings.last7Days` → speech “in the last seven days.”

The signed metadata has one exact owner and maps the phrase to `question=austinLast7Days`. That enum case is correctly mapped to last7Days. The count function reads the rolling-seven-day field and does not fall back to last24h. Conflicting explicitly supplied period values are rejected.

**Confirmed safety gap:** `resolvedSelection()` still returns `(city, period ?? .last24Hours)` if the combined question is absent and a city is present. Thus inputs `question=nil, city=austin, period=nil` silently select 24 hours. This was deliberately retained and regression-tested for city-only legacy shortcuts during the prior update; it now represents the concrete unsafe fallback exposed by the reported scenario. The absence of a metadata default did not eliminate this runtime fallback.

Leading hypothesis: Siri dropped the combined question and period but supplied Austin. Alternatives: Siri explicitly supplied `.last24Hours` or `.austinLast24Hours`, or selected Fleet/Quick Status/Briefing, which can include 24-hour activity. Only a trace can distinguish them. Equal counts alone would not prove the wrong period; the full response wording is useful.

Existing logs distinguish these paths: RecentSightings parameters_received records raw city/period/question (in selection), then entered records effective city/period. If austinLast7Days is received and execution logs last7Days, inspect the full answer/presentation. If selection is missing and period missing but entered is last24Hours, the legacy fallback is confirmed in that invocation.

**Proposed change requiring explicit approval:** request a period when both question and explicit period are absent. Never infer 24 hours merely from missing information. Tradeoff: existing city-only saved shortcuts would now prompt; city+explicit-period shortcuts and complete working phrases remain supported. There is no dependable API in this implementation that distinguishes an intentional city-only saved shortcut from Siri dropping a spoken period. Guaranteeing both implicit legacy default behavior and no missing-period substitution is not possible without an additional explicit signal. Do not silently migrate or rewrite saved shortcuts.

## Exact intended mapping and failure assessment

All listed bindings below are intended mappings, not observed runtime parameters.

| Round 2 test | Required intent and parameters | Assessment |
|---|---|---|
| 1 Austin zone | FleetStatsIntent.activity=austinZone → CityActivityIntent; Austin/zone/current area | Worked; protected. |
| 2 Austin fleet size | FleetStatsIntent.activity=austinRegistry → CityActivityIntent; Austin/registry/allTime | Failed with every-shortcut picker. Metadata ownership is unique. Broad Fleet title, mixed activity vocabulary, or unmatched semantic routing are hypotheses; no actual selected intent is established. |
| 3 Austin yesterday sightings | RecentSightingsIntent.question=austinYesterday; Austin/sightings/yesterday | Worked; protected. |
| 4 Austin this week sightings | RecentSightingsIntent.question=austinThisWeek; Austin/sightings/thisWeek | Exact synonym is exported. Website routing failure reported; no evidence of a calendar calculation defect. Registration acceptance or semantic match failure unconfirmed. |
| 5 Austin rolling seven-day sightings | RecentSightingsIntent.question=austinLast7Days; Austin/sightings/last7Days | Wrong-period report; confirmed runtime fallback exists, but actual invocation/binding unconfirmed. |
| 6 Austin cameras today | FleetStatsIntent.activity=austinCamerasToday → CityActivityIntent; Austin/cameras/today | Worked; protected. |
| 7 Dallas cameras today | FleetStatsIntent.activity=dallasCamerasToday → CityActivityIntent; Dallas/cameras/today | Wrong-city/metric report. Same-owner wrong activity is a leading hypothesis; wrong top-level intent is also possible. |
| 8 city sightings today comparison | FleetStatsIntent.activity=compareSightingsToday → CityActivityIntent; Austin+Dallas/sightings/today | Unique exported alias. General-knowledge routing failure reported; invocation not established. |
| 9 city cameras calendar-week comparison | FleetStatsIntent.activity=compareCamerasThisWeek → CityActivityIntent; Austin+Dallas/cameras/thisWeek | Not tested; do not mark passed/failed. |
| 10 Texas Cybercab DMV VIN total | CheckDMVIntent.question=cybercab; Texas DMV snapshot/Cybercab VINs/latest snapshot date | Unique exported alias. General-knowledge routing failure reported; not a Growth request or evidence of a DMV calculation defect. |
| 11 vague city comparison | FleetStatsIntent.activity=clarifyActivity in build 4; intended both cities, metric missing, period missing | Every-shortcut picker strongly suggests action selection. Separately, the universal clarification case loses known context and would ask too broadly even if invoked. |
| 12 cameras this week, no city | FleetStatsIntent.activity=clarifyActivity in build 4; intended cameras/thisWeek/city missing | Same picker assessment. Only city is genuinely missing; build-4 universal clarification asks for city, metric, and period again. |

## Phrase and metadata findings

The validated inventory has **365 unique finite expansions**, one dynamic vehicle-history template, no structural cross-owner collisions, and no exact finite cross-owner collisions. That remains a lexical check, not proof of semantic separation or correct parameter binding. It also does not validate on-device index acceptance.

The Fleet slot contributes **230 expansions**, built from seven templates. Its activity enum has **30 cases and 45 titles/synonyms**, spanning camera counts, comparisons, registry vehicles, Austin zone size, and clarification. Multiple whole questions are packed into enum synonyms and passed through generic templates such as `${activity} in ${applicationName}`. This creates semantic competition within one owner.

Two concrete mismatches:

- `Compare ${activity} in ${applicationName}` expands for noncomparison cases too, including **Compare Austin Cybercab service area in Cybercab Hunter**, which executes a single-city area answer, and **Compare Dallas camera detections today in Cybercab Hunter**, which executes a single-city count.
- The same clarifyActivity case represents “Compare Austin and Dallas Cybercab activity” (city pair known; metric/period missing), “How do Dallas and Austin compare today” (city pair and today known), and “Cybercab camera detections this week” (metric/period known; city missing). Those distinctions are lost before perform. Its generic period accessor yields allTime; that must not be logged as a genuine resolved period for this sentinel. Guards prevent executing the sentinel as a count; this is not evidence that it caused test 7.

The top-level title **Check the Cybercab Fleet**, advertised title **Check Fleet**, and overview/city-centered summary do not describe all these meanings. Direct **Check Cybercab City Activity** also exposes the broad vocabulary in the action editor. This is ambiguous metadata organization, not a confirmed cause of Apple's picker.

The owner’s “every shortcut” description strongly favors an Apple action-selection list over the expected needsValue prompt with city/metric options. The app has no custom picker UI in these intent paths. However, both action selection and parameter clarification are presented by Apple; a screenshot/heading and a synchronized trace would distinguish them more confidently. Required-parameter UI can occur before perform, so no perform event alone is not sufficient evidence.

## Proposed minimal source changes — not implemented

### A. Safety and diagnostic changes first

1. Replace RecentSightings’ missing-period 24-hour fallback with a parameter needsValueError. Preserve explicit 24-hour requests and all complete working city/period cases. Require approval of the city-only shortcut compatibility change above.
2. Add finite resolution events before fetching: received, resolved, clarification_requested, answer_ready/failed. Give delegated executions the same correlation ID or an explicit parent ID.
3. Record the effective semantic metric, not overview when the action actually answers a zone/camera question. Mark unresolved values unknown instead of deriving Austin/cameras/allTime for a clarification sentinel. Log what the framework supplied, not what we believe the user said.

### B. Reduce competition for new phrases without replacing existing registrations

4. Add optional, domain-specific bindings to the existing FleetStatsIntent: camera city/period, registry city, and sightings-comparison period. Keep all current parameters and identifiers so existing shortcuts remain loadable. Resolve these into a single validated city/metric/period selection before calling the current answer helpers. Reject contradictory legacy/new inputs; never overwrite them silently.
5. Add only these four distinctive templates in their existing slots:

| Existing slot | Proposed additive template | Binding |
|---|---|---|
| Check Fleet | Read Cybercab camera detections for {cameraQuestion} in {app} | New finite CameraCityPeriod; e.g. Dallas today; metric fixed cameras |
| Check Fleet | Read public registry fleet data for {registryCity} in {app} | ServiceCity; registry metric fixed |
| Check Fleet | Compare approved Cybercab sightings in Austin and Dallas {comparisonPeriod} in {app} | ActivityPeriod; both cities and approved-sightings metric fixed |
| Recent Sightings | Count approved Cybercab sightings for {question} in {app} | Existing CitySightingsQuestion |

Each template has an app token and one dynamic parameter. Proposed total: **42 templates**, retaining all 38 existing templates and all ten owners. Actual expanded counts and training assets must be validated after approval; no new build or metadata acceptance is claimed now. These changes can improve specificity but cannot guarantee that Siri chooses the intended phrase or binding. Keeping every old generic phrase necessarily retains some competition.

6. For failed DMV routing, first try the already registered **Read DMV statistic Texas DMV Cybercab VINs in Cybercab Hunter**. It is explicit and requires no source change. Do not add a literal Cybercab-total phrase to an overview-defaulted intent unless the registered binding truly sets question=cybercab. The failed “Tell me…” alias stays registered.
7. Improve Fleet parameter summaries/descriptions to show the resolved domain and preserve all action/shortcut titles. Do not rename or remove working phrases, aliases, or the working Austin-zone route. No paid services, backend changes, new advertised slots, or replacement intents are proposed.

### C. Clarify only missing information

8. Preserve clarifyActivity for saved shortcuts, but give the currently failing incomplete question forms distinct finite context values. Keep their spoken strings; rebind the failed aliases, subject to approval, to context-preserving cases:
   - Comparison of Austin/Dallas, no metric/period: retain both cities, ask a new optional activity-metric parameter, then period only if the selected metric is time-based.
   - Comparison today: retain both cities and today, ask only metric.
   - Camera detections this week: retain cameras and thisWeek, ask only existing city; then derive the appropriate city camera case.
9. Introduce only the optional clarification parameters needed for those contexts, using finite AppEnums. Reuse existing calendars/data helpers. A re-performed request retains supplied context and rejects incompatible selections. The legacy generic clarifyActivity remains a safe prompt when context genuinely is unknown.

Apple's [needsValueError](https://developer.apple.com/documentation/appintents/intentparameter/needsvalueerror(_:)) and [needsDisambiguationError](https://developer.apple.com/documentation/appintents/intentparameter/needsdisambiguationerror(among:dialog:)) support parameter restart/disambiguation; they do not let the app replace Apple's upstream action chooser.

## Diagnostic recommendation and decision rules

Use existing category SiriIntent for an unchanged-build reproduction first. Proposed logging additions must contain only fixed intent identifiers; random per-invocation/parent IDs; enum case IDs; city/metric/period values and set/unset/derived status; finite reason/source fields; success/unavailable/error category. Add answer_domain and response_city/period labels without answer contents. No raw speech, screenshots in logs, plates/VINs, accounts/tokens, coordinates, arbitrary dates, or backend payloads. Owner-reported phrases remain local verification evidence, not telemetry.

| Captured evidence | Interpretation |
|---|---|
| Fleet activity=austinZone followed by CityActivity Austin/zone | Top-level advertised Fleet owner selected, wrong activity binding; execution followed supplied value |
| ServiceZoneIntent Austin | Wrong top-level intent/request for the Dallas-camera question |
| Fleet activity=dallasCamerasToday and CityActivity Dallas/cameras/today, but zone answer | Investigate execution or presentation; do not blame binding without further evidence |
| RecentSightings question missing, period missing, entered last24Hours | Confirmed legacy period fallback for that reproduction |
| RecentSightings receives austinLast24Hours or explicit last24Hours | Wrong supplied period; app did not infer seven days |
| RecentSightings receives austinLast7Days, entered last7Days | Correct parameter path; inspect response wording and presentation |
| Fleet entered with clarifyActivity then needsValue | App-requested clarification path; correlate UI options with expected enum |
| Every-shortcut picker with no matching execution | Consistent with upstream selection; not conclusive alone because system resolution may precede perform |

## Regression plan after separate implementation approval

- Preserve exact sets of the 22 intent identifiers, ten advertised owners/titles, all 38 templates, and working enum aliases. New templates are additive. Verify the three fixed Dallas actions remain parameter-free and all working phrases retain their intended ownership/bindings.
- Extend metadata checks to track `(owner, parameter, enum case, effective city/metric/period)` rather than owner alone; flag domain-mismatched expansions as risks without deleting protected phrases. Check structural and finite collisions and Apple's expanded phrase budget again.
- Unit-test every period for Austin and Dallas, with missing period now prompting; explicit last24Hours remains supported. Test omitted combined question, conflicting legacy/new inputs, no request before clarification, and no global substitution for explicit city requests.
- Use deliberately distinct fixture values for public sightings, cameras, registry, DMV, and zone sizes. Explicit Dallas camera selection must never produce Austin or square-mile output. Include every reachable delegation path and invalid/wrong-city payloads.
- Test context-specific clarification and the subsequent restart: preserve both cities/today/thisWeek; ask only missing fields; ensure contradictory values fail safely.
- Retain Central-time midnight, Monday, year-boundary, DST, rolling-seven-day, missing/stale data, and exact-unavailable rolling camera tests. No period or backend calculations change.
- Keep all existing fleet, DMV, briefing, vehicle-history tests and Growth source/vocabulary/phrase fingerprints. Run the complete offline suite and metadata/training/signature checks only after approval. Simulator tests do not certify Siri recognition.

## Targeted physical retest plan — proposed, not performed

First capture unchanged-build execution evidence for original tests **7 and 5**, each once alone and once after a working Austin request. Where feasible manually run the configured existing City Activity Dallas-cameras-today and Recent Sightings Austin-last-seven-days actions as controls. A manual run and a spoken Siri invocation are separate results. Capture the exact heading/options for a single reproduction of test 2’s all-shortcuts picker. No reset or cache changes.

After any separately approved candidate implementation/build/install:

1. Repeat all five Round 1 working questions verbatim: original Dallas area; Dallas zone-size variation; “What’s … service area in Dallas”; Dallas documented fleet count; Dallas sightings today. Repeat previously verified Dallas Fleet Summary and Dallas Weekly Sightings. Keep the app-name-free Round 1 failure classified separately; no guaranteed change is expected.
2. Repeat Round 2 working Austin zone, Austin yesterday sightings, and Austin camera detections today verbatim.
3. Original test 7 plus new “Read Cybercab camera detections for Dallas today in Cybercab Hunter”; repeat Austin zone immediately before it. Require Dallas/cameras/today in both traces and no square-mile answer.
4. Original test 5 plus the distinctive Count approved sightings variant using “Austin in the last seven days.” Compare explicit today, yesterday, this week, and last 24 hours; verify response periods, not just similar counts. Omit period in a configured action and verify clarification.
5. Original test 2 plus “Read public registry fleet data for Austin in Cybercab Hunter.” Require Austin registry, no all-shortcuts picker, no global/DMV count.
6. Original test 4 plus “Count approved Cybercab sightings for Austin this week in Cybercab Hunter.” Require thisWeek and Monday Central.
7. Original test 8 plus “Compare approved Cybercab sightings in Austin and Dallas today in Cybercab Hunter.” Require both cities/sightings/today.
8. Original test 10 and existing “Read DMV statistic Texas DMV Cybercab VINs in Cybercab Hunter.” Require question=cybercab and dated Texas DMV VIN count, never active-service inference.
9. Original test 11: ask metric, then needed period; record full retry. Original test 12: ask only city; reply Dallas and verify cameras/thisWeek retained.
10. Run Round 2 test 9 (still not tested) as the camera comparison control. Keep the optional personal Dallas Cybercab Zone shortcut test separate; its result remains unreported.

Report per request: phrase, picker/prompt heading/options when present, actual top-level intent and delegated selection, city/metric/period, answer domain/period wording, and whether data was unavailable. Do not label general knowledge or website routing as an app calculation failure without an execution trace.

## Approval boundary

Recommendation: approve safety/logging changes A, the four bounded additive templates and bindings in B, and context-specific clarification C, explicitly accepting that **city-only sightings shortcuts will ask for a period**. No source change has been implemented. A later build or installation remains a separate authorization step. All existing working Dallas/Austin phrases, 22 intent identifiers, ten slots, and FleetGrowthIntent are protected. Additional phrase changes or removals require fresh explicit approval.
