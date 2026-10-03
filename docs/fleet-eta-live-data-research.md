# Fleet ETA on live data — research report

*Research only, 2026-10-03. No code, schema, config or deploy changes were made; this file is the only write. Repository facts were checked against the code at `main` (`dc9ce42`); live numbers come from public GET requests to cybercabhunter.com on 2026-10-03.*

## Bottom line

The brief's starting point is out of date:

- **The Fleet ETA page no longer exists.** It was removed on 2026-10-01 (`e7e4e7d`), together with `dispatchETA` and `estimateFare` in `calc.js`. `/dispatch-comparison` now 301-redirects to `/simulation`, which is only the Fleet ROI calculator.
- **Part of what the brief asks for is already built.** `GET /api/fleet-stats?city=austin` (`b63ef84`) returns the live public Cybercab count (edge-cached for 5 minutes) and a fare model from the site's own rides (recomputed daily by cron and stored in KV).

As agreed, this report covers how to bring an ETA tool back, built on live data from the start, by extending `/api/fleet-stats` rather than adding a new data layer.

**The honest finding: the site's live data can support a live *estimate range*, not a measured ETA.**

- **No wait times exist.** No table stores when a ride was requested or how long the rider waited, so there is nothing to calibrate an ETA against today.
- **The demand signals are far too thin to replace the Low/Normal/Surge toggle.** As of today:
  - 30 public sightings, all from the last 5 days;
  - 31 camera detections in 30 days, 30 of them filed by spotters and 1 from the automated watch;
  - 5 rides with fares.
- **The fleet count is real and live.** It currently stands at 47 public Austin Cybercabs. But it counts every car ever approved, not the cars in service right now.

The recommended path (Option B below) is:

1. Show a **range** from a standard spatial model (nearest idle car ÷ speed).
2. Base it on the live fleet count, with every assumption visible and labelled.
3. Start collecting **rider-reported wait times**, so the model can be calibrated later.

Do not ship a single precise number. With today's inputs, the honest answer is about **6–16 minutes**. The old formula said 19.4 minutes "Normal" (15.5 Low, 29.1 Surge) for 45 cars, with no grounding.

---

## 1. Ranked recommendations

| | A. Minimal: live count, range | **B. Balanced: modelled range plus a calibration loop (recommended)** | C. Ambitious: zone-level, time-of-day model |
|---|---|---|---|
| **What the user sees** | The old ETA tool, with the fleet input filled live from `/api/fleet-stats` ("47 Cybercabs · as of 2 min ago") and the output shown as a range, not a point. Demand toggle kept but relabelled "Scenario". | Range ETA ("about 6–16 min, most likely ~9") with a short "How this is estimated" panel listing each assumption and where it comes from. A "Data as of" line and stale badges. After the data gate is met, a "Based on N reported waits" line. | Per-zone ETA on the Zones map; demand factor by hour of day from sightings and camera history. |
| **Data sources** | `/api/fleet-stats` (`cybercabs`) | `/api/fleet-stats` (count; fares already there), plus a new optional rider-entered "wait time" on ride logs, aggregated daily into the same KV entry | Everything in B, plus sightings and camera-detection history per zone and hour |
| **Accuracy gain** | Small. The fleet input stops going stale, but the formula stays uncalibrated. Its value is honesty about freshness. | Medium now, high later. The model has a physical basis (distance ÷ speed) and the range shows its uncertainty. Once rider waits arrive it can be fitted to reality, which none of the other options can do. | Unknown and likely negative today. There isn't enough data per zone per hour (see §2), so the output would be invented precision. Revisit when the data gate in §3 is met. |
| **Free-tier cost** | No new D1 queries per page view: the 5-minute edge cache already serves the count. Negligible. | Same as A per view. The daily cron gains one aggregate query, and the KV writes (one per city per day) are unchanged. Negligible. | Hourly aggregation adds about 24 KV writes/day and more D1 rows read per run. Fits the free tier, but it would add a sixth cron trigger beyond the 5 allowed, unless folded into an existing one. |
| **Effort** | S | M | L |

**Why B over A:** A only fixes freshness. B is the only option that gets *more* accurate over time, because it adds the one missing measurement: actual waits.

