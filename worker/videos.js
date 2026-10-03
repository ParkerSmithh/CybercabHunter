// Public site videos, streamed from the PRIVATE evidence bucket.
//
// The bucket (EVIDENCE_BUCKET) holds riders' evidence and photos and has no
// public access. A video is served only when its slug is in VIDEOS below:
// the slug maps to one fixed object key, so a request can never name an
// arbitrary key (no path, prefix or key ever comes from the URL).
//
// GET/HEAD /videos/:slug
//   - Range requests (one range: bytes=a-b, bytes=a-, bytes=-n) answer 206
//     with Content-Range, so the browser can seek without fetching the whole
//     file; an unsatisfiable range is 416.
//   - ETag / If-None-Match (304) and If-Range, so a cached copy is revalidated
//     instead of downloaded again.
//   - Cached for a day, then revalidated (the object key never changes; a new
//     upload is picked up within a day, or at once on revalidation).
//   - Cross-Origin-Resource-Policy: same-origin: other sites cannot embed it.

const VIDEOS = new Map([
  // The homepage hero animation: the original upload, and the web copy the
  // site plays (H.264 1080p at ~6 Mbps, no audio, fast start).
  ['cybercab-animation', 'Videos/CybercabAnimation.mp4'],
  ['cybercab-animation-web', 'Videos/CybercabAnimation-web.mp4'],
]);

const CACHE_CONTROL = 'public, max-age=86400, stale-while-revalidate=604800';

function notFound() {
  return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } });
}

// One byte range from a Range header, clamped to the object's size.
// Returns { offset, length }, 'unsatisfiable', or null (no usable range:
// absent, malformed, or several ranges, so the whole file is sent).
export function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') {                                   // bytes=-n: the last n bytes
    const n = Number(m[2]);
    if (n === 0) return 'unsatisfiable';
    const length = Math.min(n, size);
    return { offset: size - length, length };
  }
  const start = Number(m[1]);
  if (start >= size) return 'unsatisfiable';
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (end < start) return null;                        // syntactically invalid: ignore it
  return { offset: start, length: end - start + 1 };
}

function etagMatches(header, etag) {
  if (!header) return false;
  if (header.trim() === '*') return true;
  const bare = (t) => t.trim().replace(/^W\//, '');
  return header.split(',').some((t) => bare(t) === bare(etag));
}

export async function serveVideo(request, env, slug) {
  const key = VIDEOS.get(slug);
  if (!key) return notFound();
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  }

  const head = await env.EVIDENCE_BUCKET.head(key);
  if (!head) return notFound();
  const size = head.size;
  const headers = new Headers({
    'Content-Type': 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Cache-Control': CACHE_CONTROL,
    'ETag': head.httpEtag,
    'Last-Modified': new Date(head.uploaded).toUTCString(),
    'Content-Disposition': 'inline',
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });

  if (etagMatches(request.headers.get('If-None-Match'), head.httpEtag)) {
    return new Response(null, { status: 304, headers });
  }

  // If-Range: only honour the range when the client's copy is this version.
  const ifRange = request.headers.get('If-Range');
  const rangeHeader = ifRange && !etagMatches(ifRange, head.httpEtag) ? null : request.headers.get('Range');
  const range = parseRange(rangeHeader, size);
  if (range === 'unsatisfiable') {
    headers.set('Content-Range', `bytes */${size}`);
    headers.set('Content-Length', '0');
    return new Response(null, { status: 416, headers });
  }

  if (range) {
    headers.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${size}`);
    headers.set('Content-Length', String(range.length));
  } else {
    headers.set('Content-Length', String(size));
  }
  const status = range ? 206 : 200;
  if (request.method === 'HEAD') return new Response(null, { status, headers });

  const object = await env.EVIDENCE_BUCKET.get(key, range ? { range } : undefined);
  if (!object) return notFound();
  return new Response(object.body, { status, headers });
}
