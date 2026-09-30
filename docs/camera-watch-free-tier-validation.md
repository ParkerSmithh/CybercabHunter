# Camera Watch — Workers FREE tier validation

*Research only, 2026-09-30 (UTC). No code, config or production changes. Sources: Cloudflare's public documentation, 4 conditional/HEAD requests to 2 camera snapshots, and a local V8 timing of base64 encoding on 3 previously downloaded frames. No Workers AI test calls were made: that needs an `ai` binding in `wrangler.jsonc` or an API token, both of which count as config/credential changes.*

## 1. Verdict

**Yes, with changes.** The Free tier's structure holds:
- **CPU:** waiting on `fetch()` and bindings does **not** count towards the 10 ms CPU budget.
- **Crons:** cron triggers are available.
- **Moondream:** not on Cloudflare's list of paid-only models.
- **Subrequests:** 16 cameras fit under the 50-subrequest cap.

But three parts of the plan as written are wrong or too tight:
1. Moondream **does not accept raw bytes**, only a public HTTPS URL or a base64 data URI. Base64-encoding the frames yourself can eat most of the 10 ms budget, so **pass the camera's public URL** instead.
2. **384 frames/day uses about 80–95% of the account's 10,000 free Neurons/day.** That's the weakest link: one extra call type, retries, or more prompt tokens than estimated tips it over, and every AI call then fails with a 429 until 00:00 UTC.
3. The feeds refresh about **every 10 minutes**, so at an hourly poll nearly every live camera returns a new frame. Conditional requests save only the stale cameras, not most of the inference.

Trim to **12 cameras hourly (about 288 calls/day)** or **16 cameras every 90 minutes (about 256 calls/day)**, add a hard daily call cap, and it fits with headroom.

Separately from the limits, **an hourly 16-camera snapshot sample will rarely catch a moving Cybercab** (§4). Camera choice matters more than any limit.

## 2. Limit table (Free plan)

| Limit | Free-plan value (source) | Plan's usage (per hourly run unless noted) | Headroom |
|---|---|---|---|
| CPU per invocation (cron) | **10 ms**. "Waiting on network requests (such as `fetch()` calls, KV reads, or database queries) does **not** count toward CPU time." | Headers compare + JSON parse + D1/R2 calls ≈ ~1–4 ms for 16 cameras **when passing the URL**. If the Worker base64-encodes frames with `btoa`: ~0.4 ms per 150 KB, ~1.1 ms per 445 KB frame → **~6–17 ms** for 16 changed frames. | URL route: comfortable. Base64 route: **shortfall likely.** |
| Subrequests per invocation | **50**. "…any request a Worker makes using the Fetch API or to Cloudflare services like R2, KV, or D1." | 16 conditional GETs + up to 16 AI calls (counted conservatively; not stated) + 1–2 D1 batches + an R2 put per "yes" ≈ **34 typical, 50 worst case** (all 16 "yes"). | ~16 typical; **0 in the worst case.** Keep R2 puts bounded or batched. |
| Cron triggers per account | **5** | Existing `*/10` + an hourly poll (e.g. `7 * * * *`) + a daily retention (or fold retention into one hourly run) = 2–3 | 2–3 spare |
| Wall time per cron run | **15 min** | 16 sequential model calls at a few seconds each ≈ ≤ 1–2 min (latency unverified) | Large |
| Workers AI Neurons | **10,000/day, account-wide**, reset 00:00 UTC. Exceeding it gives "Account limited" `3036` / HTTP 429. | 384 calls × about 21–25 Neurons ≈ **8,100–9,600/day** | **~4–19% left.** Tight. |
| Workers AI rate limit | Image-to-Text: **720 requests/minute** | 16 per hour | Huge |
| D1 (Free) | 5M rows read/day, **100k rows written/day**, shared site-wide | about 16 `last_checked_at` updates + a few inserts per hour ≈ **< 1,000 writes/day** | Large |
| R2 (Free) | 10 GB-month; 1M Class A and 10M Class B operations/month | Puts only on "yes" (tens/day at most) + daily list/delete; at most a few hundred MB for 30 days | Large |
| Workers requests (Free) | 100k/day | 24 cron runs/day | Large |

**How the Neuron figure is derived** (the "~400 frames/day" from the earlier study):
- It's **not a Cloudflare-published number**. It's arithmetic from the published token prices at **$0.011 per 1,000 Neurons**:
  - $0.30 per M input tokens = **27.3 Neurons per 1,000 input tokens**;
  - $1.00 per M output tokens = **90.9 Neurons per 1,000 output tokens**.
