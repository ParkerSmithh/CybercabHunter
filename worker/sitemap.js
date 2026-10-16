// GET /sitemap.xml — the public pages plus one /vehicle/<id> per public
// registry vehicle, for search engines.
//
// D1 budget: ONE query per regeneration, selecting only the id and approval
// date of the vehicles the public registry already shows (the shared rule,
// publicVehicleEligibleSql — never a second definition). The XML is kept in
// the Cache API for a day under one fixed key (query strings can't bust it),
// so crawlers hitting it all day cost one small read per data center per day.
import { publicVehicleEligibleSql } from './ride-status.js';

const SITE = 'https://cybercabhunter.com';
const CACHE_SECONDS = 24 * 60 * 60;

// Public pages only: every one returns 200 and is linked from the nav.
// Internal pages (sign-in, profile, rider data, moderation) are noindex and
// never listed.
export const SITEMAP_PAGES = ['/', '/sightings', '/vehicles', '/news', '/community', '/infrastructure', '/simulation', '/replay', '/dmv', '/privacy'];

const xmlEscape = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const day = v => (/^\d{4}-\d{2}-\d{2}/.test(String(v || '')) ? String(v).slice(0, 10) : null);

export function sitemapXml(vehicles, today) {
  const entry = (loc, lastmod) => `  <url><loc>${xmlEscape(SITE + loc)}</loc><lastmod>${lastmod}</lastmod><changefreq>daily</changefreq></url>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...SITEMAP_PAGES.map(p => entry(p, today)),
    ...vehicles.map(v => entry('/vehicle/' + encodeURIComponent(v.id), day(v.approved_at) || today)),
    '</urlset>',
    ''
  ].join('\n');
}

export async function sitemap(request, env, ctx) {
  const cache = typeof caches !== 'undefined' && caches.default ? caches.default : null;
  const cacheKey = new Request(new URL('/sitemap.xml', request.url).toString(), { method: 'GET' });
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }
  let vehicles = [];
  try {
    const rows = await env.cybercabhunter_db.prepare(`
      SELECT v.id, v.approval_basis_set_at AS approved_at
      FROM robotaxi_vehicles v
      WHERE ${publicVehicleEligibleSql('v')}
      ORDER BY v.id
    `).all();
    vehicles = rows.results || [];
  } catch (e) {
    // The pages alone are still a valid sitemap; don't cache the partial one.
    return new Response(sitemapXml([], new Date().toISOString().slice(0, 10)), {
      headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=300' }
    });
  }
  const response = new Response(sitemapXml(vehicles, new Date().toISOString().slice(0, 10)), {
    headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': `public, max-age=${CACHE_SECONDS}` }
  });
  if (cache) {
    const stored = cache.put(cacheKey, response.clone()).catch(() => {});
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(stored);
  }
  return response;
}
