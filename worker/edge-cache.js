// Edge cache for public, read-only GET endpoints that already declare
// `Cache-Control: public, max-age=N` but computed every request from D1:
// a Worker's response is NOT stored at the edge by that header alone; only
// the Cache API stores it (D1 read budget, Nov 2026).
//
// Only a 200 whose Cache-Control is public, with a max-age, and no
// Set-Cookie, is stored, under its full URL. Use it ONLY for endpoints whose
// response is the same for everyone (no session, no user data). The copy
// lives at most max-age seconds in each Cloudflare location — the freshness
// the endpoint already promised to browsers.
export async function edgeCached(request, ctx, compute) {
  const cache = typeof caches !== 'undefined' && caches.default ? caches.default : null;
  if (!cache || request.method !== 'GET') return compute();
  const key = new Request(new URL(request.url).toString(), { method: 'GET' });
  const hit = await cache.match(key).catch(() => null);
  if (hit) return hit;
  const response = await compute();
  const cc = response.headers.get('Cache-Control') || '';
  if (response.status === 200 && /^public\b/.test(cc) && /max-age=\d+/.test(cc) && !response.headers.has('Set-Cookie')) {
    const stored = cache.put(key, response.clone()).catch(() => {});
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(stored);
  }
  return response;
}
