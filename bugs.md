# Bugs & Known Limitations

Living list of known issues and gaps. None of these are blocking — the site works as designed — but they're worth knowing about or fixing next.

## Open

| Area | Issue |
|---|---|
| Mobile nav | The nav links (`nav.primary`) are hidden below the `lg` breakpoint and there's no hamburger menu — on phones/small tablets the only way to move between pages is the footer links. |
| Multi-tab sync | State changes (new sighting, vote, bingo tile, pad registration) only appear in the tab that made them. Other open tabs/windows don't pick up the change until reloaded — there's no `storage` event listener tying tabs together. |
| Offline use | The Leaflet map, its CartoDB tiles, Tailwind, and Google Fonts all load from CDNs. Without an internet connection, `index.html` and `infrastructure.html` will render with a blank map area (markers/popups still initialize once Leaflet loads, but with no basemap). |
| City Showdown bar scaling | Vote bars are scaled relative to the current leader (`width = votes / maxVotes`), so upvoting the leading city visually shrinks every other bar rather than growing the one just voted for. Reads a little confusingly in the moment even though the numbers are correct. |
| `verify.html` scoring | The confidence score is derived from `file.size`, `file.lastModified`, and `file.name.length` — it's a believable-looking simulation, not real image analysis, so an identical file will always score identically and an unrelated photo can still "pass."

## Fixed

| Area | Issue |
|---|---|
| Mobile header | The "Link Tesla Account" button used to be hidden below the `sm` breakpoint with no alternate entry point, making it unreachable on very small screens. Fixed by the mobile-header-overflow work: the button is now reachable at every width down to 320px.
