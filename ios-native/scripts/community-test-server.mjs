// The Community test backend for the native app: the REAL Worker
// (worker/index.js) over an isolated in-memory database with every migration
// applied (tests/e2e/harness.mjs, tests/helpers). Nothing here talks to
// production: no production data is read or written, and nothing is deployed.
//
// Everything the app shows in its Community tests is written through the
// Worker's own API by test riders (alice, bob, a moderator and a private
// rider), so every response is exactly what production code would send.
//
//   node ios-native/scripts/community-test-server.mjs --serve 8799
//       serve /api/* on http://127.0.0.1:8799 for the UI tests (Ctrl-C stops it)
//   node ios-native/scripts/community-test-server.mjs --fixtures <dir>
//       write the unit-test fixtures (real Worker responses) to <dir>
//
// Sessions: "s-alice", "s-bob", "s-mod" (moderator), "s-carol" (private).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { makeApp, V1, V2 } from '../../tests/e2e/harness.mjs';
import worker from '../../worker/index.js';
import { reconcileAllXp } from '../../worker/progression.js';
import { recomputeCommunitySummary } from '../../worker/community-summary.js';

const ROOT = new URL('../..', import.meta.url).pathname;
const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };

const app = await makeApp();
const { d1, env } = app;
const PHOTO = fs.readFileSync(path.join(ROOT, 'public/images/CybercabAnimation-poster.jpg'));

// A private rider (public-profile switch off) and a rider used to hit the post limit.
for (const id of ['carol', 'dave']) {
  d1.prepare(`INSERT INTO users (id, display_name, profile_visibility) VALUES (?, ?, 'public')`).bind(id, id === 'carol' ? 'Carol Private' : 'Dave D')._exec();
  await env.TESLA_SESSIONS.put(`session:s-${id}`, JSON.stringify({ user_id: id }));
}
d1.exec(`UPDATE users SET leaderboard_opt_in = 0, handle = 'carol_c' WHERE id = 'carol'`);
d1.exec(`UPDATE users SET leaderboard_opt_in = 1, handle = 'dave_d' WHERE id = 'dave'`);
d1.exec(`UPDATE users SET bio = 'Austin spotter. Mostly South Congress and the Domain.' WHERE id = 'alice'`);

async function api(method, p, { session, json, form } = {}) {
  const headers = { Origin: 'https://cybercabhunter.com' };
  if (session) headers.Authorization = `Bearer ${session}`;
  let body;
  if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  if (form) {
    body = new FormData();
    for (const [k, v] of Object.entries(form)) {
      if (k === 'photos') for (const ph of v) body.append('photos', new Blob([ph], { type: 'image/jpeg' }), 'photo.jpg');
      else body.append(k, v);
    }
  }
  const r = await worker.fetch(new Request(`https://cybercabhunter.com${p}`, { method, headers, body }), env, { waitUntil() {} });
  const text = await r.text();
  let out = null; try { out = JSON.parse(text); } catch (e) { /* not JSON */ }
  return { status: r.status, json: out };
}
const sqlTime = ms => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const HOUR = 3600e3, DAY = 24 * HOUR;
const now = Date.now();
const backdate = (id, ms) => d1.exec(`UPDATE social_posts SET created_at = '${sqlTime(ms)}' WHERE id = '${id}'`);
async function post(session, form, ageMs) {
  const r = await api('POST', '/api/social/posts', { session, form });
  if (r.status !== 201) throw new Error(`post failed ${r.status} ${JSON.stringify(r.json)}`);
  if (ageMs) backdate(r.json.post.id, now - ageMs);
  return r.json.post.id;
}

// ---- Approved sightings: streaks, XP, missions, the community summary ----
let n = 0;
function sighting(user, ms, plate) {
  const id = `sub-test-${++n}`;
  d1.prepare(`INSERT INTO submissions (id, user_id, submission_type, status, submitted_at, evidence_type) VALUES (?, ?, 'vehicle_sighting', 'approved', ?, 'photo')`).bind(id, user, sqlTime(ms))._exec();
  d1.prepare(`INSERT INTO vehicle_observations (id, submission_id, user_id, license_plate, service_area) VALUES (?, ?, ?, ?, 'Austin')`).bind(`obs-${n}`, id, user, plate)._exec();
}
// alice: a 4-day daily run up to today, and one sighting a week for 5 weeks.
for (let d = 0; d < 4; d++) sighting('alice', now - d * DAY - 2 * HOUR, `XVF${3500 + d}`);
for (let w = 1; w < 5; w++) sighting('alice', now - w * 7 * DAY - 3 * HOUR, `XVF${3600 + w}`);
// bob: two days in a row, last week.
sighting('bob', now - 8 * DAY, 'XVF3701');
sighting('bob', now - 9 * DAY, 'XVF3702');
await reconcileAllXp(env);
await recomputeCommunitySummary(env, now);

