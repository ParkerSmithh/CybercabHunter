# Final local validation

- Candidate: 0.1 (4), signed Release.
- Unit tests: 206 passed in 42 suites.
- Metadata regression tests: 15 passed.
- Intent identifiers: 22 retained.
- Advertised shortcut owners: 10 retained.
- Templates: 22 original + 16 added = 38.
- Finite expansions including enum synonyms: 365 unique; no exact cross-intent collisions.
- Budget including ten suggested vehicles: 375.
- Generated training corpus: validated.
- Strict/deep signature verification: passed using macOS trust services.
- App/widget entitlement bundle and team identities: validated.
- Growth source, GrowthPeriod, GrowthModel, and phrase registrations: unchanged.
- git diff --check: passed.
- iPhone installation: successful in-place 0.1 (3) → 0.1 (4); launch and startup identity match confirmed.
- Physical Siri Round 1 (owner reported): 5/6 worked; all four new registered phrase variations worked; app-name-free request did not invoke.
- Physical Siri Round 2 (owner reported): 3 worked, 2 wrong results, 6 failed, 1 not tested. Personal shortcut outcome not reported.
- Reliability investigation: read-only assessment and proposed fixes; awaiting implementation approval.

| Shortcut owner | Templates | Finite expansions | Dynamic entity templates |
|---|---:|---:|---:|
| FleetStatsIntent | 7 | 230 | 0 |
| CheckDMVIntent | 3 | 19 | 0 |
| DallasFleetSummaryIntent | 5 | 5 | 0 |
| RecentSightingsIntent | 5 | 81 | 0 |
| DallasWeeklySightingsIntent | 2 | 2 | 0 |
| DailyBriefingIntent | 6 | 6 | 0 |
| NearbySightingsIntent | 1 | 1 | 0 |
| FleetGrowthIntent | 2 | 15 | 0 |
| VehicleHistoryIntent | 2 | 1 | 1 |
| DallasServiceZoneIntent | 5 | 5 | 0 |

Full identities and paths are in validation.json. The physical test matrix is separate from local validation.

[Round 1 results](round-1-results.md) · [Round 2 test plan](round-2-test-plan.md)

[Read-only Siri Reliability investigation and proposed fixes](siri-reliability-investigation.md)
