// Tests for Google Sign-In (worker/google-auth.js). Uses an in-memory fake
// KV (real Map, same get/put/delete shape as Cloudflare KV) and a small
// fake D1 that simulates just the SQL shapes worker/db.js issues for
// users/google_connections — no live network, D1, or KV needed.
// Run: node tests/google-auth.test.mjs

import { googleAuth } from '../worker/google-auth.js';

let pass = 0, fail = 0;
function check(label, condition) {
  if (condition) { pass++; console.log(`  ok — ${label}`); }
  else { fail++; console.log(`  FAIL — ${label}`); }
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
  const users = new Map();
  const googleConnections = new Map(); // google_sub -> user_id
  function stmt(sql) {
    const s = { _sql: sql, _args: [] };
    s.bind = (...args) => { s._args = args; return s; };
    s.run = async () => {
      if (/INSERT INTO users/.test(sql)) {
        const [id, displayName, avatarUrl] = s._args;
        users.set(id, { id, display_name: displayName, avatar_url: avatarUrl });
      } else if (/INSERT INTO google_connections/.test(sql)) {
        const [, userId, googleSub, email] = s._args;
        googleConnections.set(googleSub, { user_id: userId, email });
      }
      return { success: true };
    };
    s.first = async () => {
      if (/SELECT user_id FROM google_connections WHERE google_sub = \?/.test(sql)) {
        const [googleSub] = s._args;
        return googleConnections.has(googleSub) ? { user_id: googleConnections.get(googleSub).user_id } : null;
      }
      return null;
    };
    return s;
  }
  return { prepare: sql => stmt(sql), _users: users, _googleConnections: googleConnections };
}

