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
// Sessions: "s-alice", "s-bob", "s-dave", "s-mod" (moderator), "s-carol"
// (private), "s-erin" (a throwaway account the fixtures delete), "s-frank"
// (served only: an upload and a Google photo, for the avatar checks). Any other
// token, e.g. "s-expired", is an ended session (401).
//
// Phase 5 adds sightings (approved, pending and rejected, through the real
// photo-sighting and moderation APIs) and open Social reports.
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
for (const id of ['carol', 'dave', 'erin']) {
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
      else if (k === 'photo') body.append('photo', new Blob([v], { type: 'image/jpeg' }), 'sighting.jpg');
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
// Two open reports on the private rider's post (the moderation queue).
await api('POST', '/api/social/reports', { session: 's-bob', json: { target_type: 'post', target_id: ids.anon, reason: 'off_topic', details: 'Not about a Cybercab.' } });
await api('POST', '/api/social/reports', { session: 's-alice', json: { target_type: 'post', target_id: ids.anon, reason: 'spam' } });

// ---- Sightings (Phase 5): the real photo-sighting API, reviewed by the moderator ----
async function photoSighting(session, fields) {
  const r = await api('POST', '/api/vehicle-sightings/photo', { session, form: { photo: PHOTO, ...fields } });
  if (r.status !== 201) throw new Error(`sighting failed ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.submission_id;
}
const review = (id, action, reason) => api('PATCH', `/api/moderation/vehicle-sightings/${id}`, { session: 's-mod', json: action === 'approve' ? { action } : { action, rejection_reason: reason } });
const sights = {};
sights.approved1 = await photoSighting('s-bob', { license_plate: 'XVF-3582', service_area: 'Austin', notes: 'Charging at the Domain.' });
sights.approved2 = await photoSighting('s-dave', { license_plate: 'XVF3210', service_area: 'Austin' });
sights.approved3 = await photoSighting('s-bob', { service_area: 'Dallas' });
for (const id of [sights.approved1, sights.approved2, sights.approved3]) await review(id, 'approve');
sights.pendingPhoto = await photoSighting('s-bob', { license_plate: 'ZZZ1234', service_area: 'Austin', notes: 'A plate I have not seen before.' });
sights.pendingJson = (await api('POST', '/api/vehicle-sightings', { session: 's-dave', json: { license_plate: 'XVF9999', service_area: 'Austin', model: 'Cybercab', color: 'Gold' } })).json.submission_id;
sights.rejected = await photoSighting('s-dave', { service_area: 'Austin', notes: 'Far away, sorry.' });
await review(sights.rejected, 'reject', 'Too far away to confirm it is a Cybercab.');

// ---- Moderation parity (Phase 5.1): registry vehicles, News, Gmail Link ----
// Private registry vehicles in each review state (no rides, so no board
// changes): two added from sightings (eligible: a moderator's approval stands
// in for a ride) and one from a receipt with no rides (not eligible).
const R = { sighting: 'c3d4e5f6-0000-4000-8000-000000000003', receipt: 'd4e5f6a7-0000-4000-8000-000000000004', spare: 'e5f6a7b8-0000-4000-8000-000000000005' };
for (const [id, plate, origin] of [[R.sighting, 'XVF5100', 'sighting'], [R.receipt, 'XVF5200', 'receipt'], [R.spare, 'XVF5300', 'sighting']]) {
  d1.prepare(`INSERT INTO robotaxi_vehicles (id, license_plate, model, first_seen_at, last_seen_at, origin, visibility) VALUES (?, ?, 'Cybercab', ?, ?, ?, 'private')`).bind(id, plate, sqlTime(now - 2 * DAY), sqlTime(now - DAY), origin)._exec();
}
// News: three stories (one Major and featured, one hidden) and the last run's log.
const story = (i, title, extra) => d1.prepare(`INSERT INTO news_articles (id, title, url, source, source_type, published_at, importance, source_count, hidden, featured) VALUES (?, ?, ?, ?, 'press', ?, ?, ?, ?, ?)`)
  .bind(`0000000${i}-0000-4000-8000-00000000000${i}`, title, `https://example.com/news/${i}`, extra.source, new Date(now - i * HOUR).toISOString(), extra.importance || 0, extra.outlets || 1, extra.hidden ? 1 : 0, extra.featured ? 1 : 0)._exec();
story(1, 'Tesla expands Cybercab service in Austin', { source: 'Electrek', importance: 2, outlets: 3, featured: true });
story(2, 'Robotaxi rides now available in Dallas', { source: 'Teslarati', importance: 1 });
story(3, 'Cybercab spotted testing downtown', { source: 'BASENOR', hidden: true });
await env.TESLA_SESSIONS.put('news:last_run', JSON.stringify({ at: new Date(now - HOUR).toISOString(), feeds: ['google-news'], fetched: 12, kept: 3, dropped: 9, blocked_publisher: 1, duplicates: 0, new: 3, not_modified: 0, errors: [] }));
// Gmail Link: two forwarding addresses (one set up and receiving) and three forwarded receipts.
d1.exec(`INSERT INTO receipt_ingestion_addresses (id, user_id, opaque_token, status, setup_completed_at, last_received_at, forwarding_code_received_at) VALUES
  ('addr-1', 'carol', 'tok-1', 'active', '${sqlTime(now - 3 * DAY)}', '${sqlTime(now - 2 * HOUR)}', '${sqlTime(now - 3 * DAY)}'),
  ('addr-2', 'dave', 'tok-2', 'active', NULL, NULL, NULL)`);
d1.exec(`INSERT INTO receipt_ingestions (id, user_id, received_at, status) VALUES
  ('ing-1', 'alice', '${sqlTime(now - 2 * HOUR)}', 'accepted'),
  ('ing-2', 'alice', '${sqlTime(now - DAY - 2 * HOUR)}', 'duplicate'),
  ('ing-3', 'alice', '${sqlTime(now - 3 * DAY)}', 'rejected')`);

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
  saveStatus('social-report-created', await api('POST', '/api/social/reports', { session: 's-dave', json: { target_type: 'post', target_id: ids.question, reason: 'off_topic' } }));
  saveStatus('error-already-reported', await api('POST', '/api/social/reports', { session: 's-dave', json: { target_type: 'post', target_id: ids.question, reason: 'spam' } }));
  saveStatus('error-forbidden-edit', await api('PATCH', `/api/social/posts/${ids.review}`, { session: 's-bob', form: { body: 'not mine' } }));
  let limited = null;
  for (let i = 0; i < 12 && !limited; i++) {
    const r = await api('POST', '/api/social/posts', { session: 's-dave', form: { body: `Rate limit check ${i}` } });
    if (r.status === 429) limited = r;
  }
  saveStatus('error-rate-limited', limited);
  saveStatus('error-signed-out-post', await api('POST', '/api/social/posts', { form: { body: 'hello' } }));
  save('streaks-me', await api('GET', '/api/streaks/me', { session: 's-alice' }));
  save('streaks-me-empty', await api('GET', '/api/streaks/me', { session: 's-erin' }));   // a rider with no sightings
  save('streaks-leaderboard-weekly', await api('GET', '/api/streaks/leaderboard?board=weekly'));
  save('xp-me', await api('GET', '/api/xp/me', { session: 's-alice' }));
  save('xp-rules', await api('GET', '/api/xp/rules'));
  save('community-summary', await api('GET', '/api/community/summary'));
  save('leaderboard-overall', await api('GET', '/api/community/leaderboard'));
  save('leaderboard-xp', await api('GET', '/api/community/leaderboard?board=xp'));
  save('rider-profile', await api('GET', '/api/riders/alice_a'));
  saveStatus('rider-profile-private', await api('GET', '/api/riders/carol_c'));
  save('rider-search', await api('GET', '/api/rider-search?q=a'));
  // ---- Phase 5: sightings, account, moderation ----
  const gallery = await api('GET', '/api/sightings?city=austin&order=desc&limit=1&stats=1');
  save('sightings-austin', gallery);
  save('sightings-austin-page2', await api('GET', `/api/sightings?city=austin&order=desc&limit=1&cursor=${encodeURIComponent(gallery.json.next_cursor)}`));
  save('sightings-all-asc', await api('GET', '/api/sightings?city=all&order=asc&limit=24'));
  saveStatus('error-sightings-invalid-city', await api('GET', '/api/sightings?city=houston'));
  save('service-areas', await api('GET', '/api/service-areas'));
  save('my-submissions', await api('GET', '/api/submissions', { session: 's-dave' }));
  save('sighting-photo-created', await api('POST', '/api/vehicle-sightings/photo', { session: 's-bob', form: { photo: PHOTO, license_plate: 'XVF7777', service_area: 'Austin', notes: 'Fixture sighting.' } }));
  save('sighting-photo-duplicate', await api('POST', '/api/vehicle-sightings/photo', { session: 's-bob', form: { photo: PHOTO, license_plate: 'XVF7777', service_area: 'Austin' } }));
  saveStatus('error-sighting-missing-photo', await api('POST', '/api/vehicle-sightings/photo', { session: 's-bob', form: { service_area: 'Austin' } }));
  saveStatus('error-sighting-invalid-area', await api('POST', '/api/vehicle-sightings/photo', { session: 's-bob', form: { photo: PHOTO, service_area: 'Houston' } }));
  saveStatus('error-sighting-invalid-location', await api('POST', '/api/vehicle-sightings/photo', { session: 's-bob', form: { photo: PHOTO, service_area: 'Austin', approx_location: 'Somewhere I typed' } }));
  saveStatus('error-sighting-invalid-plate', await api('POST', '/api/vehicle-sightings/photo', { session: 's-bob', form: { photo: PHOTO, license_plate: '!!!!' } }));
  saveStatus('error-sighting-signed-out', await api('POST', '/api/vehicle-sightings/photo', { session: 's-expired', form: { photo: PHOTO } }));
  save('profile', await api('GET', '/api/profile', { session: 's-alice' }));
  save('profile-updated', await api('PATCH', '/api/profile', { session: 's-dave', json: { display_name: 'Dave Spotter', handle: 'dave_d', bio: 'Downtown Austin.', profile_visibility: 'private', leaderboard_opt_in: false } }));
  saveStatus('error-handle-taken', await api('PATCH', '/api/profile', { session: 's-bob', json: { display_name: 'Bob B', handle: 'alice_a', bio: '', profile_visibility: 'private', leaderboard_opt_in: true } }));
  saveStatus('error-invalid-handle', await api('PATCH', '/api/profile', { session: 's-bob', json: { display_name: 'Bob B', handle: 'No Spaces!', bio: '', profile_visibility: 'private', leaderboard_opt_in: true } }));
  saveStatus('moderation-access-moderator', await api('GET', '/api/moderation/access', { session: 's-mod' }));
  saveStatus('moderation-access-rider', await api('GET', '/api/moderation/access', { session: 's-bob' }));
  saveStatus('moderation-access-signed-out', await api('GET', '/api/moderation/access'));
  saveStatus('error-moderation-forbidden', await api('GET', '/api/moderation/vehicle-sightings', { session: 's-bob' }));
  save('moderation-sightings', await api('GET', '/api/moderation/vehicle-sightings', { session: 's-mod' }));
  save('moderation-approved-images', await api('GET', '/api/moderation/approved-photo-sightings', { session: 's-mod' }));
  saveStatus('error-reject-needs-reason', await api('PATCH', `/api/moderation/vehicle-sightings/${sights.pendingJson}`, { session: 's-mod', json: { action: 'reject' } }));
  save('moderation-review-approved', await review(sights.pendingJson, 'approve'));
  saveStatus('error-already-reviewed', await review(sights.pendingJson, 'approve'));
  save('moderation-promoted', await api('POST', `/api/moderation/vehicle-sightings/${sights.pendingPhoto}/promote`, { session: 's-mod' }));
  save('moderation-social-overview', await api('GET', '/api/moderation/social/overview', { session: 's-mod' }));
  save('moderation-social-reports', await api('GET', '/api/moderation/social/reports', { session: 's-mod' }));
  save('moderation-social-dismissed', await api('POST', '/api/moderation/social/resolve', { session: 's-mod', json: { target_type: 'post', target_id: ids.anon, action: 'dismiss', reason: 'Fine as is.' } }));
  saveStatus('error-account-confirm-required', await api('DELETE', '/api/account', { session: 's-erin', json: {} }));
  // ---- Phase 5.1: moderation parity ----
  save('moderation-registry-private', await api('GET', '/api/moderation/robotaxi-vehicles?scope=private', { session: 's-mod' }));
  save('moderation-registry-public', await api('GET', '/api/moderation/robotaxi-vehicles?scope=public', { session: 's-mod' }));
  saveStatus('error-registry-not-eligible', await api('POST', `/api/moderation/robotaxi-vehicles/${R.receipt}/review`, { session: 's-mod', json: { action: 'approve_manual' } }));
  save('moderation-registry-approved', await api('POST', `/api/moderation/robotaxi-vehicles/${R.sighting}/review`, { session: 's-mod', json: { action: 'approve_manual' } }));
  saveStatus('error-registry-already-public', await api('POST', `/api/moderation/robotaxi-vehicles/${R.sighting}/review`, { session: 's-mod', json: { action: 'approve_manual' } }));
  saveStatus('error-registry-invalid-vin', await api('POST', `/api/moderation/robotaxi-vehicles/${R.sighting}/vin`, { session: 's-mod', json: { vin: 'NOPE' } }));
  save('moderation-registry-vin-saved', await api('POST', `/api/moderation/robotaxi-vehicles/${R.sighting}/vin`, { session: 's-mod', json: { vin: '7SAYGDEF5TA000555' } }));
  save('moderation-registry-deleted', await api('DELETE', `/api/moderation/robotaxi-vehicles/${R.spare}`, { session: 's-mod' }));
  save('moderation-news', await api('GET', '/api/moderation/news?limit=50', { session: 's-mod' }));
  save('moderation-news-hidden', await api('POST', '/api/moderation/news/00000001-0000-4000-8000-000000000001', { session: 's-mod', json: { action: 'hide' } }));
  saveStatus('error-news-empty-allowlist', await api('PUT', '/api/moderation/news-config', { session: 's-mod', json: { allow: '  ' } }));
  save('moderation-forwarding-stats', await api('GET', '/api/moderation/forwarding-stats', { session: 's-mod' }));
  save('moderation-forwarding-detail', await api('GET', '/api/moderation/forwarding-detail', { session: 's-mod' }));
  save('moderation-riders', await api('GET', '/api/moderation/riders?display_name=ali', { session: 's-mod' }));
  save('moderation-receipt-import', await api('POST', '/api/moderation/receipt-import', { session: 's-mod', json: { rider_user_id: 'dave', items: [
    { kind: 'eml', content: fs.readFileSync(path.join(ROOT, 'tests/fixtures/tesla-receipt-real-format.eml'), 'utf8') },
    { kind: 'text', content: 'Hello, this is not a receipt.' }
  ] } }));
  saveStatus('error-receipt-import-rider', await api('POST', '/api/moderation/receipt-import', { session: 's-mod', json: { rider_user_id: 'nobody', items: [{ kind: 'text', content: 'x' }] } }));
  // Phase 5.1 backend: an upload with a Google picture on record; removing the upload brings Google back.
  d1.prepare(`INSERT INTO users (id, display_name, handle, profile_visibility, leaderboard_opt_in, avatar_url, google_avatar_url) VALUES ('gina', 'Gina G', 'gina_g', 'public', 1, '/api/avatars/fedcba9876543210fedcba9876543210', 'https://lh3.googleusercontent.com/a/gina=s96-c')`)._exec();
  await env.TESLA_SESSIONS.put('session:s-gina', JSON.stringify({ user_id: 'gina' }));
  save('profile-custom-avatar', await api('GET', '/api/profile', { session: 's-gina' }));
  save('me-custom-avatar', await api('GET', '/api/me', { session: 's-gina' }));
  save('avatar-removed-google', await api('DELETE', '/api/profile/avatar', { session: 's-gina' }));
  save('profile-google-avatar', await api('GET', '/api/profile', { session: 's-gina' }));
  saveStatus('error-account-last-moderator', await api('DELETE', '/api/account', { session: 's-mod', json: { confirm: 'DELETE' } }));
  saveStatus('account-deleted', await api('DELETE', '/api/account', { session: 's-erin', json: { confirm: 'DELETE' } }));
  saveStatus('account-deleted-session-ended', await api('GET', '/api/me', { session: 's-erin' }));
  console.log(`Fixtures written to ${out}`);
}
if (port) {
  // Frank: an uploaded photo shown, his Google photo on record (the avatar checks:
  // removing the upload brings the Google one back; migrations/0046).
  d1.prepare(`INSERT INTO users (id, display_name, handle, profile_visibility, leaderboard_opt_in, avatar_url, google_avatar_url) VALUES ('frank', 'Frank F', 'frank_f', 'public', 1, '/api/avatars/0123456789abcdef0123456789abcdef', 'https://lh3.googleusercontent.com/a/test-photo=s96-c')`)._exec();
  await env.TESLA_SESSIONS.put('session:s-frank', JSON.stringify({ user_id: 'frank' }));
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
