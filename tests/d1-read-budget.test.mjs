// D1 read budget (Nov 2026): the rewritten public-sightings queries, the
// homepage summary, the moderation lookup and Daily's sightings count must
// return EXACTLY what the previous SQL returned on the same data; the hot
// queries must use migration 0055's indexes (no full scan of submissions);
// the edge cache must only ever store public, cookie-free 200s; and 0055 is
// indexes only.
// Real SQL (every migration, node:sqlite). The "reference" queries below are
// the pre-optimization SQL verbatim (main at 09df444), kept here as the oracle.
// Run: node tests/d1-read-budget.test.mjs

import { readFileSync } from 'node:fs';
import { createTestD1 } from './helpers/d1-sqlite.mjs';
import { makeCheck } from './helpers/env.mjs';
import { db, PUBLIC_PHOTO_SIGHTING_SQL, PUBLIC_SIGHTINGS_FROM } from '../worker/db.js';
import { buildDaily, USER_SIGHTING_SQL } from '../worker/daily.js';
import { publicVehicleEligibleSql } from '../worker/ride-status.js';
import { edgeCached } from '../worker/edge-cache.js';

const t = makeCheck();
const { check } = t;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const ago = hours => new Date(Date.now() - hours * 3600e3).toISOString().replace('T', ' ').slice(0, 19);

