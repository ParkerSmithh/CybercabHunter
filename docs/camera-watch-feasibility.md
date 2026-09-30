# Camera Watch — feasibility study

*Research only, 2026-09-29/30 (UTC). No code, config or production changes were made. Public sources only: the City of Austin camera inventory API, fewer than 10 camera snapshots/HEAD checks, Cloudflare's public documentation, and the ifnull/traffic-camera-map repository.*

## 1. Verdict

**Go with changes.** Polling the City of Austin cameras is easy and cheap: conditional requests make unchanged frames cost 0 bytes, and the data is public domain. Storage and the page are also cheap. **Detection is the hard, expensive, unproven part, and it can't be built the way the plan describes:**

- **No dedicated detector:** Workers AI no longer offers the object-detection model the plan assumed (`@cf/facebook/detr-resnet-50` now returns 404 and is gone from the catalog and pricing page).
- **The replacement has no scores:** the only on-platform option that returns bounding boxes is a vision-language model, Moondream 3.1. Its detect output has **no confidence scores**, so the 0.85 / 0.60 tiers would have to come from our own scoring, not the model's.
- **Paid plan required:** the full 819-camera, 30-minute cycle needs **Workers Paid** and costs roughly **$300+/month in inference alone**.
- **Accuracy unknown:** there's no evidence yet about how accurate this is on real Austin traffic-camera frames.

The smallest version worth building is a **~50–100-camera pilot on Workers Paid (about $30–45/month)**. It should route detections to human review until labelled data exists to set thresholds, then turn on auto-publish.

## 2. What's easy, what's hard

