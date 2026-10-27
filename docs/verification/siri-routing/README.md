# Siri wrong-intent / intermittent-failure investigation

> Follow-up: repeated device testing confirmed Austin but exposed Dallas and
> comparison failures. See [the Dallas/comparison investigation](../siri-dallas-comparison/README.md)
> for live invocation evidence, direct execution, and local-only shorter commands.

> Installation update: the owner subsequently approved the 21-phrase signed
> Release update. It is now installed in place on the iPhone 16 Pro. The original
> investigation below is historical; see the installation results at the end.
> Repeated Siri testing of this new configuration is still pending.

## Scope and current device status

No additional Siri features were added. The installed iPhone build has **not**
been changed, reinstalled, reset, or uninstalled during this investigation. No
commit, push, merge, or deployment was performed. The local phrase changes and
instrumentation below require a separately approved installation before device
verification. Earlier installation evidence remains historical evidence of
registration, not evidence that voice routing works.

## Confirmed observations

The owner reported the following on the physical iPhone 16 Pro:

1. Asking “How many Cybercab sightings are there in Austin today in Cybercab
   Hunter?” produced Texas DMV information.
2. Repeating it produced a system response that Siri could not use Cybercab
   Hunter.
3. During this investigation, manually tapping **Austin today** in Cybercab
   Hunter's App Shortcuts returned the correct number of sightings today.
4. On the unchanged installed app, the owner then tested **“Cybercab Hunter
   sightings in Austin today”** twice with the phone unlocked. Both returned
   **12 Austin sightings**, as reported by the owner. This is an observation of
   those two trials, not a fixed expected count or proof of unrestricted Siri
   reliability.

The manual and shorter-phrase observations were reported directly by the owner.
No screenshot of either answer was obtained. Counts remain live data, not fixtures.

### Installed metadata has a real phrase-shape collision

The installed build artifact at `/tmp/cch-siri-iphone/Build/Products/Release-iphoneos/CybercabHunter.app`
contains these templates:

| Intent | Installed template |
|---|---|
| FleetStatsIntent | `Check ${metric} in ${applicationName}` |
| FleetStatsIntent | `Check ${activity} in ${applicationName}` |
| CheckDMVIntent | `Check ${question} in ${applicationName}` |

After substituting the parameter placeholder, all have the shape
`Check {parameter} in {app}`. The original sightings action additionally advertises
long “How many…” questions and several “Check…” / “Show…” variants. The earlier
54-template configuration exposed generic phrasing across several domains.

