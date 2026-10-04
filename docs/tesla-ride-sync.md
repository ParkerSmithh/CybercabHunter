# Tesla Ride Sync

Imports a rider's Robotaxi ride history straight from their own Tesla account, with their consent. Receipt forwarding (email, Gmail, paste/import) stays as the fallback ride source; both feed the same canonical ride pipeline.

## Upstream reference

The endpoint and auth flow come from Ethan McKanna's public, MIT-licensed exporter: <https://github.com/EthanMcKanna/robotaxi-history-exporter> (`robotaxi_history.py`, Jan 2026). It calls Tesla's ride-history endpoint with a token from Tesla's first-party `ownerapi` OAuth client. This supersedes earlier notes in this repo that called that endpoint broken or unverified.

- **Endpoint:** `GET https://ownership.tesla.com/mobile-app/ride/history`. The fallback is `https://akamai-apigateway-charging-ownership.tesla.com/mobile-app/ride/history`.
- **Parameters:** `pageNo`, `deviceLanguage=en`, `deviceCountry=US`, `ttpLocale=en_US`. Pages hold 100 rides; reading stops at a short page.
- **Response:** `{"code":200,"data":{"rides":[...]}}`.
- **Auth:** Tesla SSO OAuth2 with PKCE (S256).
  - `client_id`: `ownerapi`
  - Redirect: `tesla://auth/callback`. The exporter's `https://auth.tesla.com/void/callback` has since been retired by Tesla for `ownerapi`: using it now fails with "The 'redirect_uri' supplied is not registered for this 'client_id'". `tesla://auth/callback` is the only registered redirect.
  - Token endpoint: `https://auth.tesla.com/oauth2/v3/token`
  - Scopes: `openid email offline_access phone`
  - No client secret and no audience.
  - The API call carries a plain `Bearer` token. Refresh tokens rotate.

## Flow

| Step | Route | What happens |
|---|---|---|
| 1. Connect | `GET /api/tesla/rides/connect` | Returns the Tesla authorize URL. The PKCE verifier and the single-use state are kept in KV for 10 minutes, bound to the rider's session. |
| 2. Sign in | Tesla's site, in a new tab, on a computer | The rider signs in to Tesla **themselves**. Cybercab Hunter never sees, asks for or stores Tesla credentials. Tesla then redirects to its app scheme, `tesla://auth/callback?code=…`, which a desktop browser cannot open, so the page appears to do nothing. The rider copies that address from the developer tools' Network tab (with Preserve log on), where it appears as the `callback?code=…` entry. On a phone the Tesla app may claim the `tesla://` link instead, so connecting is done on a computer. |
| 3. Paste | `POST /api/tesla/rides/callback` `{ callback_url }` | The rider pastes that address. Only `tesla://auth/callback?…` (optionally with the `location:` header name in front) or an `auth.tesla.com` address is accepted, and the state must belong to the same rider. The code is exchanged at `auth.tesla.com`, then both tokens are encrypted with `tokenCrypto` into the KV blob `tesla_rides_tokens:<user>`. D1's `tesla_ride_sync_connections` holds only a pointer. Rides are fetched immediately and the response is the **preview**. Nothing is imported yet. |
| 4. Preview | `GET /api/tesla/rides/preview` | Lists each ride with a checkbox: date, route, miles, fare and plate. It shows no VIN, coordinates or billing data. Rides already stored, from either source, are marked. |
| 5. Import | `POST /api/tesla/rides/import` `{ ride_ids }` | The rides are fetched from Tesla **again**; the browser only names which of the rider's rides to import. They are stored through `worker/ride-ingest.js`. This confirmation also turns auto-sync on. |
| 6. Auto-sync | the 10-minute cron (`worker/index.js` `scheduled`) | Covers up to 2 riders per run, each at most every 6 hours. It refreshes the token when needed (a 401 triggers one forced refresh, then one retry). It imports only rides that started after the newest ride the rider was already shown, so a ride left unticked in the preview is never imported behind their back. When nothing is new, it only records `no_new_rides`. |
| Status / disconnect | `GET /api/tesla/rides/status`, `POST /api/tesla/rides/disconnect` | Disconnecting deletes the KV token blob. Rides already imported stay. Reconnecting clears auto-sync consent until the rider confirms an import again. |

The UI is the **Tesla ride history** card on Rider Data (`public/rider-data.html`, `public/js/rider-data.js`).

