# Austin service zone expansion (Nov 2026)

The boundary in the code is **reconstructed from three map images, not official coordinates**. Tesla hasn't published coordinates, so it's a close approximation.

## Result
| | Area | Vertices |
|---|---|---|
| Previous zone | 272.2 mi² measured (272.4 in the old code) | 42 |
| **New zone** | **440.1 mi²** (shown as 440) | 32 (ring closed) |
| Increase | **+167.9 mi², +61.7%** | |

Area is measured from the polygon on the WGS84 ellipsoid, with the same method for both. Bounds: longitude −97.9363 to −97.4796, latitude 30.0509 to 30.4529.

## Method
All three images show one boundary. Image 1's gray and blue areas are combined.
1. **Calibrate Image 1 against known coordinates.** Its white "old geofence" line was fitted to the repo's exact old polygon as a Web Mercator scale and offset. Fit: mean 0.26 px (about 20 m), maximum 1.8 px, x/y scale ratio 1.0001. This also confirmed the old line is exactly the previous boundary in the code.
2. **Trace the outer outline** of each image along the centre of the line, by color.
3. **Align Images 2 and 3** to Image 1's outline (scale, rotation, offset).
4. **Build the polygon** from Image 3 (the sharpest) using 55 m corner simplification. Corners within 100 m of an old vertex use its exact coordinates, so the unchanged stretches in the north and northwest stay exact. Pairs of nearby corners created by rounded pixels were merged into true corners.

## Validation
| Image | Traced area | Rotation | Final polygon vs. traced outline |
|---|---|---|---|
| 1 | 439.4 mi² | reference | mean 26 m, 95% within 65 m, overlap (IoU) 0.9968 |
| 2 | 439.4 mi² | 0.006° | mean 22 m, 95% within 60 m, IoU 0.9972 |
| 3 | 439.6 mi² | 0.007° | mean 18 m, 95% within 48 m, IoU 0.9976 |

- The largest single difference is 189 m (Image 1), at a sharp corner where the image is only about 74 m per pixel.
- The old zone lies inside the new one (0.01% of its area falls outside, within a 90 m tolerance).
- The airport icon in Image 3 lands about 500 m from the airport's official reference point, inside the airport grounds. It is only a rough outside check, since map icons aren't surveyed points.
- `tests/austin-zone.test.mjs` checks that all four copies match, the polygon is simple and closed, the area and coverage figures agree, known places fall inside or outside as the images show, and Dallas is unchanged.

## Uncertainty
- **Boundary position:** typically about 20–50 m, and up to about 190 m at a few corners.
- **Area:** about **±3 mi²** (a 50 m boundary error over the 156 km perimeter). The three independent traces agree to within 0.2 mi²; the final polygon's 440.1 is 0.5–0.7 mi² larger because of corner simplification.
- **Source accuracy:** this is only as accurate as the three maps. Real geofences can follow streets more closely than these simplified outlines show.

## Files in this folder
`before-*` and `after-*`: the website (Zones on desktop and phone, the homepage minimap, Replay) and the iOS Zones map. `validation-final-polygon-on-image1/2/3.png`: the final polygon drawn over each reference image.
