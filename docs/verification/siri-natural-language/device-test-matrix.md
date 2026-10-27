# Siri Natural Language Update — physical-device matrix

Round 1: six cases attempted; five worked and one app-name-free request did not invoke the app. Cases 3, 11, 12 (reported contraction variant), 17, and 21 worked; case 14 did not invoke. Subsequent Round 2 results for matching exact questions are also recorded in the CSV; different city/wording tests are not treated as equivalent. See [exact reported results](round-1-results.md) and the CSV for per-case status. Build 0.1 (4) remains installed and unchanged.

Existing/new = explicitly registered template expansion (including enum synonyms). Experimental = desired variation only; invocation is not guaranteed. Growth remains unchanged; cases 34–36 are observations, not claimed fixes. Case 9 uses the actual registered “last seven days” value, correcting the earlier report’s “this week” example.

Run each spoken and typed where supported. Repeat protected Dallas commands at least three times and after an Austin request. Record iPhone model, OS, Siri/Apple Intelligence mode, language, recognized text, actual intent, finite resolved parameters, response, and whether it opened the app. Separate no invocation, wrong intent, wrong parameters, API failure, and unavailable-data responses. Do not reset or change permissions.

For experimental ambiguous wording, clarification is the desired outcome; the app cannot inspect a transcript that Siri never forwards. Existing global Fleet remains intentional. A successful global invocation cannot establish that Siri retained a spoken city.

