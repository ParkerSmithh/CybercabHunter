// Browser end-to-end harness for the Community page (tests/e2e/*.mjs).
// Serves ./public from a local HTTP server and answers /api/* and /community
// with the REAL Worker (worker/index.js) over an isolated in-memory database
// (every migration applied; tests/helpers). Nothing touches production.
//
// Needs Playwright + Chromium. Tailwind normally loads from its CDN; set
// TAILWIND_CSS=/path/to/compiled.css to serve a local build instead (offline).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { makeEnv, seedVehicle, approveVehicle } from '../helpers/env.mjs';
import worker from '../../worker/index.js';

const ROOT = new URL('../..', import.meta.url).pathname;
const require = createRequire(import.meta.url);

export function loadPlaywright() {
  for (const p of ['playwright', process.env.PW_PATH, '/opt/node22/lib/node_modules/playwright'].filter(Boolean)) {
    try { return require(p); } catch (e) { /* try the next */ }
  }
  return null;
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.json': 'application/json', '.mp4': 'video/mp4' };

export const USERS = ['alice', 'bob', 'mod'];
export const V1 = 'a1b2c3d4-0000-4000-8000-000000000001';
export const V2 = 'b2c3d4e5-0000-4000-8000-000000000002';

// Two riders and a moderator, three public registry vehicles, sessions in KV.
export async function makeApp() {
  const ctx = await makeEnv({ users: USERS });
  ctx.env.FRONTEND_URL = 'http://localhost/';
  for (const u of USERS) await ctx.env.TESLA_SESSIONS.put(`session:s-${u}`, JSON.stringify({ user_id: u }));
  ctx.d1.prepare(`UPDATE users SET leaderboard_opt_in = 1, display_name = 'Alice A', handle = 'alice_a' WHERE id = 'alice'`)._exec();
  ctx.d1.prepare(`UPDATE users SET leaderboard_opt_in = 1, display_name = 'Bob B', handle = 'bob_b' WHERE id = 'bob'`)._exec();
  ctx.d1.prepare(`UPDATE users SET role = 'moderator', leaderboard_opt_in = 1, display_name = 'Owner', handle = 'owner' WHERE id = 'mod'`)._exec();
  ctx.d1.prepare(`INSERT INTO user_xp (user_id, xp) VALUES ('alice', 5400), ('bob', 820)`)._exec();
  approveVehicle(ctx.d1, seedVehicle(ctx.d1, { id: V1, plate: 'XVF-3582', model: 'Cybercab' }), { withRide: true, userId: 'alice' });
  approveVehicle(ctx.d1, seedVehicle(ctx.d1, { id: V2, plate: 'XVF3210', model: 'Cybercab' }), { withRide: true, userId: 'alice' });
  ctx.d1.exec(`UPDATE robotaxi_vehicles SET vin = '7SAYGDEF5TA000123', service_area = 'Austin', approval_basis = 'vin-verified' WHERE id = '${V1}'`);
  ctx.d1.exec(`UPDATE robotaxi_vehicles SET approval_basis = 'manual', service_area = 'Austin' WHERE id = '${V2}'`);
  ctx.env.ASSETS = { fetch: async req => serveFile(new URL(req.url).pathname) };
  return ctx;
}

function serveFile(pathname) {
  let p = decodeURIComponent(pathname);
  if (p === '/' ) p = '/index.html';
  if (/^\/(community|vehicle|rider|moderation|signin)$/.test(p)) p += '.html';
  const file = path.join(ROOT, 'public', path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(path.join(ROOT, 'public')) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return new Response('Not found', { status: 404 });
  return new Response(fs.readFileSync(file), { headers: { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' } });
}

// The local site: /api/*, /community and /vehicle/:id through the Worker, files from ./public.
export async function startServer(ctx) {
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const url = new URL(req.url, 'http://localhost');
      const viaWorker = url.pathname.startsWith('/api/') || url.pathname === '/community' || /^\/(vehicle|rider)\/[^/.]+$/.test(url.pathname);
      let resp;
      if (viaWorker) {
        const headers = { ...req.headers, origin: 'https://cybercabhunter.com' };
        const body = ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks);
        resp = await worker.fetch(new Request(`https://cybercabhunter.com${url.pathname}${url.search}`, { method: req.method, headers, body }), ctx.env, { waitUntil() {} });
      } else resp = serveFile(url.pathname);
      res.writeHead(resp.status, { 'content-type': resp.headers.get('content-type') || 'application/octet-stream' });
      res.end(Buffer.from(await resp.arrayBuffer()));
    } catch (e) { res.writeHead(500); res.end(String(e && e.stack || e)); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

// A browser context for one rider (or signed out), offline-safe.
export async function newContext(browser, { session = null, width = 1440, height = 900, mobile = false, origin = null } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile, reducedMotion: 'reduce' });
  // Some pages call the production Worker by its full address (CCC.apiOrigin):
  // send those to the local Worker instead. Production is never contacted.
  await ctx.route(/^https:\/\/[^/]*(cybercabhunter\.com|workers\.dev)\//, async r => {
    if (!origin) return r.abort();
    const u = new URL(r.request().url());
    const resp = await r.fetch({ url: origin + u.pathname + u.search });
    return r.fulfill({ response: resp });
  });
  if (process.env.TAILWIND_CSS) {
    const tw = fs.readFileSync(process.env.TAILWIND_CSS, 'utf8');
    await ctx.route('https://cdn.tailwindcss.com/**', r => r.fulfill({ contentType: 'text/javascript', body: `window.tailwind={};document.write(${JSON.stringify('<style>' + tw + '</style>')});` }));
  }
  await ctx.route(/googletagmanager|google-analytics|fonts\.g|unpkg\.com|cdnjs/, r => r.abort());
  if (session) await ctx.addInitScript(s => { try { localStorage.setItem('teslaSessionId', s); } catch (e) { /* none */ } }, session);
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
  return ctx;
}

export function jpegBytes() {
  const enc = s => [...Buffer.from(s, 'latin1')];
  const be16 = n => [(n >> 8) & 255, n & 255];
  const seg = (m, body) => [0xff, m, ...be16(body.length + 2), ...body];
  return Buffer.from([0xff, 0xd8, ...seg(0xe0, enc('JFIF\0\x01\x01\0\0\x01\0\x01\0\0')),
    ...seg(0xe1, enc('Exif\0\0MM\0*GPSLatitude 30.2672')),
    ...seg(0xc0, [8, ...be16(64), ...be16(64), 1, 1, 0x11, 0]), ...seg(0xda, [1, 1, 0, 0, 0x3f, 0]), 0x12, 0x34, 0xff, 0xd9]);
}