// ---- Social: posts, photos, a review, attachments, comments, likes ----
const ids = {};
ids.sighting = await post('s-bob', { body: 'Two Cybercabs charging side by side at the Domain this morning. @alice_a was right about the new stalls.', category: 'sighting', vehicle_id: V1, photos: [PHOTO] }, 3 * HOUR);
ids.review = await post('s-alice', {
  body: 'First ride in a Cybercab: smooth, quiet, and the pickup was quicker than the app said.',
  category: 'review', review: '1', rating: '5', vehicle_type: 'cybercab', quoted_fare: '12.40', pickup_wait_minutes: '4',
  ride_date: sqlTime(now - DAY).slice(0, 10)
}, 5 * HOUR);
ids.question = await post('s-alice', { body: 'Has anyone seen a Cybercab north of Parmer yet?', category: 'question', link_url: 'https://www.tesla.com/robotaxi' }, 26 * HOUR);
ids.anon = await post('s-carol', { body: 'Saw one waiting at a light on Lamar. Quieter than I expected.', category: 'general' }, 30 * HOUR);
ids.photos = await post('s-bob', { body: 'Same car from both sides.', category: 'sighting', photos: [PHOTO, PHOTO] }, 2 * DAY);
for (let i = 0; i < 9; i++) await post('s-bob', { body: `Fleet note ${i + 1}: another plate for the registry list.`, category: 'general' }, (3 + i) * DAY);

for (const who of ['s-bob', 's-mod']) await api('PUT', `/api/social/posts/${ids.review}/like`, { session: who });
await api('PUT', `/api/social/posts/${ids.sighting}/like`, { session: 's-alice' });
await api('PUT', `/api/social/posts/${ids.sighting}/save`, { session: 's-alice' });
const c1 = (await api('POST', `/api/social/posts/${ids.review}/comments`, { session: 's-bob', json: { body: 'How long was the ride?' } })).json.comment.id;
await api('POST', `/api/social/posts/${ids.review}/comments`, { session: 's-alice', json: { body: 'About 18 minutes, downtown to Zilker.', parent_id: c1 } });
await api('POST', `/api/social/posts/${ids.review}/comments`, { session: 's-mod', json: { body: 'Thanks for the detailed review.' } });
await api('POST', `/api/social/posts/${ids.sighting}/comments`, { session: 's-alice', json: { body: 'Nice catch. That plate is in the registry.' } });
await api('PUT', `/api/social/posts/${ids.review}/pin`, { session: 's-mod' });
await api('PUT', '/api/moderation/social/announcement', { session: 's-mod', json: { body: 'Community Social is open. Keep it about Cybercabs and spot safely.', notify: true } });