// ---- seed: every spelling of a city the old filter had to handle ----
function seed(d1) {
  const run = (sql, ...b) => d1.prepare(sql).bind(...b)._exec();
  for (let i = 1; i <= 6; i++) run(`INSERT INTO users (id, display_name, profile_visibility) VALUES (?, ?, 'public')`, `u${i}`, `U${i}`);
  // vehicles: public (eligible by a sighting VIN), private, and public-but-ineligible
  run(`INSERT INTO robotaxi_vehicles (id, provider, license_plate, model, service_area, visibility, origin, vin, approval_basis) VALUES ('v-pub', 'tesla', 'PUB1', 'Cybercab', 'Austin', 'public', 'sighting', '7SAYGDEF000001', 'manual')`);
  run(`INSERT INTO robotaxi_vehicles (id, provider, license_plate, model, service_area, visibility, origin) VALUES ('v-priv', 'tesla', 'PRIV1', 'Model Y', 'Austin', 'private', 'sighting')`);
  run(`INSERT INTO robotaxi_vehicles (id, provider, license_plate, model, service_area, visibility, origin) VALUES ('v-inel', 'tesla', 'INEL1', 'Model Y', 'Austin', 'public', 'sighting')`);
  const areas = ['Austin', ' austin ', 'AUSTIN', 'Austin, TX', 'austin,tx', 'Austin-Bergstrom', 'Austinville', 'Austin TX', 'Dallas', 'Dallas, TX', 'dallas ', 'Houston', '', null];
  const vehicles = [null, null, 'v-pub', 'v-priv', 'v-inel'];
  let n = 0;
  for (let k = 0; k < 6; k++) {
    for (const area of areas) {
      n++;
      const id = `s${n}`, hours = (n * 11.3) % (34 * 24);          // spread over 34 days (some past the 30-day window)
      const status = n % 11 === 0 ? 'rejected' : n % 7 === 0 ? 'pending' : 'approved';
      const photo = n % 13 !== 0;
      const ref = photo && n % 17 !== 0 ? `sightings/${id}.jpg` : null;   // some photos already deleted
      const camera = n % 9 === 0 ? `cam${n % 3}` : null;
      const observed = ago(hours + 0.02);
      run(`INSERT INTO submissions (id, user_id, submission_type, status, evidence_type, evidence_ref, submitted_at, reviewed_at) VALUES (?, ?, 'vehicle_sighting', ?, ?, ?, ?, ?)`,
        id, `u${1 + (n % 6)}`, status, photo ? 'photo' : 'text', ref, ago(hours), status === 'pending' ? null : ago(Math.max(0, hours - 0.5)));
      run(`INSERT INTO vehicle_observations (id, robotaxi_vehicle_id, user_id, submission_id, observed_at, service_area, approx_location, license_plate, evidence_ref, public_id, camera_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        `o${n}`, vehicles[n % vehicles.length], `u${1 + (n % 6)}`, id, observed, area, n % 4 ? `Spot ${n % 5}, Austin` : '', `XVF${n}`, ref,
        status === 'approved' && photo && n % 19 !== 0 ? n.toString(16).padStart(32, '0') : null, camera);
      if (camera && n % 2) run(`INSERT INTO camera_detections (id, camera_id, camera_name, lat, lng, observed_at, city) VALUES (?, ?, 'C', 30.2, -97.7, ?, 'austin')`, `d-time-${n}`, camera, observed.replace(' ', 'T') + 'Z');
      if (camera && n % 3 === 0) run(`INSERT INTO camera_detections (id, camera_id, camera_name, lat, lng, observed_at, city, source_submission_id) VALUES (?, 'camX', 'C', 30.2, -97.7, ?, 'austin', ?)`, `d-src-${n}`, ago(hours - 1).replace(' ', 'T') + 'Z', id);
    }
  }
  // two rows at the exact same moment (the keyset tie-break on public_id)
  run(`UPDATE vehicle_observations SET observed_at = (SELECT observed_at FROM vehicle_observations WHERE id = 'o1') WHERE id IN ('o2', 'o3')`);
}

// ---- the pre-optimization SQL (reference) ----
const OLD_FROM = 'submissions s JOIN vehicle_observations o ON o.submission_id = s.id';
const oldCity = city => city ? { sql: ` AND (lower(trim(o.service_area)) = ? OR lower(trim(o.service_area)) LIKE ?)`, binds: [city, `${city},%`] } : { sql: '', binds: [] };
const ref = {
  async feed(sql, { city = null, limit, after = null, order = 'desc' }) {
    const f = oldCity(city), dir = order === 'asc' ? 'ASC' : 'DESC', cmp = order === 'asc' ? '>' : '<';
    const cur = after ? ` AND (o.observed_at ${cmp} ? OR (o.observed_at = ? AND o.public_id ${cmp} ?))` : '';
    const binds = [...f.binds, ...(after ? [after.observedAt, after.observedAt, after.publicId] : []), limit];
    return (await sql.prepare(`SELECT o.public_id, o.service_area, o.approx_location, o.observed_at, pv.license_plate AS public_plate, (pv.approval_basis IS NOT NULL) AS public_cybercab
      FROM ${OLD_FROM} LEFT JOIN robotaxi_vehicles pv ON pv.id = o.robotaxi_vehicle_id AND ${publicVehicleEligibleSql('pv')}
      WHERE ${PUBLIC_PHOTO_SIGHTING_SQL}${f.sql}${cur} ORDER BY o.observed_at ${dir}, o.public_id ${dir} LIMIT ?`).bind(...binds).all()).results;
  },
  async buckets(sql, city) {
    const f = oldCity(city);
    return (await sql.prepare(`SELECT substr(o.observed_at, 1, 13) AS utc_hour, COUNT(*) AS n, SUM(o.observed_at > datetime('now', '-7 days')) AS last_7_days
      FROM ${OLD_FROM} WHERE ${PUBLIC_PHOTO_SIGHTING_SQL}${f.sql} GROUP BY utc_hour`).bind(...f.binds).all()).results;
  },
  async count(sql, city, sinceHours = null) {
    const f = oldCity(city), since = sinceHours ? ` AND o.observed_at > datetime('now', '-${sinceHours} hours')` : '';
    return (await sql.prepare(`SELECT COUNT(*) AS n FROM ${OLD_FROM} WHERE ${PUBLIC_PHOTO_SIGHTING_SQL}${f.sql}${since}`).bind(...f.binds).first()).n;
  },
  async spots(sql, city, limit) {
    const f = oldCity(city);
    return (await sql.prepare(`SELECT o.approx_location AS location, COUNT(*) AS n FROM ${OLD_FROM}
      WHERE ${PUBLIC_PHOTO_SIGHTING_SQL}${f.sql} AND trim(COALESCE(o.approx_location, '')) <> ''
      GROUP BY o.approx_location ORDER BY n DESC, location LIMIT ?`).bind(...f.binds, limit).all()).results;
  },
  async moderation(sql, limit) {
    const rows = (await sql.prepare(`SELECT s.id AS submission_id, s.reviewed_at, o.observed_at, o.service_area, o.approx_location, o.license_plate, o.camera_id,
           (SELECT MAX(d.observed_at) FROM camera_detections d WHERE d.source_submission_id = s.id
                   OR (d.camera_id = o.camera_id AND d.observed_at = replace(o.observed_at, ' ', 'T') || 'Z')) AS map_observed_at
      FROM submissions s JOIN vehicle_observations o ON o.submission_id = s.id
      WHERE s.submission_type = 'vehicle_sighting' AND s.status = 'approved' AND s.evidence_type = 'photo' AND s.evidence_ref IS NOT NULL
      ORDER BY s.reviewed_at DESC, s.id DESC LIMIT ?`).bind(limit).all()).results;
    return rows.map(r => ({ ...r, on_map: r.map_observed_at !== null }));
  },
  async expired(sql, limit) {
    return (await sql.prepare(`SELECT id AS submission_id, evidence_ref FROM submissions
      WHERE submission_type = 'vehicle_sighting' AND evidence_type = 'photo' AND evidence_ref IS NOT NULL
        AND submitted_at <= datetime('now', '-30 days') ORDER BY submitted_at ASC LIMIT ?`).bind(limit).all()).results;
  },
  async dailySightings(sql, b) {
    return sql.prepare(`SELECT MIN(o.observed_at) AS first, COALESCE(SUM(o.observed_at >= ? AND o.observed_at < ?), 0) AS previous,
        COALESCE(SUM(o.observed_at >= ? AND o.observed_at < ?), 0) AS today
      FROM ${OLD_FROM} LEFT JOIN robotaxi_vehicles pv ON pv.id = o.robotaxi_vehicle_id AND ${publicVehicleEligibleSql('pv')}
      WHERE ${PUBLIC_PHOTO_SIGHTING_SQL} AND (o.robotaxi_vehicle_id IS NULL OR pv.id IS NOT NULL) AND ${USER_SIGHTING_SQL}`).bind(...b).first();
  }
};

async function run() {
  const d1 = createTestD1();
  seed(d1);
  d1.exec('ANALYZE');
  const cities = [null, 'austin', 'dallas', 'houston'];

  console.log('City filter: = city or "city,…" (range instead of LIKE) — same rows');
  const variants = d1.query(`SELECT DISTINCT service_area AS a FROM vehicle_observations`).map(r => r.a);
  for (const city of ['austin', 'dallas']) {
    const oldMatch = variants.filter(a => a !== null && d1.query(`SELECT (lower(trim(?)) = ? OR lower(trim(?)) LIKE ?) AS m`, a, city, a, `${city},%`)[0].m === 1);
    const newMatch = variants.filter(a => a !== null && d1.query(`SELECT (lower(trim(?)) = ? OR (lower(trim(?)) >= ? AND lower(trim(?)) < ?)) AS m`, a, city, a, `${city},`, a, `${city}-`)[0].m === 1);
    check(`${city}: matches ${JSON.stringify(newMatch)} — same as LIKE`, same(oldMatch.sort(), newMatch.sort()) && newMatch.length >= 2);
  }

  console.log('\nGallery feed (every city, both orders, every page) — identical to the old SQL');
  for (const city of cities) for (const order of ['desc', 'asc']) {
    let after = null, pages = 0, all = true, total = 0;
    for (;;) {
      const [a, b] = [await ref.feed(d1, { city, limit: 7, after, order }), await db.getPublicPhotoSightings(d1, { city, limit: 7, after, order })];
      if (!same(a, b)) all = false;
      total += b.length; pages++;
      if (b.length < 7) break;
      after = { observedAt: b[6].observed_at, publicId: b[6].public_id };
    }
    check(`${city || 'all'} ${order}: ${pages} pages, ${total} sightings, same rows in the same order`, all && total > 0);
  }

  console.log('\nCounts, hour buckets, top spots — identical to the old SQL');
  for (const city of cities) {
    check(`${city || 'all'}: count`, (await ref.count(d1, city)) === (await db.countPublicPhotoSightings(d1, { city })));
    for (const h of [24, 48, 168, 336]) check(`${city || 'all'}: count, last ${h}h`, (await ref.count(d1, city, h)) === (await db.countPublicPhotoSightings(d1, { city, sinceHours: h })));
    check(`${city || 'all'}: hour buckets`, same(await ref.buckets(d1, city), await db.getApprovedPhotoSightingHourBuckets(d1, { city })));
    check(`${city || 'all'}: top spots`, same(await ref.spots(d1, city, 20), await db.getPublicPhotoSightingSpots(d1, { city, limit: 20 })));
  }

  console.log('\nHomepage summary (one pass) = the five separate counts + the buckets it replaced');
  for (const city of cities) {
    const s = await db.getPublicPhotoSightingSummary(d1, { city });
    const want = { buckets: await ref.buckets(d1, city), total: await ref.count(d1, city), last24: await ref.count(d1, city, 24), last48: await ref.count(d1, city, 48), last168: await ref.count(d1, city, 168), last336: await ref.count(d1, city, 336) };
    check(`${city || 'all'}: total ${s.total}, 24h ${s.last24}, 48h ${s.last48}, 7d ${s.last168}, 14d ${s.last336}, ${s.buckets.length} buckets`, same(s, want) && s.total > 0);
  }

  console.log('\nModeration, photo cleanup, Daily — identical to the old SQL');
  const mod = await db.getRecentApprovedPhotoSightings(d1, 500);
  check(`moderation list (${mod.length} rows, ${mod.filter(r => r.on_map).length} on the map) — same rows, same map links`, same(await ref.moderation(d1, 500), mod) && mod.some(r => r.on_map) && mod.some(r => !r.on_map));
  const exp = await db.listExpiredSightingPhotos(d1, 500);
  check(`expired photos (${exp.length}) — same rows, same order`, same(await ref.expired(d1, 500), exp) && exp.length > 0);
  const daily = await buildDaily(d1);
  const wantDaily = await (async () => {
    // the same bounds buildDaily uses (local midnights in America/Chicago)
    const { usLocalParts } = await import('../worker/timezones.js');
    const midnight = date => { const ms = Date.parse(date + 'T00:00:00Z'); return new Date(ms - usLocalParts(ms + 6 * 3600e3, 'America/Chicago').offset * 3600e3).toISOString(); };
    const shift = (date, d) => new Date(Date.parse(date + 'T12:00:00Z') + d * 864e5).toISOString().slice(0, 10);
    const b = [midnight(daily.previous.date), midnight(daily.today), midnight(shift(daily.today, 1))].map(v => v.slice(0, 19).replace('T', ' '));
    return ref.dailySightings(d1, [b[0], b[1], b[1], b[2]]);
  })();
  check(`Daily sightings: today ${daily.day.sightings}, yesterday ${daily.previous.sightings} — same as the old SQL`, daily.day.sightings === wantDaily.today && daily.previous.sightings === wantDaily.previous && !daily.errors.sightings);

  console.log('\nQuery plans: the hot queries use 0055 and never scan every submission');
  const plan = (q, ...b) => d1.query(`EXPLAIN QUERY PLAN ${q}`, ...b).map(r => r.detail).join(' | ');
  const pub = `SELECT o.public_id FROM ${PUBLIC_SIGHTINGS_FROM} WHERE ${PUBLIC_PHOTO_SIGHTING_SQL}`;
  for (const [label, q, b] of [
    ['count', `SELECT COUNT(*) FROM ${PUBLIC_SIGHTINGS_FROM} WHERE ${PUBLIC_PHOTO_SIGHTING_SQL}`, []],
    ['hour buckets, one city', `SELECT substr(o.observed_at, 1, 13) h, COUNT(*) FROM ${PUBLIC_SIGHTINGS_FROM} WHERE ${PUBLIC_PHOTO_SIGHTING_SQL} AND (lower(trim(o.service_area)) = ? OR (lower(trim(o.service_area)) >= ? AND lower(trim(o.service_area)) < ?)) GROUP BY h`, ['austin', 'austin,', 'austin-']]
  ]) {
    const p = plan(q, ...b);
    check(`${label}: ${p}`, /idx_vehicle_observations_public_time/.test(p) && !/SCAN s\b/.test(p));
  }
  const feedAll = plan(`${pub} ORDER BY o.observed_at DESC, o.public_id DESC LIMIT 25`);
  check(`feed, all cities: ${feedAll}`, /idx_vehicle_observations_public_time/.test(feedAll) && !/SCAN s\b/.test(feedAll) && !/TEMP B-TREE FOR ORDER BY/.test(feedAll));
  const feedCity = plan(`${pub} AND (lower(trim(o.service_area)) = ? OR (lower(trim(o.service_area)) >= ? AND lower(trim(o.service_area)) < ?)) ORDER BY o.observed_at DESC, o.public_id DESC LIMIT 25`, 'austin', 'austin,', 'austin-');
  check(`feed, one city: ${feedCity}`, /idx_vehicle_observations_public_time/.test(feedCity) && !/SCAN s\b/.test(feedCity) && !/TEMP B-TREE FOR ORDER BY/.test(feedCity));
  const expPlan = plan(`SELECT id FROM submissions WHERE submission_type = 'vehicle_sighting' AND evidence_type = 'photo' AND evidence_ref IS NOT NULL AND submitted_at <= datetime('now', '-30 days') ORDER BY submitted_at ASC LIMIT 25`);
  check(`photo cleanup: ${expPlan}`, /idx_submissions_photo_retention/.test(expPlan));
  const MOD = `SELECT s.id FROM submissions s JOIN vehicle_observations o ON o.submission_id = s.id WHERE s.submission_type = 'vehicle_sighting' AND s.status = 'approved' AND s.evidence_type = 'photo' AND s.evidence_ref IS NOT NULL ORDER BY s.reviewed_at DESC, s.id DESC LIMIT 50`;
  const modPlan = plan(MOD);
  check(`moderation list: ${modPlan}`, /idx_submissions_approved_photo_review/.test(modPlan) && !/TEMP B-TREE FOR ORDER BY/.test(modPlan));
  // The same choices without ANALYZE statistics (production's are unknown).
  const bare = createTestD1();
  seed(bare);
  const barePlan = q => bare.query(`EXPLAIN QUERY PLAN ${q}`).map(r => r.detail).join(' | ');
  const bareFeed = barePlan(`SELECT o.public_id FROM ${PUBLIC_SIGHTINGS_FROM} WHERE ${PUBLIC_PHOTO_SIGHTING_SQL} ORDER BY o.observed_at DESC, o.public_id DESC LIMIT 25`);
  const bareCount = barePlan(`SELECT COUNT(*) FROM ${PUBLIC_SIGHTINGS_FROM} WHERE ${PUBLIC_PHOTO_SIGHTING_SQL}`);
  const bareMod = barePlan(MOD);
  check('without ANALYZE: feed and count use the 30-day index, moderation its review index',
    /idx_vehicle_observations_public_time/.test(bareFeed) && /idx_vehicle_observations_public_time/.test(bareCount)
      && /idx_submissions_approved_photo_review/.test(bareMod) && !/TEMP B-TREE FOR ORDER BY/.test(bareFeed + bareMod));

  console.log('\nWithout migration 0055 (code deployed first): same results, no errors');
  {
    const old = createTestD1({ migrateThrough: '0054_zz' });
    seed(old);
    const noIdx = old.query(`SELECT name FROM sqlite_master WHERE name IN ('idx_vehicle_observations_public_time', 'idx_submissions_photo_retention')`).length === 0;
    let ok = noIdx;
    for (const city of cities) {
      ok = ok && same(await ref.feed(old, { city, limit: 500 }), await db.getPublicPhotoSightings(old, { city, limit: 500 }))
        && same(await ref.buckets(old, city), await db.getApprovedPhotoSightingHourBuckets(old, { city }))
        && (await ref.count(old, city)) === (await db.countPublicPhotoSightings(old, { city }));
    }
    ok = ok && same(await ref.expired(old, 500), await db.listExpiredSightingPhotos(old, 500)) && !(await buildDaily(old)).errors.sightings;
    check('feed, buckets, counts, cleanup and Daily on a pre-0055 database', ok);
  }

  console.log('\nEdge cache: only public, cookie-free 200s; one compute per URL');
  const store = new Map();
  globalThis.caches = { default: { match: async k => store.get(k.url)?.clone() || null, put: async (k, r) => { store.set(k.url, r); } } };
  const ctx = { pending: [], waitUntil(p) { this.pending.push(p); } };
  let computed = 0;
  const reply = (body, headers, status = 200) => () => { computed++; return new Response(body, { status, headers }); };
  const get = (u, init) => new Request(`https://cybercabhunter.com${u}`, init);
  await edgeCached(get('/api/robotaxi-vehicles?limit=24'), ctx, reply('A', { 'Cache-Control': 'public, max-age=60' }));
  await Promise.all(ctx.pending);
  const hit = await edgeCached(get('/api/robotaxi-vehicles?limit=24'), ctx, reply('B', { 'Cache-Control': 'public, max-age=60' }));
  check('public 200 is stored and served again without recomputing', computed === 1 && (await hit.text()) === 'A');
  await edgeCached(get('/api/robotaxi-vehicles?limit=48'), ctx, reply('C', { 'Cache-Control': 'public, max-age=60' }));
  check('a different query string is a different entry', computed === 2);
  for (const [label, headers, status, init] of [
    ['private', { 'Cache-Control': 'private, max-age=60' }, 200],
    ['no-store', { 'Cache-Control': 'no-store' }, 200],
    ['no Cache-Control', {}, 200],
    ['public without max-age', { 'Cache-Control': 'public' }, 200],
    ['Set-Cookie', { 'Cache-Control': 'public, max-age=60', 'Set-Cookie': 'a=b' }, 200],
    ['a 404', { 'Cache-Control': 'public, max-age=60' }, 404],
    ['a 500', { 'Cache-Control': 'public, max-age=60' }, 500],
    ['a POST', { 'Cache-Control': 'public, max-age=60' }, 200, { method: 'POST' }]
  ]) {
    const u = `/x/${label.replace(/\W/g, '')}`;
    await edgeCached(get(u, init), ctx, reply('1', headers, status)); await Promise.all(ctx.pending);
    const before = computed;
    await edgeCached(get(u, init), ctx, reply('2', headers, status));
    check(`${label} is never stored`, computed === before + 1 && !store.has(`https://cybercabhunter.com${u}`));
  }
  globalThis.caches = undefined;
  let plain = 0;
  await edgeCached(get('/api/robotaxi-vehicles'), ctx, () => { plain++; return new Response('x', { headers: { 'Cache-Control': 'public, max-age=60' } }); });
  check('without the Cache API (tests, local) it simply computes', plain === 1);

  console.log('\nMigration 0055: indexes only');
  const migration = readFileSync(new URL('../migrations/0055_d1_read_indexes.sql', import.meta.url), 'utf8').replace(/--.*$/gm, '');
  const statements = migration.split(';').map(s => s.trim()).filter(Boolean);
  check(`${statements.length} statements, every one CREATE INDEX`, statements.length === 3 && statements.every(s => /^CREATE INDEX \w+\s+ON /i.test(s)));
  const fresh = createTestD1({ migrateThrough: '0054_zz' });
  const beforeCols = fresh.query(`SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name`);
  fresh.exec(readFileSync(new URL('../migrations/0055_d1_read_indexes.sql', import.meta.url), 'utf8'));
  check('no table changes', same(beforeCols, fresh.query(`SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name`)));

  t.finish();
}

run().catch(err => { console.error(err); process.exit(1); });
