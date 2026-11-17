# Robotaxi facilities (Zones map, website and iOS)

One list, `public/data/facilities.json`, feeds both platforms:

- **Website:** `js/zones-facilities.js` (+ `css/zones-facilities.css`) on the Zones page reads it once. It draws the markers, the All / Charging / Staging filter (per city), popups, the details drawer and the gallery. Deep link: `/infrastructure?city=dallas&facility=<id>`.
- **iOS:** `FacilityStore` (`Core/Geo/Facilities.swift`) uses the copy bundled by `ios-native/scripts/sync-web-data.mjs`. It refreshes once per launch from `https://cybercabhunter.com/data/facilities.json` and keeps that copy for offline use. The screens are in `Features/Zones/FacilityViews.swift`.

Nothing else may keep its own facility list. `tests/facilities.test.mjs` and `WebDataSyncTests` check this.

## Adding photos (no UI code changes)

1. Put the originals in `facility-photos/<facility-id>/`, named in gallery order (`01-…`, `02-…`). This folder is git-ignored because originals may carry GPS or EXIF data.
2. Run `python3 scripts/facility-photos.py <facility-id>`. It writes `public/images/facilities/<facility-id>/<name>.webp` (up to 1600 px) and `<name>-thumb.webp` (480 px). Both are re-encoded from pixels only: no EXIF, GPS, XMP or ICC data. Images are scaled down, never cropped or edited.
3. Add each printed `src` / `thumb` / `width` / `height` to the facility's `photos` in `facilities.json`. Include a `caption`, `alt` text, `credit` and `license`.
4. Run `node ios-native/scripts/sync-web-data.mjs`, then `node tests/facilities.test.mjs`.

Once deployed, the website and the app (on its next launch) show the new photos.

## Rules for records

- Every facility needs at least one source. Use `type`: `charging` | `staging` | `combined`. Use `operational`: `operating` | `reported` | `planned` | `unknown`. Use `verification`: `confirmed` | `reported` | `unverified`.
- Never present a generic charging photo as a specific site. Only host a photo when reuse is permitted. Otherwise record its source in `photoReview` and leave the placeholder.
- A Tesla service center is not a Robotaxi facility without evidence.
