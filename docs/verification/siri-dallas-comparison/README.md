# Dallas and weekly comparison diagnosis

This investigation modifies local code only. The physical iPhone remains on the
owner-approved 21-template build. Nothing was installed, uninstalled, reset,
committed, pushed, merged, or deployed. No backend code or configuration changed.

## Findings from the installed build

The owner reported two successes for Austin today, two failures for Dallas this
week, and two failures for weekly city comparison. On the failing commands Siri
provided general knowledge and said it could not search for that in the app.

The exact installed templates and bindings are:

| Spoken command | Template | Intent and parameter |
|---|---|---|
| Cybercab Hunter sightings in Austin today | `${applicationName} sightings in ${question}` | `RecentSightingsIntent.question = austinToday` |
| Cybercab Hunter sightings in Dallas this week | Same template | `RecentSightingsIntent.question = dallasThisWeek` |
| Compare Austin and Dallas sightings this week in Cybercab Hunter | `Compare ${activity} in ${applicationName}` | `FleetStatsIntent.activity = compareSightingsThisWeek` |

All three are **parameterized expansions**, not separately registered literal
sentences. Austin is not a special literal phrase. Austin and Dallas use the
same intent and typed endpoint. Fleet delegates the comparison to the existing
`CityActivityIntent.answer` helper. Its optional activity parameter selects one
of 27 finite city-activity choices; if not resolved, the Fleet intent could run
its default fleet summary instead. There is no transcript or exact-match parser
inside the app.

We checked both exported `extract.actionsdata` and generated `root.ssu.yaml` from
the exact signed artifact previously installed. The training corpus contains the
sightings/comparison templates and the titles “Austin today,” “Dallas this week,”
and “Austin and Dallas sightings this week.” This verifies the compiler's
registered expansion inputs, **not** that Siri recognizes or routes them.

## Physical-device observations

Console's physical-device stream was selected and filtered to `category:SiriIntent`.
It initially disconnected, then reconnected. The following positive controls
were observed in the live stream:

```text
22:04:07.852046-0500 intent=RecentSightingsIntent phase=entered
  city=dallas period=thisWeek selection=dallasThisWeek error=none
22:04:07.985879-0500 intent=RecentSightingsIntent phase=answer_ready
  city=dallas period=thisWeek selection=dallasThisWeek error=none

22:07:09.951332-0500 intent=RecentSightingsIntent phase=entered
  city=austin period=today selection=austinToday error=none
22:07:09.961707-0500 intent=RecentSightingsIntent phase=answer_ready
  city=austin period=today selection=austinToday error=none
```

The first was the owner's **manual Dallas weekly** action, reported as **4**.
The second was the working **Austin voice command**, used as a capture control.
Between those controls, the owner repeated both failing voice commands and
reported neither worked. No matching intent events appeared in the filtered
stream when checked after those attempts.

The stream was stopped after the comparison to avoid leaving logging running.
These are observed log samples, not a complete persisted historical archive.
A missing event alone is not definitive proof of absence: capture, system
routing, launch, parameter resolution, or an uninstrumented wrong action could
be involved. The available crash index contained no current matching report.

**Confirmed:** Dallas weekly resolves and executes correctly when manually
selected on this installed phone. The working Austin voice path also reaches
its intended action. **Most likely:** the failing voice commands are failing
before the intended app action executes, in Siri matching/routing or parameter
resolution. We cannot identify the exact internal Siri failure or assert that
all app invocations are absent from a missing event alone.

## Direct execution and actual source data

Exactly **two necessary public requests**, one per city, were made to
`/api/homepage-stats?city=austin|dallas`. They supplied complete 90-day sightings
series, including every date needed for the current Monday-through-today window.
The captured public aggregates were saved as reduced test fixtures with no
submitter data, plate, or street/location fields.

| Selection | Captured approved sightings, Oct 23, 2026 |
|---|---:|
| Austin + Today | 12 |
| Austin + This Week | 68 |
| Dallas + Today | 1 |
| Dallas + This Week | 4 |
| Austin/Dallas weekly comparison | 68 versus 4; Austin has 64 more |

The values above describe the captured dataset, not fixed future expected counts.
Tests replay these exact API aggregates through the underlying intent answer
functions with a frozen clock matching the capture. The production clock still
defaults to `.now`. This is deterministic direct execution of the app's data
path; it is not a live Siri request or proof of voice recognition.

Additional tests execute `perform()` for all four city/time combinations with
current-date, query-specific stub responses. They also execute comparison through
both **the actually advertised Fleet entry point** and CityActivityIntent's own
entry point. Query-specific stubs distinguish the two cities; a path-only stub
could accidentally return Austin's data for Dallas and miss a routing regression.

