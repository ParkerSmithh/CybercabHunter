# Bugs & Known Limitations

Living list of known issues and gaps. None of these are blocking — the site works as designed — but they're worth knowing about or fixing next.

## Open

| Area | Issue |
|---|---|
| Offline / CDN dependency | Every page loads Tailwind CSS and Google Fonts from a CDN — without an internet connection, styling and typography break site-wide, not just on any one page. `index.html` and `infrastructure.html` additionally load MapLibre GL and OpenFreeMap tiles from CDNs for their maps, which will render with a blank map area offline (markers/popups still initialize once MapLibre loads, but with no basemap). `fleet-calculator.html`'s "Export" button additionally depends on `jsPDF` from a CDN and will fail to generate a PDF offline. |
| Receipt pickup-time parsing | The v2 receipt extractor reads the first time after the pickup address as the pickup time. A receipt whose pickup-time line is missing but whose drop-off time is present will have its drop-off time read as the pickup time instead — a wrong ride identity, consistent across copies of that same malformed receipt. Real Tesla receipts carry both times. Documented in detail in `docs/receipt-ingestion.md` ("Known limitation"). |

## Fixed

| Area | Issue |
|---|---|
| Mobile header | The "Link Tesla Account" button used to be hidden below the `sm` breakpoint with no alternate entry point, making it unreachable on very small screens. Fixed by the mobile-header-overflow work: the button is now reachable at every width down to 320px.
| Mobile nav | Below the `lg` breakpoint the header nav links were hidden with no in-header alternative. Fixed with a fixed bottom nav bar (`#mobileBottomNav`) on every page carrying the same five destinations, with the current page shown in gold with `aria-current="page"` and the iOS safe-area inset handled on the bar's own padding; it sits below the drawers, modals and toasts. |

---

## Sightings stats counted sightings the page did not list — Sep 30, 2026
**Symptom:** On the Austin Sightings page (Sep 30, 2026), the stat cards read **Last 7 days: 7** and **Today: 4**, while only **5** sighting cards were listed on the page. The stats and the list disagreed.

