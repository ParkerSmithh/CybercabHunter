import { DEFAULT_CITY, SERVICE_AREAS, serviceAreaFor } from './service-areas.js';

export const CITY_PAGES = ['/', '/vehicles', '/sightings', '/infrastructure', '/replay', '/simulation', '/news'];
const metaCities = SERVICE_AREAS.filter(area => area.key !== DEFAULT_CITY);

export async function cityPage(request, env, ctx) {
  const url = new URL(request.url);
  const shortcut = SERVICE_AREAS.find(area => url.pathname === '/' + area.key);
  if (shortcut) return Response.redirect(new URL('/?city=' + shortcut.key, url), 308);
  if (!CITY_PAGES.includes(url.pathname)) return null;
  const city = metaCities.find(area => area.key === url.searchParams.get('city'));
  if (!city) return null;

  const canonical = new URL(url.pathname, 'https://cybercabhunter.com');
  canonical.searchParams.set('city', city.key);
  const key = new Request(new URL('/__city-meta' + canonical.pathname + canonical.search, url));
  const cache = globalThis.caches?.default;
  if (request.method === 'GET' && cache) {
    const hit = await cache.match(key);
    if (hit) return hit;
  }
  const asset = await env.ASSETS.fetch(request);
  if (!asset.ok || request.method === 'HEAD' || typeof HTMLRewriter === 'undefined') return asset;
  const description = `Track Cybercab sightings, registry vehicles and Robotaxi service in ${city.name}.`;
  const rewriter = new HTMLRewriter();
  for (const name of ['description', 'og:description', 'twitter:description']) {
    rewriter.on(`meta[name="${name}"], meta[property="${name}"]`, { element: el => el.setAttribute('content', description) });
  }
  rewriter.on('meta[property="og:url"]', { element: el => el.setAttribute('content', canonical.href) });
  rewriter.on('link[rel="canonical"]', { element: el => el.setAttribute('href', canonical.href) });
  const headers = new Headers(asset.headers);
  headers.delete('ETag');
  headers.set('Cache-Control', 'public, max-age=3600');
  const response = rewriter.transform(new Response(asset.body, { status: asset.status, headers }));
  if (cache && ctx) ctx.waitUntil(cache.put(key, response.clone()).catch(() => {}));
  return response;
}

export async function apiPreferredCity(request, env, userId) {
  const reply = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } });
  if (!userId) return reply({ error: 'unauthenticated' }, 401);
  const db = env.cybercabhunter_db;
  if (request.method === 'GET') {
    const row = await db.prepare('SELECT preferred_city FROM users WHERE id = ?').bind(userId).first();
    return reply({ city: row?.preferred_city || null });
  }
  const body = await request.json().catch(() => null);
  const city = body?.city === 'all' ? 'all' : serviceAreaFor(body?.city)?.key;
  if (!city) return reply({ error: 'invalid_city' }, 400);
  await db.prepare('UPDATE users SET preferred_city = ? WHERE id = ?').bind(city, userId).run();
  return reply({ city });
}
