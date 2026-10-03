// Site videos (worker/videos.js) streamed from the PRIVATE evidence bucket.
//   - only allow-listed slugs resolve, each to one fixed object key
//   - nothing else in the bucket is reachable through /videos/ (keys, paths,
//     encoded slashes, other slugs)
//   - video/mp4, Range (206 / 416), HEAD, ETag (304) and If-Range
//   - the existing private evidence routes still refuse anonymous callers
// The REAL Worker router with a bucket fake that answers head() and ranged
// get() the way R2 does.
// Run: node tests/videos.test.mjs

import { makeEnv, makeCheck } from './helpers/env.mjs';
import worker from '../worker/index.js';

const t = makeCheck();
const { check } = t;

// R2-shaped fake: head(), get(key, { range: { offset, length } }).
function rangedR2(objects) {
  const meta = (key, bytes) => ({ key, size: bytes.length, httpEtag: `"etag-${key.length}-${bytes.length}"`, uploaded: new Date('2026-10-01T00:00:00Z') });
  return {
    calls: [],
    async head(key) { this.calls.push(['head', key]); return objects.has(key) ? meta(key, objects.get(key)) : null; },
    async get(key, opts = {}) {
      this.calls.push(['get', key]);
      if (!objects.has(key)) return null;
      const bytes = objects.get(key);
      const { offset = 0, length = bytes.length - offset } = opts.range || {};
      return { ...meta(key, bytes), body: bytes.slice(offset, offset + length) };
    },
  };
}

const VIDEO = Uint8Array.from({ length: 1000 }, (_, i) => i % 251);
const WEB = Uint8Array.from({ length: 400 }, (_, i) => (i * 7) % 251);
const SECRET = new TextEncoder().encode('private evidence photo');

const { env } = await makeEnv();
const bucket = rangedR2(new Map([
  ['Videos/CybercabAnimation.mp4', VIDEO],
  ['Videos/CybercabAnimation-web.mp4', WEB],
  ['evidence/u1/receipt.jpg', SECRET],
  ['Videos/other.mp4', SECRET],
]));
env.EVIDENCE_BUCKET = bucket;
env.ASSETS = { fetch: async () => new Response('static site 404', { status: 404 }) };

const req = (path, init = {}) => worker.fetch(new Request(`https://cybercabhunter.com${path}`, init), env, {});
const bytes = async (res) => new Uint8Array(await res.arrayBuffer());
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

console.log('whole file');
{
  const res = await req('/videos/cybercab-animation');
  check('200', res.status === 200);
  check('Content-Type is video/mp4', res.headers.get('Content-Type') === 'video/mp4');
  check('advertises byte ranges', res.headers.get('Accept-Ranges') === 'bytes');
  check('Content-Length is the full size', res.headers.get('Content-Length') === '1000');
  check('cached as a static asset', /public, max-age=86400/.test(res.headers.get('Cache-Control')));
  check('has an ETag', !!res.headers.get('ETag'));
  check('not embeddable by other sites', res.headers.get('Cross-Origin-Resource-Policy') === 'same-origin');
  check('nosniff', res.headers.get('X-Content-Type-Options') === 'nosniff');
  check('body is the video', same(await bytes(res), VIDEO));
}
{
  const res = await req('/videos/cybercab-animation-web');
  check('web copy: 200 and its own bytes', res.status === 200 && same(await bytes(res), WEB));
}

console.log('ranges');
{
  const res = await req('/videos/cybercab-animation', { headers: { Range: 'bytes=100-199' } });
  check('206 for bytes=100-199', res.status === 206);
  check('Content-Range', res.headers.get('Content-Range') === 'bytes 100-199/1000');
  check('Content-Length 100', res.headers.get('Content-Length') === '100');
  check('exact slice', same(await bytes(res), VIDEO.slice(100, 200)));
}
{
  const res = await req('/videos/cybercab-animation', { headers: { Range: 'bytes=900-' } });
  check('open-ended range to the end', res.status === 206 && res.headers.get('Content-Range') === 'bytes 900-999/1000' && same(await bytes(res), VIDEO.slice(900)));
}
{
  const res = await req('/videos/cybercab-animation', { headers: { Range: 'bytes=-50' } });
  check('suffix range: the last 50 bytes', res.status === 206 && res.headers.get('Content-Range') === 'bytes 950-999/1000' && same(await bytes(res), VIDEO.slice(950)));
}
{
  const res = await req('/videos/cybercab-animation', { headers: { Range: 'bytes=990-5000' } });
  check('end past the file is clamped', res.status === 206 && res.headers.get('Content-Range') === 'bytes 990-999/1000');
}
{
  const res = await req('/videos/cybercab-animation', { headers: { Range: 'bytes=0-1' } });
  check('Safari-style probe bytes=0-1', res.status === 206 && res.headers.get('Content-Length') === '2');
}
{
  const res = await req('/videos/cybercab-animation', { headers: { Range: 'bytes=1000-' } });
  check('416 past the end', res.status === 416 && res.headers.get('Content-Range') === 'bytes */1000');
}
{
  const res = await req('/videos/cybercab-animation', { headers: { Range: 'bytes=0-10, 20-30' } });
  check('multiple ranges: whole file instead', res.status === 200 && res.headers.get('Content-Length') === '1000');
}

console.log('HEAD, ETag, If-Range');
{
  const res = await req('/videos/cybercab-animation', { method: 'HEAD' });
  check('HEAD: 200, headers, no body', res.status === 200 && res.headers.get('Content-Length') === '1000' && (await bytes(res)).length === 0);
  const etag = res.headers.get('ETag');
  const cached = await req('/videos/cybercab-animation', { headers: { 'If-None-Match': etag } });
  check('If-None-Match current ETag: 304', cached.status === 304);
  const stale = await req('/videos/cybercab-animation', { headers: { Range: 'bytes=0-9', 'If-Range': '"old"' } });
  check('If-Range with an old ETag: whole new file', stale.status === 200 && stale.headers.get('Content-Length') === '1000');
  const fresh = await req('/videos/cybercab-animation', { headers: { Range: 'bytes=0-9', 'If-Range': etag } });
  check('If-Range with the current ETag: the range', fresh.status === 206);
}
{
  const res = await req('/videos/cybercab-animation', { method: 'POST' });
  check('POST: 405', res.status === 405 && res.headers.get('Allow') === 'GET, HEAD');
}

console.log('nothing else in the bucket is reachable');
bucket.calls.length = 0;
for (const path of [
  '/videos/other',
  '/videos/Videos/other.mp4',
  '/videos/evidence/u1/receipt.jpg',
  '/videos/evidence%2Fu1%2Freceipt.jpg',
  '/videos/..%2Fevidence%2Fu1%2Freceipt.jpg',
  '/videos/CybercabAnimation.mp4',
  '/videos/cybercab-animation.mp4',
  '/videos/constructor',
  '/videos/',
]) {
  const res = await req(path);
  const body = await bytes(res);
  check(`${path}: not served`, res.status === 404 && !same(body, SECRET) && !same(body, VIDEO));
}
check('no rejected request touched the bucket', bucket.calls.length === 0);

console.log('private evidence routes unchanged');
{
  const res = await req('/api/submissions/sub-1/evidence');
  check('submission evidence still needs sign-in (401)', res.status === 401);
}

t.finish();
