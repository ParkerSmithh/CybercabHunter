#!/usr/bin/env python3
"""Builds the pre-rendered parts of the shareable vehicle card.

Output: worker/og-card-assets.js (imported by worker/og-card.js) and
public/images/og-default.png (the site-wide/generic social image).

Why pre-rendered: the Worker runs on the Workers Free plan (~10 ms of CPU per
request) with no image library. So everything that never changes is rendered
and compressed HERE, and the Worker only draws the plate and city line into a
small band of rows at request time (see worker/og-card.js for the PNG
assembly). The card is a 256-colour palette PNG:

  rows [0, BAND_TOP)         pre-compressed zlib stream, ended with a sync flush
  rows [BAND_TOP, BAND_BOT)  written per request as uncompressed deflate blocks
  rows [BAND_BOT, 630)       pre-compressed raw deflate, final block

Requires Pillow and the Space Grotesk font (OFL), downloaded on first run:
  python3 scripts/build-og-card.py
"""
import base64, io, json, os, sys, urllib.request, zlib
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
FONT_URL = 'https://github.com/google/fonts/raw/main/ofl/spacegrotesk/SpaceGrotesk%5Bwght%5D.ttf'
FONT_PATH = os.path.join(ROOT, 'scripts', '.cache', 'SpaceGrotesk.ttf')

W, H = 1200, 630
BAND_TOP, BAND_BOT = 232, 458      # rows written per request (plate + city lines)
TEXT_X = 72
PLATE_Y = 214                      # font origin (top of the em box) for the plate
PLATE_MAX_W = 540                  # beyond this the smaller plate size is used (the car starts at x=632)
CITY_Y = 352                       # two lines: 'a Tesla Cybercab' / 'in Austin, TX'
CITY_LINE = 46

VOID = (7, 9, 14)
GOLD = (212, 175, 55)
GOLDSOFT = (243, 229, 171)
CITY = (226, 232, 240)             # slate-200
MUTED = (148, 163, 184)            # slate-400
CYAN = (0, 229, 255)

PLATE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789- '
CITY_CHARS = ''.join(chr(c) for c in range(32, 127))


def font(size, weight='Bold'):
    if not os.path.exists(FONT_PATH):
        os.makedirs(os.path.dirname(FONT_PATH), exist_ok=True)
        urllib.request.urlretrieve(FONT_URL, FONT_PATH)
    f = ImageFont.truetype(FONT_PATH, size)
    f.set_variation_by_name(weight)
    return f


