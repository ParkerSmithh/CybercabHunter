// Tests for the shareable vehicle card (worker/og-card.js): the PNG endpoint,
// its 404 indistinguishability (identical to the vehicle detail route for a
// private and a nonexistent vehicle), the per-vehicle Open Graph tags on
// /vehicle/:id, and the page's Share button (js/vehicle.js, in jsdom).
// Run: node tests/share-card.test.mjs

import fs from 'node:fs';
import zlib from 'node:zlib';
import { JSDOM } from 'jsdom';
import { createTestD1, seedUser } from './helpers/d1-sqlite.mjs';
import { approveVehicle, makeCheck } from './helpers/env.mjs';
import { db } from '../worker/db.js';
import worker from '../worker/index.js';

const t = makeCheck();
const { check } = t;
const ROOT = new URL('..', import.meta.url).pathname;
const HTML = fs.readFileSync(`${ROOT}public/vehicle.html`, 'utf8');
const JS = fs.readFileSync(`${ROOT}public/js/vehicle.js`, 'utf8');
const NONEXISTENT = '0ac4f010-b852-4ae3-a064-7b2b92b7d6db';

// Serves vehicle.html like the static-assets binding does for '/vehicle'.
const ASSETS = { fetch: async req => (new URL(req.url).pathname === '/vehicle'
  ? new Response(HTML, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', ETag: '"shell"' } })
  : new Response('not found', { status: 404 })) };

async function setup() {
  const d1 = createTestD1(); seedUser(d1, 'u1');
  const pub = await db.findOrCreateRobotaxiVehicleByPlate(d1, 'XVF2569');
  approveVehicle(d1, pub, { withRide: true });
  d1.prepare(`UPDATE robotaxi_vehicles SET service_area = 'Austin', vin = '5YJ3E1EA0KF000001' WHERE id = ?`).bind(pub)._exec();
  const priv = await db.findOrCreateRobotaxiVehicleByPlate(d1, 'XJR2195');   // private by default (never approved)
  return { env: { cybercabhunter_db: d1, ASSETS }, pub, priv, d1 };
}

const get = (env, path) => worker.fetch(new Request(`https://cybercabhunter.com${path}`), env, {});

async function snapshot(resp) {
  return { status: resp.status, type: resp.headers.get('Content-Type'), cache: resp.headers.get('Cache-Control'), body: await resp.text() };
}

function pngInfo(bytes) {
  const buf = Buffer.from(bytes);
  const sig = buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  let o = 8, width = 0, height = 0, crcOk = true;
  const idat = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o), type = buf.toString('latin1', o + 4, o + 8);
    const data = buf.subarray(o + 8, o + 8 + len);
    if (zlib.crc32(buf.subarray(o + 4, o + 8 + len)) !== buf.readUInt32BE(o + 8 + len)) crcOk = false;
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); }
    if (type === 'IDAT') idat.push(data);
    o += 12 + len;
  }
  let raw = null;
  try { raw = zlib.inflateSync(Buffer.concat(idat)); } catch (e) { raw = null; }   // also verifies the Adler-32 trailer
  return { sig, width, height, crcOk, raw };
}

