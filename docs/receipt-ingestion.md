# Receipt-email ingestion

Automatic pipeline that turns a forwarded Tesla Robotaxi ride-receipt email into a structured `trips` row in D1, without requiring a user to manually type ride details.

## 1. Architecture

```
Tesla sends ride receipt email
        ↓
User forwards it to their personal Cybercab Hunter receipt address
        ↓
Cloudflare Email Routing (zone-level rule)
        ↓
This Worker's email() handler  (worker/index.js)
        ↓
handleIncomingEmail()  (worker/receipt-ingestion.js)
   ├─ resolve recipient → user           (worker/db.js)
   ├─ parse MIME                         (worker/receipt-parser.js, via postal-mime)
   ├─ extract Tesla-specific fields      (worker/receipt-extraction.js)
   ├─ compute dedup fingerprint          (worker/receipt-dedupe.js)
   ├─ classify confidence                (worker/receipt-validation.js)
   ├─ store attachment (if any) in R2    (EVIDENCE_BUCKET)
   └─ write submissions + trips + receipt_ingestions rows  (D1)
```

One Worker handles both `fetch()` (the existing HTTP API) and `email()` (this pipeline) — Cloudflare Workers supports multiple handler exports from the same script, so no second Worker was needed.

## 2. Cloudflare Email Routing setup — **not yet live**