This confirms a registration ambiguity, **not the exact cause of either reported
invocation**. The owner's failed “How many…” question is explicitly present in
sightings metadata; it is not literally a DMV phrase. Apple uses semantic
similarity when selecting shortcuts, so structural overlap is a plausible
contributor rather than conclusive evidence of what Siri selected.
[Apple's App Shortcuts sample documentation](https://developer.apple.com/documentation/appintents/acceleratingappinteractionswithappintents)

### The sightings action does not retrieve DMV data

`RecentSightingsIntent.perform()` uses the phrase-bound city-and-period choice
when present, otherwise the saved legacy city and period. It calls the typed
`SiriData.get<HomepageStats>` for `/api/homepage-stats?city=<selected city>`.
`CityActivitySpeech.answer(... metric: .sightings ...)` selects only approved
sightings fields. A separately labelled latest sighting can be appended from
that same response. The action never requests `/api/dmv/overview`, registry
stats, or the briefing as a fallback.

`CheckDMVIntent` requests `/api/dmv/overview`. Fleet and Briefing can also speak
DMV information legitimately. Therefore a DMV answer alone does **not** prove
CheckDMVIntent was selected; the selected intent must be established from an
invocation trace.

The cache key includes the endpoint and query. A cached DMVOverview cannot be
cast to HomepageStats. A malformed/mismatched homepage response fails decoding
and produces an unavailable error, never a DMV answer. Tests exercise both a
warm DMV cache and deliberately mismatched payloads through actual `perform()`
entry points.

### Registration and availability

The installed build successfully exported App Intents metadata and SSU phrase
training artifacts. The physical iPhone previously displayed the new city-and-
period choices, and the owner can manually run Austin today. This rules out a
complete absence of that action, but not a stale Siri index or a Siri-specific
parameter/routing problem.

Both sightings and DMV metadata show background execution, `openAppWhenRun=false`,
and the framework's default `.alwaysAllowed` authentication policy. The
city-and-period parameter is a finite optional AppEnum and is present in the
exported metadata. Its resolved value takes precedence over legacy city/period
parameters. Unit tests invoke all twelve choices with conflicting legacy
parameters to verify that precedence.

No authentication-policy change was made. Apple's default permits invocation
while locked, but this does not establish whether the owner’s failure occurred
while locked or whether system-level Siri permissions or protected resources
were involved.
[Apple authentication policy documentation](https://developer.apple.com/documentation/appintents/appintent/authenticationpolicy)

## Available logs and limits

- Queried the iPhone's accessible crash-log index for Cybercab Hunter, Siri,
  Shortcuts, and App Intents. The matching entries were old Siri feedback files,
  last dated October 10; no matching report from the incident was exposed.
- Checked the accessible JetsamEvent index. The latest listed memory-pressure
  report was October 18; none matched the current incident.
- Attempted a bounded 30-minute, 15 MB, Cybercab-filtered unified-log collection
  with macOS `log collect --device-udid`. Apple's tool required root access.
  Noninteractive administrator access was unavailable (`sudo` required a
  password). No password was requested, profile installed, or broad diagnostic
  archive collected.
- The installed build lacks per-invocation intent tracing. A process listing or
  absence of a crash report cannot identify a completed Siri routing decision.

**The exact wrong-intent selection and cause of “couldn't use” are unconfirmed.**
The latter could occur before `perform()` (routing, permission, resolution,
availability) or during/after it (network/decode failure, cancellation, time
budget, Siri presentation). The generic system wording alone cannot separate
those cases. A successful manual invocation does not prove that repeated Siri
requests enter the same intent or share the same runtime conditions.

## Local fixes

- Reduced 54 advertised phrase templates to a small set with explicit domain
  words outside the parameter: `<app> sightings in…`, `Read DMV…`, `Fleet summary…`,
  `City activity…`, and `Compare…`.
- Retained the shorter sightings template that the owner verified twice, and
  removed the failing long “How many…” variants from advertising.
- Retained all ten advertised actions, existing intent identities and parameters,
  underlying answer capabilities, navigation, entities, and public APIs.
- Preserved Daily Briefing's data composition and canonical tested command
  “Give me my Cybercab Hunter briefing,” plus its explicit rundown command.
  Broad “What's happening…” / “Summarize…” aliases were removed from advertising.
- Added local OSLog tracing under subsystem `com.cybercabhunter.native`, category
  `SiriIntent`. Sightings and DMV record entry, resolved public selection,
  answer readiness, or classified source failure. Fleet, Daily Briefing, and
  Quick Status also record entry/readiness/failure because they can speak DMV
  data. Correlation IDs distinguish repeated invocations.
- Logs exclude voice transcripts, answers/counts, plates, VINs, tokens, raw
  server responses and localized server/transport error text. Error categories
  distinguish HTTP status, decoding, transport, and cancellation.
- `answer_ready` means the app composed its answer, **not that Siri delivered it**.
  No trace at all is evidence to investigate routing/launch/resolution; it is
  not definitive by itself because log capture may be incomplete.

## Targeted checks

`SiriRoutingTests` exercises the actual intent entry points:

- All twelve city/period choices override conflicting legacy parameters and
  request only the correct city's homepage stats, without authentication.
- Sightings never speak sentinel DMV, camera, or registry values.
- A DMV answer cached immediately before repeated sightings answers cannot
  contaminate them.
- Homepage outage, malformed JSON, or a DMV-shaped homepage payload causes an
  unavailable error with no DMV fallback; the next valid response can recover.
- DMV requests only the DMV endpoint and returns its own values.
- Public answer authentication policy and diagnostic error redaction.

`ios-native/scripts/check-siri-metadata.py` checks a completed build artifact for
cross-intent phrase-shape collisions, Apple’s parameter/app-name rules, explicit
sightings and DMV domain words, correct parameter enum types, background/auth
metadata, and the preserved briefing phrase. It fails on the installed metadata
with the Fleet/DMV collision. This is a registration regression check, not a
simulation of Siri's semantic matching.

## Exact next device tests

### On the currently installed app, without reinstalling

1. Manually run **Austin today** again if needed (already reported correct).
2. Say **“Cybercab Hunter sightings in Austin today”**. This shorter phrase is
   already registered in the installed 54-template build.
3. Compare with **“Give me my Cybercab Hunter briefing”**, a known working action.

The shorter sightings template works on both the currently installed build and
the local cleanup. The other revised phrase templates and logs are local only.

### After a separately approved update with the local fixes

1. **“Cybercab Hunter sightings in Austin today”**
2. **“Cybercab Hunter sightings in Dallas this week”**
3. **“Compare Austin and Dallas sightings this week in Cybercab Hunter”**
4. **“Read DMV data in Cybercab Hunter”** (control: this alone should return DMV)
5. **“Give me my Cybercab Hunter briefing”** (preservation control)

Run the sightings action manually first, then say each phrase twice. Record the
recognized text, answer/error, and approximate time, keeping the device unlocked
for the initial comparison. A separate locked-screen test can follow. Use
Console device logs filtered to the app's `SiriIntent` category to correlate
entry, chosen parameters, data errors, and answer readiness. Historical log
collection on this Mac needs administrator access.

**The owner confirmed the short Austin phrase twice on the installed build.
The local cleanup, other revised commands, and resolution of the original
long-phrase/intermittent failure remain unverified on the physical device.**

## Validation results

- Both native unit-test runs passed: **171 tests**, zero failures. The final
  result bundle is `/tmp/cch-siri-routing-final-tests.xcresult`; Xcode's
  test-results summary confirms 171 passed, none failed or skipped.
- A local unsigned Release build passed. Its final metadata check is recorded in
  [metadata-check.json](metadata-check.json). The check rejects the previously
  installed metadata because Fleet and DMV share the generic phrase shape.
- No backend code changed, and no live production API probes were needed.
- The physical iPhone remains on its earlier installed build. The owner confirmed
  the short Austin sightings command twice; the local cleanup and diagnostic
  instrumentation are not on that device yet.

Reproduce the metadata check after a completed Release build:

```sh
python3 ios-native/scripts/check-siri-metadata.py \
  /tmp/cch-siri-verified/Build/Products/Release-iphoneos/CybercabHunter.app/Metadata.appintents/extract.actionsdata
```

## Approved installation of the 21-phrase Release

The owner explicitly authorized this subsequent installation. The signed Release
build and signature verification passed, using unchanged signing entitlements
and `com.cybercabhunter.native`, version **0.1 (2)**. The exact signed bundle
installed successfully through `devicectl device install app` as an in-place
update, without uninstall, reset, backend change, or permission-changing action.

The signed artifact's metadata checks confirmed **19 intents, ten advertised
shortcuts, and 21 phrase templates**, with no cross-intent structural collisions.
The signed-bundle metadata digest and complete phrase inventory are recorded in
[iphone-installation.json](iphone-installation.json), establishing which exact
bundle was installed. This verifies packaged metadata and successful installation,
not Siri's internal semantic matching decisions.

Before normal launch, preference-file size/modification metadata and the
Documents listing matched their pre-install snapshots. iOS assigned another
container path during installation, as in the previous update. No values were
reset. Permission settings were not changed, and the same app/signing identity
was retained; individual system permission grants were not independently audited.

Automatic approval review rejected a proposed local preference-file copy because
it could export sensitive app data. That copy was not performed. Preservation
checks used file metadata only, without exporting or comparing preference values.

The app launched normally with no reset arguments, requesting the startup App
Shortcuts registration refresh. The installed **21-phrase configuration has not
yet been verified through repeated Siri tests**. The three priority commands are:

1. **“Cybercab Hunter sightings in Austin today”**
2. **“Cybercab Hunter sightings in Dallas this week”**
3. **“Compare Austin and Dallas sightings this week in Cybercab Hunter”**

Say each twice and report what Siri heard and the answer/error. The earlier
12-sightings result was an owner-reported trial on the previous installed build,
not a fixed expected answer or confirmation of this new installation.