## Code

- **`worker/tesla-ride-provider.js`:** `fetchRides(accessToken)`.
  - Tries the primary host, then the fallback.
  - Starts with minimal headers. It retries a host with the mobile app's headers (`X-Tesla-User-Agent` etc.) only when the minimal request is refused with 400, 403 or 406.
  - A 401 throws `TokenExpiredError`. Failure on both hosts throws `RideHistoryError` carrying the status.
  - Returns the raw rides array.
- **`worker/tesla-ride-canonical.js`:** the `tesla-api` adapter, registered in `worker/ride-canonical.js`.
  - Times: `rideStartedAt` and `rideCompletedAt` become the local date and pickup/dropoff minute, in the API's own pickup/dropoff timezone (falling back to `resolveTimezone`).
  - Places: pickup/dropoff names and coordinates. Coordinates are in the canonical shape but are not persisted.
  - Numbers: `totalDistanceMiles` (null if absent, never 0), `totalDurationSeconds`, and `totalDue` with `currencyCode` (provenance `extracted`).
  - Vehicle: the plate goes through `plate.js`, and the VIN is kept as-is as `reportedVin`.
  - Review status: `isValid: false` holds a ride for review.
  - Never read: billing, rider and payment fields.
- **`worker/tesla-rides.js`:** the OAuth flow, preview, import and auto-sync. The `ownerapi` configuration is the default. The separately registered Fleet client is still selectable with `TESLA_RIDES_CLIENT=fleet` but is never used for ride history.
- **`migrations/0024_tesla_ride_sync_import.sql`:** adds `auto_sync_after` and `last_sync_result` to `tesla_ride_sync_connections`, and `reported_vin*` to `robotaxi_vehicles`.

## Deduplication

- **Same source:** each ride's ingestion hash is `tesla-api:<rideId>`, and `rideId` is stored as `external_ride_id`. Syncing the same ride again is a duplicate.
- **Across sources:** a forwarded receipt and a synced ride of the same trip count once. A match is any of:
  - the usual ride key (local date | pickup minute | plate);
  - Tesla's ride id;
  - the same date + plate + fare, with pickup times at most 10 minutes apart. All three values must be present on both sides; a missing value never matches.
- **Updates:** synced rides carry no "sent" time, so under the ordering rule they only **fill** values a stored ride lacks and never overwrite a receipt's values.

## Vehicles and moderation

- A plate not yet in the registry is created only as a **private** row, through the existing `db.findOrCreateRobotaxiVehicleByPlateDetailed` path.
- The VIN Tesla reports is stored as `robotaxi_vehicles.reported_vin` (with `reported_vin_source = 'tesla-api'`) for a moderator to verify later. It is written once and never overwritten.
- It is deliberately **not** the `vin` column. `vin` is the moderator's manual confirmation that Approve Cybercab requires.
- The sync never approves, publishes, or changes any vehicle's visibility, `vin` or verification status. A vehicle becomes public only through the existing moderation approval flow. Rides may attach to private vehicles, and logging a ride never changes visibility.
- `tests/registry-ride-aggregation.test.mjs` guards this statically.

## Caveats

- **First-party client, undocumented endpoint.** This uses Tesla's first-party `ownerapi` client id exactly the way the reference script does: the rider's own data, with their explicit consent, the same approach as Robotaxi Tracker. It is not a documented or partner-authorized API, and Tesla could change or remove it without notice. Email forwarding is the insurance.
- **Needs a live verification pass.** Everything is covered by mocked tests:
  - `tests/tesla-ride-provider.test.mjs`: pagination, host fallback, the app-header retry, and 401 handling.
  - `tests/tesla-ride-canonical.test.mjs`: the adapter.
  - `tests/tesla-ride-sync.test.mjs`: connect, preview, import, dedupe, vehicles and auto-sync.

  It has **not** yet been run against a real Tesla account with Robotaxi ride history. The first live run should confirm:
  - that Tesla accepts `tesla://auth/callback` for the code exchange from a Cloudflare Worker, and how easily riders can copy it from the Network tab;
  - whether the minimal headers are accepted;
  - the format of `rideStartedAt` and `totalDue` (dollars assumed);
  - the `isValid`, `state` and `status` values on cancelled rides.
- **Tokens:** encrypted at rest (`TESLA_TOKEN_ENCRYPTION_KEY`). They are never logged and never returned to the browser.
