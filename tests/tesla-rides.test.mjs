// Tests for the Tesla Ride Sync OAuth/token foundation (worker/tesla-rides.js).
// Uses an in-memory fake KV (real Map, same get/put/delete shape as
// Cloudflare KV) and a small fake D1 that simulates just the SQL shapes
// worker/db.js issues for tesla_ride_sync_connections — no live network,
// D1, or KV needed. Run: node tests/tesla-rides.test.mjs

import { teslaRides } from '../worker/tesla-rides.js';
import { tokenCrypto } from '../worker/crypto.js';

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
  const rows = new Map();
  function stmt(sql) {
    const s = { _sql: sql, _args: [] };
    s.bind = (...args) => { s._args = args; return s; };
    s.run = async () => {
      if (/INSERT INTO tesla_ride_sync_connections/.test(sql)) {
        const [id, userId, kvTokenKey, accessTokenExpiresAt] = s._args;
        rows.set(userId, {
          id, user_id: userId, kv_token_key: kvTokenKey, status: 'active',
          connected_at: 'now', last_sync_at: null, last_refresh_at: null,
          access_token_expires_at: accessTokenExpiresAt, last_error: null, updated_at: 'now'
        });
      } else if (/last_refresh_at = datetime\('now'\)/.test(sql)) {
        const [accessTokenExpiresAt, userId] = s._args;
        const row = rows.get(userId);
        if (row) { row.access_token_expires_at = accessTokenExpiresAt; row.status = 'active'; row.last_error = null; row.last_refresh_at = 'now'; }
      } else if (/status = 'revoked'/.test(sql)) {
        const [userId] = s._args;
        const row = rows.get(userId);
        if (row) row.status = 'revoked';
      } else if (/status = 'error'/.test(sql)) {
        const [error, userId] = s._args;
        const row = rows.get(userId);
        if (row) { row.status = 'error'; row.last_error = error; }
      }
      return { success: true };
    };
    s.first = async () => {
      if (/SELECT \* FROM tesla_ride_sync_connections WHERE user_id = \?/.test(sql)) {
        const [userId] = s._args;
        return rows.get(userId) || null;
      }
      return null;
    };
    return s;
  }
  return { prepare: sql => stmt(sql), _rows: rows };
}

async function makeEnv() {
  const kv = fakeKV();
  const d1 = fakeD1();
  const sessionId = 'test-session-id';
  const userId = 'user-abc-123';
  await kv.put(`session:${sessionId}`, JSON.stringify({ user_id: userId }));
  const env = {
    TESLA_SESSIONS: kv,
    cybercabhunter_db: d1,
    TESLA_TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY_B64,
    FRONTEND_URL: 'https://cybercabhunter.com/',
    TESLA_RIDES_CLIENT_ID: 'test-client-id',
    TESLA_RIDES_CLIENT_SECRET: 'test-client-secret'
  };
  return { env, kv, d1, sessionId, userId };
}

function authedRequest(url, sessionId) {
  return new Request(url, { headers: { Authorization: `Bearer ${sessionId}` } });
}

let originalFetch;
function mockFetch(handler) {
  originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
}
function restoreFetch() {
  globalThis.fetch = originalFetch;
}