**Evidence:** The stats query and the list query used two different filters. In `worker/db.js`, `getApprovedPhotoSightingHourBuckets` (the stat cards' query) filtered with `APPROVED_PHOTO_SIGHTING_SQL`: approved photo sightings with a `public_id`, *including ones whose photo had since expired or been deleted by a moderator* (its own comment said so). The list used `PUBLIC_PHOTO_SIGHTING_SQL`, which also requires the photo to still be stored and inside the photo window. So a sighting whose photo was deleted stayed approved, left the list, and kept counting in every stat.
The first suspicion, UTC day-bucketing (a late-evening Austin sighting landing on the next UTC day), was checked and ruled out: the stats were introduced the evening before in `7da1d3a` (Sep 29, 21:22 CDT) already converting UTC hour buckets to `America/Chicago` local days (`worker/timezones.js`), and a regression test added with the fix confirms it.

**Fix:** Commit `7d7cecb` (Sep 30, 2026, 12:04 CDT): the stats query in `worker/db.js` now uses the same `PUBLIC_PHOTO_SIGHTING_SQL` predicate as the list, so a stat can never include a sighting the list doesn't show. Verified with new regression tests in `tests/sightings-stats.test.mjs`:
- **3b:** sightings at 11:30 PM and 12:30 AM Austin time (the same UTC day) land on two different local days; "today" counts only the 12:30 AM one.
- **3c:** 4 sightings listed → every stat reads 4; a moderator deletes one photo → the list shows 3 and *every* stat (total, 7 days, today, month, best day, peak hour) drops to 3.
- "The gallery count and the stats total never disagree."

## Gmail forwarding confirmation never reached the rider — Oct 5, 2026
**Symptom:** On `/link-gmail` (Oct 5, 2026), a rider added their forwarding address in Gmail (and re-sent the confirmation several times), but step 3 never showed anything to confirm with. The page said there was no code waiting, so automatic forwarding could not be finished.

**Evidence:** Traced hop by hop through the email path (read-only):
1. **Cloudflare Email Routing:** the only rules are a literal `receipts@` rule and a catch-all, both sending to the `cybercabhunter` worker, with no sender filters. The routing log (GraphQL `emailRoutingAdaptive`) showed **8** confirmation emails from `Gmail Team <forwarding-noreply@google.com>` (SPF pass, DMARC pass) delivered to the worker: 2026-09-27 01:09 and 01:12 UTC, and 2026-10-06 01:55, 02:00, 02:02, 02:07, 02:30 and 02:31 UTC (Oct 5, 8:55–9:31 PM CDT). So routing worked.
2. **D1 `receipt_ingestions`:** each of the 8 has a row at the same second with `status = rejected`, `error_code = not_recognized_as_tesla_receipt`. The worker received them but treated them as failed receipts. **0** rows had ever been logged as `gmail_forwarding_confirmation`, for any rider.
3. **Deployed code:** the deployed worker script (downloaded via the Cloudflare API) matched the repo. `detectGmailForwardingConfirmation` in `worker/receipt-forwarding.js` matched the sender and subject, but returned `null` unless the body had "code" followed by 6–9 digits. With `null`, the message fell through to the receipt classifier.
4. **The message:** the logged subject was `(Gmail Forwarding Confirmation - Receive Mail from contactjoeclos@gmail.com`, with no `(#123456789)` code, unlike Gmail's older format. Together with zero code matches across all 8 bodies, this indicates Gmail's current confirmation carries a confirm **link** and no numeric code. (Cloudflare does not log bodies, so this last step is an inference from the subject and the 8/8 failed matches.)

**Fix:** Commit `a93ea2f` (Oct 5, 2026, 21:45 CDT):
- `worker/receipt-forwarding.js`: a Gmail forwarding confirmation is always recognised and returns `{ code, link, requestedBy }`. The confirm link is kept only if it is `https` on `mail-settings.google.com` or `mail.google.com` under `/mail/`, so a spoofed email can't plant any other link.
- `worker/receipt-ingestion.js`: a confirmation is never classified as a receipt.
- Migration `0026_gmail_forwarding_link.sql` adds `forwarding_link` and `forwarding_requested_by`.
- `/link-gmail` step 3 shows a **Confirm in Gmail** button with "Requested by <gmail>".

Verified by new test `tests/phase2-ingest.test.mjs` section 16b, a production-shaped link-only email that failed on the old code and passes on the new. In production, the fixed worker was deployed at 2026-10-06 02:49:31 UTC, and the next confirmation, at **02:54:59 UTC**, was logged as `gmail_forwarding_confirmation`: the first one ever recognised. (The worker went live before migration 0026 was applied, which briefly broke `/link-gmail` with "We couldn't load your forwarding address" until the migration ran.)

## iPhone footer hidden under the bottom tab bar — Oct 6, 2026
**Symptom:** On an iPhone (mobile audit, Oct 6, 2026), the footer's **Appearance** System/Light/Dark toggle on `/simulation` was half-hidden behind the fixed bottom tab bar (`#mobileBottomNav`). On `/community` the last footer line sat flush against the bar.

**Evidence:** In a headless browser at 390×844 the footer did *not* overlap: it cleared the bar by **11px** on `/`, `/vehicles`, `/sightings`, `/simulation`, `/community` and `/vehicle/<id>`. The difference is the iPhone home-indicator inset, which headless browsers don't simulate.
- The tab bar adds the inset to its own height (inline `padding-bottom: env(safe-area-inset-bottom)`).
- The body's clearance was a flat `body:has(#mobileBottomNav){padding-bottom:4.5rem;}` (72px) in `public/css/style.css`, with no inset.

On an iPhone 14 (34px inset) the bar is 62 + 34 = **96px** tall over **72px** of clearance, so the bottom ~24px of the footer slid underneath.

**Fix:** Commit `128260b` (Oct 6, 2026, 16:03 CDT):
- `public/css/style.css` defines the inset once, as `--safe-bottom: env(safe-area-inset-bottom, 0px)`.
- The tab bar's inline padding on all 12 pages uses `var(--safe-bottom, …)`.
- Below `lg` only, the body gets `padding-bottom` and `scroll-padding-bottom` of `calc(5rem + var(--safe-bottom))`.
- `style.css?v=33` → `v=34` on every page.

Verified at 390×844 with a simulated 34px inset: the bar measured 96px, and the footer ended **18–19px above it** on all six pages above, with no horizontal overflow. Desktop screenshots at 1280px matched `main`. Deployed Oct 6, 2026 (worker version `768122bd`). On-device check on a physical iPhone was still pending when this entry was written.
