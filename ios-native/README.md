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

### Community tests (Phase 4)

Production has no Social posts yet, and the Community tests write (a like, a
comment, a post), so they never run against production. They run against the
**real Worker code over an isolated in-memory database**
(`scripts/community-test-server.mjs`, built on the website's own browser-test
harness in `tests/e2e/harness.mjs`), seeded through the Worker's own API by
test riders:

```sh
ios-native/scripts/test-community.sh          # starts the test Worker on 127.0.0.1:8799, runs CommunityUITests
```

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

The app is called **Cybercab β** on the Home Screen while the migration runs.
With a free Apple ID it must be reinstalled from Xcode every 7 days.

## Profiling on a ProMotion iPhone

**Product › Profile (⌘I)** in Xcode, then the **SwiftUI** and **Animation
Hitches** templates (or **Time Profiler**). Scroll Home and switch tabs; the
hitch ratio and frame rate in the timeline are the numbers to compare between
phases. `CADisableMinimumFrameDurationOnPhone` is set, so system animations
may run at 120 Hz; it does not guarantee it.
