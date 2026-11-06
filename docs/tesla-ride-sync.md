# Tesla Ride Sync: why it isn't available

Status: **unavailable** (checked Nov 5, 2026). Robotaxi rides reach Cybercab Hunter through Tesla's ride receipts (Gmail forwarding or import), which work.

## What was tested
- **Oct 4, 2026, from the server.** Commits `31d2b1a`…`26c95a8`, since removed. Sign-in with the `ownerapi` client worked, as did the code exchange. `ownership.tesla.com/mobile-app/ride/history` answered **401 on every request**: both hosts, with and without the Tesla app's headers, even after a token refresh. Tesla had also stopped accepting `https://auth.tesla.com/void/callback` for that client.
- **Nov 5, 2026, on the owner's iPhone.** The debug-only probe (`ios-native/CybercabHunter/Features/Debug`) used the `tesla://auth/callback` redirect. The callback, code exchange and tokens all worked (HTTP 200, a 28,800 s token). Ride history answered **401** on both hosts, minimal and app-style headers alike.

So where the request comes from makes no difference, and the token is valid. The endpoint doesn't accept this sign-in for ride history.

## What Tesla supports
Primary sources, read Nov 5, 2026:
- **Fleet API is the only supported third-party API.** It covers "Tesla vehicles and energy devices": owned or shared vehicles, energy, the user profile, active orders and charging history. [What is Fleet API](https://developer.tesla.com/docs/fleet-api/getting-started/what-is-fleet-api), [user endpoints](https://developer.tesla.com/docs/fleet-api/endpoints/user-endpoints), [charging endpoints](https://developer.tesla.com/docs/fleet-api/endpoints/charging-endpoints), [vehicle endpoints](https://developer.tesla.com/docs/fleet-api/endpoints/vehicle-endpoints)
- **No ride data.** No documented endpoint returns Robotaxi or ride-hailing rides, and nothing mentions rides or trips.
- **Approval and keys.** Third-party apps are registered and approved, with a client ID and secret, a regional `audience` and these scopes: `openid`, `offline_access`, `user_data`, `vehicle_device_data`, `vehicle_location`, `vehicle_cmds`, `vehicle_charging_cmds`, `energy_device_data`, `energy_cmds`. [Authentication](https://developer.tesla.com/docs/fleet-api/authentication/overview), [third-party tokens](https://developer.tesla.com/docs/fleet-api/authentication/third-party-tokens), [regions](https://developer.tesla.com/docs/fleet-api/getting-started/regions-countries)
- **The ride-history route isn't documented.** The `ownerapi` client, `ownership.tesla.com` and `/mobile-app/ride/history` appear nowhere in the official docs; they are internal to Tesla's own app.
- **Tesla's stated policy.** "Fleet API is Tesla's official 3rd party API and the only supported API for vehicle interactions… continued usage of unsupported APIs will result in the revocation of Fleet API access privileges." [Announcements](https://developer.tesla.com/docs/fleet-api/announcements), [legal](https://developer.tesla.com/docs/fleet-api/getting-started/legal)

## Root cause, and what's still unknown
**Established:**
- The 401 isn't an expired token: it was minutes old, with 28,800 s left.
- It isn't the host or the headers: every combination failed.
- It isn't the server's network: a phone got the same answer.
- The endpoint is internal and undocumented, and Tesla supports no third-party access to ride history. So no permission we could request through a supported flow would grant it.

**Not established:** *how* the endpoint tells Tesla's app apart. It might be a token audience, app attestation or something else. The probe now shows the token's audience, scopes and issuer, never the token itself, but it hasn't been re-run since that change. Doing so needs another sign-in with the owner's account, and the owner's approval. It wouldn't change the conclusion: getting past that check is exactly what the project's rules forbid.

## What the app does
- **Rider Data** shows a "Tesla ride history" note saying automatic sync isn't available, with a link to receipt sync. There is no Connect button, and no status that isn't true.
- **The probe stays in debug builds only.** It no longer sends the Tesla app's `X-Tesla-User-Agent`, asks one host once per tap, and stops after a 401 on a token that is still in date.
- **Token handling.** Tokens are held in memory only. A refresh that fails ends the session, concurrent refreshes share one request, and single-use refresh tokens are replaced when Tesla rotates them. The probe still uses the `ownerapi` client, but only in debug builds.

## Server-side clean-up (Nov 2026)
**Removed locally, on branch `claude/tesla-ride-sync-probe`, not yet deployed:**
- The server-side `ownerapi` sign-in: `/oauth/robotaxi/start`, `/oauth/robotaxi/callback`, `/api/robotaxi/status` and `/api/robotaxi/disconnect`, along with `worker/robotaxi-owner-auth.js` and its four database helpers.
- The temporary `/api/tesla/debug/capabilities` route (`worker/tesla-debug.js`).

`tests/phase2-hardening.test.mjs` §5 checks that these routes are gone, signed in or out, and that account deletion still clears a rider's leftover row.

**Kept:**
- `/oauth/tesla/*` (`worker/tesla.js`): the documented Fleet API "Link Tesla account", for owned vehicles.
- `/api/tesla/rides/*` (`worker/tesla-rides.js`): a Fleet API sign-in with no ride source behind it. It holds no `ownerapi` tokens and does no harm, so removing it is a separate decision.

### Stored ownerapi tokens: none, and the table is dropped
- **Counted Nov 6, 2026** (read-only, statuses and counts only): production's `robotaxi_owner_connections` held **0 rows**. With no tokens stored, the planned row-deletion script was never needed and has been removed.
- **`migrations/0053_drop_robotaxi_owner_connections.sql`** drops the empty table and its index. `worker/account.js` no longer deletes from it.
- **Order matters for this one: deploy the Worker first, then apply the migration.** The Worker deployed before this change still deletes from the table during account deletion. If the table went first, every account deletion would fail until the new Worker went out.

Tesla documents no revocation endpoint for `ownerapi` tokens. Riders can remove access at [auth.tesla.com/user/revoke/consent](https://auth.tesla.com/user/revoke/consent). The token-encryption key is shared with the Fleet API tokens and stays.
