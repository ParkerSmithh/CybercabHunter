# Cybercab Hunter for iPhone (Capacitor)

A native iOS shell around **https://cybercabhunter.com**. The app opens the live
site in a native web view (`server.url` in `capacitor.config.json`), so every
website feature, the Worker routes (`/vehicle/:id`, Community links, videos)
and the API work exactly as on the web, with the same Cloudflare Worker and
D1 database. Nothing about the production website changes because of this
folder; it is not part of the Worker deploy.

| Piece | Where |
| --- | --- |
| App id / name | `com.cybercabhunter.app` / Cybercab Hunter (`capacitor.config.json`) |
| Offline page bundled in the app | `www/` (built by `scripts/build-web.mjs`, shown via `server.errorPath`) |
| Xcode project | `ios/App/App.xcodeproj` (Swift Package Manager, no CocoaPods) |
| App screen + native plugin registration | `ios/App/App/AppViewController.swift` |
| Google Sign-In in Apple's sign-in sheet | `ios/App/App/NativeSignInPlugin.swift` |
| Permissions, URL scheme | `ios/App/App/Info.plist` |

## Sign-in and sessions

* Sessions are the site's usual bearer token in `localStorage` (no cookies),
  which the app's web view keeps between launches.
* Google blocks sign-in inside embedded web views, so the app intercepts
  "Sign in with Google" and runs it in Apple's system sign-in sheet
  (`ASWebAuthenticationSession`). The Worker returns a one-time code to
  `cybercabhunter://oauth/callback`; the app redeems it with a secret verifier
  (`POST /oauth/app/exchange`, PKCE-style) and hands the session to the page.
  **This needs the Worker change in `worker/google-auth.js` deployed** before
  Google Sign-In works in the app.
* No secrets are in the app: the Google client secret and every API key stay
  in the Worker.
* Links to other sites open in Safari; Tesla's login pages (`*.tesla.com`)
  stay in the app so linking a Tesla account comes back signed in.

## Commands

```sh
cd app
npm install          # once
npm run sync         # rebuild www/ and copy config + files into the Xcode project
npm run open         # open the project in Xcode
```

## Ready for later (not built yet)

Native features go in as Capacitor plugins registered in
`AppViewController.capacitorDidLoad()` (or official `@capacitor/*` packages):
GPS (`@capacitor/geolocation`, location permission text is already in
Info.plist), camera (`@capacitor/camera`; the site's photo picker already works
with the camera and library), push notifications (`@capacitor/push-notifications`
plus an APNs key, which needs a paid Apple Developer account), and Siri App
Intents / widgets / Apple Intelligence as Swift targets added to the Xcode
project (widgets and App Groups also need a paid account).
