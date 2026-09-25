// Tests for POST /api/connector/vehicle-sightings (worker/connector.js): the
// Muse connector's shared-secret, submit-only route. Real SQL via the
// migration-loaded harness and the REAL Worker router, so "the token opens
// this one route and nothing else" is proven at the routing layer.
// Run: node tests/muse-connector.test.mjs

import { makeEnv, seedVehicle, makeCheck } from './helpers/env.mjs';
import worker from '../worker/index.js';
import { CONNECTOR_DAILY_LIMIT } from '../worker/connector.js';

const t = makeCheck();
const { check } = t;

const TOKEN = 'test-connector-token-0123456789abcdef';
const CONNECTOR_USER = 'muse-connector';

async function makeApp({ configured = true } = {}) {
  const ctx = await makeEnv({ users: [CONNECTOR_USER, 'u1'] });
  await ctx.env.TESLA_SESSIONS.put('session:session-u1', JSON.stringify({ user_id: 'u1' }));
  if (configured) {
    ctx.env.MUSE_CONNECTOR_TOKEN = TOKEN;
    ctx.env.MUSE_CONNECTOR_USER_ID = CONNECTOR_USER;
  }
  return ctx;
}

function send(ctx, body, authorization, path = '/api/connector/vehicle-sightings') {
  const headers = { 'Content-Type': 'application/json' };
  if (authorization) headers.Authorization = authorization;
  return worker.fetch(new Request('https://x' + path, { method: 'POST', headers, body: JSON.stringify(body) }), ctx.env, {});
}
const asConnector = (ctx, body) => send(ctx, body, `Bearer ${TOKEN}`);
const count = (ctx, sql, ...args) => ctx.d1.query(sql, ...args)[0].n;
const sightingsFor = (ctx, userId) => count(ctx, `SELECT COUNT(*) n FROM submissions WHERE user_id = ? AND submission_type = 'vehicle_sighting'`, userId);

function seedSubmissions(ctx, n, submittedAt) {
  for (let i = 0; i < n; i++) {
    ctx.d1.exec(`INSERT INTO submissions (id, user_id, submission_type, status, submitted_at) VALUES ('seed-${submittedAt.slice(0, 10)}-${i}', '${CONNECTOR_USER}', 'vehicle_sighting', 'pending', '${submittedAt}')`);
  }
}

