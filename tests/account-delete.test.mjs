// Self-serve account deletion: DELETE /api/account (worker/account.js) and the
// profile page's Danger zone.
//   - removes the caller's users row and every row they own in every table,
//     their R2 files and Zones-map copies, their tokens; zero references remain
//   - other riders' data is untouched; shared registry vehicles stay
//   - the session is the only input: 401 without one; no id parameter honored
//   - every session of the account stops working
//   - discovery credit / the leaderboard update by themselves
//   - the last moderator can't delete themselves; audit record has no raw id
// Real SQL (every migration) + the REAL Worker router; the page runs in jsdom.
// Run: node tests/account-delete.test.mjs

import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { makeEnv, makeCheck, seedRide } from './helpers/env.mjs';
import worker from '../worker/index.js';
import { sha256Hex } from '../worker/account.js';

const t = makeCheck();
const { check } = t;
const ROOT = new URL('..', import.meta.url).pathname;
const read = f => fs.readFileSync(`${ROOT}${f}`, 'utf8');
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 0xff, 0xd9]);

async function makeApp() {
  const ctx = await makeEnv({ users: ['victim', 'other', 'mod', 'mod2'] });
  for (const u of ['victim', 'other', 'mod', 'mod2']) await ctx.env.TESLA_SESSIONS.put(`session:session-${u}`, JSON.stringify({ user_id: u }));
  await ctx.env.TESLA_SESSIONS.put('session:second-victim-device', JSON.stringify({ user_id: 'victim' }));
  ctx.d1.exec(`UPDATE users SET role = 'moderator' WHERE id IN ('mod', 'mod2')`);
  ctx.env.ASSETS = { fetch: async () => new Response('asset') };
  return ctx;
}

// A row in `table` for `userCol` = userId, filling every other required column.
function seedRow(ctx, table, userCol, userId, extra = {}) {
  const cols = ctx.d1.query(`SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info('${table}')`);
  const values = {};
  for (const c of cols) {
    if (c.name in extra) values[c.name] = extra[c.name];
    else if (c.name === userCol) values[c.name] = userId;
    else if (c.pk) values[c.name] = `${table}-${userId}-${Math.random().toString(36).slice(2, 8)}`;
    else if (c.notnull && c.dflt_value === null) values[c.name] = /INT|REAL/i.test(c.type) ? 0 : `${table}-${c.name}-${userId}-${Math.random().toString(36).slice(2, 6)}`;
  }
  const names = Object.keys(values);
  ctx.d1.prepare(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).bind(...names.map(n => values[n]))._exec();
  return values;
}

