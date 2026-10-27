# Siri question coverage and device test guide

> Routing investigation update: the installed voice tests exposed wrong-intent
> routing and an intermittent Siri failure. The original matrix below records
> the earlier configuration. See [the current diagnosis and revised test
> phrases](../siri-routing/README.md). Local fixes have not been reinstalled.

This upgrade extends the existing App Intents, public API client, Siri cards,
entities, and Spotlight integration. It adds no endpoint, backend migration,
production configuration, scheduled job, paid service, or external AI call.

## What “supported” means

The intent can retrieve the indicated public data and form an answer. It does
not mean Siri's voice recognition has been verified on an iPhone. The owner approved an in-place installation on the physical iPhone 16 Pro.
Installation and on-device shortcut visibility are verified below. Siri voice
recognition remains unverified until the owner reports test results.
Include **Cybercab Hunter** in every test phrase. First test the action and
parameters in Shortcuts to distinguish an answer bug from Siri routing failure.
A request that omits the app name may go to web search or another system action.

Apple permits ten advertised App Shortcuts and one dynamic parameter per phrase:
[Apple's App Intents introduction](https://developer.apple.com/videos/play/wwdc2025/244/).
The existing ten shortcut slots remain, including Daily Briefing and Open a
Screen. Check Fleet also advertises camera and comparison choices. City and
period are combined into one finite choice for sightings. Existing saved intents
and the city parameter remain usable. Saved city-only Recent Sightings actions
retain their last-24-hours default; the new city-and-period phrase choice
selects available totals for an unqualified city question. A supplied “City and period” choice takes
precedence over the separate city and period parameters in the Shortcuts editor.

## City sightings: highest-priority tests

These count **moderator-approved public photo sightings**, never pending reports,
traffic-camera hits, or unique vehicles. “This week” means Monday through today
in America/Chicago. Today and yesterday are Central calendar dates, including
DST. The rolling seven-day and 24-hour counts are separate choices.

| Period | Exact Austin phrase | Exact Dallas phrase |
|---|---|---|
| Available total | How many Cybercab sightings are there in Austin in Cybercab Hunter | How many Cybercab sightings are there in Dallas in Cybercab Hunter |
| Today | How many Cybercab sightings are there in Austin today in Cybercab Hunter | How many Cybercab sightings are there in Dallas today in Cybercab Hunter |
| Yesterday | How many Cybercab sightings were there in Austin yesterday in Cybercab Hunter | How many Cybercab sightings were there in Dallas yesterday in Cybercab Hunter |
| This week | Check Cybercab sightings in Austin this week in Cybercab Hunter | Check Cybercab sightings in Dallas this week in Cybercab Hunter |
| Last seven days | Check Cybercab sightings in Austin in the last seven days in Cybercab Hunter | Check Cybercab sightings in Dallas in the last seven days in Cybercab Hunter |
| Last 24 hours | Check Cybercab sightings in Austin in the last 24 hours in Cybercab Hunter | Check Cybercab sightings in Dallas in the last 24 hours in Cybercab Hunter |
| All-time wording | Check Cybercab sightings in Austin all time in Cybercab Hunter | Check Cybercab sightings in Dallas all time in Cybercab Hunter |

“All time” is a synonym for the available city total. The answer explicitly says
that this covers **currently public records** and that a permanent city lifetime
counter is unavailable. The global lifetime counter must not be assigned to a
city. Missing daily data or a cached response from a previous local date produces
an unavailable answer rather than zero. An actual zero remains zero. A latest
sighting can be appended from the same response, labelled separately from the
requested period.

## Fleet, DMV, vehicles, and service zones

| Coverage | Exact phrase to test | Interpretation / limit |
|---|---|---|
| Daily Briefing | Give me my Cybercab Hunter briefing | Existing public registry, daily activity, and dated DMV overview preserved |
| Fleet overview | Cybercab Hunter fleet stats | Registry and DMV totals kept separate; neither proves current operation |
| Austin fleet | How many Cybercabs are in Austin in Cybercab Hunter | City registry and recent activity summary |
| Dallas fleet | How many Cybercabs are in Dallas in Cybercab Hunter | City registry and recent activity summary |
| Registry total | Check public registry vehicles in Cybercab Hunter | Existing registry statistic |
| Recorded rides | Check recorded rides in Cybercab Hunter | Recorded rides, not Tesla's complete operating volume |
| Lifetime sightings | Check lifetime approved sightings in Cybercab Hunter | Global lifetime counter only |
| DMV overview | Check Cybercab DMV updates in Cybercab Hunter | Dated statewide roster and latest processed update |
| DMV total VINs | Check Texas DMV total VINs in Cybercab Hunter | All Tesla Robotaxi VIN classes |
| DMV Cybercabs | Check Texas DMV Cybercab VINs in Cybercab Hunter | Cybercab VINs only |
| DMV Model Ys | Check Texas DMV Model Y VINs in Cybercab Hunter | Model Y VINs only |
| Latest additions | Check latest newly detected DMV VINs in Cybercab Hunter | Date of latest processed change, not necessarily today |
| Latest Cybercab additions | Check latest newly detected DMV Cybercab VINs in Cybercab Hunter | Model-specific first detections |
| Latest Model Y additions | Check latest newly detected DMV Model Y VINs in Cybercab Hunter | Model-specific first detections |
| Growth, latest snapshots | Cybercab growth latest snapshots in Cybercab Hunter | Last two actual snapshots, even if dates have a gap |
| Growth, seven days | Cybercab growth last seven days in Cybercab Hunter | Actual snapshots within window ending at latest dataset |
| Growth, thirty days | Cybercab growth last thirty days in Cybercab Hunter | Actual snapshots; no interpolation |
| Growth, since start | Cybercab growth since tracking began in Cybercab Hunter | Baseline excluded from first detections |
| Cybercab-only growth | Check Cybercab VIN growth in Cybercab Hunter | Cybercab-only counts, default seven-day window |
| Model Y-only growth | Check Model Y VIN growth in Cybercab Hunter | Model Y-only counts, default seven-day window |
| Lookup | Find XVF1524 in Cybercab Hunter | Example plate; use a currently public vehicle. Opens detail |
| Vehicle history | Show the history of XVF1524 in Cybercab Hunter | Registry first/last report, recorded rides, approved history entries, DMV first detection if VIN exists |
| First report | When was XVF1524 first spotted in Cybercab Hunter | Same history action; registry report date is explicitly labelled |
| Latest report | When was XVF1524 last spotted in Cybercab Hunter | Same history action; not a live vehicle location |
| Austin zone | How big is the Austin Cybercab service area in Cybercab Hunter | Coverage and its published source |
| Dallas zone | How big is the Dallas Cybercab service area in Cybercab Hunter | Coverage and its published source |
| Open screen | Open DMV Tracker in Cybercab Hunter | Existing navigation action preserved |
| Nearby cameras | Find Cybercab sightings near me in Cybercab Hunter | Existing one-shot local location filter and permission behavior preserved |

Growth model, period, and optional custom dates can all be set together in the
Shortcuts editor. Each registered phrase interpolates at most one parameter;
do not assume Siri can freely combine every model/date/period wording.

Vehicle history is capped at 50 **day-and-area entries**, grouped by submission
date and service area by the existing API. These are not individual observation
counts. At the cap, the answer says “latest 50, not a lifetime count.” A failed
history request says temporarily unavailable and does not produce a zero figure.
DMV dates are first detection in datasets, not registration or operation dates.

## Traffic cameras

Each phrase works for **Austin** and **Dallas**; replace Austin below with Dallas.
Counts come from aggregate history, not the recent endpoint's one-result-per-camera
map list. Detections are observations, not distinct vehicles.

| Coverage | Exact phrase | Limit |
|---|---|---|
| Today | Check Austin camera detections today in Cybercab Hunter | Central calendar day, so far |
| Yesterday | Check Austin camera detections yesterday in Cybercab Hunter | Central calendar day |
| This week | Check Austin camera detections this week in Cybercab Hunter | Monday through today |
| Available history | Check Austin camera detections all time in Cybercab Hunter | Sum of all daily buckets retained by the endpoint |
| Recent hourly count | Check Austin camera detections in the last 24 hours in Cybercab Hunter | Answer labels the endpoint's latest 24 UTC hourly buckets; not a claim of an exact rolling boundary |
| Exact rolling seven days | Check Austin camera detections in the last seven days in Cybercab Hunter | Explicitly unavailable: daily buckets cannot establish an exact rolling boundary |

Sparse camera history omits zero dates. A present empty series means zero;
an absent history field means unavailable.

## City comparisons

| Coverage | Exact phrase |
|---|---|
| Available approved sightings | Compare Austin and Dallas sightings all time in Cybercab Hunter |
| Today | Compare Austin and Dallas sightings today in Cybercab Hunter |
| Yesterday | Compare Austin and Dallas sightings yesterday in Cybercab Hunter |
| This week | Compare Austin and Dallas sightings this week in Cybercab Hunter |
| Rolling seven days | Compare Austin and Dallas sightings in the last seven days in Cybercab Hunter |
| Rolling 24 hours | Compare Austin and Dallas sightings in the last 24 hours in Cybercab Hunter |
| Camera observations | Compare Austin and Dallas camera detections today in Cybercab Hunter |
| Camera observations yesterday | Compare Austin and Dallas camera detections yesterday in Cybercab Hunter |
| Camera observations this week | Compare Austin and Dallas camera detections this week in Cybercab Hunter |
| Camera available history | Compare Austin and Dallas camera detections all time in Cybercab Hunter |
| Recent camera buckets | Compare Austin and Dallas camera detections in the last 24 hours in Cybercab Hunter |
| Registry vehicles | Compare Austin and Dallas registry vehicles in Cybercab Hunter |
| Recorded ride sample | Compare Austin and Dallas recorded rides in Cybercab Hunter |
| Service-zone coverage | Compare Austin and Dallas service zones in Cybercab Hunter |

Comparisons require both matching metrics and periods, state ties or differences,
and do not substitute zero for an unavailable city. DMV city comparisons are
unsupported because the roster is statewide and does not establish service city.

## Request budget and validation

Sightings: one `/api/homepage-stats?city=...` request. City comparisons: two
responses, reusing either one already in SiriData's two-minute cache. The existing
cache shares identical in-flight requests. DMV-specific questions use one overview
request. Growth continues to use growth plus overview. No full registry scans,
polling, or new background tasks are introduced. Spotlight still indexes data the
app already loaded; all Siri requests remain public and carry no session token.

Unit tests cover periods, Monday boundaries, Central midnight and DST, missing
versus zero data, stale daily responses, model-specific DMV answers and growth,
comparison differences/ties, partial history failures and caps, authentication
absence, and one/two-request budgets. The existing Siri suites retain briefing,
routing, entity, privacy, location, and card checks. Device recognition remains a
separate manual check after installation approval.

## Validation results (October 23, 2026)

- Native unit tests: **165 passed**, 38 suites, using the iPhone 18 Pro simulator
  (iOS 27.0) with local ad hoc signing. All Siri suites passed, including ten new
  question tests. An earlier unsigned run had a keychain-entitlement failure;
  the signed run passed that test and the full suite.
- Backend contract tests: **5 files passed**, zero failures: homepage stats,
  Daily, sightings API, camera sightings, and TxDMV activity. Tests use the
  repository's isolated harness; no production infrastructure was changed.
- Unsigned device-target **Release build passed**, including App Intents metadata
  extraction and phrase training.
- Release metadata: **10 advertised shortcuts**, **54 phrase templates**,
  application name present in every phrase, no more than one dynamic parameter
  per phrase. The city/period, activity/comparison, DMV, and growth enums export.
- Physical iPhone Siri recognition: **not tested**. The owner subsequently approved
  the in-place installation documented below. No commit, push, merge, deployment,
  or production infrastructure change was performed.

Reproduce native tests (simulator identifier will vary):

```sh
xcodebuild -project ios-native/CybercabHunter.xcodeproj -scheme CybercabHunter \
  -configuration Debug -destination 'platform=iOS Simulator,id=<simulator-id>' \
  -derivedDataPath /tmp/cch-siri-tests -parallel-testing-enabled NO -jobs 2 \
  -only-testing:CybercabHunterTests CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- test
```

Reproduce the unsigned device-target Release build (does not install):

```sh
xcodebuild -project ios-native/CybercabHunter.xcodeproj -scheme CybercabHunter \
  -configuration Release -sdk iphoneos -destination 'generic/platform=iOS' \
  -derivedDataPath /tmp/cch-siri-verified -jobs 2 CODE_SIGNING_ALLOWED=NO build
```

Reproduce backend checks:

```sh
node --test tests/homepage-stats.test.mjs tests/daily.test.mjs \
  tests/sightings-api.test.mjs tests/camera-sightings.test.mjs \
  tests/txdmv-activity.test.mjs
```

## Physical iPhone installation and registration check

At the owner's explicit request, built and installed a signed Release update on
its connected **iPhone 16 Pro**, using the existing development team and bundle
ID `com.cybercabhunter.native`. Version remains **0.1 (2)**. Signature verification,
metadata extraction, and installation succeeded. No uninstall, reset argument,
bundle-ID change, commit, push, merge, or deployment was performed.

iOS assigned a different data-container path during the update. The existing
preferences file remained, with its pre-update modification time of October 23,
2026 at 8:40 PM Central. This is evidence of retained preferences; the container
identifier itself is not proof of preservation and no claim is made that every
stored value was exhaustively compared. The app was launched normally, requesting
`updateAppShortcutParameters()` from its startup code.

The owner opened Cybercab Hunter's App Shortcuts page. A screenshot taken from
that physical iPhone confirmed the new city-and-period choices, including
**Austin today**, **Austin this week**, **Dallas today**, **Dallas yesterday**, and
**Dallas this week**. See [registration evidence](iphone-app-shortcuts.png) and
[installation record](iphone-installation.json). The exact installed build's
metadata contains 19 intents, ten advertised shortcuts, and 54 phrase templates.

**Siri voice recognition is not verified.** Start by saying:

1. “How many Cybercab sightings are there in Austin today in Cybercab Hunter”
2. “Check Cybercab sightings in Dallas this week in Cybercab Hunter”
3. “Compare Austin and Dallas sightings this week in Cybercab Hunter”
4. “Compare Austin and Dallas sightings today in Cybercab Hunter”
5. “Give me my Cybercab Hunter briefing”

For each, record what Siri heard, whether it invoked Cybercab Hunter, and the
answer or error. This separates phrase recognition, parameter selection, and
public-data retrieval. Do not substitute historical fixture numbers for the
current answers.