| Component | Rating | Finding |
|---|---|---|
| Camera inventory | **Easy** | `https://data.austintexas.gov/resource/b4k4-adkb.json` (Socrata "Traffic Cameras", **Public Domain**, updated daily). 1,007 rows: **819 `TURNED_ON`**, 124 `DESIRED`, 34 `VOID`, 30 `REMOVED`. Fields include `camera_id`, `location_name`, `camera_status`, `screenshot_address`, `location` (GeoJSON point), `primary_st`/`cross_st`, `modified_date`. |
| Snapshot URL | **Easy** | `https://cctv.austinmobility.io/image/<camera_id>.jpg` (the same URL is in the inventory's `screenshot_address`). Tested cameras 1, 3, 100, 229 and 500: all 200 `image/jpeg`. Served from **Amazon S3 behind CloudFront**. |
| Freshness / frozen detection | **Easy** | Every response has `ETag` and `Last-Modified`, and `If-None-Match` / `If-Modified-Since` return **304 with 0 bytes**. Four of the five sampled frames were refreshed within about 4 minutes (all around 00:49 UTC), suggesting a batch refresh cycle. Camera 229 was **~18 hours stale**. There's no in-image timestamp overlay in the samples. `Last-Modified` is the capture-time proxy. |
| Frame format | Mixed | Sizes vary a lot: 320×176 (13 KB) up to 1920×1080 (134–445 KB). |
| Black/blank frames | **Easy** | The reference `audit_cameras.py` uses mean luma ≤ 12 with ≥ 90% dark pixels (black), luma std-dev ≤ 3 (blank), and low entropy/edges (placeholder). Needs decoded pixels (see below), or can be skipped by letting the detector see "nothing". |
| Vehicle detection on Workers AI | **Hard** | **No object-detection model exists today** (DETR removed). ResNet-50 only classifies a whole image into 1,000 classes, with no boxes. Moondream 3.1 (`@cf/moondream/moondream3.1-9B-A2B`) has `detect` (boxes: `x_min`, `y_min`, `x_max`, `y_max`) with a free-text `target` such as "gold car", but **no score field** in its output schema. It encodes every image as a fixed **729 tokens**, so distant vehicles in a 1080p wide shot get very little detail. |
| Gold-colour check inside the Worker | **Medium** | The Workers runtime has no canvas, `ImageData` or `createImageBitmap`, so decoding a JPEG needs a pure-JS or WebAssembly decoder (a new npm dependency). That isn't feasible within the Free plan's 10 ms CPU; it's fine on Paid. Alternatives: (a) the **Images binding** can crop (`trim`) and resize a frame, but it returns encoded images only, not pixels; (b) ask the vision model itself ("what colour is this car?" / "is this a Tesla Cybercab?") on the cropped candidate. |
| Confidence tiers (0.85 / 0.60) | **Hard** | The model provides no scores, so the tiers must be a composite of our own (for example gold-pixel fraction in the box, box size, and a yes/no answer from a second vision prompt). The thresholds can't be set responsibly without a labelled sample of real frames. |
| Storage (R2) + 30-day retention | **Easy** | The same mechanism already running for sighting photos. Volumes are tiny (see costs). |
| Poller scheduling | **Easy on Paid, not possible on Free** | Free allows 10 ms CPU and 50 subrequests per cron run. The full design needs about 137 cameras per 5-minute run, each needing a conditional GET, often an AI call, and a D1 write. Paid allows **30 s CPU** per cron run (under a 1-hour interval), **10,000 subrequests**, and 250 cron triggers. |
| Public API, page, mod queue | **Easy** | Same patterns as the existing Sightings, moderation and retention code. |

## 3. Cost

Pricing (Cloudflare docs, Sept 2026):
- **Workers Paid:** $5/month, including 10M requests and 30M CPU-ms.
- **Workers AI:** 10,000 free Neurons/day, then **$0.011 per 1,000 Neurons**.
- **Moondream 3.1:** **$0.30 / M input tokens, $1.00 / M output tokens**.
- **R2:** $0.015/GB-month, with 10 GB-month free and free egress.
- **Images:** 5,000 unique transformations/month free, then $0.50 per 1,000.

**Per-inference estimate (Moondream detect):**
- about 729 image tokens + about 30 prompt tokens = ~760 input tokens, costing ≈ $0.00023;
- about 40 output tokens ≈ $0.00004;
- **≈ $0.00027 per frame**, which is about 24.5 Neurons.
- So the free 10k Neurons/day covers only about **400 frames/day**.
- Treat this as ±50%: the real token counts need a live test.

**Worker CPU and requests** are negligible at every tier when the image URL is passed straight to the model (it accepts a public HTTPS URL). Even decoding every frame in the Worker would add only about $2/month in CPU overage at full scale.

**R2:** assuming 50–200 stored detections/day (crops of about 40 KB, full frames about 200 KB), 30 days is about 0.1–1.2 GB, **inside the free tier ($0)**.

| Tier | Cameras | Cycle | Inferences/day* | Workers AI / month | Total / month |
|---|---|---|---|---|---|
| Full (as specified) | 819 | 30 min | ~39,300 | ~$315 | **~$320** |
| Service zone only | 721 inside Tesla's Austin zone | 30 min | ~34,600 | ~$280 | ~$285 |
| Full, slower | 819 | 60 min | ~19,700 | ~$155 | ~$160 |
| **Recommended pilot** | **100** hand-picked | **30 min** | **~4,800** | **~$36** | **~$41** |
| Minimal pilot | 50 | 60 min | ~1,200 | ~$7 | ~$12 |
| Free plan only | ~8 | 30 min | ≤ 400 | $0 | $0 (not useful) |

\* The upper bound. Conditional requests skip unchanged or stale frames, which lowers inference counts by the share of frozen cameras. That share is unknown (see open questions).

A second vision call to confirm "Cybercab?" on candidates only, to build a real confidence score, adds cost proportional to the number of candidates, not frames. That's likely a few percent more.

## 4. Legal and terms

- **Dataset licence:** the Traffic Cameras dataset is marked **Public Domain**.
- **City of Austin Open Data Terms of Use** (PDF from data.austintexas.gov), quoted:
  - *Licensing:* "COA data available through Data.AustinTexas.gov … is offered free and without restriction. Data and content created by COA government employees within the scope of their employment are not subject to copyright protection."
  - *Attribution:* "While not required, when using content, data … in your own work, we ask that proper credit be given." Their example citation is "Data retrieved from Data.AustinTexas.gov". The planned line "Source: City of Austin traffic cameras." satisfies the request.
  - *Endorsement:* "…It is not meant as a form of endorsement or approval from the City of Austin." Don't imply City endorsement or use the City logo beyond linking.
  - *Secondary use:* "the City of Austin cannot vouch for their quality and timeliness … cannot vouch for any analyses conducted with data retrieved…". The methodology footnote should make the same point.
- **Ambiguous points to flag:**
  1. **The images aren't hosted on the data portal.** They're on `cctv.austinmobility.io` (S3/CloudFront). The terms speak of data "available through Data.AustinTexas.gov". The inventory row links to each image, but whether the "free and without restriction" wording explicitly covers republishing snapshot crops isn't stated.
  2. **No stated rate limits or automation terms** for the image host. Polite polling with conditional requests and modest concurrency is the responsible reading.
  3. **Privacy:** frames show other people's cars, plates and pedestrians. The dataset says "Video is NOT recorded or retained of daily traffic", while this feature would **store** snapshots for 30 days. Publishing **tight crops of the detected vehicle only** (not full frames) and keeping the 30-day retention minimises exposure.
  4. **Commercial use:** nothing in the terms prohibits it.
- **Recommendation:** email ATPW Arterial Management (the dataset's listed owner) to confirm that republishing cropped snapshots with attribution is fine. It's cheap insurance.

## 5. Risks, ranked

1. **Detection accuracy — high.**
   - **Unproven:** no labelled Austin frames containing Cybercabs have been tested.
   - **Small vehicles:** the model sees each frame as 729 tokens, and vehicles at signalised intersections are often 30–150 px wide in a 1080p wide shot, so detail is thin.
   - **Colour confounds:** gold/champagne is easily confused with tan, bronze, yellow or white cars in warm evening light, and with glare.
   - **Night:** colour becomes unreliable or disappears.
   - **Weather and compression:** rain, lens spots and JPEG artefacts add further errors.
   - **Model knowledge:** it's unknown whether a general vision model reliably recognises a Cybercab, a new low-volume vehicle.
   - Auto-publishing at ≥ 0.85 without calibration would put false positives straight onto the public site.
2. **No model confidence scores — high (design).** The tiered publishing logic depends on a score we'd have to build and calibrate ourselves.
3. **Cost and capacity — medium to high.**
   - **Cost:** full scale is about $320/month and sensitive to token pricing.
   - **Plan requirement:** it's unverified whether Moondream on Workers AI needs Workers Paid.
   - **Rate limit:** also unverified is which rate limit it falls under. Cloudflare lists 720 requests/minute for image-to-text, but **20 requests/minute** for models that require the paid plan. At 20/minute, capacity is about 28,800 frames/day, **below full scale**.
4. **Model churn — medium.** The planned model was removed. Workers AI deprecated 18 models on 2026-05-30. Any vision model chosen may change behaviour or be retired, forcing re-tuning.
5. **Feed reliability — medium.** Stale cameras exist (camera 229 was 18 hours old). The image host is an undocumented S3/CloudFront bucket that could change URL, add hotlink protection or go down. Night and weather degrade frames.
6. **Moderator workload — medium.** Until thresholds are tuned, every candidate needs a human yes/no. The volume is unknown until the pilot runs.
7. **Terms and privacy — low to medium.** See §4. Mitigated by crops, attribution, 30-day retention, and an email to the City.
8. **Workers Paid required — low.** $5/month base. The existing Gmail sync and retention jobs keep working unchanged.

## 6. Recommended approach: the smallest version worth building

- **Plan:** Workers Paid.
- **Cameras:** about **100** hand-picked cameras inside Tesla's Austin service zone (721 of the 819 are inside it), weighted towards downtown, South Congress / Riverside and other known Cybercab corridors. Use the site's own Sightings locations to choose them.
- **Cadence:** every **30 minutes** per camera, as a 5-minute cron handling about 17 cameras per run.
  - A conditional GET (`If-None-Match`) skips frozen or unchanged frames at 0 bytes.
  - Pass the image URL straight to the model, so the Worker doesn't need to decode.
  - Keep 3–5 requests in flight at once.
- **Detection:**
  1. `detect` with target "gold car" (and/or "Tesla Cybercab").
  2. For each box, crop it with the Images binding and ask a yes/no "Is this a Tesla Cybercab?" follow-up.
  3. Build our own score from that answer plus box size (and optionally gold-pixel fraction via a small WebAssembly decoder on the crop only).
- **Thresholds:** keep the named constants (0.85 auto-publish, 0.60 review). For the **first 2–4 weeks, route everything ≥ 0.60 to review**, logging scores, until there are enough approved and rejected examples to check that ≥ 0.85 is actually about 95% precise. Then turn on auto-publish; it's a one-line switch.
- **Storage:** tight crops only, 30-day retention, attribution and methodology footnote exactly as planned.
- **Expected cost:** about **$41/month**, with a hard daily inference cap as a cost circuit-breaker.

## 7. Open questions (need a live test or your input)

1. **Moondream on Workers AI:** does it require Workers Paid, what are its actual rate limit and latency, and how many tokens (Neurons) does one detect call really use? Are the box coordinates normalised 0–1? (The schema doesn't say.)
2. **Detection quality:** how well does it do on real Austin frames? This needs **known positives**: timestamps and cameras where a Cybercab was actually visible (for example from Sightings or rides), plus night and rain samples.
3. **Stale feeds:** what share of the 819 feeds are frozen at any time? Answering needs one audit pass of about 819 HEAD requests, which I didn't run to stay within your "fewer than 10 snapshots" rule.
4. **City confirmation:** will the City (ATPW Arterial Management) confirm that republishing cropped snapshots is fine?
5. **Pilot cameras:** which ~100 cameras should the pilot use, and should the moderators pick them?
6. **Account plan:** this codebase is built for Workers Free, so upgrading to Paid is your decision.

## Sources

- City of Austin Traffic Cameras dataset: https://data.austintexas.gov/resource/b4k4-adkb.json (metadata: `/api/views/b4k4-adkb.json`)
- City of Austin Open Data Terms of Use (PDF): https://data.austintexas.gov/download/2z87-8uh7/application/pdf, via https://catalog.data.gov/dataset/city-of-austin-open-data-terms-of-use-policy
- Reference repo: https://github.com/ifnull/traffic-camera-map (`sources/coa.json`, `audit_cameras.py`)
- Workers AI pricing: https://developers.cloudflare.com/workers-ai/platform/pricing/
- Workers AI limits: https://developers.cloudflare.com/workers-ai/platform/limits/
- Workers AI models catalog: https://developers.cloudflare.com/workers-ai/models/
- Moondream 3.1 model page: https://developers.cloudflare.com/ai/models/@cf/moondream/moondream3.1-9B-A2B/
- Moondream 729-token image representation: https://moondream.ai/models/moondream_3-1_9B_A2B
- Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- Workers & R2 pricing: https://developers.cloudflare.com/workers/platform/pricing/
- Images binding: https://developers.cloudflare.com/images/transform-images/bindings/ ; transform options (trim/gravity): https://developers.cloudflare.com/images/transform-images/transform-via-url/ ; pricing: https://developers.cloudflare.com/images/pricing/
- Workers AI planned model deprecations (2026-05-08): https://developers.cloudflare.com/changelog/post/2026-05-08-planned-model-deprecations/
