Final camera list update — October 7, 2026

The authoritative list is now `dallas-camera-plan-50.txt` alongside this report,
transcribed from the owner's corrected final 50. The public catalog matches
all 50 IDs, names and coordinates exactly. IH45 @ Loop 12 is txdot-dal-823
at 32.701176,-96.753359; IH45 @ Linfield is txdot-dal-822 at
32.714454,-96.756825. Neither US175 entry remains. All 70 Austin entries
are unchanged.

The Submit and moderation dropdown renderers are tested in DOM selects for
Dallas → Austin → Dallas, comparing every option's ID and label to the catalog.
The same catalog is imported by the Worker for coordinate/name validation.
The approval test now uses SH183 @ Regal Row (txdot-dal-1000) instead of
US75 @ Lemmon, which the owner's final list removes.

Boundary verification found eight supplied cameras outside the existing
service-zone polygon: IH45 @ Loop 12, IH45 @ Linfield, IH45 @ Lamar North,
IH30 @ Samuell, Loop 12 @ SH183 East, SH183 @ SH114, IH30 @ Hunnicut,
and IH35E @ Raceway. The exact supplied list and polygon were preserved;
the boundary test pins those exceptions rather than claiming all are inside.
The earlier camera substitutions described below are superseded.

---

Dallas zone polish verification — October 7, 2026

Branch: `claude/dallas-zone-polish`, based on `claude/dallas-launch`.
Preview: https://dallas-zone-polish-cybercabhunter.contactjoeclos.workers.dev

The existing shared Dallas polygon was compared with the owner's
`/Users/parkersmith/Downloads/IMG_7863.jpg`: its Love Field notch, stepped north
edge, eastern bends and southern/western edges match the reference shape.
Both the Zones map and homepage minimap use this same polygon and Austin's styling.

Camera identities, names and coordinates were checked against TxDOT's public
[TxDOT_ITS_Device_locations layer](https://services.arcgis.com/KTcxiTD9dsQw4r7Z/arcgis/rest/services/Existing_ITS_Device_Service_view/FeatureServer/0).
All selected cameras are CCTV devices in DAL1/DAL2. Seven supplied cameras
fell outside the polygon and were replaced with in-zone cameras:

| Supplied OBJECTID | Replacement OBJECTID | Replacement |
| --- | --- | --- |
| 1155 | 1085 | US75 @ Caruth Haven |
| 820 | 1119 | US75 @ Monticello |
| 614 | 1140 | US75 @ SMU Blvd. |
| 1113 | 1109 | US75 @ Lovers Lane |
| 821 | 1096 | US75 @ Fitzhugh |
| 579 | 1108 | US75 @ Lemmon |
| 755 | 1024 | Spur 366 @ US75 North |

The original plan's approximate spacing is not a strict minimum: retained
cameras and the available US75 replacements include pairs under 0.6 km.
The supplied in-zone selections were preserved, with replacements prioritizing
the Highland Park / Uptown corridor. Exactly 50 distinct Dallas cameras remain;
all 70 Austin entries are unchanged. A regression test checks each Dallas
camera against the shared polygon, rather than merely its bounding box.

Validation: `node --test tests/*.test.mjs` — 65 passed, 0 failed;
`node tests/calc.test.js` — all assertions passed; `git diff --check` passed.
Browser results and screenshots alongside this file cover 1280×900 and 390×844,
including the mobile Zones drawer. All Dallas views show the requested copy,
no obsolete Dallas hours/placeholder/legend wording, no horizontal overflow,
and no page errors. The existing site's design detector reported incumbent
style warnings; shared Austin styling was preserved as requested.

Only a Cloudflare version preview was uploaded. No production deployment,
merge to main, database migration, or backend source change was performed.

Final camera update validation: `node --test tests/*.test.mjs` — 68 passed,
0 failed; `node tests/calc.test.js` — all assertions passed; `git diff --check`
passed. Cloudflare version cd249847-0f71-4973-a962-0f9b91c3de46 was uploaded
with preview alias `dallas-zone-polish`. The served preview catalog was fetched
and compared to the complete local catalog: identical IDs, names and coordinates
for all 50 Dallas and 70 Austin entries.
Preview: https://dallas-zone-polish-cybercabhunter.contactjoeclos.workers.dev
No merge, production deployment, or database migration was performed.