Both comparison operands use `.sightings` and the same `.thisWeek` period and
clock. Weeks begin Monday in America/Chicago, not a rolling seven-day window.
The comparison never requests DMV, registry, or camera endpoints. Missing dates,
malformed Dallas data, or a Dallas API outage do not become zero or fall back to
Austin/DMV/camera values.

## Focused local changes

- Keep **`${applicationName} sightings in ${question}`** unchanged, including
  the `austinToday` raw value and “Austin today” display title. Daily Briefing's
  advertised commands and answer composition are unchanged.
- Add the short word-order template **`${applicationName} ${question} sightings`**.
- Shorten the existing weekly enum display labels to **Austin weekly** and
  **Dallas weekly**, retaining “Austin this week” / “Dallas this week” as enum
  synonyms. Their raw identifiers and calendar-week meaning do not change.
- Shorten the existing weekly comparison choice to **Weekly sightings comparison**,
  retaining the old long title as a synonym, and advertise
  **`${applicationName} ${activity}`** through the existing Fleet shortcut.
- Preserve all **19 intents**, all existing parameters/raw identifiers, and the
  **ten advertised shortcut slots**. There are 23 templates. No new intent,
  backend endpoint, service, infrastructure, or paid dependency was introduced.
- Add CityActivity's own entered/answer-ready/error diagnostics so direct and
  delegated comparison execution can both be diagnosed.
- Add explicit optional clocks to the two answer helpers for historical-response
  replay and equivalent-period testing; production behavior still uses `.now`.

The shorter forms reduce the compound utterance and avoid asking Siri to parse
“this week” inside a long comparison choice. This is a targeted mitigation for
matching/parameter-resolution risk, **not a confirmed diagnosis of Apple's
internal matching algorithm or a proven voice fix**.

## Exact metadata and regression checks

`check-siri-metadata.py` now verifies the exact working Austin template, the new
short templates, their **specific enum identifiers and display titles**, and the
corresponding generated SSU training strings. It continues to check 19 intents,
ten shortcut slots, no cross-intent structural phrase collisions, domain words,
background/authentication support, and the preserved Daily Briefing command.
The script does not equate metadata presence with successful Siri invocation.

Six new native tests cover the captured four-way execution table, captured weekly
comparison, all four actual `perform()` entries, Fleet and CityActivity comparison
entry points, missing dates, Dallas API/decode failures, city query isolation,
public authentication, and exclusion of DMV/camera/registry statistics.

## Commands to test after a separately approved installation

1. **Cybercab Hunter sightings in Austin today** — unchanged working command.
2. **Cybercab Hunter Dallas weekly sightings** — Dallas, Monday through today.
3. **Cybercab Hunter weekly sightings comparison** — Austin versus Dallas,
   approved sightings over the same Monday-through-today interval.

These shorter forms are parameterized expansions supported by the generated
App Shortcuts corpus. They are **local only** until installation approval. Start
with manual choices, then say each twice while recording recognized text and
answer/error. Test the preserved Daily Briefing as a control.

Apple requires the app-name token and permits one parameter per phrase; short,
predictable choices are recommended. Semantic matching, regional/language
behavior, Siri permissions and internal routing remain system-controlled.
[Apple App Shortcuts guidance](https://developer.apple.com/design/human-interface-guidelines/app-shortcuts)

**The new Dallas/comparison voice commands are not verified until the owner
confirms repeated tests on a separately approved device update.**

## Validation results

- **177 native unit tests passed**, zero failures and zero skips, in the iPhone
  18 Pro simulator. This includes six new direct city/comparison tests and the
  existing Austin, briefing, routing, privacy, and error suites.
- The **unsigned Release build passed**. This unsigned configuration did not
  run SSU training automatically, so Apple's `appintentsnltrainingprocessor`
  was run explicitly against the new exported metadata. It generated and
  archived the English corpus successfully.
- Exact-template, enum-binding, and generated-corpus checks passed:
  **19 intents**, **ten advertised shortcuts**, **23 phrase templates**, and
  **zero cross-intent structural collisions**. See
  [metadata-check.json](metadata-check.json) and [validation.json](validation.json).
- No physical-device installation or reset was performed. Voice behavior for the
  shorter Dallas/comparison expansions remains unverified.

The test stub now supports exact query keys with a backwards-compatible path-only
fallback. This is test infrastructure only and does not affect the app API or
production backend.

## Owner-authorized physical-device installation

Installed the signed Release in place on the connected iPhone 16 Pro and launched it normally. The exact installed source bundle passed signature and metadata/training-corpus checks: 19 intents, 10 advertised shortcuts, 23 templates. Signing entitlements match the previous installed artifact. Preference-file metadata remained unchanged; no preference contents were accessed. Diagnostic logger symbols are present in the Release executable. Startup requests shortcut parameter refresh; direct read-back of Siri’s private registry is unavailable. Voice recognition remains unverified pending owner testing. See `iphone-installation.json` for the installation record. Earlier unsigned/not-installed validation describes the preceding test stage.