- Moondream 3 represents any image as a fixed **729 tokens**. So one detect call is about 750–800 input tokens (≈ 20.5–22 Neurons) plus about 5–30 output tokens for an empty or short box list (≈ 0.5–3 Neurons), totalling **≈ 21–25 Neurons**.
- 10,000 ÷ that ≈ **400–475 calls/day**. That's consistent with the earlier ~400, and it's still current per today's pricing page.
- The real per-call usage must be read from the `usage` field of live responses.

## 3. Weakest link: the Workers AI daily allowance

**Why it's the weakest link:**
- 384 calls/day leaves **~4–19% headroom** on an account-wide 10k Neurons/day. Any of these tips it over:
  - a second call per frame, such as a yes/no `query` (roughly **doubles** usage);
  - `reasoning: true` on a `query` call (it's the default for `query`, and adds output tokens);
  - retries;
  - more prompt tokens than estimated;
  - any other Workers AI use on the same account.
- **When it's exceeded,** every later call that day fails with `3036`/429. A full cycle wouldn't break: the rest of that day's runs would find nothing, with no warning.

**Fallback** (each is still useful for a first look):

| Option | Calls/day | Allowance used |
|---|---|---|
| **12 cameras hourly (recommended)** | 288 | ~60–70% |
| 16 cameras every 90 minutes | 256 | ~55–65% |
| 16 cameras every 2 hours | 192 | ~40–48% |

**Always:**
- one `detect` call per frame, nothing else;
- a **hard daily cap** (count calls in D1 or KV and stop at about 320);
- treat a 429/`3036` as "stop until 00:00 UTC", not as a camera failure.

## 4. Corrections to the plan

1. **"Pass the raw frame bytes straight to Moondream"** is wrong. The input schema says: `"image":{"type":"string","description":"Input image as a public HTTPS URL or base64 data URI..."}`. Binary (`Uint8Array`, number arrays) isn't accepted. Two correct routes:
   - **(a) Pass `https://cctv.austinmobility.io/image/<id>.jpg`**, which is public HTTPS. There's no CPU cost, and the Worker still uses the conditional GET only to decide *whether* to call the model.
   - **(b) Build a `data:image/jpeg;base64,…` string.** The manual `btoa` approach measured ~0.4–1.1 ms per frame locally, so 16 frames can exceed 10 ms. Native `Uint8Array.prototype.toBase64()` was ~0.01–0.05 ms, but I couldn't confirm it exists in the Workers runtime.
   - **Use (a).** One caveat: the model fetches the frame itself. The feed refreshes about every 10 minutes, so the frame the model sees is almost always the one just checked. Store the bytes from the conditional GET's 200 body in R2 on a "yes".
2. **"Prompt Moondream for a yes/no plus bounding box"** can be **one call**. `task: "detect"` with `target: "gold Tesla Cybercab"` returns an `objects[]` list of boxes (`x_min`, `y_min`, `x_max`, `y_max`); an empty list means "no". A separate yes/no `query` call would double Neuron use. Note that **detect returns no confidence score**, and the schema doesn't say whether coordinates are normalised (0–1) or in pixels.
3. **"The free tier allows ~10 ms CPU per run, so all heavy lifting must happen inside the model call"** is correct, and the reason it works is explicit: *"Waiting on network requests (such as `fetch()` calls, KV reads, or database queries) does not count toward CPU time."* (Workers limits). If waiting counted, the plan would be dead; it doesn't.
4. **"Conditional fetch → on 304 skip inference"** is correct (re-confirmed today: `If-None-Match` → `304`, 0 bytes, on cameras 1 and 229), **but it saves little**. Camera 1's `Last-Modified` moved from 00:49 to 00:59 UTC, so feeds refresh about every 10 minutes. At an hourly poll, every live camera returns 200 on essentially every run. Only stale feeds are skipped (camera 229 has been frozen since 07:02 UTC the previous day).
5. **The rumoured "20/min" limit for Moondream** doesn't apply as far as the docs show. The documented 20 requests/minute is for models that **require a paid billing method**, and that list (`kimi`, `glm`, `deepseek-v4` variants) doesn't include Moondream. Its task type, Image-to-Text, is listed at **720 requests/minute**.

## 5. Cameras and cadence: will it catch anything?

A snapshot is one instant. An hourly sample catches a *moving* car only if it happens to be in view at that moment.
- **Per pass:** if a Cybercab spends about 10–30 s in a camera's view, the chance an hourly snapshot catches that pass is about **0.3–0.8%**.
- **Formula:** expected detections per day ≈ Σ over cameras of (passes per day × seconds in view ÷ 3,600).
- **Example:** 16 cameras × 20 passes/day × 20 s ÷ 3,600 ≈ **1.8/day**, and that's on the optimistic side for a small fleet; the registry lists about 38 vehicles today.
- **Implication:** through-traffic cameras will mostly show nothing. **Dwell points** (where Cybercabs park, stage, wait for riders or charge) are where the chance approaches the share of time a car is present.

**How to choose the 16 (or 12):**
- **Evidence first:** use the site's own approved Sightings locations, and aggregate pickup/drop-off areas from rides (internal use only; never published), to find where Cybercabs actually are.
- **Prefer dwell and staging points** (pickup zones, curbside waiting areas, parking or charging spots visible to a camera) over busy through-intersections.
- **Stay inside Tesla's Austin service zone** (721 of the 819 cameras are inside it). Downtown/Congress Avenue, South Congress and the Riverside/East Cesar Chavez area are the natural first candidates, **but confirm with our own data**. I have no authoritative data on where Tesla stages vehicles.
- **Drop dead feeds:** skip any camera whose `Last-Modified` is hours old; one such camera was found.
- **Check each camera's frame by eye once:** some are 320×176 (too small to identify anything); prefer 1920×1080 feeds.
- **Probably no coverage at Giga Texas:** it's likely outside the City camera network (unverified).

**A no-cost improvement:** the feed only refreshes every ~10 minutes. So polling a few **dwell-point** cameras every 20–30 minutes, instead of 16 cameras hourly, spends the same allowance where catches are likelier.

## 6. What breaks first (ranked)

| Rank | Constraint | Likelihood of breaking it | Fallback |
|---|---|---|---|
| 1 | **Workers AI daily Neurons (10k, account-wide)** | **High**: 80–95% used at 384 calls/day, with a silent 429 until midnight UTC | 12 cameras hourly or 16 every 90–120 min; one `detect` call per frame; hard daily cap |
| 2 | **CPU 10 ms**, *if* frames are base64-encoded in the Worker | High on that route (6–17 ms); **low with the URL route** (~1–4 ms) | Pass the public camera URL; never decode or encode images in the Worker |
| 3 | **Subrequests (50)** | Low typically (~34); **at the cap** if all 16 are "yes" in one run | Bound R2 puts per run (e.g. at most 8), deferring the rest to the next run; batch D1 writes |
| 4 | **Moondream availability / behaviour** | Medium over time: DETR was already removed, and 18 models were deprecated on 2026-05-30 | Keep the model ID and prompt in one constant; watch the changelog |
| 5 | Rate limits (720/min) | Negligible | — |
| 6 | D1 / R2 free tiers | Negligible at this volume (<1,000 D1 writes/day; MBs of R2) | — |

Beyond the limits, the plan's **value** (§5) is the real risk: a correct, in-budget system that catches almost nothing because it samples busy intersections once an hour.

## 7. Open questions (need a live call or your input)

1. **Real Neurons per call:** the actual `usage` for one Moondream `detect` on a 1080p Austin frame (input tokens beyond the 729 image tokens, and output tokens). This decides whether 16/hour fits.
2. **URL fetching:** does Moondream fetch `cctv.austinmobility.io` URLs reliably (S3/CloudFront, no hotlink block seen), and how long does a call take?
3. **Coordinates:** are detect boxes normalised or in pixels? Does detect ever return a score?
4. **Subrequests:** does a Workers AI binding call count towards the 50 (the docs name Fetch, R2, KV and D1 only)? The table counts it to be safe.
5. **Base64 support:** is `Uint8Array.prototype.toBase64` available in the Workers runtime? Only relevant if the URL route fails.
6. **Detection quality:** does `target: "gold Tesla Cybercab"` work at all on real traffic-camera frames? This needs known-positive frames (camera plus time) from sightings or rides.
7. **Other AI use:** is anything else on the account using Workers AI? The 10k is shared.

## Sources

- Workers limits (CPU definition, subrequests, cron count): https://developers.cloudflare.com/workers/platform/limits/
- Scheduled handler (`controller.cron`, 15-minute duration): https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/
- Workers AI pricing (10k Neurons/day, $0.011/1k, paid-only model list, 00:00 UTC reset): https://developers.cloudflare.com/workers-ai/platform/pricing/
- Workers AI limits (Image-to-Text 720 rpm; 20 rpm for paid-billing models): https://developers.cloudflare.com/workers-ai/platform/limits/
- Workers AI errors (`3036` Account limited, 429): https://developers.cloudflare.com/workers-ai/platform/errors/
- Moondream 3.1 model page and input schema: https://developers.cloudflare.com/ai/models/@cf/moondream/moondream3.1-9B-A2B/ and `/schema-input.json`, `/schema-output.json`
- Moondream 3 image representation (729 tokens): https://moondream.ai/models/moondream_3-1_9B_A2B
- D1 pricing / Free limits: https://developers.cloudflare.com/d1/platform/pricing/
- Earlier study: `docs/camera-watch-feasibility.md`
