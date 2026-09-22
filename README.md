# Cybercab Hunter

A crowdsourced tracking and analytics platform for Tesla Cybercabs and Model Y robotaxis — a static frontend backed by a Cloudflare Worker and D1 database, with a cyberpunk automotive command-center aesthetic (dark carbon/glassmorphism, gold/crimson/cyan accents).

Not affiliated with Tesla, Inc. Vehicle sightings, receipts, and rider-submitted data are crowdsourced. The site does connect to Tesla's real Fleet API: a rider can link their Tesla account through Tesla's own OAuth flow. Ride history itself is not read from that link — it comes from receipts (forwarded email or import), by deliberate design; see [Architecture & backend](#architecture--backend).

## Pages

| File / route | Purpose |
|---|---|
| `index.html` | Homepage — hero, real registry stats, animated counters, MapLibre fleet map, recent sightings feed, Submit Sighting drawer |
| `dispatch-comparison.html` | Fleet ETA — Cybercab vs. Model Y dispatch simulator (Austin only; Dallas is explicitly marked unavailable) |
| `fleet-calculator.html` | Fleet ROI — investor sandbox for energy overhead, gross revenue, NOI, and a breakeven timeline; exports a PDF (jsPDF) |
| `infrastructure.html` | Zones — Austin/Dallas selector, a real Tesla Robotaxi service-zone map and charging-location markers for Austin; Dallas is explicitly marked unavailable |
| `community.html` | Community — placeholder page; rankings aren't shown until they can be based on real, moderated contributions |
| `vehicles.html` (served at `/vehicles`) | Cars — the public vehicle registry: every moderator-approved, publicly eligible vehicle |
| `vehicle.html` (served at `/vehicle/:id`) | Vehicle detail — a single public vehicle's record |
| `moderation.html` (served at `/moderation`) | Moderator page — vehicle-sighting review queue, and registry vehicle approve/return/delete |
| `rider-data.html` | Rider Data — a signed-in rider's own ride history, vehicles ridden/discovered, and links out to their public Cars entries |
| `profile.html` | Profile — a rider's own account/profile settings |
| `signin.html` | Sign-in — Google Sign-In entry point |

## Tech stack

- Static HTML + Tailwind CSS (via CDN) + vanilla ES6 on the frontend — no framework, no build step
- [MapLibre GL JS](https://maplibre.org/) with [OpenFreeMap](https://openfreemap.org/) tiles for the dark-mode maps (`index.html`, `infrastructure.html`)
- Backend: a Cloudflare Worker (`worker/index.js`) handling both HTTP requests and inbound email, backed by:
  - **D1** (`cybercabhunter_db`) — the source of truth for users, trips, submissions, the vehicle registry, and moderation history
  - **R2** (`EVIDENCE_BUCKET`) — stores receipt attachment evidence (PDF/JPEG/PNG only; the email body itself is never stored)
  - **KV** (`TESLA_SESSIONS`) — session storage
- `localStorage` holds only the client's session token (`teslaSessionId`) — it is not a data store. All application data lives in D1.

## Running locally

Frontend (no build step):

```bash
open index.html
```

or serve it (needed for clean relative paths / testing from another device on your network):

```bash
python3 -m http.server 8123
# then visit http://localhost:8123/index.html
```

Backend (Worker + D1), for local development:

```bash
npx wrangler dev --local
```

See `docs/deployment-and-migrations.md` for the production deployment and migration procedure.

## Project structure

```
index.html, dispatch-comparison.html, fleet-calculator.html, infrastructure.html,
community.html, vehicles.html, vehicle.html, moderation.html, rider-data.html,
profile.html, signin.html            — the 11 pages

js/calc.js        — pure calculation functions (ETA, arrival odds, fleet ROI), no DOM dependency
js/main.js        — shared runtime: nav highlighting, session/account menu, Tesla-link button,
                     scroll-reveal, counters, toasts, sighting drawer
js/home-stats.js  — fetches and renders real homepage stats from GET /api/registry/stats
js/vehicles.js    — renders the Cars registry list (vehicles.html)
js/vehicle.js     — renders a single vehicle detail page (vehicle.html)
js/moderation.js  — moderator page: sighting queue + registry vehicle review/delete
js/rider-data.js  — Rider Data page: ride history, vehicles ridden/discovered

worker/           — the Cloudflare Worker: routing (index.js), auth (tesla.js, google-auth.js),
                     D1 queries (db.js, db-rides.js), the receipt ingestion pipeline
                     (receipt-*.js, ride-ingest.js, ride-canonical.js), moderation
                     (moderation.js), and the public registry (vehicles.js) — see
                     docs/receipt-ingestion.md for the ingestion pipeline in depth

migrations/       — numbered D1 schema migrations, applied via wrangler (see
                     docs/deployment-and-migrations.md)

tests/            — node:test suite; see Testing below

docs/             — deployment/migrations, receipt ingestion, and registry reference docs

css/style.css     — glassmorphism panels, neon glows, and keyframes Tailwind can't express
HeroImage.png     — hero background image
```

Every page duplicates the same header/footer markup (no server-side includes) and loads `js/calc.js` then `js/main.js` before its own inline script, which calls `CCC.init()` first.

## Architecture & backend

- **Authentication:** Google Sign-In (`worker/google-auth.js`) is the account system.
- **Tesla linking:** a signed-in rider can connect their Tesla account through Tesla's real Fleet API OAuth flow (`worker/tesla.js`) and disconnect it later. This does not import ride history — Tesla's Fleet API returns a rider's *owned* vehicles, not the robotaxis they rode, so it is deliberately not used as a ride source (see `docs/receipt-ingestion.md`, "Not implemented"). A separate "Tesla Ride Sync" OAuth/token subsystem (`worker/tesla-rides.js`) exists in the backend but is Phase 1 only — authorization and encrypted token storage, with no UI entry point and no ride-history call implemented yet.
- **Receipt ingestion:** each rider gets a personal forwarding address; forwarding a Tesla Robotaxi receipt email (or pasting/importing one) runs it through a shared parsing/identity/dedup pipeline that turns it into a `trips` row. This is the actual source of ride history. See `docs/receipt-ingestion.md` for the full pipeline, identity rules, and known limitations.
- **Registry & moderation:** a receipt can create a private `robotaxi_vehicles` row. A moderator reviews it on the moderator page and can approve it for the public registry, return it to private, or delete it outright — deleting also purges the rides/receipts backing it, so the same receipt can be resent and reviewed again. See `docs/registry-preflight.md` for the eligibility rules and the rollout history.
- **Public registry ("Cars"):** a vehicle is publicly retrievable only when it is both moderator-approved (`public`) and backed by at least one counted ride. A private or currently-ineligible vehicle's detail route returns the same 404 as a nonexistent one — it is never exposed as a distinguishable resource.
- **Rider Data:** a signed-in rider's own ride history, split into vehicles ridden vs. vehicles they were first to log (discovered), with a link out to a vehicle's public Cars page when it's publicly eligible.

## Data & persistence

D1 is the source of truth for all application data. The only thing the browser holds locally is the session token (`teslaSessionId`, in `localStorage`) used to authenticate API requests — there is no offline/local data model to reset or sync.

## Testing

Two independent layers:

```bash
node tests/calc.test.js
```

Unit tests for `dispatchETA`, `arrivalOdds`, and `fleetFinancials` in `js/calc.js` — pure functions, no DOM.

```bash
node --test tests/*.test.mjs
```

The integration suite (31 files) — real SQL against an in-memory D1 database built from `migrations/`, the real Worker router, and jsdom for UI-level tests. Covers auth, receipt ingestion, moderation, the registry, and Rider Data.

There's no automated test coverage for the simulator pages' DOM/UI behavior (sliders, map, drawers) — verify those by hand in a browser.

## Docs

- [`docs/deployment-and-migrations.md`](docs/deployment-and-migrations.md) — production deployment and the D1 migration procedure
- [`docs/receipt-ingestion.md`](docs/receipt-ingestion.md) — the receipt-to-ride pipeline in depth: parsing, identity, deduplication, and known limitations
- [`docs/registry-preflight.md`](docs/registry-preflight.md) — registry eligibility rules, moderator review, and the historical rollout runbook

## Known limitations

See `bugs.md`.

## My Spike Test

I tried to use a github that someone build to instantly extract data such as vehicles, ride distance, cities driven in, plate numbers, amount spent, etc. I used ChatGPT to write Claude prompts for me, and help me plan, and I used Claude to run the repository and test it with my current infrastructure. I ran multiple tests and ran multiple prompts through Claude. I kept on getting the same error when I tried to link my Tesla account. I did not implement the code into my website, I simply had it run the repository to see if it would work. It turns out Tesla changed their uthentication system so that repository will not work. 

In order to move forward, I have to change my original plan of using receipts to track data slightly. If you take a ride, it will automatically import that info as long as you have your account linked to the website, but in order to get old information from receipts, I will have to have it go through the users gmail in order to auto import any Tesla Robotaxi emails it finds. 

I also included a video of my ChatGPT convsersation in my repository under docs/SpikeTest.mp4

**Update:** the Gmail-forwarding / receipt-ingestion pivot described above has since been built — see [Architecture & backend](#architecture--backend) and `docs/receipt-ingestion.md`.
