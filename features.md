# Features

## Shared across all pages (`js/main.js`, `css/style.css`)

- Sticky, blurred glass header with a sliding gold-to-cyan indicator under the active nav link (`CCC.initNav`)
- "Link Tesla Account" button — a real link into Tesla's Fleet API OAuth flow (`/oauth/tesla/start`). Shares the rider's eligible Tesla vehicle info; it does not import Robotaxi ride history. Once linked, the button simply disappears from the header (unlinking happens from Rider Data instead)
- Google Sign-In / account menu drawer (Profile, Rider Data, Sign out)
- Scroll-triggered reveal animations (`IntersectionObserver`) with staggered delays via `data-delay`
- Ambient floating particle background + radial gradient mesh
- Reusable "Submit Sighting" slide-over drawer, wired once in `main.js` and available from every page's header — requires sign-in; sightings are submitted for moderator review, not published immediately
- Toast notifications for confirmations and errors
- Animated number counters (`CCC.animateCounter`) with easing, used for stats and financial outputs
- Custom dark-themed scrollbar, magnetic gold/cyan hover glow on buttons

## Homepage (`index.html`)

- Hero section with Cybercab hero image
- Real registry stats fetched from `GET /api/registry/stats` (`js/home-stats.js`), rendered with animated counters
- Interactive dark-mode MapLibre GL map (OpenFreeMap tiles)
- Recent sightings feed
- Submit Sighting drawer

## Fleet ETA — Dispatch Comparison Simulator (`dispatch-comparison.html`)

- Austin/Dallas city selector. Dallas shows an explicit "isn't available in Cybercab Hunter yet" state rather than any simulated data.
- Austin: Active Cybercabs (45), Active Model Y Fleet (114), and Service Radius (264 mi²) are shown as fixed values, not adjustable sliders. The one adjustable control besides Passenger Demand is Trip Distance (0–30 mi, range slider), which drives the estimated fare shown per fleet, not the ETA itself.
- Passenger Demand toggle: Low (0.8×) / Normal (1.0×) / Surge (1.5×)
- Live-animated ETA "stopwatch" displays for both fleets using `ETA = k × √(Area / Fleet) × Demand`
- Dual-colored (gold vs. crimson) Arrival Odds bar computed as `fleetA / (fleetA + fleetB)`
- Radar-sweep graphic per fleet whose spin speed scales with that fleet's ETA

## Fleet ROI — Fleet Investor Sandbox (`fleet-calculator.html`)

- Adjustable inputs: fleet size, electricity rate, and daily miles/cab (range sliders), plus an inductive-loss toggle (defaults to 8%)
- Passenger Fare, Tesla Network Cut, and Cost per Unit are shown as fixed assumptions, not adjustable inputs
- Animated output cards: Monthly Energy Overhead, Gross Fleet Revenue, Net Operating Income
- Breakeven-timeline meter
- "Export Investment Prospectus" button generates a PDF client-side via `jsPDF` (loaded from a CDN) — not a `.txt` file

## Zones (`infrastructure.html`)

- Austin/Dallas city selector. Dallas shows "NOT YET AVAILABLE — Dallas zone information isn't available in Cybercab Hunter yet."
- Austin: a MapLibre GL map showing Tesla's actual published Robotaxi service-zone geofence as a polygon, plus two named, real charging-location markers (St. Elmo Robotaxi Charging Hub, Ridgepoint Robotaxi Charging Site) with popup details
- Austin "Services in Austin" (coverage in mi², launch date) and "Fleet & Fares" (Cybercab count, median/average fare, per-mile rate) figures. **These are manually maintained, hardcoded numbers written directly into the page's own script**, shown with the same animated count-up effect used for real stats elsewhere — they are not fetched from any API and are not live telemetry.

## Community (`community.html`)

Placeholder page only. The previously described City Showdown voting, Cybercab Bingo, and Spotter Leaderboard features have been removed and do not exist in the current page. Current copy: *"The spotter leaderboard isn't live yet... Rankings will only be shown once they can be based on real, moderated contributions."*

## Sign-in (`signin.html`)

- Google Sign-In entry point for the account system

## Cars — public vehicle registry (`vehicles.html`, served at `/vehicles`)

- Lists every vehicle that is both moderator-approved (`public`) and backed by at least one counted ride, from `GET /api/robotaxi-vehicles`
- Card fields include plate, model (or "Model not confirmed"), service area, ride count, and first/last-seen dates drawn from the vehicle's own counted rides

## Vehicle detail (`vehicle.html`, served at `/vehicle/:id`)

- Shows a single public vehicle's record: plate, model, provider, color, service area, first/last seen, and a verification-status note
- **Public eligibility is strictly enforced at the route level.** A private vehicle, or one that has lost its last counted ride, is not exposed as a distinguishable resource — its detail route returns the exact same 404 response as a vehicle id that doesn't exist at all, so a private vehicle's existence can never be inferred from this route

## Moderation (`moderation.html`, served at `/moderation`)

- Vehicle-sighting review queue: approve or reject a rider-submitted sighting
- Registry vehicle review, with a scope filter of **Private** (default) or **Public**:
  - **Approve** — single click, shown only when the vehicle is eligible (private, has a counted ride, unique plate); no confirmation step
  - **Return to Private** — single click, shown for public vehicles; no confirmation step
  - **Delete Vehicle** — two-step confirmation (ask, then confirm), for extra safety. Deleting also purges the ride(s)/receipt(s) logged against that vehicle, for any rider who logged one — this is what actually frees the underlying receipt to be resent and reprocessed, since the ingestion pipeline's duplicate check keys off the trip surviving, not the vehicle link. This is intentional, disclosed in the confirmation text, and not a bug (see `bugs.md`).
- Access is restricted to accounts with the `moderator` role (see `docs/registry-preflight.md` for how that's granted)

## Rider Data (`rider-data.html`)

- A signed-in rider's own paginated ride history, with a per-ride **Remove** control (`DELETE /api/trips/:id`)
- Vehicles Ridden vs. Vehicles You Discovered (the first rider to log a counted ride on that vehicle)
- A "View on Cars →" link to a vehicle's public registry entry, shown only when that vehicle is currently public and eligible

## Profile (`profile.html`)

- A rider's own account/profile settings