def glow(size, center, radius, color, strength):
    layer = Image.new('RGB', size, (0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx, cy = center
    d.ellipse((cx - radius, cy - radius, cx + radius, cy + radius), fill=tuple(int(c * strength) for c in color))
    return layer.filter(ImageFilter.GaussianBlur(radius * 0.45))


def add(base, layer):
    from PIL import ImageChops
    return ImageChops.add(base, layer)


def spaced(draw, xy, text, fnt, fill, tracking):
    x, y = xy
    for ch in text:
        draw.text((x, y), ch, font=fnt, fill=fill)
        x += fnt.getlength(ch) + tracking
    return x


def background(with_car, car_w=540):
    im = Image.new('RGB', (W, H), VOID)
    im = add(im, glow((W, H), (930, 330), 300, GOLD, 0.22 if with_car else 0.12))
    im = add(im, glow((W, H), (80, 640), 260, CYAN, 0.07))
    d = ImageDraw.Draw(im)
    # Gold hairline frame, like the site's glass cards.
    d.rounded_rectangle((20, 20, W - 21, H - 21), radius=28, outline=(58, 50, 26), width=2)
    if with_car:
        car = Image.open(os.path.join(ROOT, 'public', 'images', 'Cybercab2.png')).convert('RGBA')
        car = car.crop(car.getbbox())
        car = car.resize((car_w, round(car.height * car_w / car.width)), Image.LANCZOS)
        im.paste(car, (W - car_w - 28, 150 + (300 - car.height) // 2), car)
    # Brand, top-left: logo + wordmark.
    logo = Image.open(os.path.join(ROOT, 'public', 'images', 'Cybercab2.png')).convert('RGBA')
    logo = logo.crop(logo.getbbox())
    lw = 84
    logo = logo.resize((lw, round(logo.height * lw / logo.width)), Image.LANCZOS)
    im.paste(logo, (TEXT_X - 4, 60 + (46 - logo.height) // 2), logo)
    spaced(d, (TEXT_X + 92, 56), 'CYBERCAB', font(28), (241, 245, 249), 1.5)
    spaced(d, (TEXT_X + 93, 90), 'HUNTER', font(14, 'Medium'), MUTED, 4)
    return im


def static_text(im, eyebrow, footer=True):
    d = ImageDraw.Draw(im)
    spaced(d, (TEXT_X, 184), eyebrow, font(26), GOLD, 5)
    if footer:
        f = font(28, 'Medium')
        d.text((TEXT_X, 530), 'Tracked live at ', font=f, fill=MUTED)
        d.text((TEXT_X + f.getlength('Tracked live at '), 530), 'cybercabhunter.com', font=f, fill=CYAN)
    return im


def glyph_set(fnt, chars):
    """Per-character ink bitmaps (16 alpha levels) + advance widths."""
    meta, blob = {}, bytearray()
    for ch in chars:
        adv = fnt.getlength(ch)
        box = fnt.getbbox(ch)  # relative to the text origin (anchor 'la')
        if box[2] <= box[0] or box[3] <= box[1]:
            meta[ch] = [round(adv, 2), 0, 0, 0, 0, len(blob)]
            continue
        x0, y0, x1, y1 = box
        g = Image.new('L', (x1 - x0, y1 - y0), 0)
        ImageDraw.Draw(g).text((-x0, -y0), ch, font=fnt, fill=255)
        meta[ch] = [round(adv, 2), x0, y0, g.width, g.height, len(blob)]
        blob += bytes((v * 15 + 127) // 255 for v in g.getdata())
    return meta, bytes(blob)


def draw_glyphs(im, fnt, text, xy, color, tracking=0):
    d = ImageDraw.Draw(im)
    x, y = xy
    for ch in text:
        d.text((x, y), ch, font=fnt, fill=color)
        x += fnt.getlength(ch) + tracking


def raw_rows(indices, y0, y1):
    out = bytearray()
    for y in range(y0, y1):
        out.append(0)
        out += indices[y * W:(y + 1) * W]
    return bytes(out)


def chunk(kind, data):
    body = kind + data
    return len(data).to_bytes(4, 'big') + body + (zlib.crc32(body) & 0xffffffff).to_bytes(4, 'big')


def b64(data):
    return base64.b64encode(data).decode('ascii')


PLATE_TRACKING = 4


def build_variant(with_car, plate_big, plate_small, city_font):
    base = static_text(background(with_car), 'I SPOTTED')
    # Palette calibration: the same card with sample text in the band, so the
    # palette holds the plate/city colours blended over this background.
    calib = base.copy()
    draw_glyphs(calib, plate_big, 'XVF2569 ABKMRTWZ', (TEXT_X, PLATE_Y), GOLD, PLATE_TRACKING)
    draw_glyphs(calib, plate_small, 'QJ-HYGN80 CDEPSU', (TEXT_X, PLATE_Y + 20), GOLD, PLATE_TRACKING)
    draw_glyphs(calib, city_font, 'a Tesla Cybercab', (TEXT_X, CITY_Y), CITY)
    draw_glyphs(calib, city_font, 'in San Antonio, TX', (TEXT_X, CITY_Y + CITY_LINE), CITY)
    draw_glyphs(calib, city_font, 'Robotaxi Houston Dallas', (TEXT_X + 20, CITY_Y + 20), CITY)
    # Median cut weights colours by pixel count, so the text side (small but
    # what must stay crisp: gold, slate and the cyan footer) is repeated
    # below the card to earn its share of the 256 entries.
    text_side = calib.crop((0, 160, 640, 600))
    weighted = Image.new('RGB', (W, H + 440 * 2), VOID)
    weighted.paste(calib, (0, 0))
    for i, x in enumerate((0, 600)):
        weighted.paste(text_side.crop((0, 0, 600, 440)), (x, H))
        weighted.paste(text_side.crop((0, 0, 600, 440)), (x, H + 440))
    pal_img = weighted.quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    q = base.quantize(palette=pal_img, dither=Image.Dither.FLOYDSTEINBERG)
    palette = bytes(q.getpalette()[:256 * 3])
    palette += bytes(256 * 3 - len(palette))
    idx = bytes(q.getdata())

    top = raw_rows(idx, 0, BAND_TOP)
    band = raw_rows(idx, BAND_TOP, BAND_BOT)
    bottom = raw_rows(idx, BAND_BOT, H)
    c = zlib.compressobj(9, zlib.DEFLATED, 15)
    head_stream = c.compress(top) + c.flush(zlib.Z_SYNC_FLUSH)
    c = zlib.compressobj(9, zlib.DEFLATED, -15)
    tail_stream = c.compress(bottom) + c.flush(zlib.Z_FINISH)

    ihdr = W.to_bytes(4, 'big') + H.to_bytes(4, 'big') + bytes([8, 3, 0, 0, 0])
    head = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'PLTE', palette) + chunk(b'IDAT', head_stream)
    tail = chunk(b'IDAT', tail_stream)

    # Band background without filter bytes, raw-deflated; inflated per request.
    band_bg = b''.join(idx[y * W:(y + 1) * W] for y in range(BAND_TOP, BAND_BOT))
    c = zlib.compressobj(9, zlib.DEFLATED, -15)
    band_z = c.compress(band_bg) + c.flush()

    # Reference rendering (for the build log / eyeballing only).
    return {
        'head': b64(head), 'tail': b64(tail), 'band': b64(band_z),
        'adlerTop': zlib.adler32(top), 'adlerBottom': zlib.adler32(bottom), 'bottomLen': len(bottom),
        'palette': b64(palette),
    }, base


def main():
    plate_big, plate_small, city_font = font(120), font(84), font(38, 'Medium')
    variants, previews = {}, {}
    for name, with_car in (('cybercab', True), ('robotaxi', False)):
        variants[name], previews[name] = build_variant(with_car, plate_big, plate_small, city_font)

    fonts = {}
    blobs = bytearray()
    for key, fnt, chars in (('plate', plate_big, PLATE_CHARS), ('plateSmall', plate_small, PLATE_CHARS), ('city', city_font, CITY_CHARS)):
        meta, blob = glyph_set(fnt, chars)
        for m in meta.values():
            m[5] += len(blobs)
        blobs += blob
        fonts[key] = meta
    c = zlib.compressobj(9, zlib.DEFLATED, -15)
    glyphs_z = c.compress(bytes(blobs)) + c.flush()

    layout = {
        'W': W, 'H': H, 'bandTop': BAND_TOP, 'bandBottom': BAND_BOT,
        'textX': TEXT_X, 'plateY': PLATE_Y, 'plateSmallY': PLATE_Y + 20, 'plateMaxW': PLATE_MAX_W,
        'plateTracking': PLATE_TRACKING, 'cityY': CITY_Y, 'cityLine': CITY_LINE, 'cityMaxW': 632 - TEXT_X - 16,
        'plateColor': GOLD, 'cityColor': CITY,
    }
    out = os.path.join(ROOT, 'worker', 'og-card-assets.js')
    with open(out, 'w') as fh:
        fh.write('// GENERATED by scripts/build-og-card.py — do not edit by hand.\n')
        fh.write('// Pre-rendered parts of the shareable vehicle card; see worker/og-card.js.\n')
        fh.write('export const LAYOUT = ' + json.dumps(layout) + ';\n')
        fh.write('export const FONTS = ' + json.dumps(fonts, separators=(',', ':')) + ';\n')
        fh.write("export const GLYPHS = '" + b64(glyphs_z) + "';\n")
        fh.write('export const VARIANTS = ' + json.dumps(variants, indent=1) + ';\n')

    # Generic card for the site-wide / fallback og:image.
    im = background(True, 600)
    d = ImageDraw.Draw(im)
    spaced(d, (TEXT_X, 184), 'COMMUNITY ROBOTAXI TRACKER', font(26), GOLD, 5)
    draw_glyphs(im, font(96), 'Spot a', (TEXT_X, 214), GOLDSOFT)
    draw_glyphs(im, font(96), 'Cybercab', (TEXT_X, 314), GOLD)
    d.text((TEXT_X, 440), 'Tesla robotaxis in Austin, TX', font=font(36, 'Medium'), fill=CITY)
    static_text(im, '', footer=True)
    im.save(os.path.join(ROOT, 'public', 'images', 'og-default.png'), optimize=True)

    for name, p in previews.items():
        p.save(os.path.join(os.path.dirname(FONT_PATH), f'preview-{name}.png'))
    print('wrote', out, os.path.getsize(out), 'bytes')


if __name__ == '__main__':
    sys.exit(main())
