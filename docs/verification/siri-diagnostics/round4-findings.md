# Physical-device findings after diagnostic build installation

Fresh Console reproduction capture on October 23, 2026, America/Chicago (CDT, UTC−05:00). The original test events were not retained before capture began; the events below are new reproductions. Event text is transcribed from Console accessibility output. No spoken answer text is logged.

## Dallas Fleet summary: confirmed missing city

Correlation: `E25CC423-A71B-4EDD-80BA-3197616C2B88`.

- 23:15:01.528904 entered FleetStatsIntent, city=missing, city_state=unset, metric=overview, metric_state=set, activity=missing, activity_state=unset, error=none.
- 23:15:01.616801 answer_ready, outcome=answer_composed, error=none.
- 23:15:01.616822 completed, same parameters/outcome, error=none.

The intended intent ran, but Dallas was not delivered. The existing nil-city overview branch therefore returned global statistics. This was not substitution for zero Dallas totals: the non-nil Dallas branch accepts zero as a valid registry count and never substitutes global statistics. Whether Siri matched the global shortcut instead of the city template or failed to resolve the city cannot be distinguished by these events.

The smallest safe app-side correction must distinguish city-summary requests from the legitimate global overview. A city-summary-specific path should require or explicitly bind Dallas and fail closed if its city is missing. Do not globally reject nil Fleet city, because that would break the working global fleet command and potentially comparisons. A manually configured personal shortcut with City=Dallas, Statistic=Overview and no activity is a minimal workaround that requires no app/backend change; its success has not yet been established in this capture.

## Dallas service area: confirmed framework-provided Austin

Correlation: `0E4BCDEF-822B-45AA-BFD1-54AFB4243209`.

- 23:18:57.717591 entered ServiceZoneIntent, city=austin, city_state=set, metric=zone (derived), compare=false, compare_state=set, error=none.
- 23:18:57.724153 answer_ready, outcome=answer_composed, error=none.
- 23:18:57.724176 completed, same parameters/outcome, error=none.

The correct intent ran and completed, but the framework provided Austin, not Dallas. Austin equals the declared default. Because valueState is set, this is not evidence that the app read an unset parameter and applied its own fallback. It remains unknown whether the framework applied the configured default, reused a stored setting, or resolved/matched incorrectly. A set value does not establish that the human explicitly selected or spoke Austin.

The current Dallas API response, generated 2026-10-24T04:13:55.970Z (October 23, 23:13:55.970 CDT), has city=dallas, area.square_miles=81, area.vehicles=0, and in_service_since=2026-04-18. It was fetched directly during this investigation, not hardcoded from the previous report.

Source: https://cybercabhunter.com/api/homepage-stats?city=dallas

A small safety correction is to remove the implicit Austin default from the zone action and require a city; that needs approval and retesting because the captured framework-set Austin value may still require addressing discovery or using an explicitly Dallas-bound action. A fixed-city personal shortcut is a minimal workaround. Do not change the area calculation or substitute another source/count.

## Cybercab VIN growth: discovery/routing unresolved, no calculation failure established

No FleetGrowthIntent events were captured for the voice attempts, so there are no timestamps, actual model/period, completion, or failure events to report. This is not conclusive proof of no invocation; there is no successful manual Growth control in this capture. The owner could not find Growth in the new-shortcut action search and initially ran Check Fleet instead. That is a different action and is not a Growth execution test.

The exact installed source bundle still matches its installation metadata hash. Its exported FleetGrowthIntent is discoverable, not assistant-only, background-capable, and alwaysAllowed, with title “Check Cybercab Fleet Growth” and advertised short title “Fleet Growth”. It has these templates:

- `Cybercab growth ${period} in ${applicationName}`
- `Check ${model} growth in ${applicationName}`

GrowthModel.cybercab displays “Cybercab VIN”, so “Check Cybercab VIN growth in Cybercab Hunter” is a registered expansion. Expected period is week/Last seven days, with no custom dates. These are expected parameters, not captured values. The two growth templates belong to the same intent; metadata checks found no cross-intent structural collision. Semantic routing and stale system registrations cannot be audited from this metadata alone, nor can Apple's private on-device registry be read back directly.

The public growth API has 15 snapshots and enough_history=true. The requested seven-day window selects October 16 (349 Cybercab VINs) to October 23 (351), net +2. This confirms sufficient current input data, not actual device execution.

Source: https://cybercabhunter.com/api/dmv/growth?range=all

The smallest safe next step is to restore/verify device action discovery and run the actual Growth action before touching calculations. A full close/reopen of Cybercab Hunter requests the existing supported startup shortcut-parameter refresh, followed by reopening a new Shortcuts editor and searching Growth. This is a refresh request, not a guaranteed cache purge. No reset, reinstall, permission toggle, or deletion of user shortcuts is recommended. If still missing, investigate device action registration/discovery before adding phrases or changing math.

## Preserved state

No source code, shortcut phrases/defaults, backend, installation, app data, or permissions changed during this investigation. Capture stopped after the checks. Working Austin sightings, dedicated Dallas weekly action, today/weekly comparisons, Daily Briefing, DMV and camera commands remain untouched. No commits, pushes, merges or deployments were performed.
