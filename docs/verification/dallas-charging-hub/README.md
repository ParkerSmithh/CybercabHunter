Dallas charging hub verification — October 7, 2026

Branch: `codex/dallas-charging-hub`, created from main.

Added only the owner-supplied Irving Robotaxi Hub, at 32.92182,-97.00428,
with the exact supplied note. Source comments immediately above the entry cite
TeslaNorth (May 17, 2026), Irving City Council coverage on citizenportal.ai,
and the supplied @scotsrule08 drive-by post (May 21, 2026).

The Zones page supplies Dallas's array to the existing map feature helper.
The Irving marker uses the same addPin implementation, 18px size, #D4AF37
color, marker-pulse class and three-part popup styling as Austin. The live
Austin label is text-[11px]/tracking-wide, and its legend has a dark ring;
these incumbent styles were preserved instead of replacing them with the
older 10px label/glowing legend quoted in the request. Dallas's legend already
matches Austin's byte for byte, so neither legend needed editing.

Dallas's bounds include both its existing polygon and the Irving coordinates.
Desktop framing leaves room for the full 240px popup beside the sidebar;
mobile uses the existing 24px map padding. Dallas markers are removed on
switching to Austin and restored once on returning to Dallas.

Local browser verification used http://localhost:8765/infrastructure.html
with the real MapLibre map and basemap; read-only API requests were proxied
to production. Checked 1280×900 and 390×844: initial Austin has its same two
charging pins; Dallas includes the Irving pin; every popup line matches the
supplied text; legends match; pin and desktop popup clear the sidebar;
Austin → Dallas → Austin → Dallas produces no duplicate hub; no horizontal
overflow and no page errors. See browser-results.json and the four PNGs.

Additional scope checks confirmed Austin's complete sidebar, its charging
array, both zone polygons and the camera catalog are unchanged from main.
Validation: node --test tests/*.test.mjs — 68 passed, 0 failed;
node tests/calc.test.js — all assertions passed; git diff --check passed.
The design detector reported incumbent style warnings; the requested existing
Austin styles were preserved. No merge or deployment performed.
