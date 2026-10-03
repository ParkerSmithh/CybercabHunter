# Features

## Shared across all pages (`public/js/main.js`, `public/css/style.css`)

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
- Real registry stats fetched from `GET /api/registry/stats` (`public/js/home-stats.js`), rendered with animated counters
- Interactive dark-mode MapLibre GL map (OpenFreeMap tiles)
- Recent sightings feed
- Submit Sighting drawer

## Simulation (`simulation.html`)

Two tools on one page (nav label "Simulation", URL `/simulation`), switched with the **FLEET ROI** and **FLEET ETA** buttons. Fleet ROI opens first; the choice is kept in the URL as `?view=eta`. The old `/fleet-calculator` URL redirects to `/simulation` and `/dispatch-comparison` to `/simulation?view=eta`.

### Fleet ETA — dispatch comparison

- Austin/Dallas selector; Dallas shows an explicit "isn't available in Cybercab Hunter yet" note instead of simulated data.
- Active Cybercabs and Active Model Y Fleet are live from `GET /api/fleet-stats` (vehicles with an approved sighting or a logged ride in the last 30 days), "—" when not tracked. Service area (264 mi²) is fixed.
- Trip Distance (0–30 mi) drives the fare estimate: miles × the average of the live per-mile rate and median fare ÷ median miles, from riders' logged rides, labelled as an estimate with its sample size and date.
- Passenger Demand: Low (0.8×) / Normal (1.0×) / Surge (1.5×).
- ETA per fleet: `ETA = k × √(Area / Fleet) × Demand`.

### Fleet ROI — Fleet Dashboard

- Adjustable inputs: fleet size, electricity rate, and daily miles/cab (range sliders), plus an inductive-loss toggle (defaults to 8%)
- Passenger Fare, Tesla Network Cut, and Cost per Unit are shown as fixed assumptions, not adjustable inputs
- Animated output cards: Monthly Energy Overhead, Gross Fleet Revenue, Net Operating Income
- Breakeven-timeline meter
- "Export" button generates a PDF client-side via `jsPDF` (loaded from a CDN) — not a `.txt` file

## Zones (`infrastructure.html`)

- Austin/Dallas city selector. Dallas shows "NOT YET AVAILABLE — Dallas zone information isn't available in Cybercab Hunter yet."
- Austin: a MapLibre GL map showing Tesla's actual published Robotaxi service-zone geofence as a polygon, plus two named, real charging-location markers (St. Elmo Robotaxi Charging Hub, Ridgepoint Robotaxi Charging Site) with popup details
- Austin "Services in Austin" (coverage in mi², launch date) and "Fleet & Fares" (Cybercab count, median/average fare, per-mile rate) figures. The Cybercab count and the fares are live from `GET /api/fleet-stats` (worker/fleet-stats.js): the count is the public Austin registry, and the fares are computed daily from riders' logged Austin rides, with "—" when there are none. Coverage and the launch date are fixed text.

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
- **Add to registry** (on a sighting card that has a plate and no matching registry vehicle) — creates a *private* registry vehicle from the sighting and approves the sighting in one step. No ride is created: such a vehicle shows "0 counted rides" and "Added from a community sighting", and reaches the public registry only after a moderator enters its VIN and clicks Approve Cybercab (the VIN stands in for the counted-ride requirement that receipt-created vehicles need). Refused when the sighting has no plate or a registry vehicle already holds that plate.
- **Muse connector sightings register automatically.** A new sighting from the Muse connector with a plate that no registry vehicle holds skips the sighting queue and appears directly in Registry Vehicles as a private vehicle (same card and Cybercab verification panel; no ride is invented, and nothing is public until a VIN is entered and Approve Cybercab is clicked). A sighting with no plate, or whose plate is already in the registry, still waits in the sighting queue. Riders' own sightings are unchanged.
- Access is restricted to accounts with the `moderator` role (see `docs/registry-preflight.md` for how that's granted)

## Rider Data (`rider-data.html`)

- A signed-in rider's own paginated ride history, with a per-ride **Remove** control (`DELETE /api/trips/:id`)
- Vehicles Ridden vs. Vehicles You Discovered (the first rider to log a counted ride on that vehicle)
- A "View on Cars →" link to a vehicle's public registry entry, shown only when that vehicle is currently public and eligible

## Profile (`profile.html`)

- A rider's own account/profile settings
