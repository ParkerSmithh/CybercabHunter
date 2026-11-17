#!/usr/bin/env python3
"""Robotaxi facility photos: originals in, optimized public copies out.

    python3 scripts/facility-photos.py            # every facility folder
    python3 scripts/facility-photos.py dallas-cedar-springs

Originals go in facility-photos/<facility-id>/ (git-ignored: they may carry
EXIF and GPS). For each image there this writes, under
public/images/facilities/<facility-id>/:
    <name>.webp        the gallery image, longest side at most 1600 px
    <name>-thumb.webp  the thumbnail, longest side at most 480 px
Both are re-encoded from pixels only, so no EXIF, GPS, XMP or ICC data is
copied. The picture itself is never cropped, retouched or altered: it is only
scaled down (never up) and rotated upright from its EXIF orientation.

Then add (or update) the photo in public/data/facilities.json (caption, alt,
credit, license; the script prints the src/thumb/width/height to paste) and
run `node ios-native/scripts/sync-web-data.mjs` so the app gets the same
data. No UI code changes are needed for new photos.
"""
import json
import os
import sys

from PIL import Image, ImageOps

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INBOX = os.path.join(ROOT, 'facility-photos')
OUT = os.path.join(ROOT, 'public', 'images', 'facilities')
SIZES = {'': 1600, '-thumb': 480}
EXTS = ('.jpg', '.jpeg', '.png', '.heic', '.webp', '.tif', '.tiff')


def process(facility_id):
    src_dir = os.path.join(INBOX, facility_id)
    out_dir = os.path.join(OUT, facility_id)
    os.makedirs(out_dir, exist_ok=True)
    made = []
    for name in sorted(os.listdir(src_dir)):
        stem, ext = os.path.splitext(name)
        if ext.lower() not in EXTS:
            continue
        with Image.open(os.path.join(src_dir, name)) as original:
            upright = ImageOps.exif_transpose(original)
            pixels = upright.convert('RGB')   # drops alpha and every metadata block
        entry = {}
        for suffix, longest in SIZES.items():
            img = pixels.copy()
            img.thumbnail((longest, longest), Image.LANCZOS)   # only ever shrinks
            path = os.path.join(out_dir, f'{stem}{suffix}.webp')
            # No exif=/icc_profile=/xmp= arguments: the file carries pixels only.
            img.save(path, 'WEBP', quality=82 if suffix == '' else 78, method=6)
            if suffix == '':
                entry = {'src': f'/images/facilities/{facility_id}/{stem}.webp', 'width': img.width, 'height': img.height}
            else:
                entry['thumb'] = f'/images/facilities/{facility_id}/{stem}-thumb.webp'
        made.append(entry)
        print(json.dumps(entry))
    return made


def main(argv):
    ids = argv or sorted(d for d in os.listdir(INBOX) if os.path.isdir(os.path.join(INBOX, d)))
    for facility_id in ids:
        print(f'# {facility_id}')
        process(facility_id)


if __name__ == '__main__':
    main(sys.argv[1:])
