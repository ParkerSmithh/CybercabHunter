// Profile pictures (worker/avatars.js, the profile page editor, the shared avatar).
//   - upload: two square variants (512, 128) from the browser's crop; type from
//     the bytes; 5 MB cap; exact sizes; EXIF/GPS and other metadata stripped
//   - served only as those variants, by a random key (no user id, no original)
//   - replace and remove delete the stored files; old URLs stop resolving
//   - ownership: the session's user only — never another rider's picture
//   - shown by the one shared avatar (account button, profile, Community)
// Real SQL (every migration) + the REAL Worker router; the page runs in jsdom.
// Run: node tests/avatars.test.mjs

import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { makeEnv, makeCheck, seedRide } from './helpers/env.mjs';
import worker from '../worker/index.js';

const t = makeCheck();
const { check } = t;
const ROOT = new URL('..', import.meta.url).pathname;
const read = f => fs.readFileSync(`${ROOT}${f}`, 'utf8');
const enc = s => [...Buffer.from(s, 'latin1')];
const be16 = n => [(n >> 8) & 255, n & 255];
const be32 = n => [(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
const le32 = n => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
const le24 = n => [n & 255, (n >> 8) & 255, (n >> 16) & 255];

// Minimal, structurally valid images of an exact size, with metadata to strip.
function jpeg(w, h, { exif = true } = {}) {
  const seg = (m, body) => [0xff, m, ...be16(body.length + 2), ...body];
  return Uint8Array.from([
    0xff, 0xd8,
    ...seg(0xe0, enc('JFIF\0\x01\x01\0\0\x01\0\x01\0\0')),
    ...(exif ? seg(0xe1, enc('Exif\0\0MM\0*GPSLatitude 30.2672 GPSLongitude -97.7431')) : []),
    ...(exif ? seg(0xfe, enc('taken at home')) : []),
    ...seg(0xc0, [8, ...be16(h), ...be16(w), 1, 1, 0x11, 0]),
    ...seg(0xda, [1, 1, 0, 0, 0x3f, 0]), 0x12, 0x34, 0x56, 0xff, 0xd9
  ]);
}
function png(w, h, { text = true } = {}) {
  const chunk = (name, body) => [...be32(body.length), ...enc(name), ...body, 0, 0, 0, 0];
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk('IHDR', [...be32(w), ...be32(h), 8, 6, 0, 0, 0]),
    ...(text ? chunk('tEXt', enc('Comment\0GPS 30.26,-97.74')) : []),
    ...chunk('IDAT', [1, 2, 3, 4]),
    ...chunk('IEND', [])
  ]);
}
function webp(w, h, { exif = true } = {}) {
  const chunk = (name, body) => [...enc(name), ...le32(body.length), ...body, ...(body.length % 2 ? [0] : [])];
  const chunks = [
    ...chunk('VP8X', [exif ? 0x08 : 0, 0, 0, 0, ...le24(w - 1), ...le24(h - 1)]),
    ...chunk('VP8 ', [1, 2, 3, 4, 5, 6]),
    ...(exif ? chunk('EXIF', enc('MM\0*GPSLatitude 30.2672')) : [])
  ];
  return Uint8Array.from([...enc('RIFF'), ...le32(4 + chunks.length), ...enc('WEBP'), ...chunks]);
}

async function makeApp(users = ['alice', 'bob']) {
  const ctx = await makeEnv({ users });
  ctx.env.ASSETS = { fetch: async () => new Response('asset') };
  for (const u of users) await ctx.env.TESLA_SESSIONS.put(`session:session-${u}`, JSON.stringify({ user_id: u }));
  return ctx;
}
async function upload(ctx, session, { large = webp(512, 512), thumb = webp(128, 128), path = '/api/profile/avatar' } = {}) {
  const fd = new FormData();
  if (large) fd.append('large', new File([large], 'a'));
  if (thumb) fd.append('thumb', new File([thumb], 'b'));
  const r = await worker.fetch(new Request(`https://x${path}`, { method: 'POST', headers: session ? { Authorization: `Bearer ${session}` } : {}, body: fd }), ctx.env, {});
  let body = null; try { body = await r.json(); } catch (e) { /* none */ }
  return { status: r.status, body };
}
const remove = (ctx, session, path = '/api/profile/avatar') => worker.fetch(new Request(`https://x${path}`, { method: 'DELETE', headers: session ? { Authorization: `Bearer ${session}` } : {} }), ctx.env, {});
const get = (ctx, path) => worker.fetch(new Request(`https://x${path}`), ctx.env, {});
const avatarOf = (ctx, u) => ctx.d1.query('SELECT avatar_url FROM users WHERE id = ?', u)[0].avatar_url;
const files = (ctx, u) => [...ctx.env.EVIDENCE_BUCKET._objects.keys()].filter(k => k.startsWith(`avatars/${u}/`)).sort();
const has = (bytes, s) => Buffer.from(bytes).includes(Buffer.from(s, 'latin1'));