| # | Phrase | Intended intent / parameters | Expected response | Registration |
|---|---|---|---|---|
| 1 | Cybercab Hunter Dallas fleet summary | DallasFleetSummaryIntent; city=dallas; metric=overview | Dallas public registry/activity; never global | existing |
| 2 | Fleet summary for Dallas in Cybercab Hunter | DallasFleetSummaryIntent; city=dallas; metric=overview | Same fixed Dallas result | existing |
| 3 | Cybercab Hunter Dallas service area | DallasServiceZoneIntent; city=dallas; metric=zone | Dallas square miles and source | existing |
| 4 | How big is the Dallas Cybercab service area in Cybercab Hunter | DallasServiceZoneIntent; city=dallas; metric=zone | Dallas area | existing |
| 5 | Cybercab Hunter Dallas weekly sightings | DallasWeeklySightingsIntent; city=dallas; period=thisWeek; metric=sightings | Approved public sightings since Monday Central | existing |
| 6 | Cybercab Hunter fleet stats | FleetStatsIntent; city=nil; metric=overview; activity=nil | Existing global overview; label registry and DMV separately | existing |
| 7 | Read DMV data in Cybercab Hunter | CheckDMVIntent; question=overview | DMV snapshot; no active-service claim | existing |
| 8 | Cybercab Hunter briefing | DailyBriefingIntent; city=nil | Existing dated briefing with distinct metrics | existing |
| 9 | Cybercab growth last seven days in Cybercab Hunter | FleetGrowthIntent; period=week; model=all; from=nil; to=nil | Unchanged latest-snapshot-relative Growth behavior; record missing editor action separately | existing |
| 10 | Get Cybercab history in Cybercab Hunter | VehicleHistoryIntent; vehicle=missing | Ask which Cybercab/plate | existing |
| 11 | How big is the Dallas Cybercab zone in Cybercab Hunter | DallasServiceZoneIntent; city=dallas; metric=zone | Dallas area | new |
| 12 | What is the Cybercab service area in Dallas in Cybercab Hunter | DallasServiceZoneIntent; city=dallas; metric=zone | Dallas area | new |
| 13 | How many square miles is the Dallas Cybercab service zone in Cybercab Hunter | DallasServiceZoneIntent; city=dallas; metric=zone | Square miles and source | new |
| 14 | How big is the Dallas Cybercab zone? | DallasServiceZoneIntent; city=dallas; metric=zone | If invoked, Dallas area; no app-name-free routing guarantee | experimental |
| 15 | Show me the Dallas Cybercab service area | ServiceZoneIntent / OpenZonesIntent; city=dallas; compare=false | Check spoken-area versus map interpretation; never Austin | experimental |
| 16 | How big is the Austin Cybercab zone? | FleetStatsIntent -> CityActivityIntent; activity=austinZone | If invoked with selection, Austin area | experimental |
| 17 | How many Cybercabs are documented in Dallas in Cybercab Hunter | DallasFleetSummaryIntent; city=dallas; metric=overview | Documented registry count, not active cars | new |
| 18 | Give me Dallas Cybercab fleet stats in Cybercab Hunter | DallasFleetSummaryIntent; city=dallas; metric=overview | Dallas summary | new |
| 19 | What is the Austin Cybercab fleet size in Cybercab Hunter | FleetStatsIntent -> CityActivityIntent; activity=austinRegistry | Austin public registry count; no global/DMV substitution | new |
| 20 | How many Cybercabs are registered? | Unresolved: FleetStatsIntent / CheckDMVIntent; dataset=ambiguous | Desired clarification: public registry versus Texas DMV; routing is experimental | experimental |
| 21 | Any Cybercabs spotted in Dallas today in Cybercab Hunter | RecentSightingsIntent; question=dallasToday; city/period unset or matching | Approved public sightings today Central | new |
| 22 | How many Cybercabs were spotted in Austin yesterday in Cybercab Hunter | RecentSightingsIntent; question=austinYesterday; city/period unset or matching | Previous Central calendar day | new |
| 23 | Dallas Cybercab sightings this week in Cybercab Hunter | DallasWeeklySightingsIntent; city=dallas; period=thisWeek | Fixed Dallas Monday-to-today sightings | new |
| 24 | Were any Cybercabs seen yesterday? | RecentSightingsIntent; city=missing; period=yesterday | If invoked with missing city, request Austin or Dallas | experimental |
| 25 | Cybercab Hunter sightings in Dallas in the last seven days | RecentSightingsIntent; question=dallasLast7Days | Rolling seven-day sightings, not calendar week | existing |
| 26 | Which city has more Cybercab sightings today in Cybercab Hunter | FleetStatsIntent -> CityActivityIntent; activity=compareSightingsToday | Compare both cities approved sightings today | new |
| 27 | Compare Austin and Dallas Cybercab activity in Cybercab Hunter | FleetStatsIntent; activity=clarifyActivity | Ask for complete metric/city/period; zero API requests before clarification | new |
| 28 | How do Dallas and Austin compare today? | FleetStatsIntent / CityActivityIntent; activity=clarifyActivity if resolved | Ask metric/city/period; no assumed metric | experimental |
| 29 | Cybercab Hunter Dallas camera detections today | FleetStatsIntent -> CityActivityIntent; activity=dallasCamerasToday | Camera observations only; not unique cars or public photos | existing |
| 30 | Have Austin cameras spotted Cybercabs? | CityActivityIntent; city=austin; metric=cameras; period=unresolved | Desired period clarification; no free-form routing guarantee | experimental |
| 31 | Cybercab camera detections this week in Cybercab Hunter | FleetStatsIntent; activity=clarifyActivity | Ask city/metric/period; never default Austin | new |
| 32 | Dallas camera detections in the last seven days | CityActivityIntent; question=dallasCamerasLast7Days | If resolved, explain exact rolling camera count unavailable | experimental |
| 33 | Tell me how many Cybercab VINs are registered in Texas in Cybercab Hunter | CheckDMVIntent; question=cybercab | Cybercab DMV VIN count and snapshot date; not active service | new |
| 34 | How many new Cybercab VINs were added this week? | FleetGrowthIntent (experimental target); model=cybercab; calendar-week interpretation unresolved | Growth unchanged: do not certify calendar-week support; verify actual model and dates | experimental |
| 35 | Are Cybercab VIN registrations increasing? | FleetGrowthIntent (experimental target); model=cybercab; period=unresolved | Growth unchanged: verify scope/dates, record default behavior; no new clarification promised | experimental |
| 36 | Check Cybercab VIN growth | FleetGrowthIntent (experimental target); model=cybercab intended; actual parameters must be recorded | Growth unchanged; discovery investigated separately | experimental |
| 37 | What is happening with Cybercabs today in Cybercab Hunter | DailyBriefingIntent; city=nil | Dated briefing with distinct metrics | new |
| 38 | What is new with the Cybercab fleet in Cybercab Hunter | DailyBriefingIntent; city=nil | Briefing; no active-fleet inference | new |
| 39 | What about Dallas? | No reliable standalone intent; context=unresolved | Do not certify conversational carryover; no invented period/metric | experimental |
| 40 | How big is the Houston Cybercab zone? | ServiceZoneIntent (unsupported-city probe); city=unsupported | Desired unsupported-city/clarification; never silently Austin or Dallas | experimental |

Additional execution controls: manually configure conflicting sightings city/question, conflicting period/question, conflicting Fleet metric/activity, and missing City Activity question in Shortcuts. Expect clarification before network access. Confirm saved legacy shortcuts with matching parameters still run. City-specific briefings must fail safely when their city aggregate is unavailable.

The CSV has fields for device results and actual parameters. Automated metadata checks validate the registered rows against the compiled artifact, not voice recognition.

Round 2 has now been reported; see [the investigation](siri-reliability-investigation.md) for exact outcomes and limits of execution evidence.