function makeEnv(overrides = {}) {
  return {
    TESLA_SESSIONS: fakeKV(),
    cybercabhunter_db: fakeD1(),
    FRONTEND_URL: 'https://cybercabhunter.com/',
    GOOGLE_CLIENT_ID: 'test-google-client-id',
    GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
    GOOGLE_REDIRECT_URI: 'https://cybercabhunter.com/oauth/google/callback',
    ...overrides
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

async function run() {
  console.log('1. startOAuth returns not_configured when GOOGLE_CLIENT_ID is missing');
  {
    const env = makeEnv({ GOOGLE_CLIENT_ID: undefined });
    const resp = await googleAuth.startOAuth(new Request('https://x/oauth/google/start'), env);
    const body = await resp.json();
    check('503 not_configured', resp.status === 503 && body.error === 'google_signin_not_configured');
  }

  console.log('2. startOAuth builds a correct authorize URL and single-use state, never exposing the secret');
  {
    const env = makeEnv();
    const resp = await googleAuth.startOAuth(new Request('https://x/oauth/google/start'), env);
    check('302 redirect', resp.status === 302);
    const location = resp.headers.get('Location');
    const authorizeUrl = new URL(location);
    check('redirects to accounts.google.com', authorizeUrl.hostname === 'accounts.google.com');
    check('client_id present, matches configured value', authorizeUrl.searchParams.get('client_id') === 'test-google-client-id');
    check('redirect_uri is the pinned callback URL', authorizeUrl.searchParams.get('redirect_uri') === 'https://cybercabhunter.com/oauth/google/callback');
    check('scope requests openid email profile', authorizeUrl.searchParams.get('scope') === 'openid email profile');
    check('client_secret never appears in the redirect URL', !location.includes('test-google-client-secret'));

    const state = authorizeUrl.searchParams.get('state');
    check('a state value was issued', !!state);
    const stored = await env.TESLA_SESSIONS.get(`google_state:${state}`);
    check('state was recorded server-side for single-use validation', stored === '1');
  }

  console.log('3. handleCallback redirects on cancellation without touching state/network');
  {
    const env = makeEnv();
    let fetchCalled = false;
    mockFetch(async () => { fetchCalled = true; throw new Error('should not be called'); });
    try {
      const resp = await googleAuth.handleCallback(new Request('https://x/oauth/google/callback?error=access_denied'), env);
      check('redirects with signin=cancelled', resp.status === 302 && resp.headers.get('Location').includes('signin=cancelled'));
      check('never called Google', !fetchCalled);
    } finally {
      restoreFetch();
    }
  }

  console.log('4. handleCallback rejects missing/invalid state without ever calling Google');
  {
    const env = makeEnv();
    let fetchCalled = false;
    mockFetch(async () => { fetchCalled = true; throw new Error('should not be called'); });
    try {
      const resp = await googleAuth.handleCallback(new Request('https://x/oauth/google/callback?code=abc'), env);
      check('missing state -> signin=error, no Google call', resp.status === 302 && resp.headers.get('Location').includes('signin=error') && !fetchCalled);

      const resp2 = await googleAuth.handleCallback(new Request('https://x/oauth/google/callback?code=abc&state=never-issued'), env);
      check('unrecognized state -> signin=invalid_state, no Google call', resp2.status === 302 && resp2.headers.get('Location').includes('invalid_state') && !fetchCalled);
    } finally {
      restoreFetch();
    }
  }

  console.log('5. successful callback exchanges the code, creates a user with Google profile data, and hands back a session');
  {
    const env = makeEnv();
    const startResp = await googleAuth.startOAuth(new Request('https://x/oauth/google/start'), env);
    const state = new URL(startResp.headers.get('Location')).searchParams.get('state');

    mockFetch(async (url, opts) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        const body = new URLSearchParams(opts.body);
        check('token exchange sends client_secret server-side only', body.get('client_secret') === 'test-google-client-secret');
        check('token exchange sends the authorization code', body.get('code') === 'realcode');
        check('token exchange sends the pinned redirect_uri', body.get('redirect_uri') === 'https://cybercabhunter.com/oauth/google/callback');
        return new Response(JSON.stringify({ access_token: 'google-access-token', id_token: 'unused', expires_in: 3600 }), { status: 200 });
      }
      if (url === 'https://www.googleapis.com/oauth2/v3/userinfo') {
        check('userinfo call carries the access token as a bearer header', opts.headers.Authorization === 'Bearer google-access-token');
        return new Response(JSON.stringify({ sub: 'google-sub-123', email: 'rider@example.com', name: 'Ada Rider', picture: 'https://example.com/photo.jpg' }), { status: 200 });
      }
      throw new Error(`unexpected fetch to ${url}`);
    });

    let callbackResp;
    try {
      callbackResp = await googleAuth.handleCallback(new Request(`https://x/oauth/google/callback?code=realcode&state=${state}`), env);
    } finally {
      restoreFetch();
    }

    check('callback redirects to frontend with signin=success', callbackResp.status === 302 && callbackResp.headers.get('Location').startsWith('https://cybercabhunter.com/?signin=success'));
    const location = callbackResp.headers.get('Location');
    check('session id handed back via the #tesla_session= fragment', /#tesla_session=[a-f0-9]+$/.test(location));

    check('state deleted after use (single-use)', await env.TESLA_SESSIONS.get(`google_state:${state}`) === null);

    const db = env.cybercabhunter_db;
    check('exactly one user was created', db._users.size === 1);
    const user = [...db._users.values()][0];
    check('display_name populated from Google profile', user.display_name === 'Ada Rider');
    check('avatar_url populated from Google profile picture', user.avatar_url === 'https://example.com/photo.jpg');
    check('google_connections links the user by google_sub', db._googleConnections.get('google-sub-123').user_id === user.id);

    const sessionId = location.split('#tesla_session=')[1];
    const sessionRaw = await env.TESLA_SESSIONS.get(`session:${sessionId}`);
    check('a real session was created mapping to the new user', JSON.parse(sessionRaw).user_id === user.id);
  }

  console.log('6. a repeat sign-in with the same Google account reuses the existing user, not a new one');
  {
    const env = makeEnv();
    mockFetch(async (url) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
      }
      return new Response(JSON.stringify({ sub: 'same-sub', email: 'a@example.com', name: 'A', picture: 'p' }), { status: 200 });
    });
    try {
      const start1 = await googleAuth.startOAuth(new Request('https://x/oauth/google/start'), env);
      const state1 = new URL(start1.headers.get('Location')).searchParams.get('state');
      const cb1 = await googleAuth.handleCallback(new Request(`https://x/oauth/google/callback?code=c1&state=${state1}`), env);
      const user1 = cb1.headers.get('Location').split('#tesla_session=')[1];

      const start2 = await googleAuth.startOAuth(new Request('https://x/oauth/google/start'), env);
      const state2 = new URL(start2.headers.get('Location')).searchParams.get('state');
      await googleAuth.handleCallback(new Request(`https://x/oauth/google/callback?code=c2&state=${state2}`), env);

      check('only one user row exists across two sign-ins', env.cybercabhunter_db._users.size === 1);
      check('two separate sessions were still issued (different session ids)', !!user1);
    } finally {
      restoreFetch();
    }
  }

  console.log('7. token exchange failure redirects with token_exchange_failed, never leaking the raw error');
  {
    const env = makeEnv();
    const startResp = await googleAuth.startOAuth(new Request('https://x/oauth/google/start'), env);
    const state = new URL(startResp.headers.get('Location')).searchParams.get('state');
    mockFetch(async () => new Response('nope', { status: 401 }));
    try {
      const resp = await googleAuth.handleCallback(new Request(`https://x/oauth/google/callback?code=bad&state=${state}`), env);
      check('redirects with signin=token_exchange_failed', resp.status === 302 && resp.headers.get('Location').includes('token_exchange_failed'));
    } finally {
      restoreFetch();
    }
  }
}

run().then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
});