**Why not C now:** see §2's sample sizes and the "Dead ends" section.

---

## 2. Data inventory (verified against the repo)

| Source | What it contains today (verified) | Update cadence | Gaps for ETA |
|---|---|---|---|
| **Public registry count**: `GET /api/fleet-stats?city=austin` → `cybercabs` (`worker/fleet-stats.js` `computeFleetCounts`) | Count of `robotaxi_vehicles` that are `visibility='public'`, pass the evidence gate (`publicVehicleEligibleSql`), have `service_area` Austin and `model='Cybercab'`. **Live: 47** (2026-10-03). Fleet ROI's default fleet size is already live (commit `a74d6c6`), but it reads a *different* count: `GET /api/registry/stats` → `public_vehicles` (every public registry vehicle, any model or city; also 47 today). A rebuilt ETA should use the Austin Cybercab count from `/api/fleet-stats`, and the two pages should agree on which count they mean. | Recomputed on request; edge-cached `max-age=300` (5 minutes). | Cumulative registry, not "in service now". The "active in 30 days" count (an approved sighting or counted ride in 30 days) existed in `b63ef84` but was **removed** with the ETA page (`e7e4e7d`). Nothing says how many of the 47 are on the road at a given moment. |
| **Fare model**: the same endpoint → `fares` | `median_fare`, `average_fare`, `per_mile` (total fares ÷ total miles) over every counted Austin ride with fare and distance, one per physical ride. **Live: 5 rides**, median $8.40, mean $9.18, $3.76/mi, computed 2026-10-03 11:00 UTC. | Daily cron `0 11 * * *` → KV (`fleet_stats:v2:austin:fares`). | n=5 is far too few for a stable per-mile rate; it could swing a lot with each new ride. Already shows its sample size, which is the right pattern to copy. |
| **Rides**: `trips` table | `ride_date`, `start_time`, `end_time`, `pickup_time`, `dropoff_time`, `duration_minutes`, `distance`, `fare_amount_cents`, `service_area`, free-text `pickup_description`/`dropoff_description`. Public: `/api/registry/stats` → `recorded_rides: 3` on public vehicles. | As rides are logged or imported (receipts, Gmail sync every 10 minutes, manual). | **No request time and no wait time anywhere.** I searched the migrations and parsers for "wait", "request" and "eta": none. Pickup and dropoff are free text, not coordinates. Gives trip length and duration, not pickup ETA. |
| **Public sightings**: `GET /api/sightings?city=austin&stats=1` (`worker/sightings-public.js`) | Approved photo sightings: `spotted_at`, city, free-text approximate `location` (often null), optional plate. **Live: 30 total, all in the last 7 days, first on 2026-09-29.** `peak_hour: null`, because the site's own rule needs at least 2 sightings in one clear-winner hour, and none qualifies. | Real time as moderators approve; public for 30 days (photo retention). | No coordinates or zone, so no per-zone signal. It measures where *spotters* were, not rider demand. It's a supply-side, observer-biased signal. |
| **Camera detections**: `GET /api/camera-sightings` (latest per camera, 24 h) and `/history` (up to 31 days) (`worker/camera-sightings.js`) | `camera_id`, name, lat/lng, `observed_at`, source `watch` (automated) or `spotter` (an approved sighting at a traffic camera). **Live, last 30 days: 31 detections at 18 cameras over 4 days; 30 spotter, 1 watch.** | List edge-cached for 60 s; the map polls every 60 s. The watch is designed as an hourly sample of 12–50 of the city's 819 cameras (`docs/camera-watch-feasibility.md`). | Presence only, at fixed intersections, mostly from human spotters. The feasibility study itself says an hourly sample "will rarely catch a moving Cybercab". Usable as a "recently seen near X" freshness cue, not as a fleet density or demand estimate. |
| **Service area** | `index.html` `serviceZoneCoords`: the published Austin geofence, 35 vertices. **Area 264.1 sq mi** (computed), which matches the old hard-coded 264. `worker/service-areas.js` holds only a wider metro bounding box. | Static (changes when Tesla changes the zone). | Fine as an input; keep one shared constant rather than a second hard-coded number. |
| **Robotaxi Tracker** (external) | Its `llms.txt` documents feeds including `/v1/api/texas-dmv` (Texas DMV registered AVs) and `/v1/api/texas-dmv/vehicles` (by VIN). **Its `robots.txt` disallows `/v1/` and `/data/` for all user agents.** Fares appear only on pages (already noted in `worker/fleet-stats.js`). | Not documented. | Automated polling conflicts with its robots.txt, so treat it as **not permitted without written permission**. The "daily pipeline" the brief mentions is not in this repo; I couldn't verify it. If permission is granted, the DMV registration count could cross-check the registry count (attribution required, per its `llms.txt`). |

