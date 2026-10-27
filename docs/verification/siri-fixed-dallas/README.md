# Dallas weekly routing fix

## Physical-device evidence

After the owner reported Austin answers for the Dallas command, a fresh Console stream filtered to `category:SiriIntent` captured two reproductions on the unchanged installed build. Both invoked `RecentSightingsIntent`, entered with `city=austin period=last24Hours selection=legacy-city-period`, and reached `answer_ready` without an error. See `device-reproduction.log` for timestamps and correlation IDs.

This confirms the correct intent executed through its legacy/default branch, with no combined `question` selection, instead of `dallasThisWeek`. The existing diagnostics show the effective city/period, not raw parameter inputs; they cannot distinguish omitted city/period from Siri explicitly supplying values identical to the defaults. The code defaults were Austin and last24Hours. Apple's internal reason for dropping or misresolving the phrase's enum parameter is not observable. Neither reproduction requested Dallas, so a Dallas request receiving an Austin cache entry does not explain these runs. The cache keys include the query city. No wrong-intent or API-failure event was captured in these reproductions.

The owner's earlier second attempt that failed entirely was not captured. There is no evidence establishing whether it invoked an intent. Console had no retained capture of those historical attempts; the new repetitions both executed successfully with the wrong effective selection. Streaming stopped after capture.

## Focused changes

- Added `DallasWeeklySightingsIntent`, a parameter-free wrapper calling the existing `RecentSightingsIntent.answer(city: .dallas, period: .thisWeek)`. It uses the same API, cache, approved sightings metric, Central-time week, and answer card.
- Registered the literal `${applicationName} Dallas weekly sightings`. Removed the reverse-order `${applicationName} ${question} sightings` expansion that previously advertised this command. The Dallas command is now independent of enum resolution.
- Retained all 19 prior intents, plus the new wrapper (20 total). Ten advertised shortcuts remain. The Dallas wrapper takes the previous Open a Screen advertised slot. `OpenScreenIntent` remains available in the Shortcuts editor; its generic advertised voice template is removed.
- Kept `${applicationName} sightings in ${question}`, its Austin today value, Fleet's weekly comparison template/value, and Daily Briefing.
- Removed the general sightings intent's implicit Austin default. Missing both question and explicit city produces a choose-city error; explicit legacy city/period shortcuts still work. Logs now record supplied city/period/question before resolution, with no transcripts or user data.
- Validate the response's city before composing a sightings answer. A wrong-city response fails rather than speaking another city's count.
- No changes to backend, cache TTL, API request volume, signing, bundle ID, physical installation, data, or permissions.

Apple documents App Shortcuts as preconfigured actions, including actions with preconfigured parameters: https://developer.apple.com/documentation/appintents/app-shortcuts . A literal phrase and successful metadata validation do not establish Siri voice reliability.

## Validation

Regression coverage includes Austin and Dallas Today/This Week, a fixed Dallas wrapper run twice after warming Austin's cache, missing city rejection, explicit legacy cities, wrong-city responses, HTTP/decoding failures, and equivalent-period approved sightings comparisons. The metadata guard verifies all 19 original intents plus the wrapper, ten shortcut slots, the literal Dallas command's unique owner across finite enum expansions, no default Austin city, preserved Austin/comparison/briefing templates, and the Apple-generated training corpus.

Build and test results are recorded in `validation.json` when complete. No new production API requests are needed: tests use stubs and previously captured public aggregates.

## Next physical test after a separately approved installation

Say **Cybercab Hunter Dallas weekly sightings** repeatedly. Expected diagnostic route: `DallasWeeklySightingsIntent` entered, then `RecentSightingsIntent` with `city=dallas period=thisWeek selection=fixed-dallasThisWeek`, followed by answer_ready (or data_failed on an actual data error). The answer must identify Dallas.

Controls remain **Cybercab Hunter sightings in Austin today**, **Cybercab Hunter weekly sightings comparison**, and **Cybercab Hunter briefing**. The current physical app has not been replaced by this local fix. Voice reliability remains unverified.

## Owner-authorized signed Release installation

The dedicated Dallas build was subsequently installed successfully in place on the connected iPhone 16 Pro. The final bundle passed strict signature verification and metadata/training checks (20 intents including all 19 originals, ten advertised shortcuts, 22 phrase templates). Apple training assets were explicitly regenerated after the incremental build omitted them; the bundle was then re-signed using the same Xcode identity and entitlements and verified before installation. Preferences file metadata was unchanged; no values were exported or reset. Launch succeeded after the owner unlocked the device, requesting the normal startup shortcut parameter refresh. This supersedes the earlier local-only installation status above. The private on-device Siri registry was not read back, and voice recognition remains unverified. See `iphone-installation.json`.
