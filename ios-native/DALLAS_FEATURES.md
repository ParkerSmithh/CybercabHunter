# Dallas-era SwiftUI handoff

The app target is `com.cybercabhunter.native` in the shared CybercabHunter Xcode scheme. The project also contains Widgets, Share, unit tests, and UI tests. The deployment target is iOS 18. The existing project uses automatic signing. The Mac exposes an Apple Development identity. Apple Distribution signing and App Store Connect app access were not verified. The existing app entitlements contain app and Keychain groups. They do not contain `aps-environment` or associated domains.

## Existing experience and API audit

Home, Cars, Zones, Sightings, and Community are the main tabs. Simulation, Replay, News, DMV, rider and account screens already exist. Cars, Zones, and Sightings already supported Austin and Dallas with separate screen selections. The app receives raw UIKit APNs bytes, converts them to hex, and uses the existing push Keychain entry. Registration sends the installation ID, token, authorization, APNs environment and timezone to the authenticated `PUT /api/push/device`, which writes `push_devices` when enabled. The Worker cron is absent from production configuration. A local permission grant or configured device token alone does not establish working production delivery.

The widget scheme already opens registry, sightings, zones, community and actions. This branch adds `cybercabhunter-widget://vehicle?id=<uuid>`, `cybercabhunter-widget://city?city=dallas` and city query handling on registry and sightings links. An individual sighting link can supply `id=<public-id>` and uses the existing authenticated push sighting lookup. No universal-link entitlement was added.

## API dependencies and request budget

| Surface | Calls | Status and D1 cost |
| --- | --- | --- |
| Home city facts | One hourly public `GET /api/cities` | Staging 200 and two rows uncached. Production 404 at verification. |
| Fleet History | One hourly public `GET /api/fleet-history?city=` per selected city | Staging 200 and one row uncached. Range changes use the cached payload. |
| Fare History | One hourly public `GET /api/fare-history?city=` per selected city | Staging 200 and one row uncached. The separate calibration endpoint is intended for Fleet ETA, not required by this screen. |
| Registry, Sightings and Zones | Existing city-aware registry pages, sightings feed, cameras and zone stats | Existing routes reused. List costs vary by pagination and edge cache state. Additional app traffic was not measured. |
| Vehicle detail | Adds one public `GET /api/robotaxi-vehicles/:id/timeline?page=` per requested page | Planned production contract. The route is absent from Worker main. A separate prototype exists on the local vehicle timeline worktree. It exposes aggregate public ride counts only. |
| Notifications | Existing authenticated `GET/PUT /api/push/preferences` and `PUT/DELETE /api/push/device` | The city field, active production cron and staging APNs integration are pending. The legacy preference payload omits the city field. |

Public city and history requests can use the three independent preview deployments only in Debug with `-dallasPreviewAPIs`. Those requests do not attach bearer sessions. Release builds use the site's normal production origin. The shared city is an on-device choice. The authenticated city preference endpoint is not used to send production account credentials to a preview.

A cold visit to all three new summary surfaces for a single city costs four underlying D1 rows if all edge caches miss. A cold visit to both histories across all three scopes plus city facts costs eight. Live app usage and timeline or per-city push costs were not available, so a daily all-user total remains unverified. No paid service or new entitlement was introduced.

## Draft TestFlight notes

- Switch between Austin, Dallas and All cities. The app remembers your selection.
- Browse Fleet History and Fare History with source labels, date ranges and saved-snapshot timestamps.
- Open a public vehicle timeline where the server provides it.
- Pause push delivery or remove this iPhone from alerts in Notification Settings. City filtering requires the updated push backend.

Release readiness requires production summary and timeline APIs, the per-city push backend and cron, signed APNs capability, an App Store Connect app record and distribution access, and a successful archive. Capture screenshots from the signed build after those gates are verified.

## Existing request paths

