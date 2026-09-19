// Tests for the Tesla Fleet API OAuth start/callback in worker/tesla.js,
// focused on the ?session= "attach to an already signed-in account" path
// (e.g. a user who signed in with Google first, then links Tesla) added
// alongside the original sign-in-with-Tesla-creates-a-new-account path.
// Uses an in-memory fake KV and a small fake D1 simulating users/
// tesla_connections, including the real (provider, tesla_account_identifier)
// unique-index conflict when a Tesla account is already linked elsewhere.
// Run: node tests/tesla-oauth.test.mjs

import { tesla } from '../worker/tesla.js';

let pass = 0, fail = 0;
function check(label, condition) {
  if (condition) { pass++; console.log(`  ok — ${label}`); }
  else { fail++; console.log(`  FAIL — ${label}`); }
}

const ENCRYPTION_KEY_B64 = (() => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  bytes.forEach(b => { binary += String.fromCharCode(b); });
  return btoa(binary);
})();

function makeIdToken(sub) {
  const b64url = obj => btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64url({ alg: 'none' })}.${b64url({ sub })}.sig`;
}

function fakeKV() {
  const store = new Map();
  return {
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); },
    _store: store
  };
}

function fakeD1() {
  const users = new Map(); // id -> row
  const connections = new Map(); // user_id -> row
  function stmt(sql) {
    const s = { _sql: sql, _args: [] };
    s.bind = (...args) => { s._args = args; return s; };
    s.run = async () => {
      if (/INSERT INTO users \(id\) VALUES/.test(sql)) {
        const [id] = s._args;
        users.set(id, { id, display_name: null, avatar_url: null, created_at: 'now' });
      } else if (/INSERT INTO tesla_connections/.test(sql)) {
        const [, userId, teslaAccountIdentifier] = s._args;
        if (teslaAccountIdentifier) {
          for (const [otherUserId, row] of connections) {
            if (otherUserId !== userId && row.tesla_account_identifier === teslaAccountIdentifier) {
              throw new Error('D1_ERROR: UNIQUE constraint failed: tesla_connections.provider, tesla_connections.tesla_account_identifier');
            }
          }
        }
        connections.set(userId, {
          user_id: userId, tesla_account_identifier: teslaAccountIdentifier, status: 'active'
        });
      } else if (/UPDATE tesla_connections SET status = 'revoked', tesla_account_identifier = NULL/.test(sql)) {
        const [userId] = s._args;
        const row = connections.get(userId);
        if (row) { row.status = 'revoked'; row.tesla_account_identifier = null; }
      } else if (/UPDATE tesla_connections SET status = 'revoked'/.test(sql)) {
        const [userId] = s._args;
        const row = connections.get(userId);
        if (row) row.status = 'revoked';
      }
      return { success: true };
    };
    s.first = async () => {
      if (/SELECT user_id FROM tesla_connections WHERE provider = 'tesla' AND tesla_account_identifier = \?/.test(sql)) {
        const [identifier] = s._args;
        for (const row of connections.values()) {
          if (row.tesla_account_identifier === identifier) return { user_id: row.user_id };
        }
        return null;
      }
      if (/SELECT \* FROM tesla_connections WHERE user_id = \?/.test(sql)) {
        const [userId] = s._args;
        return connections.get(userId) || null;
      }
      if (/SELECT \* FROM users WHERE id = \?/.test(sql)) {
        const [id] = s._args;
        return users.get(id) || null;
      }
      return null;
    };
    return s;
  }
  return { prepare: sql => stmt(sql), _users: users, _connections: connections };
}

function makeEnv() {
  return {
    TESLA_SESSIONS: fakeKV(),
    cybercabhunter_db: fakeD1(),
    TESLA_TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY_B64,
    FRONTEND_URL: 'https://cybercabhunter.com/',
    TESLA_CLIENT_ID: 'test-tesla-client-id',
    TESLA_CLIENT_SECRET: 'test-tesla-client-secret'
  };
}

let originalFetch;
function mockFetch(handler) {
  originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
}
function restoreFetch() {
  globalThis.fetch = originalFetch;
}

function mockTeslaNetwork(sub) {
  mockFetch(async (url) => {
    if (String(url).includes('fleet-auth')) {
      return new Response(JSON.stringify({ access_token: 'tok', refresh_token: 'reftok', expires_in: 28800, id_token: makeIdToken(sub) }), { status: 200 });
    }
    if (String(url).includes('/api/1/vehicles')) {
      return new Response(JSON.stringify({ response: [] }), { status: 200 });
    }
    throw new Error(`unexpected fetch to ${url}`);
  });
}

async function completeFlow(env, startUrl, sub) {
  const startResp = await tesla.startOAuth(new Request(startUrl), env);
  const state = new URL(startResp.headers.get('Location')).searchParams.get('state');
  mockTeslaNetwork(sub);
  try {
    return await tesla.handleCallback(new Request(`https://x/oauth/tesla/callback?code=c&state=${state}`), env);
  } finally {
    restoreFetch();
  }
}

