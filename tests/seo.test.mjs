// Tests for search-engine support: /sitemap.xml (worker/sitemap.js), robots.txt,
// the canonical / Open Graph / Twitter / JSON-LD tags on public pages, noindex
// on internal pages, and the per-vehicle tags js/vehicle.js sets.
// Run: node tests/seo.test.mjs

import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { createTestD1, seedUser } from './helpers/d1-sqlite.mjs';
import { seedRide, approveVehicle, makeCheck } from './helpers/env.mjs';
import { SITEMAP_PAGES } from '../worker/sitemap.js';
import worker from '../worker/index.js';

const t = makeCheck();
const { check } = t;
const ROOT = new URL('..', import.meta.url).pathname;
const read = f => fs.readFileSync(`${ROOT}public/${f}`, 'utf8');
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const head = html => html.slice(html.indexOf('<head>'), html.indexOf('</head>'));
const metaContent = (html, attr, key) => { const m = head(html).match(new RegExp(`<meta ${attr}="${key}" content="([^"]*)">`)); return m ? m[1] : null; };

const PUBLIC = { 'index.html': '/', 'sightings.html': '/sightings', 'vehicles.html': '/vehicles', 'news.html': '/news', 'community.html': '/community',
  'infrastructure.html': '/infrastructure', 'simulation.html': '/simulation', 'replay.html': '/replay', 'dmv.html': '/dmv', 'privacy.html': '/privacy' };
const INTERNAL = ['moderation.html', 'moderation/import-receipt.html', 'signin.html', 'profile.html', 'rider-data.html', 'link-gmail.html'];

// A Cache API stand-in, so the second request can be served without D1.
function fakeCache() {
  const store = new Map();
  return { store, match: async req => (store.has(req.url) ? store.get(req.url).clone() : undefined), put: async (req, res) => { store.set(req.url, res); } };
}

