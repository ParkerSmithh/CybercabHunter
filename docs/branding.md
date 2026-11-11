# CybercabHunter branding and typography

## The brand

`[gold diamond emblem] CYBERCABHUNTER`, after the reference artwork
`CyberCabHunter Gold Emblem Logo.png`: one line, no space, **CYBERCAB** white
(`#FFFFFF`) and **HUNTER** gold (`#FAE030`), Inter black (900), uppercase,
letter-spacing −0.012em, centred on the emblem. Measured from the reference and
reproduced on both platforms:
- the emblem is 2.92× the letters' cap height (website 2.93); Inter's cap height
  is 0.727em, so the font size is 0.47× the emblem;
- the gap is 0.24 cap height (website 0.25, `0.085 × emblem`);
- the word is 13.2 cap heights long (website 13.3).

The markup keeps the real text "CybercabHunter" (screen readers, copy and
paste); only its display is uppercase. Inside sentences ("Sign in to
CybercabHunter", eyebrows) the name keeps normal case. The light website theme
uses the ink color for CYBERCAB and `#A88400` for HUNTER (`#FAE030` is 1.3:1 on
white).

Header sizes: a 42px emblem on desktop; on phones it is sized to the room left
beside the buttons (`(100vw − 170px) / 5.65`, between 24 and 38px), and the
buttons never wrap. The footer uses a 36px emblem (32px on phones). On iOS the
Home bar uses a 40 pt emblem and an 18.8 pt word, which shrinks rather than
wraps.

The source is the owner's `CybercabLogoNew.png` (kept unchanged and outside version control; nothing loads it).
`public/images/brand/cybercab-emblem-master.png` is its cleaned master:
- 1,370 stray specks removed (disconnected bits up to 2,000 px);
- pixels below alpha 16 cleared (invisible, they only widened the bounds);
- near-opaque pixels (alpha ≥ 224) made fully opaque;
- trimmed and centred on a square with a 2% margin.

The four segments, the car and the gold lighting are untouched. Every other
asset is generated from this master.

| Asset | Where | Use |
|---|---|---|
| `cybercab-emblem-64/128/192.png` | `public/images/brand/` | header/footer mark (1×/2×/3× via srcset) |
| `favicon-16/32/48/64.png`, `/favicon.ico` (16+32+48) | `public/images/brand/`, `public/` | browser tabs; small sizes lightly sharpened |
| `apple-touch-icon.png` (180, on `#050505`) | `public/images/brand/` | iOS home-screen bookmark |
| `cybercab-logo-512.png` (on `#050505`) | `public/images/brand/` | structured-data organization logo |
| `AppIcon-1024.png` (+ `-dark`, `-tinted`) | `ios-native/.../AppIcon.appiconset/` | app icon: emblem at 80% on `#050505`; dark on transparency; tinted grayscale |
| `brandmark@2x/@3x.png` | `ios-native/.../BrandMark.imageset/` | in-app emblem (Home bar, Account) |

No SVG favicon: the emblem is gradient lighting, which can't be traced to an
accurate vector. The site has no web manifest, so no PWA icons were added.

## Website typography

The homepage headline "TRACK THE FUTURE OF AUTONOMY" is **Inter** (self-hosted
variable font `fonts/inter-latin-wght.woff2`, weights 100–900) at weight 700,
uppercase, −0.035em, line-height 1.05. Nothing new is loaded; the site just uses
more of Inter's weights.

- `js/theme.js`: Tailwind's `font-bold` / `font-extrabold` / `font-black` are 700
  / 800 / 900 again (they were all 590). `medium` 510 and `semibold` 590 are
  unchanged.
- `css/brand-type.css` (every page, after style.css) holds the lockup and the
  hierarchy as tokens: page headings `h1.font-display` 800, section headings 760,
  card titles 700, `.stat-value` 700 tabular, navigation 500 (current 650). Body
  text and metadata are unchanged. Authors' tracking/case classes are kept.
- The hero keeps its own 700 (the reference).

## iOS

- `DesignSystem/BrandLockup.swift`: the lockup (emblem 40 pt, CYBERCABHUNTER at
  0.47× in Inter black, gap 0.085×, one line, shrinks to 70% rather than wrap,
  grows up to 15% with Dynamic Type). Used by Home's top bar;
  `BrandLockup.wordmark(size:)` also renders "Sign in to CybercabHunter".
- The Home Screen name stays **"Cybercab Hunter"**: the one-word name was
  truncated to "CybercabH…" on the Home Screen, and the two-word name also
  keeps Siri phrases natural.

## Regenerating

The assets were produced with Pillow from the master. Re-run the same resize
steps (LANCZOS; favicons ≤ 64 px with a light unsharp mask; icons composited on
`#050505`) if the master changes.