---

## 3. Proposed ETA model

### Formula: nearest idle car ÷ speed, as a range

If idle cars are spread roughly at random over the zone, the straight-line distance from a rider to the nearest idle car averages `0.5 / √ρ`, where ρ is idle cars per square mile. That is the classic nearest-neighbour result used in urban operations research. The *square-root law* of ride-hailing (pickup time ∝ 1/√idle vehicles) follows from it. The old `k·√(area/fleet)` had the right *shape*, but `k = 8` was never tied to distance or speed, and it divided by *all* cars, not idle ones.

```
idle cars     n_idle = N_public × deployed_share × idle_share
density       ρ      = n_idle / A
road distance d      = circuity × 0.5 / √ρ               (miles)
pickup ETA    ETA    = dispatch_latency + d / speed × 60  (minutes)
```

| Input | Value today | Source | Status |
|---|---|---|---|
| `N_public` | 47 | `/api/fleet-stats` | **Live** |
| `A` | 264.1 sq mi | geofence polygon | Verified |
| `deployed_share` | 0.4–0.8 (central 0.6) | Assumption: share of registered cars in service at a given time | **Unknown**: owner question |
| `idle_share` | 0.3–0.6 (central 0.5) | Assumption: share of in-service cars free to take a ride | **Unknown** |
| `speed` | 18–28 mph (central 22) | Assumption: urban arterial average | Could be grounded later from `trips` distance ÷ duration (currently n≈5) |
| `circuity` | 1.35 | Road distance ÷ straight line; a commonly used urban detour factor | Assumption |
| `dispatch_latency` | 1 min | Assumption | Assumption |

**Worked example, 2026-10-03:** the central case gives about 14 idle cars, a nearest car about 2.2 mi straight-line away, and an **ETA of about 9 minutes**. The corners of the assumption ranges give **about 6–16 minutes**. Show it as **"about 6–16 min, most likely ~9"**, not as "9.0 min".

The spread is real, not just modelling noise: geometry alone puts single-ride waits anywhere from about 4 to 15 minutes even in the central case (10th to 90th percentile of the nearest-car distance).

### Demand and queueing

- **Demand toggle:** keep it, but as an explicit **scenario** ("Quiet / Typical / Busy") that changes `idle_share`, the real effect of demand. Don't multiply the ETA by an arbitrary factor.
- **Queueing:** an M/M/c (Erlang C) queue would model "every car is busy, you wait for one". It needs ride arrival rates and service times the site does not have, so don't add it yet. When the scenario pushes `idle_share` toward 0, show "Wait could be much longer: few or no cars free", not a number.

### Calibration and validation (the step that makes it trustworthy)

