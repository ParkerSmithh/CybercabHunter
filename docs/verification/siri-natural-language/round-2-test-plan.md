# Physical-device Round 2 — owner-run plan

Use the existing installed **0.1 (4)**. No source edits, rebuild, reinstall, reset, cache clearing, or permissions changes are needed. FleetGrowthIntent discovery is excluded. Results are now recorded in round-2-test-results.csv: 3 worked, 2 wrong results, 6 failed, 1 not tested among cases 1–12. Personal shortcut case 13 has no reported result. The expectations below are the original test plan, not observed bindings.

Cases 1–12 are registered templates/finite enum expansions or their existing synonyms (ordinary punctuation ignored). Their device recognition and retry behavior remain unverified. Complete each as a separate Siri request; record whether Siri invoked the app, the city/metric/period in the answer, and any prompt/error. An explicitly unavailable-data answer is different from wrong routing or a fabricated zero.

| # | Say | Expected behavior |
|---|---|---|
| 1 | How big is the Austin Cybercab zone in Cybercab Hunter? | Austin service-area size/source; never Dallas or global. |
| 2 | What is the Austin Cybercab fleet size in Cybercab Hunter? | Austin public registry vehicles; not active service or DMV VINs. |
| 3 | How many Cybercabs were spotted in Austin yesterday in Cybercab Hunter? | Approved sightings on the previous Central calendar day. |
| 4 | Cybercab Hunter sightings in Austin this week | Austin approved sightings since Monday Central. |
| 5 | Cybercab Hunter sightings in Austin in the last seven days | Rolling seven-day approved sightings; do not silently label as calendar week. |
| 6 | Cybercab Hunter Austin camera detections today | Austin camera observations today Central; not unique vehicles or public photos. |
| 7 | How many Cybercabs did Dallas cameras detect today in Cybercab Hunter? | Dallas camera detections today; no Austin substitution. |
| 8 | Which city has more Cybercab sightings today in Cybercab Hunter? | Both cities, approved sightings today; state winner or tie. |
| 9 | Compare Austin and Dallas camera detections this week in Cybercab Hunter | Both cities camera detections since Monday Central; not approved sightings. |
| 10 | Tell me how many Cybercab VINs are registered in Texas in Cybercab Hunter | Texas DMV Cybercab VIN count and snapshot date; not public registry or active service. |
| 11 | Compare Austin and Dallas Cybercab activity in Cybercab Hunter | Ask for metric/city/period. Reply “Austin and Dallas sightings today”; record prompt and retry outcome. |
| 12 | Cybercab camera detections this week in Cybercab Hunter | Ask for city/metric/period. Reply “Dallas camera detections this week”; record prompt and retry outcome. |

## 13. Personal shortcut: Dallas Cybercab Zone

In Shortcuts, create a personal shortcut with the existing Cybercab Hunter **Dallas Service Area** action (`DallasServiceZoneIntent`). This action has no city parameters. Name the personal shortcut **Dallas Cybercab Zone**. If that name already exists, inspect it and reuse it only if it already contains the intended action; do not overwrite an unrelated shortcut.

1. Run the personal shortcut manually. Confirm it returns Dallas service-area information.
2. Say **“Siri, Dallas Cybercab Zone.”** Record whether it launches that personal shortcut and returns the Dallas result.
3. Optionally repeat after an Austin request to check that Dallas remains fixed.

This tests a user-defined shortcut name, not automatic routing of arbitrary app-name-free questions. Creating it does not change the app’s ten advertised slots, its 38 templates, or any action implementation. The agent has only prepared these instructions and has not created the shortcut or changed device settings.

## Reporting results

Return case numbers with WORKED, DID NOT INVOKE APP, WRONG CITY/METRIC/PERIOD, CLARIFICATION, or DATA UNAVAILABLE. For 11–12, include the actual prompt and what happened after the stated reply. For 13, report manual run and Siri run separately. Include the response wording when a result is unexpected; exact counts are not required for recognition testing.

Do not retest or try to repair Growth discovery in this round. Keep the existing Dallas actions/phrases unchanged. No additional Siri changes are proposed; await owner results.
