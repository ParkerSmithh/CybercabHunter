# Cybercab Hunter — native iPhone app (SwiftUI)

A fully native SwiftUI app on the website's backend: the same Cloudflare
Worker APIs, the same D1 data, the same Google accounts and sessions. See
[PLAN.md](PLAN.md) for the architecture, the phases and the feature-parity
checklist. The Capacitor app in `../app` is unchanged and stays installable
side by side (different bundle id) until this one reaches parity.

* Xcode project: `CybercabHunter.xcodeproj` (scheme **CybercabHunter**), iOS 18+, Swift 6.
* No dependencies, no CocoaPods / packages: URLSession, Codable, Keychain,
  AuthenticationServices, SwiftUI.
* Source folders are Xcode "synchronized" folders: a new `.swift` file under
  `CybercabHunter/` is compiled automatically (handy when editing in VS Code).

## Build and test from the command line

```sh
cd ios-native
xcodebuild -scheme CybercabHunter -destination 'platform=iOS Simulator,name=iPhone 18 Pro' test
```

The unit tests run offline from saved fixtures. The Home, Cars and Zones UI
tests use the live backend, read only.

### Community, Sightings, Account, Moderation and Rider data tests (Phases 4–7)

These tests write: likes, comments and posts, submitted sightings, profile
edits and privacy changes, moderator reviews (sightings, registry vehicles,
News, receipt import), and the deletion of a throwaway account. So they never run against production. They run against the **real
Worker code over an isolated in-memory database**
(`scripts/community-test-server.mjs`, built on the website's own browser-test
harness in `tests/e2e/harness.mjs`), seeded through the Worker's own API.

The test accounts:
- alice, bob, dave: riders. alice has two rides and a forwarding address with
  Gmail's confirmation code waiting (receipt domain `receipts.cch-test.invalid`,
  which is not a real mail domain).
- mod: the moderator.
- carol: a private rider.
- erin: a throwaway account, deleted by the fixtures.
- frank: a rider with a Google photo (served only; the avatar checks).
- Any other token (e.g. `s-expired`): an ended session.

```sh
# Starts the test Worker on 127.0.0.1:8799 and runs CommunityUITests, SightingsAccountUITests and Phase51UITests.
ios-native/scripts/test-community.sh
# Phase 7 signed-in screens (Rider data, Receipt sync, Tesla status) plus Simulation, News and DMV (live, read only):
ONLY="CybercabHunterUITests/Phase7AccountUITests CybercabHunterUITests/Phase7UITests" ios-native/scripts/test-community.sh -parallel-testing-enabled NO
# One simulator, no parallel clones (what the reported runs used):
DESTINATION="id=<iPhone 18 Pro udid>" ios-native/scripts/test-community.sh -parallel-testing-enabled NO
# Everything (unit + every UI test; Home/Cars/Zones read production):
ONLY="CybercabHunterTests CybercabHunterUITests" ios-native/scripts/test-community.sh -parallel-testing-enabled NO
```

Run one test session at a time on one booted simulator. Parallel-testing
clones, or a freshly created simulator still doing its first-boot work,
overloaded the Mac (load average about 200) and made Apple's own simulator
processes (PosterBoard, Calendar) crash.

The app reaches it only in Debug builds, through launch arguments
(`-apiBase http://127.0.0.1:8799 -session s-alice`); a Release build has no
way to point anywhere but cybercabhunter.com. The unit-test fixtures for
Community were produced by the same script:

```sh
node ios-native/scripts/community-test-server.mjs --fixtures ios-native/CybercabHunterTests/Fixtures
```

Node 22 or later (it uses `node:sqlite`).

## Map data from the website

The zone boundaries, charging locations and US map aren't served by an API;
they're fixed data in the site's JS. `scripts/sync-web-data.mjs` copies them
into `CybercabHunter/Resources/WebData/*.json`:

```sh
node ios-native/scripts/sync-web-data.mjs
```

`WebDataSyncTests` fails if the bundled copies have drifted from the site.

## Install on your iPhone

1. `open ios-native/CybercabHunter.xcodeproj`
2. Select the **CybercabHunter** target → **Signing & Capabilities** → tick
   **Automatically manage signing** → **Team**: your *(Personal Team)*.
   (If `com.cybercabhunter.native` is taken, change the Bundle Identifier.)
3. Plug in the iPhone, pick it as the run destination, press **⌘R**.
4. First time only: on the iPhone, **Settings › General › VPN & Device
   Management** → your Apple ID → **Trust**. Developer Mode must be on
   (**Settings › Privacy & Security › Developer Mode**).

The app is called **Cybercab Hunter** on the Home Screen (Debug and Release).

Phase 6 adds a widget extension (`CybercabHunterWidgets`, bundle id
`com.cybercabhunter.native.widgets`). In **Signing & Capabilities**, select the
same Team for it as for the app (Xcode creates its profile automatically). On
the iPhone: long-press the Home Screen → **Edit → Add Widget** → Cybercab
Hunter. Siri phrases ("Cybercab Hunter fleet stats", "Open the zone map in
Cybercab Hunter", "Submit a sighting in Cybercab Hunter", "Look up XVF1524 in
Cybercab Hunter") and the Shortcuts app work after the app has been opened once.
With a free Apple ID it must be reinstalled from Xcode every 7 days.

Phase 7 adds no target, capability or entitlement. Simulation, News and the
Texas DMV roster open from Home: Explore, View News, and the DMV panel’s
“Every VIN on the roster” link, respectively; Rider data and Receipt sync (Gmail)
under Account › Your activity. Receipt sync is Gmail *forwarding*: the steps
are done in Gmail on a computer; the app shows the address, Gmail's
confirmation and whether receipts arrive, and never signs in to Gmail.

## Profiling on a ProMotion iPhone

**Product › Profile (⌘I)** in Xcode, then the **SwiftUI** and **Animation
Hitches** templates (or **Time Profiler**). Scroll Home and switch tabs; the
hitch ratio and frame rate in the timeline are the numbers to compare between
phases. `CADisableMinimumFrameDurationOnPhone` is set, so system animations
may run at 120 Hz; it does not guarantee it.