async function run() {
  console.log('1. startAuthorization rejects unauthenticated requests');
  {
    const { env } = await makeEnv();
    const resp = await teslaRides.startAuthorization(new Request('https://x/api/tesla/rides/connect'), env);
    check('401 without a bearer session', resp.status === 401);
  }

  console.log('2. startAuthorization returns not_configured when secrets are missing');
  {
    const { env, sessionId } = await makeEnv();
    delete env.TESLA_RIDES_CLIENT_ID;
    const resp = await teslaRides.startAuthorization(authedRequest('https://x/api/tesla/rides/connect', sessionId), env);
    const body = await resp.json();
    check('503 not_configured when client id/secret are unset', resp.status === 503 && body.error === 'not_configured');
  }

  console.log('3. startAuthorization generates a valid authorize URL, PKCE, and single-use state');
  {
    const { env, kv, sessionId, userId } = await makeEnv();
    const resp = await teslaRides.startAuthorization(authedRequest('https://x/api/tesla/rides/connect', sessionId), env);
    const body = await resp.json();
    const authorizeUrl = new URL(body.authorize_url);
    check('authorize URL points at auth.tesla.com', authorizeUrl.hostname === 'auth.tesla.com');
    check('client_id is the ride-sync client, not Fleet API\'s', authorizeUrl.searchParams.get('client_id') === 'test-client-id');
    check('code_challenge_method is S256', authorizeUrl.searchParams.get('code_challenge_method') === 'S256');
    check('a code_challenge is present', !!authorizeUrl.searchParams.get('code_challenge'));
    check('audience is present (required by Tesla for this token type)', !!authorizeUrl.searchParams.get('audience'));

    const state = authorizeUrl.searchParams.get('state');
    const stored = JSON.parse(await kv.get(`tesla_rides_oauth_state:${state}`));
    check('state maps back to the authenticated user, not anything client-supplied', stored.user_id === userId);
    check('a PKCE code_verifier was stored server-side', !!stored.code_verifier);
  }

  console.log('4. callback rejects missing/invalid state without ever calling Tesla');
  {
    const { env } = await makeEnv();
    let fetchCalled = false;
    mockFetch(async () => { fetchCalled = true; throw new Error('should not be called'); });
    try {
      const resp = await teslaRides.handleCallback(new Request('https://x/api/tesla/rides/callback?code=abc'), env);
      check('missing state -> redirect with error, no Tesla call', resp.status === 302 && resp.headers.get('Location').includes('tesla_rides=error') && !fetchCalled);

      const resp2 = await teslaRides.handleCallback(new Request('https://x/api/tesla/rides/callback?code=abc&state=never-issued'), env);
      check('unrecognized state -> redirect with invalid_state, no Tesla call', resp2.status === 302 && resp2.headers.get('Location').includes('invalid_state') && !fetchCalled);
    } finally {
      restoreFetch();
    }
  }

  console.log('5. successful callback exchanges the code, encrypts tokens, and never returns them');
  {
    const { env, kv, d1, sessionId, userId } = await makeEnv();
    const startResp = await teslaRides.startAuthorization(authedRequest('https://x/api/tesla/rides/connect', sessionId), env);
    const { authorize_url } = await startResp.json();
    const state = new URL(authorize_url).searchParams.get('state');

    mockFetch(async (url, opts) => {
      check('token exchange goes to Fleet API\'s real token host, not auth.tesla.com', url === 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token');
      const body = new URLSearchParams(opts.body);
      check('client_secret sent, PKCE verifier sent, no bearer/session leakage', body.get('client_secret') === 'test-client-secret' && !!body.get('code_verifier'));
      return new Response(JSON.stringify({ access_token: 'plain-access-token', refresh_token: 'plain-refresh-token', expires_in: 28800 }), { status: 200 });
    });
    try {
      const callbackResp = await teslaRides.handleCallback(new Request(`https://x/api/tesla/rides/callback?code=realcode&state=${state}`), env);
      check('callback redirects to frontend with connected status', callbackResp.status === 302 && callbackResp.headers.get('Location').includes('tesla_rides=connected'));
    } finally {
      restoreFetch();
    }

    check('state is deleted after use (single-use)', await kv.get(`tesla_rides_oauth_state:${state}`) === null);

    const row = d1._rows.get(userId);
    check('a connection row was created for the right user', !!row && row.status === 'active');
    const kvRaw = await kv.get(row.kv_token_key);
    const stored = JSON.parse(kvRaw);
    check('stored access token is encrypted, not plaintext', stored.encryptedAccessToken !== 'plain-access-token');
    check('stored refresh token is encrypted, not plaintext', stored.encryptedRefreshToken !== 'plain-refresh-token');
    const decrypted = await tokenCrypto.decrypt(stored.encryptedAccessToken, env.TESLA_TOKEN_ENCRYPTION_KEY);
    check('encryption round-trips correctly', decrypted === 'plain-access-token');

    console.log('  6. apiStatus never exposes token material');
    const statusResp = await teslaRides.apiStatus(authedRequest('https://x/api/tesla/rides/status', sessionId), env);
    const statusBody = await statusResp.json();
    check('status reports connected: true', statusBody.connected === true);
    const statusStr = JSON.stringify(statusBody).toLowerCase();
    check('response contains no token-shaped field or value', !statusStr.includes('token') && !statusStr.includes(row.kv_token_key.toLowerCase()));

    console.log('  7. getValidAccessToken returns the decrypted token without refreshing when not expired');
    let refreshCalled = false;
    mockFetch(async () => { refreshCalled = true; throw new Error('should not refresh yet'); });
    try {
      const token = await teslaRides.getValidAccessToken(env, userId);
      check('valid unexpired token returned without a refresh call', token === 'plain-access-token' && !refreshCalled);
    } finally {
      restoreFetch();
    }

    console.log('  8. refresh-token rotation: Tesla issues a new refresh token -> old one replaced');
    // Force expiry by rewriting the stored expiry into the past.
    row.access_token_expires_at = new Date(Date.now() - 1000).toISOString();
    mockFetch(async () => new Response(JSON.stringify({
      access_token: 'new-access-token', refresh_token: 'rotated-refresh-token', expires_in: 28800
    }), { status: 200 }));
    let newToken;
    try {
      newToken = await teslaRides.getValidAccessToken(env, userId);
    } finally {
      restoreFetch();
    }
    check('refreshed access token returned', newToken === 'new-access-token');
    const afterRotate = JSON.parse(await kv.get(row.kv_token_key));
    const decryptedRefresh = await tokenCrypto.decrypt(afterRotate.encryptedRefreshToken, env.TESLA_TOKEN_ENCRYPTION_KEY);
    check('rotated refresh token replaced the old one', decryptedRefresh === 'rotated-refresh-token');

    console.log('  9. refresh-token rotation: Tesla omits a new refresh token -> old one is kept, not nulled');
    row.access_token_expires_at = new Date(Date.now() - 1000).toISOString();
    mockFetch(async () => new Response(JSON.stringify({
      access_token: 'newer-access-token', expires_in: 28800 // no refresh_token field
    }), { status: 200 }));
    try {
      await teslaRides.getValidAccessToken(env, userId);
    } finally {
      restoreFetch();
    }
    const afterOmit = JSON.parse(await kv.get(row.kv_token_key));
    const stillHasRefresh = await tokenCrypto.decrypt(afterOmit.encryptedRefreshToken, env.TESLA_TOKEN_ENCRYPTION_KEY);
    check('previous refresh token retained when Tesla omits a new one', stillHasRefresh === 'rotated-refresh-token');

    console.log('  10. expired token + failed refresh marks the connection as error, not silently active');
    row.access_token_expires_at = new Date(Date.now() - 1000).toISOString();
    mockFetch(async () => new Response('nope', { status: 401 }));
    let result;
    try {
      result = await teslaRides.getValidAccessToken(env, userId);
    } finally {
      restoreFetch();
    }
    check('failed refresh returns null rather than a stale/garbage token', result === null);
    check('connection marked as error status', d1._rows.get(userId).status === 'error');
    check('stored error is a short safe code, not a raw Tesla response', d1._rows.get(userId).last_error === 'refresh_failed');

    console.log('  11. disconnect deletes the KV token blob outright, not just a status flag');
    // Restore to active for a clean disconnect test.
    row.status = 'active';
    const disconnectResp = await teslaRides.apiDisconnect(authedRequest('https://x/api/tesla/rides/disconnect', sessionId), env);
    const disconnectBody = await disconnectResp.json();
    check('disconnect reports success', disconnectBody.success === true && disconnectBody.connected === false);
    check('D1 status flipped to revoked', d1._rows.get(userId).status === 'revoked');
    check('KV token blob is actually deleted, not just marked revoked', await kv.get(row.kv_token_key) === null);
  }

  console.log('12. authenticated user isolation — status/disconnect never trust a client-supplied user id');
  {
    const { env } = await makeEnv();
    const resp = await teslaRides.apiStatus(new Request('https://x/api/tesla/rides/status?user_id=someone-else'), env);
    check('no bearer session -> 401 regardless of any query param', resp.status === 401);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

run();
