# Bugs & Known Limitations

Living list of known issues and gaps. None of these are blocking — the site works as designed — but they're worth knowing about or fixing next.

## Open

| Area | Issue |
|---|---|
| Offline / CDN dependency | Every page loads Tailwind CSS and Google Fonts from a CDN — without an internet connection, styling and typography break site-wide, not just on any one page. `index.html` and `infrastructure.html` additionally load MapLibre GL and OpenFreeMap tiles from CDNs for their maps, which will render with a blank map area offline (markers/popups still initialize once MapLibre loads, but with no basemap). `fleet-calculator.html`'s "Export Investment Prospectus" button additionally depends on `jsPDF` from a CDN and will fail to generate a PDF offline. |
| Receipt pickup-time parsing | The v2 receipt extractor reads the first time after the pickup address as the pickup time. A receipt whose pickup-time line is missing but whose drop-off time is present will have its drop-off time read as the pickup time instead — a wrong ride identity, consistent across copies of that same malformed receipt. Real Tesla receipts carry both times. Documented in detail in `docs/receipt-ingestion.md` ("Known limitation"). |

## Fixed

| Area | Issue |
|---|---|
| Mobile header | The "Link Tesla Account" button used to be hidden below the `sm` breakpoint with no alternate entry point, making it unreachable on very small screens. Fixed by the mobile-header-overflow work: the button is now reachable at every width down to 320px.
| Mobile nav | Below the `lg` breakpoint the header nav links were hidden with no in-header alternative. Fixed with a fixed bottom nav bar (`#mobileBottomNav`) on every page carrying the same five destinations, with the current page shown in gold with `aria-current="page"` and the iOS safe-area inset handled on the bar's own padding; it sits below the drawers, modals and toasts. |
