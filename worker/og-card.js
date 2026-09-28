// Shareable vehicle card: GET /api/og/vehicle/:id.png, plus the Open Graph /
// Twitter Card tags injected into /vehicle/:id (link previews don't run the
// page's JavaScript, so the tags must be in the served HTML).
//
// Public-eligibility is MIRRORED, never redefined: both use
// db.getPublicRobotaxiVehicle, exactly like apiGetVehicle. A private,
// hidden, ineligible or nonexistent vehicle gets the identical 404 body the
// vehicle detail route returns, and the page gets the same generic tags it
// always had — so neither can reveal that a private vehicle exists.
//
// Rendering without an image library, inside the Workers Free plan's CPU
// budget: scripts/build-og-card.py pre-renders a 256-colour palette card
// and pre-compresses everything except one band of rows (plate + city
// line). Per request this module only draws text into that band from
// pre-rendered glyphs and stitches a valid PNG together:
//
//   IDAT 1  zlib header + rows above the band (pre-compressed, sync-flushed)
//   IDAT 2  the band, as uncompressed ("stored") deflate blocks
//   IDAT 3  rows below the band (pre-compressed, final block)
//   IDAT 4  the zlib Adler-32 trailer, combined from the three parts
//
// Only the rider-free vehicle facts already on the public vehicle page are
// used (plate, city, whether a moderator confirmed it as a Cybercab). No
// rider name is ever drawn: Cybercab Hunter's privacy page promises names
// are never shown publicly.

import { db } from './db.js';
import { VEHICLE_ID_RE } from './vehicles.js';
import { LAYOUT, FONTS, GLYPHS, VARIANTS } from './og-card-assets.js';

const CARD_VERSION = '1';
const CITIES = { austin: 'Austin, TX', dallas: 'Dallas, TX', houston: 'Houston, TX', 'san antonio': 'San Antonio, TX' };
const SITE = 'https://cybercabhunter.com';

// ---------- Card facts (shared by the image and the meta tags) ----------

function cityFor(vehicle) {
  const key = String(vehicle.service_area || '').trim().replace(/\s+/g, ' ').toLowerCase();
  return CITIES[key] || null;
}

// Mirrors js/vehicle.js: "Cybercab" is claimed only once a moderator has
// recorded a VIN (the Cybercab badge and image key off vin alone).
function cardFacts(vehicle) {
  const plate = String(vehicle.license_plate || '').toUpperCase().replace(/[^A-Z0-9 -]/g, '').trim().slice(0, 10);
  return { plate, city: cityFor(vehicle), cybercab: !!vehicle.vin };
}

function kindLabel(facts) {
  return facts.cybercab ? 'Tesla Cybercab' : 'Tesla Robotaxi';
}

// Changes whenever anything drawn on the card changes, so share previews that
// cached an older card refetch it.
function cardVersion(facts) {
  let h = 0x811c9dc5;
  for (const ch of `${CARD_VERSION}|${facts.plate}|${facts.city}|${facts.cybercab}`) {
    h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  }
  return h.toString(36);
}

// ---------- PNG assembly ----------

const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

let glyphAlpha = null;   // inflated once per isolate
const variantCache = {};

