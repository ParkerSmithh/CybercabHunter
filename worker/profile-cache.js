// Edge caching for responses that show riders' names, photos or privacy
// (the leaderboards, streak boards, public rider profiles, the signed-out
// Social feed).
//
// Why not just delete the cached copy when a profile changes: Cloudflare's
// Cache API (caches.default) is per data centre, so cache.delete() only
// clears the copy where the edit ran; every other location would keep the
// old name or photo for the rest of its TTL. A zone-wide purge needs the
// Purge API, a zone id and an API token, which this Worker doesn't have.
//
// Instead every such response is cached under a key that carries the current
// PROFILE EPOCH, a counter in KV (PROFILE_EPOCH_KEY) that goes up whenever a
// rider's public name, username, photo or privacy changes, or an account is
// deleted (leaderboardRiderChanged). A new epoch makes every old copy
// unreachable everywhere; KV carries the new value to every location within
// about a minute (immediately where the edit was made). Caching itself is
// kept: between profile changes every location serves its cached copy.
//
// Browsers and the app get the response with `private, no-store` (as the
// signed-out feed already does): the copy to keep is the edge's, so a browser
// never holds an old name after the edge has a new one. (A cached Response
// returned as-is also picks up the zone's long Browser Cache TTL on
// cybercabhunter.com; rewrapping it avoids that.)

export const PROFILE_EPOCH_KEY = 'profile_epoch';
const EDGE_HOST = 'https://cybercabhunter.com';

/**
 * The current epoch: '0' when it was never bumped, null when KV can't be
 * read. With null, callers serve straight from the database (no shared copy),
 * so a KV problem can never surface a stale name, photo or hidden profile.
 */
export async function profileEpoch(env) {
  if (!env || !env.TESLA_SESSIONS) return '0';
  try {
    const v = await env.TESLA_SESSIONS.get(PROFILE_EPOCH_KEY);
    return v && /^[0-9a-z]{1,32}$/.test(v) ? v : '0';
  } catch (e) { return null; }
}

/**
 * A rider's public details changed: every profile-bearing edge copy is
 * replaced on its next request. Each value is new (time + random), so
 * concurrent bumps can't collide; KV allows one write per second per key, so
 * a refused write is tried once more. If both fail, the copies still expire
 * on their own TTL (5 min boards, 60 s profiles and feed): the freshness of
 * the previous version, never worse. The database itself is already correct.
 */
export async function bumpProfileEpoch(env, { retryMs = 1100 } = {}) {
  if (!env || !env.TESLA_SESSIONS) return false;
  for (let attempt = 0; attempt < 2; attempt++) {
    // Time plus 48 random bits: never equal to an earlier value, even within one millisecond.
    const next = Date.now().toString(36) + [...crypto.getRandomValues(new Uint8Array(6))].map(b => b.toString(16).padStart(2, '0')).join('');
    try { await env.TESLA_SESSIONS.put(PROFILE_EPOCH_KEY, next); return true; } catch (e) {
      if (attempt === 0 && retryMs > 0) await new Promise(r => setTimeout(r, retryMs));
    }
  }
  console.error(JSON.stringify({ event: 'profile_epoch_bump_failed' }));
  return false;
}

/**
 * Serves `build()` through the edge cache under `name` + `params` + the epoch.
 * Only a 200 is stored (for `ttl` seconds); every response leaves with
 * `browser` as its Cache-Control. Unknown query parameters never reach the
 * key, so they can't be used to bypass the cache.
 */
export async function profileCached(env, ctx, { name, params = {}, ttl, browser = 'private, no-store' }, build) {
  const cache = typeof caches !== 'undefined' && caches.default ? caches.default : null;
  const toClient = r => {
    const headers = new Headers(r.headers);
    headers.set('Cache-Control', browser);
    headers.delete('CF-Cache-Status');
    headers.delete('Age');
    return new Response(r.body, { status: r.status, headers });
  };
  if (!cache) return toClient(await build());
  const epoch = await profileEpoch(env);
  if (epoch === null) return toClient(await build());   // KV unreadable: fresh, never a shared copy
  const qs = new URLSearchParams({ ...params, pe: epoch });
  const key = new Request(`${EDGE_HOST}/__edge/${name}?${qs}`, { method: 'GET' });
  const hit = await cache.match(key);
  if (hit) return toClient(hit);
  const response = await build();
  if (response.status !== 200) return toClient(response);
  const body = await response.arrayBuffer();
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', `public, max-age=${ttl}`);
  const put = cache.put(key, new Response(body, { status: 200, headers })).catch(() => {});
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(put); else await put;
  return toClient(new Response(body, { status: 200, headers: response.headers }));
}
