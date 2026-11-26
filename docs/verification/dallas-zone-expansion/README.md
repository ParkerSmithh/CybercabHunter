# Dallas service zone expansion (Nov 2026)

The boundary in the code is **reconstructed from two map images, not official coordinates**. Tesla hasn't published coordinates or an area figure, so it's a close approximation.

## Result
| | Area | Vertices |
|---|---|---|
| Previous zone | 80.1 mi² measured (the site showed Tesla's 81) | 22 |
| **New zone** | **147.9 mi²** (shown as 148) | 15 (ring closed) |
| Increase | **+67.8 mi², +84.6%** | |

Area is measured from the polygon on the WGS84 ellipsoid, with the same method for both. Bounds: longitude −96.92316 to −96.70955, latitude 32.73566 to 32.95555.

For comparison, press reports from independent measurements of Tesla's map put the new zone at about 150 mi², up from about 81–82.

## What changed
- **North.** The zone now runs past I-635 (LBJ) to a straight northern edge at about 32.955°N, near Belt Line Rd. It reaches the edges of Carrollton, Farmers Branch, Addison and Richardson; it doesn't cover any of those cities in full.
- **West.** A new edge runs from the previous west corner (Loop 12, near SH 183) northeast past Love Field, then north to the northwest corner. Love Field is now inside.
- **East.** The edge runs from the northeast corner south to the previous east elbow.
- **South.** The southern part is the previous boundary, vertex for vertex, from the east elbow round to the west corner. No area the old zone covered is lost.

## Method
The two images show one boundary. Image 1 has the old line in white and the new one in blue. Image 2 has the new line in red, on a more detailed map.
1. **Calibrate Image 1 against known coordinates.** Its white "old geofence" line was fitted to the repo's exact old polygon (Web Mercator scale, rotation and offset). Fit: mean 0.2 px (about 2 m), maximum 2 px (about 25 m), at 11.4 m per pixel on the ground.
   - One stretch was left out: the small northeast notch near Northwest Hwy and US 75. In Tesla's old map that notch is about 1.8 km taller than in the old code, which was digitized from an earlier screenshot. It's inside the new zone, so it doesn't affect the result.
2. **Fit each blue edge.** Each straight edge is a total-least-squares line through the blue line's pixels (spread about 0.8 px). Consecutive lines were intersected to give the corners.
3. **Join the new part to the old one.** The blue line meets the old boundary at the west corner (−96.92316, 32.81619) and at the east elbow (−96.72921, 32.81363). Between them, the southern part uses the old coordinates unchanged.

## Validation
| Check | Result |
|---|---|
| Image 2, red line vs the final polygon (aligned only by scale, rotation and offset; rotation 0.03°) | mean 5 m, 95% within 20 m, max 52 m |
| Image 2, the DAL airport icon placed by that alignment | 11 m from Love Field's reference point |
| Closed, simple (no edge crosses another) | yes |
| Old zone inside the new one | 100% |

- The Love Field check is only a rough outside test, since map icons aren't surveyed points.
- `tests/dallas-zone.test.mjs` checks several things:
  - the website and the app share one ring;
  - the polygon is simple and closed;
  - the area and the figures derived from it agree;
  - the southern part is the old boundary unchanged;
  - known places fall inside or outside as the images show;
  - Austin is unchanged.

## How the area is shown
Every area figure on the website and in the app is labelled as an estimate: "Coverage (est.)" (with "Area estimated from Tesla's map; not an official Tesla figure." on the Zones panels), "≈… mi² (est.)" in the app's city panel, and Siri says "about … not an official Tesla figure". This applies to Austin's figure too, which is also reconstructed.

## Uncertainty
- **Where the blue line sits.** In Image 1, where the old and new lines coincide (the south), the blue line is drawn about 5 px (about 57 m) outside the white one rather than on top of it.
  - That could be a drawing offset, but it doesn't fit both junctions. The blue line meets the old west corner within 0.5 px, yet passes about 7.6 px outside the east elbow.
  - So the new part uses the blue line as drawn. Pulling it in by 5 px would make the zone 147.0 mi².
- **Boundary position:** typically within about 20–60 m along the new edges.
- **Area:** about **±2 mi²**.
- **Source accuracy:** this is only as accurate as the two maps. Real geofences can follow streets more closely than these simplified outlines show.

## Files in this folder
- `before-web-*` and `after-web-*`: the website before and after.
  - Zones on desktop and phone, and the homepage minimap.
  - Replay (Dallas).
  - Zones zoomed out (`zoom9`) and in (`zoom12`).
- `after-ios-zones*`: the iOS Zones map, framed and zoomed in.
- `after-ios-zone-details.png`: the iOS Zones details, with "Coverage (est.)" and the estimate note.
- `after-ios-home-minimap.png`: the iOS Home minimap. The local test server's city stats come from the daily stats job, run once on its seeded test data.
- `after-ios-home-tracker-panel.png`: the iOS Home city panel ("≈148 mi² (est.)").
- `validation-final-polygon-on-image1/2.png`: the final polygon (red line with yellow corners, cyan in Image 2) drawn over each reference image.