async function variant(name) {
  if (!glyphAlpha) glyphAlpha = await inflateRaw(b64(GLYPHS));
  if (!variantCache[name]) {
    const v = VARIANTS[name];
    variantCache[name] = {
      head: b64(v.head), tail: b64(v.tail), band: b64(v.band), palette: b64(v.palette),
      adlerTop: v.adlerTop, adlerBottom: v.adlerBottom, bottomLen: v.bottomLen
    };
  }
  return variantCache[name];
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(parts) {
  let c = 0xffffffff;
  for (const p of parts) for (let i = 0; i < p.length; i++) c = CRC_TABLE[(c ^ p[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(buf) {
  let a = 1, b = 0;
  for (let i = 0; i < buf.length;) {
    const end = Math.min(i + 3800, buf.length);
    for (; i < end; i++) { a += buf[i]; b += a; }
    a %= 65521; b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// zlib's adler32_combine: the checksum of A||B from adler(A), adler(B), len(B).
function adlerCombine(a1, a2, len2) {
  const BASE = 65521;
  const rem = len2 % BASE;
  let sum1 = a1 & 0xffff;
  let sum2 = (rem * sum1) % BASE;
  sum1 += (a2 & 0xffff) + BASE - 1;
  sum2 += ((a1 >>> 16) & 0xffff) + ((a2 >>> 16) & 0xffff) + BASE - rem;
  if (sum1 >= BASE) sum1 -= BASE;
  if (sum1 >= BASE) sum1 -= BASE;
  if (sum2 >= BASE * 2) sum2 -= BASE * 2;
  if (sum2 >= BASE) sum2 -= BASE;
  return ((sum2 << 16) | sum1) >>> 0;
}

function u32(n) { return new Uint8Array([n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]); }

function chunk(type, data) {
  const t = new TextEncoder().encode(type);
  return [u32(data.length), t, data, u32(crc32([t, data]))];
}

function textWidth(font, text, tracking = 0) {
  let w = 0;
  for (const ch of text) { const g = font[ch]; if (g) w += g[0] + tracking; }
  return w - (text.length ? tracking : 0);
}

// Draws `text` into the band (palette indices, bandTop-relative), blending each
// anti-aliased edge pixel to the nearest palette colour (memoised per
// background index + alpha level, so only a handful of searches run).
function drawText(band, palette, font, text, x0, y0, rgb, tracking, maxRight) {
  const { W, bandTop, bandBottom } = LAYOUT;
  const memo = new Map();
  const blend = (bg, level) => {
    const key = bg * 16 + level;
    let v = memo.get(key);
    if (v !== undefined) return v;
    const a = level / 15;
    const r = palette[bg * 3] * (1 - a) + rgb[0] * a;
    const g = palette[bg * 3 + 1] * (1 - a) + rgb[1] * a;
    const b = palette[bg * 3 + 2] * (1 - a) + rgb[2] * a;
    let best = 0, bestD = Infinity;
    for (let i = 0; i < 256; i++) {
      const dr = palette[i * 3] - r, dg = palette[i * 3 + 1] - g, db = palette[i * 3 + 2] - b;
      const d = dr * dr * 3 + dg * dg * 4 + db * db * 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    memo.set(key, best);
    return best;
  };
  let pen = x0;
  for (const ch of text) {
    const g = font[ch];
    if (!g) continue;
    const [adv, gx, gy, gw, gh, off] = g;
    if (pen + gx + gw > maxRight) break;
    for (let yy = 0; yy < gh; yy++) {
      const y = Math.round(y0) + gy + yy;
      if (y < bandTop || y >= bandBottom) continue;
      const row = (y - bandTop) * W;
      for (let xx = 0; xx < gw; xx++) {
        const level = glyphAlpha[off + yy * gw + xx];
        if (!level) continue;
        const x = Math.round(pen) + gx + xx;
        if (x < 0 || x >= W) continue;
        band[row + x] = blend(band[row + x], level);
      }
    }
    pen += adv + tracking;
  }
}

export async function renderVehicleCard(facts) {
  const v = await variant(facts.cybercab ? 'cybercab' : 'robotaxi');
  const L = LAYOUT;
  const band = await inflateRaw(v.band);   // fresh copy per request

  let plateFont = FONTS.plate, plateY = L.plateY;
  if (textWidth(plateFont, facts.plate, L.plateTracking) > L.plateMaxW) { plateFont = FONTS.plateSmall; plateY = L.plateSmallY; }
  const maxRight = L.textX + L.cityMaxW;
  drawText(band, v.palette, plateFont, facts.plate, L.textX, plateY, L.plateColor, L.plateTracking, maxRight);
  drawText(band, v.palette, FONTS.city, `a ${kindLabel(facts)}`, L.textX, L.cityY, L.cityColor, 0, maxRight);
  if (facts.city) drawText(band, v.palette, FONTS.city, `in ${facts.city}`, L.textX, L.cityY + L.cityLine, L.cityColor, 0, maxRight);

  // Band rows (filter byte 0 + indices) as stored deflate blocks, BFINAL=0.
  const rows = L.bandBottom - L.bandTop, stride = L.W + 1;
  const raw = new Uint8Array(rows * stride);
  for (let y = 0; y < rows; y++) raw.set(band.subarray(y * L.W, (y + 1) * L.W), y * stride + 1);
  const blocks = [];
  for (let i = 0; i < raw.length; i += 65535) {
    const len = Math.min(65535, raw.length - i);
    blocks.push(new Uint8Array([0, len & 0xff, len >>> 8, ~len & 0xff, (~len >>> 8) & 0xff]), raw.subarray(i, i + len));
  }
  const stored = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
  let o = 0;
  for (const b of blocks) { stored.set(b, o); o += b.length; }

  const adler = adlerCombine(adlerCombine(v.adlerTop, adler32(raw), raw.length), v.adlerBottom, v.bottomLen);
  const parts = [v.head, ...chunk('IDAT', stored), v.tail, ...chunk('IDAT', u32(adler)), ...chunk('IEND', new Uint8Array(0))];
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  o = 0;
  for (const p of parts) { png.set(p, o); o += p.length; }
  return png;
}

// ---------- Routes ----------

// GET /api/og/vehicle/:id.png — same 400/404 contract as apiGetVehicle.
export async function apiVehicleCard(request, env, vehicleId) {
  if (!VEHICLE_ID_RE.test(vehicleId)) {
    return Response.json({ success: false, error: 'invalid_vehicle_id' }, { status: 400 });
  }
  const vehicle = await db.getPublicRobotaxiVehicle(env.cybercabhunter_db, vehicleId);
  if (!vehicle) {
    return Response.json({ success: false, error: 'not_found' }, { status: 404 });
  }
  const png = await renderVehicleCard(cardFacts(vehicle));
  // The eligibility check above runs on every request; the cache lifetime is
  // what bounds how long a card could outlive a vehicle going private in a
  // browser or share-preview cache. The ?v= on og:image changes whenever the
  // card's content changes, so a longer lifetime never shows a stale plate.
  return new Response(png, {
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' }
  });
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// The per-vehicle tags that replace vehicle.html's generic block. `null`
// (private / nonexistent / lookup failed) leaves the generic block as served.
export async function vehicleShareTags(env, vehicleId) {
  if (!VEHICLE_ID_RE.test(vehicleId) || !env.cybercabhunter_db) return null;
  const vehicle = await db.getPublicRobotaxiVehicle(env.cybercabhunter_db, vehicleId);
  if (!vehicle) return null;
  const history = await db.getRobotaxiVehicleHistory(env.cybercabhunter_db, vehicleId);
  const facts = cardFacts(vehicle);
  const plate = facts.plate || 'Vehicle';
  const rides = history && history.trip_count > 0 ? ` ${history.trip_count} recorded ride${history.trip_count === 1 ? '' : 's'}.` : '';
  const where = facts.city ? ` in ${facts.city}` : '';
  const title = `${plate} — Cybercab Hunter`;
  const description = `${plate} is a ${kindLabel(facts)} spotted${where}.${rides} Tracked live at cybercabhunter.com.`;
  const url = `${SITE}/vehicle/${vehicleId}`;
  const image = `${SITE}/api/og/vehicle/${vehicleId}.png?v=${cardVersion(facts)}`;
  const alt = `${plate} — a ${kindLabel(facts)}${where}`;
  return `<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(url)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Cybercab Hunter">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${esc(alt)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(image)}">`;
}

const SHARE_START = '<!-- share-tags -->';
const SHARE_END = '<!-- /share-tags -->';

// Serves the vehicle.html shell for /vehicle/:id with per-vehicle share tags
// when (and only when) the vehicle is public. Any failure serves the shell
// exactly as before — share tags are never worth breaking the page for.
export async function serveVehiclePage(request, env, vehicleId, shell) {
  let tags = null;
  try { tags = await vehicleShareTags(env, vehicleId); } catch (e) { tags = null; }
  if (!tags || shell.status !== 200) return shell;
  const html = await shell.text();
  const a = html.indexOf(SHARE_START), b = html.indexOf(SHARE_END);
  if (a < 0 || b < a) return new Response(html, shell);
  const headers = new Headers(shell.headers);
  headers.delete('Content-Length');
  headers.delete('ETag');
  headers.set('Cache-Control', 'public, max-age=60');
  return new Response(html.slice(0, a + SHARE_START.length) + '\n' + tags + '\n' + html.slice(b), { status: 200, headers });
}