1. **Collect the missing measurement.** Add an optional field when a rider logs a ride: "Minutes from request to pickup" (or "time requested"). It's rider-reported, aggregate-only, with the same privacy gate as fares.
2. **Store it** in the daily KV aggregate: the count of waits, median and interquartile range. Never per ride.
3. **Fit one factor.** Once there are at least about 20 waits (the owner's threshold to choose), fit a single scale `s = median(observed wait) / median(model ETA at that time and fleet size)` and apply it, shown as "Calibrated on N reported waits". Below the gate, the page says "Not yet calibrated: estimate only".
4. **Validate** by showing, on the methodology panel, how many observed waits fell inside the displayed range (target: about 80%). If coverage is poor, widen the range rather than hide it.
5. **Do not calibrate against sightings or camera gaps.** They measure where observers were, not how long riders waited (see Dead ends).

---

## 4. Freshness and honesty UX

Concrete treatments, all compatible with the static HTML and vanilla JS front end:

- **Ranges, not points.** Lead with "about 6–16 min" and "most likely ~9" in smaller text. Kay et al.'s CHI 2016 study of real-time transit predictions found that showing a distribution as discrete outcomes (*quantile dotplots*) made people's probability estimates more accurate and more confident than a single number. A simple 10-dot strip ("8 of 10 waits under 14 min") is the mobile-friendly form of that.
- **Every live number shows its age.** Example: "47 public Cybercabs · as of 3 min ago". The existing Zones panel already does "Based on N rides · updated <date>"; reuse that wording. Note that `/api/fleet-stats` doesn't return a timestamp for the count, so add `count_as_of` (see Option B).
- **Stale states, spelled out:**
  - Fresh: no badge.
  - Count older than 30 minutes, or the fare model older than 36 hours (the daily cron missed a run): an amber "Stale" badge with the age.
  - Request failed: "Live data unavailable. Showing the estimate from <time>" if a cached copy exists, otherwise an empty state with no number.
  - Never silently fall back to a hard-coded 45 or 264.
- **Assumptions are UI, not footnotes.** In a collapsible "How this is estimated" panel, list each input with a *Live*, *Measured (n=…)* or *Assumed* tag, matching the table in §3.
- **Sample sizes beside every measured value.** "$3.76/mi (5 rides)". Already the site's pattern; keep it for waits.
- **No false precision.** Round to whole minutes, cap the upper bound display ("20+ min"), and when inputs are in "few or no free cars" territory, show a qualitative state instead of a number.
- **Respect reduced motion** for any live-update animation; the site already does this elsewhere.

---

## 5. Update mechanism: options ranked

| Rank | Mechanism | Accuracy gain | Free-tier cost (limits from Cloudflare's docs) | Verdict |
|---|---|---|---|---|
| 1 | **Extend `/api/fleet-stats`**: add `count_as_of`, the model inputs and the wait-time aggregate to the response. Live count per request (edge-cached for 5 minutes); slow-moving aggregates from the existing daily cron into the existing KV key. The page polls every 5 minutes while visible (the same visibility-aware `setInterval` pattern as `sightings.js` and `austin-map.js`). | Count fresh within 5 minutes; aggregates fresh within 24 h, which matches how fast they can change. | Requests: 1 per open tab per 5 minutes. A thousand tab-hours a day is 12k requests, against the 100k/day free limit. D1: about 1 query per 5 minutes per edge location, against 5M rows read/day. KV: 1 read per cache miss (100k reads/day free) and still 1 write per city per day (1k/day free). Cron: **no new trigger** (5 allowed per account; the site uses 2). | **Recommended** |
| 2 | Client-side polling of several existing endpoints (`fleet-stats`, `sightings`, `camera-sightings`) and computing in the browser | Same as rank 1 for the count; duplicates the logic in JS. | About 3× the requests per view, and `sightings?stats=1` reads more D1 rows. | Worse on both counts |
| 3 | A separate new endpoint (for example `/api/fleet-eta`) with its own cache | Same as rank 1. | Similar cost, but more surface area. | Unnecessary: the brief's proposed `/api/fleet-stats` **already exists** |
| 4 | An hourly cron pre-computing per-zone, per-hour demand into KV | Only useful for Option C. | +24 KV writes/day, fine; but needs a 6th cron trigger unless folded into the existing `*/10` run, and must stay within 10 ms CPU and 50 subrequests per run. | Defer until the data gate is met |

---

## 6. Dead ends (researched and rejected)

- **Scraping Tesla's app or private endpoints.** There's no official fleet API, it would break Tesla's terms, and it's out of scope by the brief's own constraints.
- **Polling Robotaxi Tracker's `/v1/` or `/data/` feeds.** `robots.txt` disallows both for all agents, even though `llms.txt` lists them. Don't automate it without written permission. The site already rejected its fare data for the same reason. Its images are off-limits regardless.
- **A demand factor from sightings or camera detections.**
  - The samples are tiny: 30 sightings in 5 days; 31 detections, almost all from spotters.
  - The data carries no zone (sightings have only free-text locations).
  - It's biased: it measures where spotters and cameras were, not where riders requested rides.
  - Turning it into "Surge ×1.37 in Zone 4" would be invented precision.
- **Per-zone or time-of-day ETAs (Option C) today.** Every zone-hour cell would hold zero or one observation.
- **Fitting `k` from "sighting gaps"** (the time between sightings of the same car). That measures spotter coverage, not dispatch, and it would systematically overstate waits.
- **Erlang C / M/M/c with made-up arrival rates.** It looks rigorous but needs request and service-time data the site doesn't have; the error would hide inside the formula.
- **Treating the registry count as "active now".** 47 is the number of cars ever approved; using it as all-available would understate waits. Hence the explicit `deployed_share` assumption and an owner question.
- **Tesla's published rate card as "the fare".** It's a price list, not measured fares; `fleet-stats.js` already rejects hard-coding it.

---

## 7. Open questions for the owner

1. **Where should the tool live?** A section on `/simulation` (Fleet ROI), on the Zones page beside Fleet & Fares, or its own page again (and if so, should `/dispatch-comparison` stop redirecting)?
2. **Rider-reported wait time:** add an optional "minutes from request to pickup" field to ride logging? It's the only path to a calibrated ETA. If yes, what minimum sample before the page says "calibrated" (I suggest 20)?
3. **"In service now" assumption:** what share of the public registry do you believe is on the road at a typical time? Or bring back the removed "active in 30 days" count as a better ceiling than the full registry?
4. **Model Y comparison:** the old page compared against a Model Y fleet of 114. There is no live source for Model Y counts in the site's data. Drop the comparison, or keep it as a clearly labelled static scenario?
5. **Robotaxi Tracker:** do you want to request written permission to use its Texas DMV feed as a fleet-size cross-check? Its terms require visible attribution if used.
6. **Range presentation:** a plain range ("6–16 min") only, or also the 10-dot strip?

---

## Sources

**Repository (verified)**
- `worker/fleet-stats.js`, `worker/ride-status.js`, `worker/sightings-public.js`, `worker/camera-sightings.js`, `worker/service-areas.js`
- `migrations/0002_ride_submissions.sql`, `0005_receipt_v2_fields.sql`, `0009_phase2_rides.sql`, `0018_camera_detections.sql`, `0020_sighting_traffic_camera.sql`
- `public/index.html` (geofence), `public/infrastructure.html` and `public/js/austin-map.js` (existing pollers)
- `docs/camera-watch-feasibility.md`, `docs/camera-watch-free-tier-validation.md`
- Commits `b63ef84`, `e7e4e7d`, `a74d6c6`

**Live public endpoints (2026-10-03)**
- `/api/fleet-stats?city=austin`, `/api/registry/stats`, `/api/sightings?city=austin&stats=1`, `/api/camera-sightings/history` (30 days)

**Web**
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/): 100k requests/day, 10 ms CPU, 50 subrequests, 5 cron triggers (Free)
- [Cloudflare KV limits](https://developers.cloudflare.com/kv/platform/limits/): 100k reads/day, 1k writes/day (Free)
- [Cloudflare D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/): 5M rows read/day, 100k rows written/day (Free); [D1 limits](https://developers.cloudflare.com/d1/platform/limits/): 50 queries per invocation
- [Optimizing Pricing, Repositioning, En-Route Time, and Idle Time in Ride-Hailing Systems (arXiv 2111.11551)](https://arxiv.org/pdf/2111.11551): pickup time ∝ 1/√(idle vehicles); en-route distance ∝ 1/√(idle density)
- [Larson & Odoni, *Urban Operations Research* (MIT)](https://web.mit.edu/urban_or_book/www/): spatial nearest-neighbour distance models
- [Kay, Kola, Hullman & Munson, "When(ish) is My Bus?", CHI 2016](https://idl.uw.edu/papers/when-ish-is-my-bus) ([PDF](https://vis.mit.edu/classes/6.859/readings/pdfs/Kay-WhenishIsMyBus.pdf)); follow-up: [Uncertainty displays using quantile dotplots or CDFs improve transit decision-making](https://mucollective.northwestern.edu/project/uncertainty-bus)
- [robotaxitracker.com/robots.txt](https://robotaxitracker.com/robots.txt) and [robotaxitracker.com/llms.txt](https://robotaxitracker.com/llms.txt)