async function run() {
  console.log('1. Authentication: only the exact token is accepted');
  {
    const ctx = await makeApp();
    const cases = [
      ['no Authorization header', null],
      ['a wrong token', 'Bearer wrong-token'],
      ['a prefix of the real token', `Bearer ${TOKEN.slice(0, -1)}`],
      ['the real token with extra characters', `Bearer ${TOKEN}x`],
      ['the right token without the Bearer scheme', TOKEN],
      ['an empty bearer value', 'Bearer ']
    ];
    for (const [label, header] of cases) {
      const resp = await send(ctx, { service_area: 'Dallas' }, header);
      check(`${label} is refused with 401`, resp.status === 401);
      check(`${label}: no token text is echoed back`, !(await resp.text()).includes(TOKEN));
    }
    check('nothing was written by any refused attempt', sightingsFor(ctx, CONNECTOR_USER) === 0);
    const ok = await asConnector(ctx, { service_area: 'Dallas' });
    check('the exact token succeeds (201)', ok.status === 201);
    const lower = await send(ctx, { service_area: 'Austin' }, `bearer ${TOKEN}`);
    check('the Bearer scheme is case-insensitive, as HTTP allows', lower.status === 201);
  }

  console.log('2. Fails closed when the connector is not configured');
  {
    const ctx = await makeApp({ configured: false });
    const resp = await send(ctx, { service_area: 'Dallas' }, `Bearer ${TOKEN}`);
    check('no secrets set: 503, never accepted', resp.status === 503);
    ctx.env.MUSE_CONNECTOR_TOKEN = TOKEN; // token set but no user
    const noUser = await send(ctx, { service_area: 'Dallas' }, `Bearer ${TOKEN}`);
    check('token set but no attribution user: 503, never accepted', noUser.status === 503);
    ctx.env.MUSE_CONNECTOR_TOKEN = '';
    ctx.env.MUSE_CONNECTOR_USER_ID = CONNECTOR_USER;
    const emptyToken = await send(ctx, { service_area: 'Dallas' }, 'Bearer ');
    check('an empty configured token is treated as not configured (503), never as a match', emptyToken.status === 503);
    check('nothing was written in any unconfigured case', sightingsFor(ctx, CONNECTOR_USER) === 0);
  }

  console.log('3. A submission is a normal pending sighting owned by the connector user');
  {
    const ctx = await makeApp();
    const vehId = seedVehicle(ctx.d1, { id: 'veh1', plate: 'XJR2195', model: 'Model Y' });
    ctx.d1.exec(`UPDATE robotaxi_vehicles SET last_seen_at = '2020-01-01 00:00:00' WHERE id = 'veh1'`);
    const before = ctx.d1.query('SELECT * FROM robotaxi_vehicles ORDER BY id');

    const resp = await asConnector(ctx, { license_plate: 'xjr-2195', service_area: 'Dallas', user_id: 'u1', status: 'approved' });
    const body = await resp.json();
    check('the request succeeds (201)', resp.status === 201 && body.success === true);
    const sub = ctx.d1.query('SELECT * FROM submissions WHERE id = ?', body.submission_id)[0];
    const obs = ctx.d1.query('SELECT * FROM vehicle_observations WHERE id = ?', body.observation_id)[0];
    check('owned by the connector user; a spoofed user_id in the body is ignored', sub.user_id === CONNECTOR_USER && obs.user_id === CONNECTOR_USER);
    check('nothing was written for the spoofed rider', sightingsFor(ctx, 'u1') === 0);
    check('submission is pending and the body cannot pre-approve it', sub.status === 'pending' && sub.reviewed_at === null && sub.reviewed_by === null);
    check('observation is unverified', obs.verification_status === 'unverified');
    const queue = ctx.d1.query(`SELECT COUNT(*) n FROM submissions WHERE id = ? AND status IN ('pending','needs_review')`, body.submission_id)[0].n;
    check('it is waiting in the moderation review queue', queue === 1);
    check('the registry is byte-for-byte untouched (no vehicle created or modified)',
      JSON.stringify(ctx.d1.query('SELECT * FROM robotaxi_vehicles ORDER BY id')) === JSON.stringify(before));

    const bad = await asConnector(ctx, { license_plate: '!!!', service_area: 'Dallas' });
    check('the shared validation still applies (bad plate -> 400)', bad.status === 400);
  }

  console.log('4. The token opens this one route and nothing else');
  {
    const ctx = await makeApp();
    const bearer = { Authorization: `Bearer ${TOKEN}` };
    const gets = ['/api/me', '/api/profile', '/api/trips', '/api/submissions', '/api/rides/sync-status', '/api/receipt-ingestion/address',
      '/api/moderation/access', '/api/moderation/vehicle-sightings', '/api/moderation/robotaxi-vehicles'];
    for (const path of gets) {
      const resp = await worker.fetch(new Request('https://x' + path, { headers: bearer }), ctx.env, {});
      check(`GET ${path} with the connector token is refused`, resp.status === 401 || resp.status === 403);
    }
    const riderRoute = await send(ctx, { service_area: 'Dallas' }, `Bearer ${TOKEN}`, '/api/vehicle-sightings');
    check('the rider sighting route does not accept the connector token', riderRoute.status === 401);
    const del = await worker.fetch(new Request('https://x/api/trips', { method: 'DELETE', headers: bearer }), ctx.env, {});
    check('a destructive rider route does not accept the connector token', del.status === 401);
    const mod = await worker.fetch(new Request('https://x/api/moderation/robotaxi-vehicles/veh1/review', {
      method: 'POST', headers: { ...bearer, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'approve_public' })
    }), ctx.env, {});
    check('moderation actions do not accept the connector token', mod.status === 401 || mod.status === 403);

    const sessionOnConnector = await send(ctx, { service_area: 'Dallas' }, 'Bearer session-u1');
    check('a real rider session token is NOT accepted on the connector route', sessionOnConnector.status === 401);
    check('nothing was written by any of the refused requests', sightingsFor(ctx, CONNECTOR_USER) === 0 && sightingsFor(ctx, 'u1') === 0);
  }

  console.log('5. Daily cap: 50 per rolling 24h, then 429');
  {
    const ctx = await makeApp();
    seedSubmissions(ctx, CONNECTOR_DAILY_LIMIT - 1, new Date().toISOString().slice(0, 19).replace('T', ' '));
    const last = await asConnector(ctx, { service_area: 'Dallas' });
    check(`submission #${CONNECTOR_DAILY_LIMIT} (the last one allowed) succeeds`, last.status === 201);
    const over = await asConnector(ctx, { service_area: 'Dallas' });
    const overBody = await over.json();
    check('the next one is refused with 429', over.status === 429);
    check('the 429 says why and carries Retry-After', overBody.error === 'daily_limit_reached' && over.headers.get('Retry-After') === '3600');
    check('the refused request wrote nothing', sightingsFor(ctx, CONNECTOR_USER) === CONNECTOR_DAILY_LIMIT);
    const wrongToken = await send(ctx, { service_area: 'Dallas' }, 'Bearer nope');
    check('a wrong token is still 401 (not 429) even at the cap', wrongToken.status === 401);
    check('the cap is per-connector: a rider is not blocked by it', (await send(ctx, { service_area: 'Dallas' }, 'Bearer session-u1', '/api/vehicle-sightings')).status === 201);
  }
  {
    const ctx = await makeApp();
    seedSubmissions(ctx, CONNECTOR_DAILY_LIMIT + 10, '2020-01-01 00:00:00');
    const resp = await asConnector(ctx, { service_area: 'Dallas' });
    check('submissions older than 24h do not count toward the cap', resp.status === 201);
  }
  {
    const ctx = await makeApp();
    const first = await asConnector(ctx, { license_plate: 'ABC1234', service_area: 'Dallas' });
    const replay = await asConnector(ctx, { license_plate: 'ABC1234', service_area: 'Dallas' });
    const replayBody = await replay.json();
    check('an immediate duplicate replay creates nothing new', first.status === 201 && replayBody.duplicate === true && sightingsFor(ctx, CONNECTOR_USER) === 1);
  }

  console.log('6. Public reads stay open with no token');
  {
    const ctx = await makeApp();
    for (const path of ['/api/registry/stats', '/api/robotaxi-vehicles']) {
      const resp = await worker.fetch(new Request('https://x' + path), ctx.env, {});
      check(`GET ${path} works with no Authorization header`, resp.status === 200);
    }
  }

  console.log('7. Errors do not leak internals or the token');
  {
    const ctx = await makeApp();
    const broken = { ...ctx.env, cybercabhunter_db: { prepare() { throw new Error('db exploded'); } } };
    const resp = await worker.fetch(new Request('https://x/api/connector/vehicle-sightings', {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ service_area: 'Dallas' })
    }), broken, {});
    const text = await resp.text();
    check('a database failure returns a clean JSON 500', resp.status === 500 && JSON.parse(text).error === 'connector_unavailable');
    check('the error body has no exception text and no token', !/db exploded/.test(text) && !text.includes(TOKEN));
  }

  t.finish();
}

run().catch(err => { console.error(err); process.exit(1); });
