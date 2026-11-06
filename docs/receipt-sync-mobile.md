# Mobile receipt sync

How Tesla Robotaxi receipts reach Cybercab Hunter, and what the iPhone app adds. Written Nov 2026, on branch `claude/receipt-sync-upgrade`.

## Every path ends in one pipeline
Every receipt, whatever its source, goes through `processReceiptMessage` → `ingestRide` (`worker/receipt-process.js`, `worker/ride-ingest.js`). That one path does:
- extraction, including the missing-pickup-time protection in `docs/receipt-ingestion.md`;
- the Tesla check;
- ride identity: date + pickup time + plate;
- duplicate detection, by Message-ID, receipt hash, and the same ride identity across different receipt text;
- revisions and ownership.

So the same ride forwarded by email and later shared or scanned in the app is **one trip**.

| Source | How it arrives | Automatic? |
|---|---|---|
| **Gmail forwarding** (the rider's private address) | Cloudflare Email Routing hands the email to the Worker (`handleIncomingEmail`) the moment Tesla sends it | **Yes, event-driven.** This is the automatic path in production |
| Connect Gmail (Gmail API) | `worker/gmail.js`: `users.history.list`, then a narrow search, on the 10-minute schedule | Built but **off** (`GMAIL_SYNC_ENABLED = false`), and connecting is allow-listed to the owner until Google verifies `gmail.readonly` |
| App: Import Receipt (scan, camera, Photos, Files) | Text is read on the device (Vision for images, PDFKit for PDFs), checked with `POST /api/rides/import/preview`, then imported with `POST /api/rides/import` | Manual, after the rider's review |
| App: Share Sheet | The extension keeps the receipt in the App Group (`ReceiptShareInbox`); the app's Import Receipt opens with it | Manual, about two taps |
| Website import | `POST /api/rides/import` (unchanged) | Manual |

## Gmail push (`users.watch` + Pub/Sub): evaluated, not built
**Recommendation: don't build it now.** Forwarding already imports a receipt the moment Tesla sends it, needs no Google permission, and has no setup in Google Cloud. Push would only speed up the Connect-Gmail path, which is off.

Push would need all of the following:
1. **Google's restricted-scope verification of `gmail.readonly`.** This includes an annual third-party security assessment (CASA), which has a real cost and takes weeks. It's needed for Connect Gmail anyway, push or not.
2. **A Google Cloud project with Pub/Sub enabled**, plus a topic. `gmail-api-push@system.gserviceaccount.com` must be granted Publisher on the topic, and a push subscription must point at a new Worker endpoint using an OIDC token. Pub/Sub's free tier (10 GB a month) would cover this volume.
3. **Worker work:** verifying each Pub/Sub push's Google-signed JWT (issuer, audience, signature against Google's keys); calling `users.watch` per rider; renewing every watch within 7 days (from the existing daily cron); and handling `historyId` expiry with a full resync. The existing `history.list` + narrow-scan code would be reused. Deliveries can repeat or arrive out of order, which the existing duplicate rules already handle.
4. **A decision on the free-plan limits.** The current design processes one message per rider per run to stay inside 50 subrequests. Push doesn't change that limit.

If you want it later, the order is: Google verification → GCP project and Pub/Sub → the endpoint and watch renewal, behind a kill switch → enable for the allow-listed account → widen.

## Notifications: "New Tesla ride imported"
- A new push category, `rides`, in the existing system (`worker/push-*.js`). It's **off by default**; the rider turns on "Receipt Import Notifications" in the app's notification settings.
- **When it fires:** only for a ride **created** by an automatic import (forwarded email, or Gmail when enabled). Never for a manual import, a duplicate, an update, or a receipt missing details, and never for another account's ride. A ride removed before delivery cancels its notification.
- **What it says:** the title is "New Tesla ride imported" and the body is "Tap to view your ride details." Several rides become one summarized notification: "N new Tesla rides imported". No address, time or fare appears, so it's safe on the Lock Screen. Tapping opens Ride Receipts.
- **Delivery:** it reuses device registration, preferences, quiet hours, grouping, de-duplication and expired-token handling. Like every push category, nothing is sent until `PUSH_ENABLED` and `PUSH_DELIVERY_ENABLED` are turned on in production; both are off.

## New and changed endpoints
- `POST /api/rides/import/preview`: one item, `{ kind: 'text'|'eml', content }`. It runs the same parser, classifier and duplicate rules as `/api/rides/import` and **writes nothing**. Returns `would` (`new` / `same_ride` / `duplicate` / `needs_details` / `rejected`), the fields (missing ones are null, never guessed) and `uncertain`.
- `GET /api/rides/imports?cursor=`: the rider's own recent receipts, newest first, 20 per page. Each comes with its source, its result, a stable error code, and the ride it made. It never returns email text, Message-IDs or hashes. It reads through the existing `user_id` index, so no migration.
- `GET /api/push/preferences` now fills in defaults for keys added since a rider saved, such as `rides`.

There are no database migrations.

## Share extension
- **What it accepts:** images, PDFs, plain text and email files, through a type predicate in `Config/ShareInfo.plist`.
- **What happens to each:**
  - A PDF, email or text is kept as a receipt.
  - An image gets a choice: **Add as a sighting** (the existing flow) or **Import as a ride receipt**.
- **The hand-off:** receipts go in `ReceiptShares/` in the existing App Group (`group.com.cybercabhunter.native`). The type is judged by the bytes, the limit is 15 MB, and leftovers are cleaned up after three days.
- **Reaching the app:** an extension can't open its app, so it posts a local "Finish importing your receipt" notification, as the sighting share does. Opening the app also offers the waiting receipt.
- **Nothing gets lost:** the app reads the shared receipt without deleting it, and removes it only once it's imported or the rider discards it. Signing in or closing the screen doesn't lose it.
- **No new entitlements:** the App Group already exists for the sighting share.

## Limitations
- Scanned and photographed receipts are read by on-device text recognition. The server's parser expects the layout of Tesla's receipt email, so a photo of a different layout (for example the Tesla app's own ride screen) may come back "not recognized" or "needs details". The rider can correct the recognized text and check again; nothing is ever guessed.
- A receipt that "needs details" isn't stored, so it can't be retried from the history. The rider imports a clearer copy or the original email.
- The document scanner needs a real iPhone camera; the Simulator has none.