async function run() {
  console.log('1. Card image for a public vehicle: a valid 1200x630 PNG with the plate drawn');
  {
    const { env, pub, d1 } = await setup();
    const resp = await get(env, `/api/og/vehicle/${pub}.png`);
    check('200 image/png', resp.status === 200 && resp.headers.get('Content-Type') === 'image/png');
    check('a long-lived public cache header', /public/.test(resp.headers.get('Cache-Control')) && /max-age=\d{4,}/.test(resp.headers.get('Cache-Control')));
    const png = pngInfo(new Uint8Array(await resp.arrayBuffer()));
    check('PNG signature, 1200x630', png.sig && png.width === 1200 && png.height === 630);
    check('every chunk CRC is correct', png.crcOk);
    check('the image data inflates (zlib + Adler-32 valid) to exactly 630 rows of 1 + 1200 bytes', png.raw && png.raw.length === 630 * 1201);

    // A different plate changes the plate rows, and only the band of rows
    // written per request (the rest of the card is pre-rendered).
    d1.prepare(`UPDATE robotaxi_vehicles SET license_plate = 'ABC1234' WHERE id = ?`).bind(pub)._exec();
    const other = pngInfo(new Uint8Array(await (await get(env, `/api/og/vehicle/${pub}.png`)).arrayBuffer()));
    const rowsDiffer = y => !png.raw.subarray(y * 1201, (y + 1) * 1201).equals(other.raw.subarray(y * 1201, (y + 1) * 1201));
    check('another plate renders differently in the plate rows', [260, 300, 320].some(rowsDiffer));
    check('...and identically above and below the text band', !rowsDiffer(100) && !rowsDiffer(560));
  }

  console.log('2. 404 indistinguishability: private and nonexistent vehicles look exactly like the detail route');
  {
    const { env, priv } = await setup();
    const cardPriv = await snapshot(await get(env, `/api/og/vehicle/${priv}.png`));
    const cardMissing = await snapshot(await get(env, `/api/og/vehicle/${NONEXISTENT}.png`));
    const apiPriv = await snapshot(await get(env, `/api/robotaxi-vehicles/${priv}`));
    const apiMissing = await snapshot(await get(env, `/api/robotaxi-vehicles/${NONEXISTENT}`));
    check('card: private vehicle is a 404', cardPriv.status === 404);
    check('card: private and nonexistent responses are identical (status, type, cache, body)', JSON.stringify(cardPriv) === JSON.stringify(cardMissing));
    check('card 404 is byte-identical to the vehicle detail route\'s 404', cardPriv.body === apiPriv.body && cardPriv.status === apiPriv.status && cardPriv.type === apiPriv.type);
    check('(and the detail route itself treats private = nonexistent)', JSON.stringify(apiPriv) === JSON.stringify(apiMissing));
    const cardBad = await snapshot(await get(env, '/api/og/vehicle/not-an-id.png'));
    const apiBad = await snapshot(await get(env, '/api/robotaxi-vehicles/not-an-id'));
    check('a malformed id is the same 400 as the detail route', cardBad.status === 400 && cardBad.body === apiBad.body);
  }

  console.log('3. /vehicle/:id share tags: per-vehicle for a public vehicle, generic otherwise');
  {
    const { env, pub, priv } = await setup();
    const html = await (await get(env, `/vehicle/${pub}`)).text();
    const meta = (attr, key) => (html.match(new RegExp(`<meta ${attr}="${key}" content="([^"]*)"`)) || [])[1];
    check('og:title is the plate', meta('property', 'og:title') === 'XVF2569 — Cybercab Hunter');
    check('og:description mentions the city and the ride count', /Austin, TX/.test(meta('property', 'og:description')) && /1 recorded ride\b/.test(meta('property', 'og:description')));
    check('og:image points at the card endpoint for this vehicle', new RegExp(`^https://cybercabhunter\\.com/api/og/vehicle/${pub}\\.png\\?v=\\w+$`).test(meta('property', 'og:image')));
    check('og:url is the canonical vehicle URL', meta('property', 'og:url') === `https://cybercabhunter.com/vehicle/${pub}`);
    check('Twitter summary_large_image card', meta('name', 'twitter:card') === 'summary_large_image' && meta('name', 'twitter:image') === meta('property', 'og:image'));
    check('the generic block is replaced, not duplicated', (html.match(/property="og:title"/g) || []).length === 1 && (html.match(/<title>/g) || []).length === 1);
    check('the rest of the page is untouched', html.includes('id="vehicleLoaded"') && html.includes('js/vehicle.js'));
    const imgPath = new URL(meta('property', 'og:image')).pathname;
    check('the og:image URL resolves to the PNG', (await get(env, imgPath)).status === 200);

    const privHtml = await (await get(env, `/vehicle/${priv}`)).text();
    const missingHtml = await (await get(env, `/vehicle/${NONEXISTENT}`)).text();
    check('private vehicle: the page is served byte-identical to a nonexistent one', privHtml === missingHtml);
    check('...which is the unmodified generic shell (no plate anywhere)', privHtml === HTML && !privHtml.includes('XJR2195'));
    const noDb = await worker.fetch(new Request(`https://cybercabhunter.com/vehicle/${pub}`), { ASSETS }, {});
    check('a failing lookup still serves the page (generic tags)', noDb.status === 200 && (await noDb.text()) === HTML);
  }

  console.log('4. Share button (js/vehicle.js in jsdom)');
  {
    const { env, pub } = await setup();
    async function openPage({ nativeShare }) {
      const dom = new JSDOM(HTML, { runScripts: 'outside-only', url: `https://cybercabhunter.com/vehicle/${pub}?ref=abc#x`, pretendToBeVisual: true });
      const w = dom.window;
      w.fetch = async fetchUrl => worker.fetch(new Request(`https://x${String(fetchUrl).replace(/^https:\/\/[^/]+/, '')}`), env, {});
      const shared = [], copied = [];
      Object.defineProperty(w.navigator, 'share', { configurable: true, value: nativeShare ? async data => { shared.push(data); } : undefined });
      Object.defineProperty(w.navigator, 'clipboard', { configurable: true, value: { writeText: async s => { copied.push(s); } } });
      w.eval(JS);
      const d = w.document;
      const end = Date.now() + 3000;
      while (Date.now() < end && d.getElementById('vehicleLoaded').classList.contains('hidden')) await new Promise(r => setTimeout(r, 10));
      const click = el => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
      return { w, d, shared, copied, click };
    }
    const canonical = `https://cybercabhunter.com/vehicle/${pub}`;

    const mobile = await openPage({ nativeShare: true });
    mobile.click(mobile.d.getElementById('vShareBtn'));
    await new Promise(r => setTimeout(r, 20));
    check('with the Web Share API: the native share sheet gets the canonical URL', mobile.shared.length === 1 && mobile.shared[0].url === canonical);
    check('...and the "I spotted" text', mobile.shared[0].text === 'I spotted XVF2569 — a Tesla Cybercab in Austin, TX');
    check('...and the fallback menu stays closed', mobile.d.getElementById('vShareMenu').classList.contains('hidden'));

    const desktop = await openPage({ nativeShare: false });
    const btn = desktop.d.getElementById('vShareBtn');
    desktop.click(btn);
    check('without it: the fallback menu opens (aria-expanded true)', !desktop.d.getElementById('vShareMenu').classList.contains('hidden') && btn.getAttribute('aria-expanded') === 'true');
    const x = new URL(desktop.d.getElementById('vShareX').href), fb = new URL(desktop.d.getElementById('vShareFacebook').href);
    check('X intent link carries the text and canonical URL', x.hostname === 'twitter.com' && x.searchParams.get('url') === canonical && /I spotted XVF2569/.test(x.searchParams.get('text')));
    check('Facebook share link carries the canonical URL', fb.hostname === 'www.facebook.com' && fb.searchParams.get('u') === canonical);
    desktop.click(desktop.d.getElementById('vShareCopy'));
    await new Promise(r => setTimeout(r, 20));
    check('Copy link copies the canonical URL (no ?ref / #fragment) and closes the menu', desktop.copied[0] === canonical && desktop.d.getElementById('vShareMenu').classList.contains('hidden'));
    desktop.click(btn);
    desktop.w.document.dispatchEvent(new desktop.w.KeyboardEvent('keydown', { key: 'Escape' }));
    check('Escape closes the menu', desktop.d.getElementById('vShareMenu').classList.contains('hidden'));
  }

  t.finish();
}

run().catch(err => { console.error(err); process.exit(1); });