const call = (ctx, method, path, { session, body, headers = {} } = {}) => worker.fetch(new Request(`https://x${path}`, {
  method, headers: { ...(session ? { Authorization: `Bearer ${session}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
  body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined
}), ctx.env, {});
const del = (ctx, session, body = { confirm: 'DELETE' }, path = '/api/account') => call(ctx, 'DELETE', path, { session, body });

// Everything a rider can own, for `u`.
async function populate(ctx, u) {
  const vehicle = `${u}-veh`;
  ctx.d1.prepare(`INSERT INTO robotaxi_vehicles (id, license_plate, visibility, origin) VALUES (?, ?, 'public', 'receipt')`).bind(vehicle, `P${u.toUpperCase()}`)._exec();
  const trip = seedRide(ctx.d1, { id: `${u}-trip`, userId: u, vehicleId: vehicle, status: 'approved', rideKey: `${u}-rk`, createdAt: '2026-09-01 10:00:00' });
  seedRide(ctx.d1, { id: `${u}-dupe`, userId: u, vehicleId: vehicle, status: 'approved', rideKey: `${u}-rk2`, supersededBy: trip });
  seedRow(ctx, 'trip_revisions', 'trip_id', trip);
  // Files in both per-user folders, one referenced by a photo sighting.
  await ctx.env.EVIDENCE_BUCKET.put(`evidence/${u}/sighting.jpg`, JPEG);
  await ctx.env.EVIDENCE_BUCKET.put(`evidence/${u}/orphan.jpg`, JPEG);
  await ctx.env.EVIDENCE_BUCKET.put(`receipts/${u}/receipt.pdf`, new Uint8Array([1]));
  const sighting = `${u}-sig`;
  ctx.d1.prepare(`INSERT INTO submissions (id, user_id, submission_type, status, evidence_type, evidence_ref) VALUES (?, ?, 'vehicle_sighting', 'approved', 'photo', ?)`).bind(sighting, u, `evidence/${u}/sighting.jpg`)._exec();
  ctx.d1.prepare(`INSERT INTO vehicle_observations (id, robotaxi_vehicle_id, user_id, submission_id, service_area, evidence_ref, public_id, verification_status) VALUES (?, ?, ?, ?, 'Austin', ?, ?, 'verified')`)
    .bind(`${u}-obs`, vehicle, u, sighting, `evidence/${u}/sighting.jpg`, `${u}00000000000000000000000000`.slice(0, 32))._exec();
  await ctx.env.EVIDENCE_BUCKET.put(`camera-captures/65/${u}.jpg`, JPEG);
  ctx.d1.prepare(`INSERT INTO camera_detections (id, camera_id, camera_name, lat, lng, observed_at, image_r2_key, source_submission_id) VALUES (?, '65', 'CAM', 30.27, -97.73, ?, ?, ?)`)
    .bind(`${u}-cam`, `2026-09-30T0${u.length % 10}:00:00Z`, `camera-captures/65/${u}.jpg`, sighting)._exec();
  // Connections and bookkeeping.
  seedRow(ctx, 'tesla_connections', 'user_id', u, { status: 'active' });
  seedRow(ctx, 'vehicles', 'owner_user_id', u);
  seedRow(ctx, 'robotaxi_owner_connections', 'user_id', u, { status: 'active' });
  const tokenKey = `ride_tokens:${u}`;
  await ctx.env.TESLA_SESSIONS.put(tokenKey, JSON.stringify({ encryptedAccessToken: 'x' }));
  seedRow(ctx, 'tesla_ride_sync_connections', 'user_id', u, { kv_token_key: tokenKey, status: 'active' });
  seedRow(ctx, 'google_connections', 'user_id', u, { email: `${u}@example.com` });
  seedRow(ctx, 'gmail_connections', 'user_id', u, { status: 'active', email: `${u}@example.com` });
  seedRow(ctx, 'gmail_processed_messages', 'user_id', u, { outcome: 'imported' });
  seedRow(ctx, 'ride_sync_runs', 'user_id', u);
  seedRow(ctx, 'receipt_ingestions', 'user_id', u, { status: 'accepted' });
  return { vehicle, tokenKey };
}

// Every column in every table that holds exactly `id`.
function references(ctx, id) {
  const hits = [];
  for (const { name } of ctx.d1.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)) {
    for (const c of ctx.d1.query(`SELECT name FROM pragma_table_info('${name}')`)) {
      const n = ctx.d1.query(`SELECT COUNT(*) AS n FROM ${name} WHERE "${c.name}" = ?`, id)[0].n;
      if (n) hits.push(`${name}.${c.name}=${n}`);
    }
  }
  return hits;
}
// The other rider's rows (those naming them and not the victim), by table and
// rowid — so the same rows can be compared before and after.
function otherRows(ctx, pick = null) {
  const out = {};
  for (const { name } of ctx.d1.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE '%WITHOUT ROWID%'`)) {
    for (const r of ctx.d1.query(`SELECT rowid AS _rid, * FROM ${name}`)) {
      const key = `${name}#${r._rid}`;
      const json = JSON.stringify(r);
      if (pick ? pick.has(key) : (json.includes('other') && !json.includes('victim'))) out[key] = json;
    }
  }
  return out;
}

async function run() {
  console.log('1. Deletes everything the caller owns — and nothing else');
  {
    const ctx = await makeApp();
    const v = await populate(ctx, 'victim');
    await populate(ctx, 'other');
    // The victim also acted as a moderator on shared records.
    ctx.d1.exec(`UPDATE submissions SET reviewed_by = 'victim' WHERE id = 'other-sig'`);
    ctx.d1.exec(`UPDATE robotaxi_vehicles SET vin = 'VIN1', vin_set_by_user_id = 'victim' WHERE id = 'other-veh'`);
    seedRow(ctx, 'robotaxi_vehicle_reviews', 'moderator_user_id', 'victim', { id: 'rev-1', robotaxi_vehicle_id: 'other-veh', action: 'approved_public' });
    check('(setup: the victim is referenced across the schema)', references(ctx, 'victim').length >= 15, references(ctx, 'victim').join(' '));
    const otherBefore = otherRows(ctx);
    const otherFiles = [...ctx.env.EVIDENCE_BUCKET._objects.keys()].filter(k => k.includes('other')).sort().join();

    const r = await del(ctx, 'session-victim');
    const out = await r.json();
    check('200 { success, deleted }', r.status === 200 && out.success === true && out.deleted === true);
    // The one intentional exception: the append-only moderator approval history
    // (robotaxi_vehicle_reviews, migrations/0012) keeps a moderator's id.
    const left = references(ctx, 'victim').filter(h => !h.startsWith('robotaxi_vehicle_reviews.moderator_user_id='));
    check('ZERO references to the id remain anywhere else in any table', left.length === 0, left.join(' '));
    check('the append-only moderator approval history keeps its row (now naming no existing account)',
      ctx.d1.query(`SELECT moderator_user_id FROM robotaxi_vehicle_reviews WHERE id = 'rev-1'`)[0].moderator_user_id === 'victim' && ctx.d1.query(`SELECT COUNT(*) n FROM users WHERE id = 'victim'`)[0].n === 0);
    check('the users row is gone', ctx.d1.query(`SELECT COUNT(*) n FROM users WHERE id = 'victim'`)[0].n === 0);
    check('their receipt forwarding address, trips (and revisions), sightings, submissions and connections are gone',
      ['receipt_ingestion_addresses', 'trips', 'vehicle_observations', 'submissions', 'tesla_connections', 'vehicles', 'robotaxi_owner_connections', 'tesla_ride_sync_connections', 'google_connections', 'gmail_connections', 'gmail_processed_messages', 'ride_sync_runs', 'receipt_ingestions']
        .every(tb => ctx.d1.query(`SELECT COUNT(*) n FROM ${tb} WHERE ${tb === 'vehicles' ? 'owner_user_id' : 'user_id'} = 'victim'`)[0].n === 0)
      && ctx.d1.query(`SELECT COUNT(*) n FROM trip_revisions WHERE trip_id LIKE 'victim%'`)[0].n === 0);
    check('their Zones-map copy is gone (row and image)', ctx.d1.query(`SELECT COUNT(*) n FROM camera_detections WHERE id = 'victim-cam'`)[0].n === 0 && !ctx.env.EVIDENCE_BUCKET._objects.has('camera-captures/65/victim.jpg'));
    check('ALL their R2 files are gone, including one nothing referenced', ![...ctx.env.EVIDENCE_BUCKET._objects.keys()].some(k => k.includes('victim')));
    check('their Tesla ride-sync token is gone from KV', (await ctx.env.TESLA_SESSIONS.get(v.tokenKey)) === null);
    check('shared records that only named them as a moderator are kept, without the id',
      ctx.d1.query(`SELECT reviewed_by FROM submissions WHERE id = 'other-sig'`)[0].reviewed_by === null &&
      ctx.d1.query(`SELECT vin, vin_set_by_user_id FROM robotaxi_vehicles WHERE id = 'other-veh'`)[0].vin === 'VIN1' &&
      ctx.d1.query(`SELECT vin_set_by_user_id FROM robotaxi_vehicles WHERE id = 'other-veh'`)[0].vin_set_by_user_id === null);
    check('the public registry vehicle their rides referenced is NOT deleted', ctx.d1.query(`SELECT COUNT(*) n FROM robotaxi_vehicles WHERE id = 'victim-veh'`)[0].n === 1);
    const otherAfter = otherRows(ctx, new Set(Object.keys(otherBefore)));
    check('every row belonging only to the other rider is still there, byte-for-byte unchanged',
      Object.keys(otherBefore).length > 15 && JSON.stringify(otherAfter) === JSON.stringify(otherBefore), `${Object.keys(otherBefore).length} rows`);
    check('...and all of their files are still there', [...ctx.env.EVIDENCE_BUCKET._objects.keys()].filter(k => k.includes('other')).sort().join() === otherFiles);
    check('the other rider\'s session still works', (await call(ctx, 'GET', '/api/profile', { session: 'session-other' })).status === 200);
  }

  console.log('2. The session is the only input');
  {
    const ctx = await makeApp();
    check('no session: 401', (await del(ctx, null)).status === 401);
    check('an unknown session: 401', (await del(ctx, 'nope')).status === 401);
    check('no confirmation: 400, nothing deleted', (await del(ctx, 'session-victim', {})).status === 400 && ctx.d1.query(`SELECT COUNT(*) n FROM users WHERE id = 'victim'`)[0].n === 1);
    check('a lowercase "delete" is not the confirmation', (await del(ctx, 'session-victim', { confirm: 'delete' })).status === 400);
    const r = await del(ctx, 'session-victim', { confirm: 'DELETE', user_id: 'other', handle: 'other', email: 'other@example.com' }, '/api/account?user_id=other&id=other');
    check('a user id/handle/email in the body or query is ignored: only the caller is deleted',
      r.status === 200 && ctx.d1.query(`SELECT COUNT(*) n FROM users WHERE id = 'victim'`)[0].n === 0 && ctx.d1.query(`SELECT COUNT(*) n FROM users WHERE id = 'other'`)[0].n === 1);
    const post = await call(ctx, 'POST', '/api/account', { session: 'session-other', body: { confirm: 'DELETE' } });
    const get = await call(ctx, 'GET', '/api/account', { session: 'session-other' });
    check('GET/POST /api/account never delete (only DELETE does)', !/"deleted":true/.test(await post.text()) && !/"deleted":true/.test(await get.text()) && ctx.d1.query(`SELECT COUNT(*) n FROM users WHERE id = 'other'`)[0].n === 1);
  }

  console.log('3. Every session of the account stops working');
  {
    const ctx = await makeApp();
    await del(ctx, 'session-victim');
    check('the session used is deleted from KV', (await ctx.env.TESLA_SESSIONS.get('session:session-victim')) === null);
    check('a request with it now fails', (await call(ctx, 'GET', '/api/profile', { session: 'session-victim' })).status === 401);
    check('the account\'s OTHER session (another device) fails too', (await call(ctx, 'GET', '/api/profile', { session: 'second-victim-device' })).status === 401 &&
      (await call(ctx, 'GET', '/api/me', { session: 'second-victim-device' })).status !== 200 || (await (await call(ctx, 'GET', '/api/me', { session: 'second-victim-device' })).json()).authenticated === false);
    check('...including write endpoints (no rows are created for the deleted id)', (await call(ctx, 'POST', '/api/vehicle-sightings', { session: 'second-victim-device', body: { service_area: 'Austin', license_plate: 'ABC1234' } })).status === 401);
    check('a second delete attempt: 401', (await del(ctx, 'second-victim-device')).status === 401);
  }

  console.log('4. Leaderboard and discovery credit update by themselves');
  {
    const ctx = await makeApp();
    ctx.d1.exec(`UPDATE users SET leaderboard_opt_in = 1, display_name = 'Other', handle = 'other' WHERE id = 'other'`);
    ctx.d1.exec(`UPDATE users SET leaderboard_opt_in = 1, display_name = 'Victim', handle = 'victim' WHERE id = 'victim'`);
    ctx.d1.prepare(`INSERT INTO robotaxi_vehicles (id, license_plate, visibility, origin) VALUES ('car1', 'CAR1', 'public', 'receipt')`)._exec();
    seedRide(ctx.d1, { id: 'v-ride', userId: 'victim', vehicleId: 'car1', status: 'approved', rideKey: 'a', createdAt: '2026-09-01 10:00:00' });
    seedRide(ctx.d1, { id: 'o-ride', userId: 'other', vehicleId: 'car1', status: 'approved', rideKey: 'b', createdAt: '2026-09-01 11:00:00' });
    ctx.d1.prepare(`INSERT INTO robotaxi_vehicles (id, license_plate, visibility, origin, vin) VALUES ('car2', 'CAR2', 'public', 'sighting', 'VIN2')`)._exec();
    ctx.d1.exec(`INSERT INTO submissions (id, user_id, submission_type, status) VALUES ('v-sig', 'victim', 'vehicle_sighting', 'approved')`);
    ctx.d1.exec(`INSERT INTO vehicle_observations (id, robotaxi_vehicle_id, user_id, submission_id, verification_status) VALUES ('v-obs', 'car2', 'victim', 'v-sig', 'verified')`);
    const board = async () => (await (await call(ctx, 'GET', '/api/community/leaderboard')).json()).entries.map(e => `${e.name}:${e.count}`).join(',');
    check('before: the victim discovered both vehicles', await board() === 'Victim:2');
    await del(ctx, 'session-victim');
    check('after: the car they rode first is credited to the next rider; the one their sighting created has no discoverer', await board() === 'Other:1');
    check('the sighting-created vehicle stays in the public registry', ctx.d1.query(`SELECT visibility FROM robotaxi_vehicles WHERE id = 'car2'`)[0].visibility === 'public');
    check('the deleted rider\'s profile is gone', (await call(ctx, 'GET', '/api/riders/victim')).status === 404);
  }

  console.log('5. Moderators');
  {
    const ctx = await makeApp();
    ctx.d1.exec(`UPDATE users SET role = 'user' WHERE id = 'mod2'`);
    const r = await del(ctx, 'session-mod');
    const out = await r.json();
    check('the last moderator is refused (409), with the transfer message', r.status === 409 && out.error === 'last_moderator' && /transfer the role/.test(out.message));
    check('...and nothing was deleted', ctx.d1.query(`SELECT COUNT(*) n FROM users WHERE id = 'mod'`)[0].n === 1 && (await call(ctx, 'GET', '/api/profile', { session: 'session-mod' })).status === 200);
    ctx.d1.exec(`UPDATE users SET role = 'moderator' WHERE id = 'mod2'`);
    check('with another moderator, a moderator can delete their account', (await del(ctx, 'session-mod')).status === 200 && ctx.d1.query(`SELECT COUNT(*) n FROM users WHERE id = 'mod'`)[0].n === 0);
  }

  console.log('6. Audit, privacy, rate limit');
  {
    const ctx = await makeApp();
    const logs = [];
    const realLog = console.log;
    console.log = (...a) => { logs.push(a.join(' ')); };
    let r;
    try { r = await del(ctx, 'session-victim'); } finally { console.log = realLog; }
    const hash = await sha256Hex('victim');
    const audit = await ctx.env.TESLA_SESSIONS.get(`account_deleted:${hash}`);
    check('an audit record keyed by the id\'s SHA-256 hash, holding only the time', audit && Object.keys(JSON.parse(audit)).join() === 'at');
    check('the log line has the time and hash — no raw id, email or token', logs.some(l => l.includes('account_deleted') && l.includes(hash)) && !logs.some(l => /"victim"|victim@|session-victim/.test(l)));
    check('the response carries no id or email', !/victim/.test(await r.text()));
    check('the session tombstone is keyed by the hash, not the raw id', (await ctx.env.TESLA_SESSIONS.get(`deleted_user:${hash}`)) === '1' && (await ctx.env.TESLA_SESSIONS.get('deleted_user:victim')) === null);

    const limited = await makeApp();
    limited.env.ACCOUNT_DELETE_LIMITER = { limit: async () => ({ success: false }) };
    check('rate limited: 429, nothing deleted', (await del(limited, 'session-victim')).status === 429 && limited.d1.query(`SELECT COUNT(*) n FROM users WHERE id = 'victim'`)[0].n === 1);
    const wrangler = read('wrangler.jsonc');
    check('the rate limiter is bound in wrangler.jsonc', /"name": "ACCOUNT_DELETE_LIMITER"/.test(wrangler));
  }

  console.log('7. Profile page: Danger zone');
  {
    const ctx = await makeApp();
    const html = read('public/profile.html');
    check('a Danger zone with a red Delete account button', /id="dangerZone"/.test(html) && /id="deleteAccountBtn"[^>]*bg-crimson[^>]*>Delete account</.test(html));
    check('the confirmation says it is permanent and lists what goes', /This is permanent and can't be undone\./.test(html) && /ride history/.test(html) && /sightings, including their photos/.test(html) && /Gmail access is revoked/.test(html));
    const dom = new JSDOM(html.replace(/<script src="https?:[^"]*"><\/script>/g, ''), { runScripts: 'outside-only', url: 'https://cybercabhunter.com/profile.html', pretendToBeVisual: true });
    const w = dom.window;
    w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
    w.localStorage.setItem('teslaSessionId', 'session-victim');
    const sent = [];
    w.fetch = async (url, init = {}) => {
      const path = String(url).replace('https://cybercabhunter.contactjoeclos.workers.dev', '');
      if (path === '/api/account') sent.push({ method: init.method, body: init.body, auth: init.headers.Authorization });
      return worker.fetch(new Request(`https://x${path}`, init), ctx.env, {});
    };
    let navigatedTo = null;
    const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).filter(s => s.includes('initDeleteAccount')).join('\n');
    w.eval(`${read('public/js/calc.js')}\n${read('public/js/main.js')}\nCCC.init();\n${inline.replace("window.location.href = 'index.html?account=deleted';", "window.__navigated = 'index.html?account=deleted';")}`);
    await new Promise(r => setTimeout(r, 60));
    const d = w.document;
    check('the explanation is hidden until the button is pressed', d.getElementById('deleteAccountPanel').classList.contains('hidden'));
    d.getElementById('deleteAccountBtn').click();
    const submit = d.getElementById('deleteAccountSubmit');
    check('pressing it shows the explanation; the delete button stays disabled', !d.getElementById('deleteAccountPanel').classList.contains('hidden') && submit.disabled);
    const input = d.getElementById('deleteAccountConfirm');
    input.value = 'delete'; input.dispatchEvent(new w.Event('input'));
    check('typing something other than DELETE keeps it disabled', submit.disabled && sent.length === 0);
    input.value = 'DELETE'; input.dispatchEvent(new w.Event('input'));
    check('typing DELETE enables it', !submit.disabled);
    submit.click();
    await new Promise(r => setTimeout(r, 120));
    navigatedTo = w.__navigated;
    check('one DELETE /api/account with the confirmation and the session — no id anywhere', sent.length === 1 && sent[0].method === 'DELETE' && JSON.parse(sent[0].body).confirm === 'DELETE' && Object.keys(JSON.parse(sent[0].body)).join() === 'confirm' && sent[0].auth === 'Bearer session-victim');
    check('on success: signed out on this device and sent home with the notice', w.localStorage.getItem('teslaSessionId') === null && navigatedTo === 'index.html?account=deleted' && ctx.d1.query(`SELECT COUNT(*) n FROM users WHERE id = 'victim'`)[0].n === 0);
    w.close();

    const home = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'https://cybercabhunter.com/index.html?account=deleted', pretendToBeVisual: true });
    home.window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
    home.window.fetch = async () => new Response('{}', { status: 401 });
    home.window.eval(`${read('public/js/calc.js')}\n${read('public/js/main.js')}\nCCC.init();`);
    await new Promise(r => setTimeout(r, 30));
    const toast = home.window.document.getElementById('toastRoot');
    check('the homepage shows "Your account has been deleted." and cleans the URL', toast && /Your account has been deleted\./.test(toast.textContent) && !/account=deleted/.test(home.window.location.search));
    home.window.close();
  }

  t.finish();
}

run().catch(e => { console.error(e); process.exit(1); });