**Blocking fact, verified directly:** `cybercabhunter.com` is not registered (checked against the live `.com` registry — no match). Cloudflare Email Routing only attaches to a domain that is an active Cloudflare zone; neither `parkersmithh.github.io` (GitHub Pages) nor `cybercabhunter.contactjoeclos.workers.dev` (Cloudflare's own shared `workers.dev` domain) qualifies — confirmed against Cloudflare's own current documentation: *"workers.dev subdomains are not supported... you need a custom domain managed through Cloudflare."*

**To go live, you (not me) need to:**
1. Register a domain (e.g. `cybercabhunter.com`, or any domain you prefer).
2. Add it to Cloudflare as a zone (point its nameservers at Cloudflare).
3. In the dashboard: **Compute → Email Service → Email Routing → Onboard Domain**.
4. Create a routing rule: pattern `u_*` (or a catch-all, see note below) → Action **"Send to a Worker"** → select `cybercabhunter`.
5. Set the Worker var `RECEIPT_DOMAIN` to the real domain (e.g. `wrangler` config or dashboard) so `/api/receipt-ingestion/address` starts returning full, working addresses instead of just a local-part.

**Do not enable a bare catch-all** unless you specifically want every address at the domain routed here — prefer a rule scoped to the `u_` prefix pattern this system actually uses, so unrelated mail to the domain isn't silently processed as a receipt attempt.

Everything else described below is built and tested against synthetic fixtures; only this final routing-rule step is pending your domain purchase.

## 3. User-to-address mapping

Each user gets one row in `receipt_ingestion_addresses` (`user_id` UNIQUE, `opaque_token` UNIQUE — a random 32-hex-char string, never a raw user ID, email, or Tesla identifier). The email's local-part is `u_<opaque_token>`. `GET /api/receipt-ingestion/address` (authenticated) creates the row on first call and returns it.

The `email()` handler resolves `message.to`'s local-part against this table (`status = 'active'` only) to find the user — **the address itself is the only authorization**; anyone possessing your personal `u_...` address could submit receipts under your identity, which is why it's treated as sensitive (never logged, never shown to other users) even though it isn't a secret in the cryptographic sense. Revoking access later just means flipping `status` to `'revoked'` (not yet exposed via an API — see §12 for how to do this manually if ever needed).

## 4. Email parsing

`postal-mime` (the parser Cloudflare's own docs recommend) turns the raw MIME stream into `{ from, to, replyTo, subject, messageId, date, text, html, attachments }`. This module has zero Tesla-specific knowledge.

## 5. Tesla-receipt extraction (`tesla_robotaxi_v1`)

Operates on the plain-text body (falling back to HTML-stripped-to-text if no plain-text part exists), matching multiple candidate patterns per field rather than one brittle selector — e.g. distance is looked for as `Distance: X mi` regardless of surrounding HTML markup. Every extracted field is only ever set when a pattern actually matched; nothing is invented for a missing field.

**Important honesty note:** these patterns are built against a *plausible* receipt layout (typical ride-hailing receipt fields), not a confirmed real Tesla email — none was available to develop against. Treat `tesla_robotaxi_v1` as a first version that will likely need real-world adjustment. When you (or a user) has a genuine Tesla Robotaxi receipt, compare it against `worker/receipt-extraction.js`'s patterns and add a `tesla_robotaxi_v2` function alongside (not replacing) `v1` if the format differs — `extraction.parserVersion` is stored per-row precisely so old and new records can coexist without a backfill.

## 6. Validation (confidence, not proof)

`worker/receipt-validation.js` combines a From-domain check (`*.tesla.com` — spoofable, so this is a weak signal, not authentication) with a structural score (robotaxi mention, fare, distance, ride ID — 0 to 4). Only sender-match **and** ≥3 structural signals auto-accept (`submissions.status = 'pending'`); anything weaker becomes `needs_review`; zero signals and no sender match is `rejected` (no submission/trip created at all).

## 7. Deduplication

Two independent mechanisms:
- **Message-ID lookup** (`receipt_ingestions.message_id`) catches retried/duplicate SMTP deliveries of the exact same email.
- **Content-fingerprint hash** (`receipt_hash` — Tesla's own ride/receipt ID if extracted, else a SHA-256 of the normalized body) catches the same ride forwarded twice under different Message-IDs, and is enforced by a real database constraint: `idx_trips_receipt_hash` is a UNIQUE index, so the same hash can never back two `trips` rows even if application logic were bypassed.

A duplicate is logged in `receipt_ingestions` (`status = 'duplicate'`, pointing at the original `submission_id`/`trip_id`) but never creates a second trip.

## 8. D1 schema (migration `0003_receipt_ingestion.sql`)

- `trips` gained: `source` (default `'manual'`, `'receipt_email'` for these), `source_message_id`, `external_ride_id`, `receipt_hash`.
- New `receipt_ingestion_addresses` — the address mapping (§3).
- New `receipt_ingestions` — one row per processed email attempt, every status (`accepted`/`needs_review`/`rejected`/`duplicate`/`parse_error`), for audit and idempotency.

No existing table was altered beyond adding columns to `trips`; `users`, `tesla_connections`, `vehicles`, `submissions`, `robotaxi_vehicles`, `vehicle_observations` are untouched.

## 9. R2 usage

Only a supported attachment (PDF/JPEG/PNG) is stored, at `receipts/<userId>/<uuid>.<ext>` — server-generated key, never the original filename. **The email body itself is never stored** — it's parsed, structured fields are extracted, and the body is discarded, matching the privacy-minimization requirement. No public URLs exist; the bucket has no public access enabled.

## 10. Security/privacy

- Recipient resolution only trusts the opaque token in `message.to` — never anything else in the email.
- An email to an unrecognized address is bounced (`message.setReject('Unknown recipient')`) with **no database write at all** — there's no user to attribute a log entry to.
- Inbound messages over 10 MB are rejected before parsing (well under Cloudflare's 25 MiB platform cap).
- HTML in the email is only ever used as plain-text-stripped input to regex extraction — never rendered, never executed.
- Logs (via `receipt_ingestions`) never contain raw email bodies, tokens, or secrets — only status, hashes, and short error codes.

## 11. Testing

- `tests/receipt-pipeline.test.mjs` — pure-function tests (parsing, extraction, classification, hashing) against fixtures in `tests/fixtures/`. Run: `node tests/receipt-pipeline.test.mjs`. No network, D1, or R2 needed.
- Full pipeline (D1 writes, R2 storage, dedup, vehicle matching) was verified via `wrangler dev --local` + Cloudflare's local email-testing endpoint:
  ```bash
  npx wrangler dev --local
  curl -X POST 'http://localhost:8787/cdn-cgi/local/email' \
    --url-query 'from=robotaxi@tesla.com' \
    --url-query 'to=u_<token>@receipts.example.com' \
    --data-binary @tests/fixtures/tesla-receipt-valid.eml
  ```
  This was run against all fixtures (valid receipt, duplicate, non-Tesla, missing fields, receipt with a real PDF attachment, unroutable recipient) with results inspected directly in local D1/R2 — see the implementation report for exact outcomes.

## 12. Manual replay / debugging

To replay a fixture locally: start `wrangler dev --local`, seed a matching `users`/`receipt_ingestion_addresses` row via `wrangler d1 execute cybercabhunter-db --local --command "..."`, then use the `curl .../cdn-cgi/local/email` command above with any file under `tests/fixtures/`.

To manually revoke a compromised address in production (no API for this yet):
```bash
npx wrangler d1 execute cybercabhunter-db --remote --command \
  "UPDATE receipt_ingestion_addresses SET status='revoked', revoked_at=datetime('now') WHERE user_id='<id>';"
```

## 13. Adding a future receipt format

Add a new `extractTeslaReceiptFieldsV2` (or similarly named) function to `worker/receipt-extraction.js` and a corresponding parser-version constant; have `handleIncomingEmail` in `worker/receipt-ingestion.js` try the newest version first, falling back to older ones, or pick based on a detectable signal in the email. Existing rows keep whatever `parser_version` they were created with — no backfill required.