async function run() {
  console.log('1. /sitemap.xml: the public pages and every public registry vehicle, from one query');
  {
    const d1 = createTestD1();
    seedUser(d1, 'u1');
    const ins = (n, plate, extra = '') => d1.prepare(`INSERT INTO robotaxi_vehicles (id, license_plate, first_seen_at, last_seen_at${extra ? ', origin, approval_basis, approval_basis_set_at' : ''}) VALUES (?, ?, '2026-08-01', '2026-09-01'${extra ? ', ?, ?, ?' : ''})`)
      .bind(uuid(n), plate, ...(extra ? extra : []))._exec();
    ins(1, 'PUB1');
    approveVehicle(d1, uuid(1), { withRide: true, userId: 'u1' });                 // public, a counted ride
    ins(2, 'PUB2', ['sighting', 'manual', '2026-09-20 12:00:00']);
    approveVehicle(d1, uuid(2));                                                      // public, sighting-approved
    ins(3, 'PRIV');
    d1.prepare(`UPDATE robotaxi_vehicles SET visibility = 'private' WHERE id = ?`).bind(uuid(3))._exec();
    seedRide(d1, { userId: 'u1', vehicleId: uuid(3), status: 'pending' });          // private, though it has a ride
    ins(4, 'NOEV');
    approveVehicle(d1, uuid(4));                                                      // public but no evidence

    let queries = 0;
    const prepare = d1.prepare.bind(d1);
    const env = { cybercabhunter_db: { ...d1, prepare: (...a) => { queries++; return prepare(...a); } } };
    const cache = fakeCache();
    globalThis.caches = { default: cache };
    const waits = [];
    const ctx = { waitUntil: p => waits.push(p) };

    const r = await worker.fetch(new Request('https://cybercabhunter.com/sitemap.xml?bust=1'), env, ctx);
    await Promise.all(waits);
    const xml = await r.text();
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
    check('200 with an XML content type', r.status === 200 && /application\/xml/.test(r.headers.get('Content-Type')));
    check('well-formed XML (parses, one urlset in the sitemap namespace)', (() => {
      const doc = new JSDOM(xml, { contentType: 'application/xml' }).window.document;
      return !doc.querySelector('parsererror') && doc.documentElement.localName === 'urlset' && doc.documentElement.namespaceURI === 'http://www.sitemaps.org/schemas/sitemap/0.9';
    })());
    check('every public page is listed, with an absolute https URL', SITEMAP_PAGES.every(p => locs.includes('https://cybercabhunter.com' + p)));
    check('no internal page is listed', !locs.some(l => /signin|profile|rider-data|moderation|link-gmail/.test(l)));
    check('public vehicles are listed as /vehicle/<id>', locs.includes(`https://cybercabhunter.com/vehicle/${uuid(1)}`) && locs.includes(`https://cybercabhunter.com/vehicle/${uuid(2)}`));
    check('private and evidence-less vehicles are not', !xml.includes(uuid(3)) && !xml.includes(uuid(4)));
    check('a vehicle\'s lastmod is its approval date when known', xml.includes(`/vehicle/${uuid(2)}</loc><lastmod>2026-09-20</lastmod>`));
    check('every entry is daily', (xml.match(/<changefreq>daily<\/changefreq>/g) || []).length === locs.length);
    check('exactly one D1 query to build it', queries === 1);
    check('no plate or other vehicle detail is in the sitemap', !/PUB1|PUB2/.test(xml));

    const again = await worker.fetch(new Request('https://cybercabhunter.com/sitemap.xml?other=2'), env, ctx);
    check('a second request (any query string) is served from the cache: no more D1 reads', (await again.text()) === xml && queries === 1);
    check('cached for a day', /max-age=86400/.test(r.headers.get('Cache-Control')));
    delete globalThis.caches;
  }

  console.log('2. robots.txt');
  {
    const robots = read('robots.txt');
    check('allows everything and points at the sitemap', /^User-agent: \*$/m.test(robots) && /^Allow: \/$/m.test(robots) && /^Sitemap: https:\/\/cybercabhunter\.com\/sitemap\.xml$/m.test(robots));
    check('keeps the owner\'s content-signals block (Cloudflare does not add it once the site serves its own file)', robots.startsWith('# As a condition of accessing this website') && robots.includes('ARTICLE 4 OF THE EUROPEAN UNION DIRECTIVE 2019/790'));
    check('blocks nothing (internal pages rely on noindex, which crawlers must be able to read)', !/Disallow/.test(robots));
  }

  console.log('3. Public pages: canonical, Open Graph, Twitter and JSON-LD; the tab title stays "Cybercab Hunter"');
  for (const [file, path] of Object.entries(PUBLIC)) {
    const html = read(file);
    const url = 'https://cybercabhunter.com' + path;
    const h = head(html);
    const ld = (h.match(/<script type="application\/ld\+json">([^<]*)<\/script>/g) || []);
    let graph = null;
    try { graph = JSON.parse(ld[0].replace(/<[^>]+>/g, ''))['@graph']; } catch (e) { graph = null; }
    const desc = metaContent(html, 'name', 'description');
    const ogTitle = metaContent(html, 'property', 'og:title');
    check(`${file}: tab title "Cybercab Hunter", canonical ${url}`, /<title>Cybercab Hunter<\/title>/.test(h) && h.includes(`<link rel="canonical" href="${url}">`));
    check(`${file}: og:url = canonical; og:image and twitter:image absolute https`, metaContent(html, 'property', 'og:url') === url
      && /^https:\/\/cybercabhunter\.com\/images\//.test(metaContent(html, 'property', 'og:image')) && metaContent(html, 'name', 'twitter:image') === metaContent(html, 'property', 'og:image'));
    check(`${file}: og:type website, site name, large Twitter card, matching titles/descriptions`, metaContent(html, 'property', 'og:type') === 'website'
      && metaContent(html, 'property', 'og:site_name') === 'Cybercab Hunter' && metaContent(html, 'name', 'twitter:card') === 'summary_large_image'
      && metaContent(html, 'name', 'twitter:title') === ogTitle && metaContent(html, 'property', 'og:description') === desc && metaContent(html, 'name', 'twitter:description') === desc);
    check(`${file}: share title ≤ 60 and description ≤ 160 characters`, ogTitle && ogTitle.replace(/&amp;/g, '&').length <= 60 && desc && desc.length <= 160);
    check(`${file}: one JSON-LD block (Organization + WebSite) that parses`, ld.length === 1 && graph && graph.some(n => n['@type'] === 'Organization') && graph.some(n => n['@type'] === 'WebSite'));
    check(`${file}: indexable (no robots noindex), each tag once`, !/name="robots"/.test(h) && (h.match(/rel="canonical"/g) || []).length === 1 && (h.match(/property="og:title"/g) || []).length === 1);
  }
  {
    const h = head(read('vehicle.html'));
    check('vehicle.html (serves every /vehicle/:id) has no static canonical or og:url; the script sets them', !/rel="canonical"/.test(h) && !/og:url/.test(h) && /og:title/.test(h));
  }

  console.log('4. Internal pages: noindex, nofollow');
  for (const file of INTERNAL) {
    const h = head(read(file));
    check(`${file}: noindex, nofollow and no canonical`, h.includes('<meta name="robots" content="noindex, nofollow">') && !/rel="canonical"/.test(h));
  }

  console.log('5. A vehicle page sets its own search tags from the record');
  {
    const d1 = createTestD1();
    seedUser(d1, 'u1');
    d1.prepare(`INSERT INTO robotaxi_vehicles (id, license_plate, color, vin, service_area, origin, approval_basis, first_seen_at, last_seen_at) VALUES (?, 'CYB 123', 'Gold', '7SAXCBE5XRF000001', 'Austin', 'sighting', 'vin-verified', '2026-08-01', '2026-09-01')`).bind(uuid(10))._exec();
    approveVehicle(d1, uuid(10));
    d1.prepare(`INSERT INTO robotaxi_vehicles (id, license_plate, first_seen_at, last_seen_at) VALUES (?, 'MY 999', '2026-08-01', '2026-09-01')`).bind(uuid(11))._exec();
    approveVehicle(d1, uuid(11), { withRide: true, userId: 'u1' });
    const env = { cybercabhunter_db: d1 };
    const open = async id => {
      const dom = new JSDOM(read('vehicle.html'), { runScripts: 'outside-only', url: `https://cybercabhunter.com/vehicle/${id}`, pretendToBeVisual: true });
      const w = dom.window;
      w.fetch = async u => worker.fetch(new Request('https://x' + String(u).replace(/^https?:\/\/[^/]+/, '')), env, {});
      w.eval(read('js/vehicle.js'));
      const end = Date.now() + 3000;
      while (Date.now() < end && w.document.getElementById('vehicleLoaded').classList.contains('hidden')) await new Promise(r => setTimeout(r, 10));
      return w.document;
    };
    const d = await open(uuid(10));
    const m = (attr, key) => d.head.querySelector(`meta[${attr}="${key}"]`).getAttribute('content');
    const url = `https://cybercabhunter.com/vehicle/${uuid(10)}`;
    check('canonical and og:url are this vehicle\'s URL', d.head.querySelector('link[rel="canonical"]').href === url && m('property', 'og:url') === url);
    check('title: "Cybercab <plate> | Tesla Cybercab Registry" (og and twitter); the tab stays "Cybercab Hunter"',
      m('property', 'og:title') === 'Cybercab CYB 123 | Tesla Cybercab Registry' && m('name', 'twitter:title') === m('property', 'og:title') && d.title === 'Cybercab Hunter');
    check('description names the plate, VIN and city, under 160 characters', m('name', 'description') === 'Tesla Cybercab CYB 123 (VIN 7SAXCBE5XRF000001) operating in Austin: rides, sightings and details on Cybercab Hunter.'
      && m('name', 'description').length <= 160 && m('property', 'og:description') === m('name', 'description'));
    const graph = JSON.parse(d.head.querySelector('script[type="application/ld+json"]').textContent)['@graph'];
    const car = graph.find(n => n['@type'] === 'Car');
    check('JSON-LD gains a Car: Tesla Cybercab, its VIN and colour, still one block', car && car.model === 'Cybercab' && car.manufacturer.name === 'Tesla'
      && car.vehicleIdentificationNumber === '7SAXCBE5XRF000001' && car.color === 'Gold' && d.head.querySelectorAll('script[type="application/ld+json"]').length === 1);

    const d2 = await open(uuid(11));
    const graph2 = JSON.parse(d2.head.querySelector('script[type="application/ld+json"]').textContent)['@graph'];
    check('a vehicle not approved as a Cybercab is a "Robotaxi", with no Car data and no invented VIN or colour (its city is where its rides were, as the page shows)',
      !graph2.some(n => n['@type'] === 'Car') && d2.head.querySelector('meta[name="description"]').getAttribute('content') === 'Tesla Robotaxi MY 999 operating in Dallas: rides, sightings and details on Cybercab Hunter.');
  }

  console.log('6. Headings');
  for (const file of Object.keys(PUBLIC)) {
    // simulation.html: one <h1> per view (Fleet ROI / Fleet ETA); only one view shows.
    check(`${file}: exactly one <h1>`, (read(file).match(/<h1[\s>]/g) || []).length === (file === 'simulation.html' ? 2 : 1));
  }

  t.finish();
}
run().catch(err => { console.error(err); process.exit(1); });