The following literal paths are from the application source on main. Path parameters appear as Swift interpolation where the app builds the URL.
- `/api/account`
- `/api/avatars/<key>`
- `/api/camera-sightings/heat`
- `/api/camera-sightings/history`
- `/api/camera-sightings`
- `/api/community/leaderboard`
- `/api/community/summary`
- `/api/daily`
- `/api/dmv-registrations`
- `/api/dmv/activity/\(date)`
- `/api/dmv/activity`
- `/api/dmv/growth`
- `/api/dmv/overview`
- `/api/dmv/vins/\(VehicleSearchText.normalized(vin))`
- `/api/dmv/vins/\(vin)`
- `/api/dmv/vins`
- `/api/fare-reports`
- `/api/fleet-eta`
- `/api/fleet-stats`
- `/api/follow-requests/\(r.id)/\(accept`
- `/api/follow-requests`
- `/api/followers/\(id)`
- `/api/follows/\(handle)`
- `/api/homepage-stats`
- `/api/me`
- `/api/moderation/access`
- `/api/moderation/approved-photo-sightings`
- `/api/moderation/forwarding-detail`
- `/api/moderation/forwarding-stats`
- `/api/moderation/news-config`
- `/api/moderation/news/\(story.id)`
- `/api/moderation/news/run`
- `/api/moderation/news`
- `/api/moderation/receipt-import`
- `/api/moderation/riders`
- `/api/moderation/robotaxi-vehicles/\(id)/review`
- `/api/moderation/robotaxi-vehicles/\(v.id)/vin`
- `/api/moderation/robotaxi-vehicles/\(v.id)`
- `/api/moderation/robotaxi-vehicles`
- `/api/moderation/sightings/\(s.id)/photo`
- `/api/moderation/social/announcement`
- `/api/moderation/social/overview`
- `/api/moderation/social/reports`
- `/api/moderation/social/resolve`
- `/api/moderation/vehicle-sightings/\(a.submissionId)/map`
- `/api/moderation/vehicle-sightings/\(s.submissionId)/promote`
- `/api/moderation/vehicle-sightings/\(s.submissionId)`
- `/api/moderation/vehicle-sightings/\(submissionId)/photo`
- `/api/moderation/vehicle-sightings`
- `/api/news`
- `/api/onboarding/tesla-sync`
- `/api/places/map`
- `/api/places`
- `/api/profile/avatar`
- `/api/profile`
- `/api/push/device`
- `/api/push/news`
- `/api/push/preferences`
- `/api/push/report`
- `/api/push/sighting`
- `/api/receipt-ingestion/address/rotate`
- `/api/receipt-ingestion/address`
- `/api/receipt-ingestion/setup/complete`
- `/api/registry/stats`
- `/api/rider-search`
- `/api/riders/\(route.handle)`
- `/api/rides/import/preview`
- `/api/rides/import`
- `/api/rides/imports`
- `/api/rides/sync-status`
- `/api/robotaxi-vehicles/\(id)`
- `/api/robotaxi-vehicles/\(route.id)/sightings`
- `/api/robotaxi-vehicles/\(route.id)`
- `/api/robotaxi-vehicles/\(vehicle.id)/sightings`
- `/api/robotaxi-vehicles/\(vehicle.id)`
- `/api/robotaxi-vehicles`
- `/api/service-areas`
- `/api/sightings/following`
- `/api/sightings`
- `/api/social/comments/\(comment.id)`
- `/api/social/feed`
- `/api/social/notifications/read`
- `/api/social/notifications`
- `/api/social/posts/\($0.id)`
- `/api/social/posts/\(id)/like`
- `/api/social/posts/\(id)/pin`
- `/api/social/posts/\(id)/save`
- `/api/social/posts/\(id)`
- `/api/social/posts/\(postID)/comments`
- `/api/social/posts`
- `/api/social/reports`
- `/api/social/sidebar`
- `/api/social/vehicles`
- `/api/streaks/leaderboard`
- `/api/streaks/me`
- `/api/submissions`
- `/api/tesla/disconnect`
- `/api/trips/\(id.addingPercentEncoding(withAllowedCharacters:`
- `/api/trips`
- `/api/vehicle-sightings/photo`
- `/api/xp/me`
- `/api/xp/rules`
- `/data/traffic-cameras.json`
- `/oauth/app/exchange`
- `/oauth/google/start`
- `/oauth/tesla/link`
