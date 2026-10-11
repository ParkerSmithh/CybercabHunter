import assert from 'node:assert/strict';
import worker from '../worker/index.js';

const quota = new Error("D1_ERROR: Your account has exceeded D1's free tier daily row read limit.");
const failedStatement = {
  bind() { return this; },
  async first() { throw quota; },
  async all() { throw quota; },
  async run() { throw quota; }
};
const env = {
  cybercabhunter_db: { prepare() { return failedStatement; } },
  TESLA_SESSIONS: { async get(key) { return key.startsWith('session:') ? JSON.stringify({ user_id: 'test' }) : null; } },
  ASSETS: { async fetch() { throw new Error('private internal details'); } }
};
const ctx = { waitUntil() {} };
const savedConsole = console.error;
const logs = [];
console.error = (...args) => logs.push(args);
try {
  for (const path of ['/api/me', '/api/moderation/vehicle-sightings', '/api/sightings']) {
    const response = await worker.fetch(new Request(`https://cybercabhunter.com${path}`, {
      headers: { Authorization: 'Bearer private-token', Origin: 'https://cybercabhunter.com' }
    }), env, ctx);
    assert.equal(response.status, 503, path);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://cybercabhunter.com');
    assert.deepEqual(await response.json(), { success: false, error: 'database_unavailable' });
  }
  // OAuth returns its handler promise directly; a KV rejection must also be caught.
  const response = await worker.fetch(new Request('https://cybercabhunter.com/oauth/google/callback?code=private-code&state=private-state'), {
    ...env, TESLA_SESSIONS: { async get() { throw new Error('private KV details'); } }
  }, ctx);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { success: false, error: 'internal_error' });
  const asset = await worker.fetch(new Request('https://cybercabhunter.com/missing'), env, ctx);
  assert.equal(asset.status, 500);
  assert.equal(asset.headers.get('Cache-Control'), 'no-store');
  assert.doesNotMatch(JSON.stringify(logs), /private-|private KV|private internal/);
  assert.equal((await worker.fetch(new Request('https://cybercabhunter.com/health'), env, ctx)).status, 200);
  console.log('Worker error boundary: quota, auth, moderation, feed, OAuth, assets, CORS and redaction passed');
} finally {
  console.error = savedConsole;
}