async function run() {
  console.log('1. Upload: two square variants, metadata stripped, served by a random key');
  {
    const ctx = await makeApp();
    const r = await upload(ctx, 'session-alice', { large: jpeg(512, 512), thumb: jpeg(128, 128) });
    const key = (r.body && r.body.avatar_url || '').split('/').pop();
    check('200 with avatar_url /api/avatars/<32 hex>', r.status === 200 && /^\/api\/avatars\/[a-f0-9]{32}$/.test(r.body.avatar_url));
    check('saved on the user', avatarOf(ctx, 'alice') === r.body.avatar_url);
    check('R2 holds exactly the two variants: avatars/<user>/<key>/512 and /128 (no original)', JSON.stringify(files(ctx, 'alice')) === JSON.stringify([`avatars/alice/${key}/128`, `avatars/alice/${key}/512`]));
    const stored = ctx.env.EVIDENCE_BUCKET._objects.get(`avatars/alice/${key}/512`);
    check('EXIF (incl. GPS) and comments are stripped; the image itself is intact', !has(stored, 'Exif') && !has(stored, 'GPS') && !has(stored, 'taken at home') && stored[0] === 0xff && stored[1] === 0xd8 && has(stored, 'JFIF'));
    for (const size of [128, 512]) {
      const res = await get(ctx, `/api/avatars/${key}/${size}`);
      check(`GET /api/avatars/<key>/${size}: the ${size} px variant, cacheable, no sniffing`, res.status === 200 && res.headers.get('Content-Type') === 'image/jpeg' && /immutable/.test(res.headers.get('Cache-Control')) && res.headers.get('X-Content-Type-Options') === 'nosniff' && Buffer.from(await res.arrayBuffer()).equals(Buffer.from(ctx.env.EVIDENCE_BUCKET._objects.get(`avatars/alice/${key}/${size}`))));
    }
    check('any other size or key: 404 (no original exists to serve)', (await get(ctx, `/api/avatars/${key}/1024`)).status === 404 && (await get(ctx, `/api/avatars/${key}/original`)).status === 404 && (await get(ctx, `/api/avatars/${'0'.repeat(32)}/128`)).status === 404);
    check('the public URL has no user id in it', !r.body.avatar_url.includes('alice'));

    const p = await upload(ctx, 'session-alice', { large: png(512, 512), thumb: png(128, 128) });
    const pk = p.body.avatar_url.split('/').pop();
    const pb = ctx.env.EVIDENCE_BUCKET._objects.get(`avatars/alice/${pk}/512`);
    check('PNG: text chunks stripped, IHDR/IDAT/IEND kept', p.status === 200 && !has(pb, 'tEXt') && !has(pb, 'GPS') && has(pb, 'IHDR') && has(pb, 'IDAT') && has(pb, 'IEND'));
    const w = await upload(ctx, 'session-alice');
    const wk = w.body.avatar_url.split('/').pop();
    const wb = ctx.env.EVIDENCE_BUCKET._objects.get(`avatars/alice/${wk}/512`);
    const riffSize = wb[4] | (wb[5] << 8) | (wb[6] << 16) | (wb[7] << 24);
    check('WebP: EXIF chunk removed, its VP8X flag cleared, RIFF size still right', w.status === 200 && !has(wb, 'EXIF') && !has(wb, 'GPS') && (wb[20] & 0x08) === 0 && riffSize === wb.length - 8);
  }

  console.log('2. Rejections (server-side)');
  {
    const ctx = await makeApp();
    const gif = Uint8Array.from([...enc('GIF89a'), 0, 2, 0, 2, 0, 0]);
    const cases = [
      ['no session', () => upload(ctx, null), 401, null],
      ['a GIF', () => upload(ctx, 'session-alice', { large: gif, thumb: gif }), 400, 'unsupported_file_type'],
      ['a PDF named like an image', () => upload(ctx, 'session-alice', { large: Uint8Array.from(enc('%PDF-1.7 ...')), thumb: webp(128, 128) }), 400, 'unsupported_file_type'],
      ['the wrong size (500x500)', () => upload(ctx, 'session-alice', { large: webp(500, 500) }), 400, 'invalid_dimensions'],
      ['not square (512x400)', () => upload(ctx, 'session-alice', { large: jpeg(512, 400) }), 400, 'invalid_dimensions'],
      ['the variants swapped', () => upload(ctx, 'session-alice', { large: webp(128, 128), thumb: webp(512, 512) }), 400, 'invalid_dimensions'],
      ['a missing variant', () => upload(ctx, 'session-alice', { thumb: null }), 400, 'missing_image'],
      ['over 5 MB', () => upload(ctx, 'session-alice', { large: Uint8Array.from([...webp(512, 512), ...new Uint8Array(5 * 1024 * 1024)]) }), 413, 'file_too_large']
    ];
    for (const [label, fn, status, error] of cases) {
      const r = await fn();
      check(`${label}: ${status}${error ? ' ' + error : ''}`, r.status === status && (!error || r.body.error === error), `${r.status} ${r.body && r.body.error}`);
    }
    check('nothing was stored or changed', files(ctx, 'alice').length === 0 && avatarOf(ctx, 'alice') === null);
  }

  console.log('3. Replace and remove');
  {
    const ctx = await makeApp();
    const first = (await upload(ctx, 'session-alice')).body.avatar_url;
    const firstKey = first.split('/').pop();
    const second = (await upload(ctx, 'session-alice')).body.avatar_url;
    check('a new upload gets a new key; the old files are deleted', second !== first && files(ctx, 'alice').every(k => !k.includes(firstKey)) && files(ctx, 'alice').length === 2);
    check('...and the old URL stops resolving', (await get(ctx, `${first}/128`)).status === 404 && (await get(ctx, `${second}/128`)).status === 200);
    const r = await remove(ctx, 'session-alice');
    check('Remove photo: 200, the avatar is cleared (-> initials placeholder) and its files deleted', r.status === 200 && avatarOf(ctx, 'alice') === null && files(ctx, 'alice').length === 0);
    check('...and its URL 404s', (await get(ctx, `${second}/512`)).status === 404);
    ctx.d1.exec(`UPDATE users SET avatar_url = 'https://lh3.googleusercontent.com/a/x' WHERE id = 'alice'`);
    check('removing a Google photo also reverts to the placeholder', (await remove(ctx, 'session-alice')).status === 200 && avatarOf(ctx, 'alice') === null);
    check('remove without a session: 401', (await remove(ctx, null)).status === 401);
  }

  console.log('4. Ownership: only your own picture');
  {
    const ctx = await makeApp();
    const a = (await upload(ctx, 'session-alice')).body.avatar_url;
    const aFiles = files(ctx, 'alice');
    const b = await upload(ctx, 'session-bob', { path: '/api/profile/avatar?user_id=alice&id=alice' });
    check('Bob uploading (even naming Alice in the URL) changes only Bob\'s picture', b.status === 200 && avatarOf(ctx, 'bob') === b.body.avatar_url && avatarOf(ctx, 'alice') === a && JSON.stringify(files(ctx, 'alice')) === JSON.stringify(aFiles));
    await remove(ctx, 'session-bob', '/api/profile/avatar?user_id=alice');
    check('Bob removing (naming Alice) removes only Bob\'s', avatarOf(ctx, 'bob') === null && avatarOf(ctx, 'alice') === a && JSON.stringify(files(ctx, 'alice')) === JSON.stringify(aFiles));
    check('Alice\'s picture still serves', (await get(ctx, `${a}/128`)).status === 200);
  }

  console.log('5. Shown everywhere a rider appears; gone with the account');
  {
    const ctx = await makeApp(['alice', 'mod']);
    ctx.d1.exec(`UPDATE users SET role = 'moderator' WHERE id = 'mod'`);
    const a = (await upload(ctx, 'session-alice')).body.avatar_url;
    ctx.d1.exec(`UPDATE users SET leaderboard_opt_in = 1, display_name = 'Alice', handle = 'alice' WHERE id = 'alice'`);
    ctx.d1.prepare(`INSERT INTO robotaxi_vehicles (id, license_plate, visibility, origin) VALUES ('00000001-0000-4000-8000-000000000001', 'P1', 'public', 'receipt')`)._exec();
    seedRide(ctx.d1, { id: 'r1', userId: 'alice', vehicleId: '00000001-0000-4000-8000-000000000001', status: 'approved', rideKey: 'k1' });
    const board = await (await get(ctx, '/api/community/leaderboard')).json();
    check('the Community board passes the uploaded picture on', board.entries[0].avatar_url === a);
    const rider = await (await get(ctx, '/api/riders/alice')).json();
    check('...and the public rider profile', rider.rider.avatar_url === a);
    const me = await (await worker.fetch(new Request('https://x/api/profile', { headers: { Authorization: 'Bearer session-alice' } }), ctx.env, {})).json();
    check('...and the rider\'s own profile', me.user.avatar_url === a);
    const del = await worker.fetch(new Request('https://x/api/account', { method: 'DELETE', headers: { Authorization: 'Bearer session-alice', 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: 'DELETE' }) }), ctx.env, {});
    check('deleting the account deletes the picture files too', del.status === 200 && files(ctx, 'alice').length === 0 && (await get(ctx, `${a}/128`)).status === 404);
  }

  console.log('6. The shared avatar and the profile page editor (jsdom)');
  {
    const ctx = await makeApp();
    const html = read('public/profile.html');
    const dom = new JSDOM(html.replace(/<script src="https?:[^"]*"><\/script>/g, ''), { runScripts: 'outside-only', url: 'https://cybercabhunter.com/profile.html', pretendToBeVisual: true });
    const w = dom.window;
    w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
    w.localStorage.setItem('teslaSessionId', 'session-alice');
    const sent = [];
    w.fetch = async (url, init = {}) => {
      const path = String(url).replace('https://cybercabhunter.contactjoeclos.workers.dev', '');
      if (path === '/api/profile/avatar') sent.push({ method: init.method, body: init.body });
      let body = init.body;
      if (body instanceof w.FormData) {          // jsdom FormData -> a real one for the Worker
        const fd = new FormData();
        for (const [k, v] of body.entries()) fd.append(k, typeof v === 'string' ? v : new File([new Uint8Array(await v.arrayBuffer())], v.name || 'f'));
        body = fd;
      }
      return worker.fetch(new Request(`https://x${path}`, { ...init, body }), ctx.env, {});
    };
    // The browser's image APIs (jsdom has no canvas): the crop renders each
    // variant as a WebP of exactly the canvas size.
    w.createImageBitmap = async () => ({ width: 1000, height: 800, close() {} });
    w.URL.createObjectURL = () => 'blob:photo';
    w.URL.revokeObjectURL = () => {};
    const draws = [];
    w.HTMLCanvasElement.prototype.getContext = function () { const c = this; return { drawImage: (...a) => draws.push({ size: c.width, args: a.slice(1, 5) }), set imageSmoothingQuality(v) {} }; };
    w.HTMLCanvasElement.prototype.toBlob = function (cb, type) { cb(new w.Blob([webp(this.width, this.height)], { type: 'image/webp' })); };
    w.confirm = () => true;
    const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).filter(s => s.includes('initAvatarEditor')).join('\n');
    w.eval(`${read('public/js/calc.js')}\n${read('public/js/main.js')}\n${inline}`);
    await new Promise(r => setTimeout(r, 80));
    const d = w.document;
    const avatarBox = d.getElementById('profileAvatar');
    check('no picture: the shared initials placeholder, and no "Remove photo"', !avatarBox.querySelector('img') && avatarBox.textContent.trim().length > 0 && d.getElementById('avatarRemove').classList.contains('hidden'));

    const pick = file => { const input = d.getElementById('avatarFile'); Object.defineProperty(input, 'files', { configurable: true, value: [file] }); input.dispatchEvent(new w.Event('change')); };
    pick(new w.File(['GIF89a'], 'x.gif', { type: 'image/gif' }));
    await new Promise(r => setTimeout(r, 20));
    check('a GIF is refused in the page, with a clear message, nothing sent', /JPEG, PNG or WebP/.test(d.getElementById('avatarError').textContent) && sent.length === 0 && d.getElementById('avatarEditor').classList.contains('hidden'));
    pick(new w.File([new Uint8Array(5 * 1024 * 1024 + 1)], 'big.jpg', { type: 'image/jpeg' }));
    await new Promise(r => setTimeout(r, 20));
    check('over 5 MB is refused in the page', /under 5 MB/.test(d.getElementById('avatarError').textContent) && sent.length === 0);

    pick(new w.File([new Uint8Array(100)], 'me.jpg', { type: 'image/jpeg' }));
    await new Promise(r => setTimeout(r, 20));
    const editor = d.getElementById('avatarEditor');
    const cropImg = d.getElementById('avatarCropImg');
    check('choosing a photo opens the crop editor in the profile section (nothing uploaded yet)', !editor.classList.contains('hidden') && sent.length === 0 && cropImg.getAttribute('src') === 'blob:photo');
    const px = v => parseFloat(v);
    const near = (a, b) => Math.abs(px(a) - b) < 0.01;
    check('the photo covers the square: 1000x800 shown at 280x224 (the short side fits)', near(cropImg.style.width, 280) && near(cropImg.style.height, 224), `${cropImg.style.width} x ${cropImg.style.height}`);
    const zoom = d.getElementById('avatarZoom');
    zoom.value = '2'; zoom.dispatchEvent(new w.Event('input'));
    check('zoom enlarges it (2x -> 560x448)', near(cropImg.style.width, 560) && near(cropImg.style.height, 448));
    const box = d.getElementById('avatarCropBox');
    box.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    const leftAfterKey = parseFloat(cropImg.style.left);
    box.dispatchEvent(new w.MouseEvent('pointerdown', { clientX: 100, clientY: 100, bubbles: true }));
    box.dispatchEvent(new w.MouseEvent('pointermove', { clientX: 5000, clientY: 5000, bubbles: true }));
    box.dispatchEvent(new w.MouseEvent('pointerup', { bubbles: true }));
    check('dragging/arrow keys reposition it, but never past an edge (the square stays covered)', leftAfterKey < 0 && cropImg.style.left === '0px' && cropImg.style.top === '0px');

    d.getElementById('avatarSave').click();
    await new Promise(r => setTimeout(r, 150));
    check('Save renders exactly a 512 and a 128 square from the chosen crop', draws.length === 2 && draws.map(x => x.size).sort((a, b) => a - b).join() === '128,512' && draws.every(x => x.args[0] === 0 && x.args[1] === 0 && Math.abs(x.args[2] - 400) < 0.01 && Math.abs(x.args[3] - 400) < 0.01));
    check('...and uploads only those two variants', sent.length === 1 && sent[0].method === 'POST' && [...sent[0].body.keys()].sort().join() === 'large,thumb');
    const saved = avatarOf(ctx, 'alice');
    const img = avatarBox.querySelector('img');
    check('the new picture appears at once on the profile (512 variant)', /^\/api\/avatars\/[a-f0-9]{32}$/.test(saved) && img && img.getAttribute('src') === `${saved}/512` && editor.classList.contains('hidden'));
    check('...and in the header account button (128 variant)', d.getElementById('accountAvatarImg').getAttribute('src') === `${saved}/128` && !d.getElementById('accountAvatarImg').classList.contains('hidden'));
    check('"Remove photo" is now offered', !d.getElementById('avatarRemove').classList.contains('hidden'));
    d.getElementById('avatarRemove').click();
    await new Promise(r => setTimeout(r, 80));
    check('Remove photo: back to the initials placeholder, files deleted', !avatarBox.querySelector('img') && avatarOf(ctx, 'alice') === null && files(ctx, 'alice').length === 0 && sent[1].method === 'DELETE');
    img && img.dispatchEvent(new w.Event('error'));
    w.close();

    const main = read('public/js/main.js');
    check('one shared avatar component: the profile, Community and rider pages all use CCC.renderAvatar', /function renderAvatar/.test(main) &&
      ['public/profile.html', 'public/js/community.js', 'public/js/rider.js'].every(f => /CCC\.renderAvatar\(/.test(read(f))) && /avatarSrc\(avatarUrl, 128\)/.test(main));
  }

  t.finish();
}

run().catch(e => { console.error(e); process.exit(1); });