// ---- Serve, or write the fixtures ----
const port = flag('--serve');
const out = flag('--fixtures');
if (out) {
  fs.mkdirSync(out, { recursive: true });
  const save = (name, r) => fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(r.json, null, 2) + '\n');
  const saveStatus = (name, r) => fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify({ status: r.status, body: r.json }, null, 2) + '\n');
  const latest1 = await api('GET', '/api/social/feed?filter=latest&limit=10', { session: 's-alice' });
  save('social-feed-latest', latest1);
  save('social-feed-latest-page2', await api('GET', `/api/social/feed?filter=latest&limit=10&cursor=${encodeURIComponent(latest1.json.next_cursor)}`, { session: 's-alice' }));
  save('social-feed-foryou-signed-out', await api('GET', '/api/social/feed?filter=foryou&limit=10'));
  save('social-feed-saved', await api('GET', '/api/social/feed?filter=saved&limit=10', { session: 's-alice' }));
  save('social-feed-moderator', await api('GET', '/api/social/feed?filter=latest&limit=3', { session: 's-mod' }));
  saveStatus('social-feed-saved-signed-out', await api('GET', '/api/social/feed?filter=saved'));
  save('social-post', await api('GET', `/api/social/posts/${ids.review}`, { session: 's-alice' }));
  saveStatus('social-post-missing', await api('GET', '/api/social/posts/0123456789abcdef0123456789abcdef'));
  save('social-comments', await api('GET', `/api/social/posts/${ids.review}/comments`, { session: 's-bob' }));
  save('social-sidebar', await api('GET', '/api/social/sidebar'));
  save('social-notifications', await api('GET', '/api/social/notifications', { session: 's-alice' }));
  save('social-notifications-count', await api('GET', '/api/social/notifications?count_only=1', { session: 's-alice' }));
  save('social-vehicles', await api('GET', '/api/social/vehicles?q=XVF'));
  save('social-like', await api('PUT', `/api/social/posts/${ids.question}/like`, { session: 's-bob' }));
  save('social-save', await api('PUT', `/api/social/posts/${ids.question}/save`, { session: 's-bob' }));
  save('social-comment-created', await api('POST', `/api/social/posts/${ids.question}/comments`, { session: 's-bob', json: { body: 'Not yet, only around downtown.' } }));
  save('social-post-created', await api('POST', '/api/social/posts', { session: 's-bob', form: { body: 'Composer fixture with a review.', category: 'review', review: '1', rating: '4', vehicle_type: 'model_y', vehicle_id: V2 } }));
  saveStatus('error-duplicate-post', await api('POST', '/api/social/posts', { session: 's-bob', form: { body: 'Composer fixture with a review.' } }));
  saveStatus('error-invalid-rating', await api('POST', '/api/social/posts', { session: 's-bob', form: { body: 'x', review: '1', rating: '9' } }));
  saveStatus('error-cannot-report-own', await api('POST', '/api/social/reports', { session: 's-alice', json: { target_type: 'post', target_id: ids.review, reason: 'spam' } }));
  saveStatus('social-report-created', await api('POST', '/api/social/reports', { session: 's-bob', json: { target_type: 'post', target_id: ids.anon, reason: 'off_topic' } }));
  saveStatus('error-already-reported', await api('POST', '/api/social/reports', { session: 's-bob', json: { target_type: 'post', target_id: ids.anon, reason: 'spam' } }));
  saveStatus('error-forbidden-edit', await api('PATCH', `/api/social/posts/${ids.review}`, { session: 's-bob', form: { body: 'not mine' } }));
  let limited = null;
  for (let i = 0; i < 12 && !limited; i++) {
    const r = await api('POST', '/api/social/posts', { session: 's-dave', form: { body: `Rate limit check ${i}` } });
    if (r.status === 429) limited = r;
  }
  saveStatus('error-rate-limited', limited);
  saveStatus('error-signed-out-post', await api('POST', '/api/social/posts', { form: { body: 'hello' } }));
  save('streaks-me', await api('GET', '/api/streaks/me', { session: 's-alice' }));
  save('streaks-me-empty', await api('GET', '/api/streaks/me', { session: 's-dave' }));
  save('streaks-leaderboard-weekly', await api('GET', '/api/streaks/leaderboard?board=weekly'));
  save('xp-me', await api('GET', '/api/xp/me', { session: 's-alice' }));
  save('xp-rules', await api('GET', '/api/xp/rules'));
  save('community-summary', await api('GET', '/api/community/summary'));
  save('leaderboard-overall', await api('GET', '/api/community/leaderboard'));
  save('leaderboard-xp', await api('GET', '/api/community/leaderboard?board=xp'));
  save('rider-profile', await api('GET', '/api/riders/alice_a'));
  saveStatus('rider-profile-private', await api('GET', '/api/riders/carol_c'));
  save('rider-search', await api('GET', '/api/rider-search?q=a'));
  console.log(`Fixtures written to ${out}`);
}
if (port) {
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const url = new URL(req.url, 'http://localhost');
      const headers = { ...req.headers, origin: 'https://cybercabhunter.com' };
      const body = ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks);
      const resp = await worker.fetch(new Request(`https://cybercabhunter.com${url.pathname}${url.search}`, { method: req.method, headers, body }), env, { waitUntil() {} });
      const outHeaders = {};
      resp.headers.forEach((v, k) => { outHeaders[k] = v; });
      res.writeHead(resp.status, outHeaders);
      res.end(Buffer.from(await resp.arrayBuffer()));
    } catch (e) { res.writeHead(500); res.end(String(e && e.stack || e)); }
  });
  server.listen(Number(port), '127.0.0.1', () => console.log(`READY http://127.0.0.1:${port}`));
}