async function run() {
  console.log('1. classic flow (no ?session=) is unchanged: creates a new user and a new session');
  {
    const env = makeEnv();
    const resp = await completeFlow(env, 'https://x/oauth/tesla/start', 'tesla-sub-classic');
    check('redirects with tesla=linked', resp.status === 302 && resp.headers.get('Location').startsWith('https://cybercabhunter.com/?tesla=linked'));
    check('a new session id is handed back via the fragment', /#tesla_session=[a-f0-9]+$/.test(resp.headers.get('Location')));
    check('exactly one user was created', env.cybercabhunter_db._users.size === 1);
  }

  console.log('2. ?session= with no valid session behaves exactly like the classic flow');
  {
    const env = makeEnv();
    const resp = await completeFlow(env, 'https://x/oauth/tesla/start?session=not-a-real-session', 'tesla-sub-noauth');
    check('still creates a new user (invalid session ignored, not treated as an error)', env.cybercabhunter_db._users.size === 1);
    check('still hands back a new session', /#tesla_session=/.test(resp.headers.get('Location')));
  }

  console.log('3. ?session= with a valid existing session attaches Tesla to that SAME user, no new user/session');
  {
    const env = makeEnv();
    const existingUserId = 'google-user-abc';
    env.cybercabhunter_db._users.set(existingUserId, { id: existingUserId, display_name: 'Ada', avatar_url: null });
    const priorSessionId = 'existing-google-session';
    await env.TESLA_SESSIONS.put(`session:${priorSessionId}`, JSON.stringify({ user_id: existingUserId }));

    const resp = await completeFlow(env, `https://x/oauth/tesla/start?session=${priorSessionId}`, 'tesla-sub-attach');

    check('redirects with tesla=linked', resp.status === 302 && resp.headers.get('Location').startsWith('https://cybercabhunter.com/?tesla=linked'));
    check('no new session fragment — the existing session already covers this user', !resp.headers.get('Location').includes('#tesla_session='));
    check('no second user row was created', env.cybercabhunter_db._users.size === 1);
    check('the Tesla connection was attached to the EXISTING user, not a new one', env.cybercabhunter_db._connections.get(existingUserId).tesla_account_identifier === 'tesla-sub-attach');

    const stillValid = await env.TESLA_SESSIONS.get(`session:${priorSessionId}`);
    check('the original session is untouched and still maps to the same user', JSON.parse(stillValid).user_id === existingUserId);
  }

  console.log('4. linking a Tesla account already claimed by a DIFFERENT user is rejected, not merged/reattached');
  {
    const env = makeEnv();
    const userA = 'user-a';
    const userB = 'user-b';
    env.cybercabhunter_db._users.set(userA, { id: userA });
    env.cybercabhunter_db._users.set(userB, { id: userB });
    env.cybercabhunter_db._connections.set(userA, { user_id: userA, tesla_account_identifier: 'shared-tesla-sub', status: 'active' });

    const sessionB = 'session-for-b';
    await env.TESLA_SESSIONS.put(`session:${sessionB}`, JSON.stringify({ user_id: userB }));

    const resp = await completeFlow(env, `https://x/oauth/tesla/start?session=${sessionB}`, 'shared-tesla-sub');

    check('redirects with tesla=already_linked_elsewhere, not tesla=linked', resp.status === 302 && resp.headers.get('Location').includes('tesla=already_linked_elsewhere'));
    check('user B still has no Tesla connection row', !env.cybercabhunter_db._connections.has(userB));
    check("user A's connection is untouched", env.cybercabhunter_db._connections.get(userA).tesla_account_identifier === 'shared-tesla-sub');
  }

  console.log('5. state is single-use and encodes existing_user_id server-side, not client-suppliable');
  {
    const env = makeEnv();
    const existingUserId = 'sneaky-target-user';
    const sessionId = 'real-session';
    await env.TESLA_SESSIONS.put(`session:${sessionId}`, JSON.stringify({ user_id: existingUserId }));
    env.cybercabhunter_db._users.set(existingUserId, { id: existingUserId });

    const startResp = await tesla.startOAuth(new Request(`https://x/oauth/tesla/start?session=${sessionId}`), env);
    const state = new URL(startResp.headers.get('Location')).searchParams.get('state');
    const stored = JSON.parse(await env.TESLA_SESSIONS.get(`state:${state}`));
    check('state carries the resolved existing_user_id, not the raw session id', stored.existing_user_id === existingUserId);

    mockTeslaNetwork('replay-sub');
    try {
      await tesla.handleCallback(new Request(`https://x/oauth/tesla/callback?code=c&state=${state}`), env);
      const replay = await tesla.handleCallback(new Request(`https://x/oauth/tesla/callback?code=c2&state=${state}`), env);
      check('replaying the same state a second time fails as invalid_state', replay.status === 302 && replay.headers.get('Location').includes('invalid_state'));
    } finally {
      restoreFetch();
    }
  }

  console.log('6. apiDisconnect unlinks Tesla without signing the user out, and frees the identifier for relinking');
  {
    const env = makeEnv();
    const existingUserId = 'google-user-unlink-test';
    const sessionId = 'session-to-keep';
    env.cybercabhunter_db._users.set(existingUserId, { id: existingUserId });
    await env.TESLA_SESSIONS.put(`session:${sessionId}`, JSON.stringify({ user_id: existingUserId }));

    await completeFlow(env, `https://x/oauth/tesla/start?session=${sessionId}`, 'unlink-test-sub');
    check('connection is active before unlinking', env.cybercabhunter_db._connections.get(existingUserId).status === 'active');

    const resp = await tesla.apiDisconnect(new Request('https://x/api/tesla/disconnect', {
      method: 'POST', headers: { Authorization: `Bearer ${sessionId}` }
    }), env);
    const body = await resp.json();
    check('reports success, connected: false', resp.status === 200 && body.success === true && body.connected === false);

    check('connection row marked revoked', env.cybercabhunter_db._connections.get(existingUserId).status === 'revoked');
    check('tesla_account_identifier cleared so it can be relinked elsewhere', env.cybercabhunter_db._connections.get(existingUserId).tesla_account_identifier === null);

    const stillValid = await env.TESLA_SESSIONS.get(`session:${sessionId}`);
    check('the browser session is NOT destroyed by unlinking Tesla', JSON.parse(stillValid).user_id === existingUserId);

    console.log('  7. that freed Tesla identity can now be linked to a DIFFERENT user');
    const otherUserId = 'a-different-user';
    const otherSession = 'other-session';
    env.cybercabhunter_db._users.set(otherUserId, { id: otherUserId });
    await env.TESLA_SESSIONS.put(`session:${otherSession}`, JSON.stringify({ user_id: otherUserId }));

    const relinkResp = await completeFlow(env, `https://x/oauth/tesla/start?session=${otherSession}`, 'unlink-test-sub');
    check('relinking the same Tesla account to a different user now succeeds', relinkResp.status === 302 && relinkResp.headers.get('Location').includes('tesla=linked'));
    check('the new user now holds that Tesla identifier', env.cybercabhunter_db._connections.get(otherUserId).tesla_account_identifier === 'unlink-test-sub');
  }
}

run().then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
});
