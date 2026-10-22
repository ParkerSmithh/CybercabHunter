# Phase 7 progress (paused Oct 22, 2026; testing resumed and completed the same day)

**Status: all Phase 7 testing complete. Every test passed.** The interrupted
regression tests were rerun after the pause (`reg2.log`): Phase6UITests
`testWidgetsAreInTheHomeScreenGallery` passed, and SightingsAccountUITests
passed 5/5. Still uncommitted; nothing committed, pushed, merged or deployed.

Paused at the owner's request (Mac shutdown). Nothing was committed, pushed,
merged, deployed or reset. All work is uncommitted on the branch below.

- **Branch:** `claude/phase7-remaining-native` (created from `claude/phase6-native-extras`; keeps the uncommitted work of Phases 5.1–6)
- **Simulator:** iPhone 18 Pro `AC3027CC-AD0B-4091-8223-69DDF4364FFE`
- **Results folder:** `~/Library/Developer/CybercabHunterTestResults/20261022-phase7/` (logs and `.xcresult` bundles)
- Details of what was built: `ios-native/PLAN.md`, section "Phase 7: Remaining native features".

## Completed features (built, tested)

1. Simulation: Fleet ROI, Fleet ETA, fare report form (`Features/Simulation/`, `Core/Models/FleetEta.swift`)
2. News (`Features/News/`)
3. Texas DMV roster (`Features/DMV/`), plus Home › Explore and the Home DMV-panel link (`Features/Home/ExploreSection.swift`)
4. Rider data, and Receipt sync (Gmail *forwarding*: no Gmail OAuth, no tokens) (`Features/Rider/`), linked from Account
5. Tesla link status, link via Tesla's own page, and unlink, for moderators only, as on the website (not tested end to end with a Tesla account)

Also:
- Bug fix: the Fleet ETA demand slot was locale-dependent (`SimulationCalc.slot`).
- Test Worker seed: a test receipt domain, a Gmail code for alice, and 4 new fixtures (`scripts/community-test-server.mjs`).
- PLAN.md and README.md updated.

## Test results

| Run | Result |
| --- | --- |
| Debug build | ✅ succeeded |
| Release build (generic iOS Simulator) | ✅ succeeded |
| Unit tests, all phases (`unit2.log`) | ✅ 122/122 passed (24 new in `Phase7Tests`) |
| Phase7UITests (Simulation, News, DMV; live site, read only) (`ui6.log`) | ✅ 3/3 passed |
| Phase7AccountUITests (Rider data, Receipt sync, Tesla status; test Worker) (`ui6.log`) | ✅ 3/3 passed |
| Regression `reg.log`: CommunityUITests | ✅ 4/4 passed |
| Regression: Phase51UITests | ✅ 5/5 passed |
| Regression: Phase6UITests | ✅ 2 passed (`testSubmitSightingShortcutOpensTheForm`, `testWidgetLinksOpenTheirTabs`); ✅ `testWidgetsAreInTheHomeScreenGallery` passed on the resumed run (`reg2.log`) |
| Regression: SightingsAccountUITests | ✅ 5/5 passed on the resumed run (`reg2.log`) |

No test failed in the final runs. The Gmail test's code assertion and the
iOS 26 dialog dismissal were fixed during the work; the Simulation test's
expected value was corrected earlier.

## Outstanding

- Tesla linking was not exercised against a real Tesla account. Tesla's
  callback returns to the website, not the app.
- Still blocked from Phase 6: Live Activities and push notifications (need a
  paid Apple Developer account, an APNs key and a Worker sender).
- Cosmetic: the long forwarding address can wrap mid-token.

## Resume testing

```sh
cd ~/Downloads/Website
git branch --show-current          # expect claude/phase7-remaining-native
xcrun simctl boot AC3027CC-AD0B-4091-8223-69DDF4364FFE; xcrun simctl bootstatus AC3027CC-AD0B-4091-8223-69DDF4364FFE -b
cd ios-native
R=~/Library/Developer/CybercabHunterTestResults/20261022-phase7

# The interrupted regression tests (starts the isolated test Worker on 127.0.0.1:8799 itself):
ONLY="CybercabHunterUITests/SightingsAccountUITests CybercabHunterUITests/Phase6UITests/testWidgetsAreInTheHomeScreenGallery" \
  DESTINATION="id=AC3027CC-AD0B-4091-8223-69DDF4364FFE" scripts/test-community.sh \
  -derivedDataPath ~/Library/Developer/CybercabHunterTestResults/dd -parallel-testing-enabled NO \
  -resultBundlePath $R/reg2.xcresult > $R/reg2.log 2>&1
grep -E "Test Case.*(passed|failed)|\*\* TEST" $R/reg2.log

# Optional full re-check of Phase 7 (unit, then UI):
xcodebuild -project CybercabHunter.xcodeproj -scheme CybercabHunter -destination "id=AC3027CC-AD0B-4091-8223-69DDF4364FFE" \
  -derivedDataPath ~/Library/Developer/CybercabHunterTestResults/dd -parallel-testing-enabled NO -only-testing:CybercabHunterTests test
ONLY="CybercabHunterUITests/Phase7AccountUITests CybercabHunterUITests/Phase7UITests" \
  DESTINATION="id=AC3027CC-AD0B-4091-8223-69DDF4364FFE" scripts/test-community.sh \
  -derivedDataPath ~/Library/Developer/CybercabHunterTestResults/dd -parallel-testing-enabled NO
```

Run one test session at a time. If xcodebuild hangs after a failure:
`pkill -f "xcodebuild.*CybercabHunter"; pkill -f community-test-server.mjs`.
