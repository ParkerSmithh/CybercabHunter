# Cybercab Central

A crowdsourced tracking and analytics platform for Tesla Cybercabs and Model Y robotaxis — built as a static, zero-build-step site with a cyberpunk automotive command-center aesthetic (dark carbon/glassmorphism, gold/crimson/cyan accents).

Not affiliated with Tesla, Inc. All fleet, sighting, and infrastructure data is simulated/crowdsourced — the site does not connect to any official Tesla API.

## Pages

| File | Purpose |
|---|---|
| `index.html` | Live Command Deck — hero, telemetry ticker, animated stats, Leaflet fleet map, recent sightings feed, Submit Sighting drawer |
| `dispatch-comparison.html` | Cybercab vs. Model Y dispatch simulator — sliders drive an ETA formula and an arrival-odds bar |
| `fleet-calculator.html` | Fleet investor ROI sandbox — energy overhead, gross revenue, NOI, and breakeven timeline from user inputs |
| `infrastructure.html` | Depots & Inductive PadSpotter — pad map/list, depot capacity bars, charging dead-zone overlay, pad registration |
| `verify.html` | Proof-of-Sighting hub — simulated client-side photo scan with a confidence score, bounty board |
| `community.html` | City Showdown voting, Cybercab Bingo, spotter leaderboard |

## Tech stack

- Static HTML + Tailwind CSS (via CDN) + vanilla ES6 — no framework, no build step
- [Leaflet.js](https://leafletjs.com/) with CartoDB DarkMatter tiles for the dark-mode maps (`index.html`, `infrastructure.html`)
- `localStorage` for all user-generated state (sightings, pad registrations, votes, bingo progress, Tesla-link status) — see [Data & persistence](#data--persistence)

## Running locally

No build step. Either:

```bash
open index.html
```

or serve it (needed if you want clean relative paths / to test from another device on your network):

```bash
python3 -m http.server 8123
# then visit http://localhost:8123/index.html
```

## Project structure

```
index.html, dispatch-comparison.html, fleet-calculator.html,
infrastructure.html, verify.html, community.html   — the 6 pages
js/calc.js       — pure calculation functions (ETA, arrival odds, fleet ROI), no DOM dependency
js/main.js       — shared runtime: seed data, localStorage helpers, nav highlighting,
                    Tesla-link modal, scroll-reveal, counters, confetti, toasts, sighting drawer
css/style.css    — glassmorphism panels, neon glows, and keyframes Tailwind can't express
tests/calc.test.js — unit tests for js/calc.js (node tests/calc.test.js)
HeroImage.png    — hero background image
```

Every page duplicates the same header/footer markup (no server-side includes) and loads `js/calc.js` then `js/main.js` before its own inline script, which calls `CCC.init()` first.

## Data & persistence

There's no backend. `js/main.js` ships seed data (fleet vehicles, sightings, pads, depots, bounties, leaderboard, city votes, bingo tiles) as plain JS objects. Anything a visitor does — submitting a sighting, registering a pad, voting for a city, checking a bingo tile, linking a "Tesla account" — is written to `localStorage` under a `cybercabCentral.*` namespace and merged with the seed data on load.

This means: state is per-browser only. It doesn't sync across devices, and clearing site data resets everything to the seed defaults.

## Testing

```bash
node tests/calc.test.js
```

Covers `dispatchETA`, `arrivalOdds`, and `fleetFinancials` in `js/calc.js`. There's no automated test coverage for DOM/UI behavior — verify interactive features (sliders, map, drawers, bingo, etc.) by hand in a browser.

## Known limitations

See `bugs.md`.

## My Spike Test

I tried to use a github that someone build to instantly extract data such as vehicles, ride distance, cities driven in, plate numbers, amount spent, etc. I used ChatGPT to write Claude prompts for me, and help me plan, and I used Claude to run the repository and test it with my current infrastructure. I ran multiple tests and ran multiple prompts through Claude. I kept on getting the same error when I tried to link my Tesla account. I did not implement the code into my website, I simply had it run the repository to see if it would work. It turns out Tesla changed their uthentication system so that repository will not work. 

In order to move forward, I have to change my original plan of using receipts to track data slightly. If you take a ride, it will automatically import that info as long as you have your account linked to the website, but in order to get old information from receipts, I will have to have it go through the users gmail in order to auto import any Tesla Robotaxi emails it finds. 

I also included a video of my ChatGPT convsersation in my repository under docs/SpikeTest.mp4
