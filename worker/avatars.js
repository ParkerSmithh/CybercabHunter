// Profile pictures.
//
//   POST   /api/profile/avatar   (signed in) multipart: `large` 512x512, `thumb` 128x128
//   DELETE /api/profile/avatar   (signed in) removes it -> the initials placeholder
//   GET    /api/avatars/<key>/<128|512>   public: one generated variant
//
// The cropping, zooming and resizing happen in the browser (public/profile.html):
// Workers on the Free plan can't decode or resize images. The browser draws the
// chosen square crop at exactly 512 and 128 px and re-encodes it — the user's
// ORIGINAL file never leaves their device, so no full-resolution original is
// ever stored or served. The server trusts none of that: it checks each variant's
// real type from its bytes (JPEG, PNG or WebP), its size (5 MB at most), and that
// its pixel size is exactly 512x512 / 128x128, and it strips every metadata block
// (EXIF incl. GPS, XMP, text, comments) before storing it.
//
// Ownership: the user is ALWAYS the session's — no user id, key or path is read
// from the request — so a rider can only ever set or remove their own picture.
//
// Storage (R2, the evidence bucket): avatars/<user_id>/<key>/512 and .../128,
// where <key> is 32 random hex characters, new on every upload. users.avatar_url
// becomes "/api/avatars/<key>" (a Google sign-in's own photo URL otherwise), so a
// public avatar URL never contains a user id, and a replaced or removed picture's
// key simply stops resolving. A new upload deletes the previous one's files.

import { tesla } from './tesla.js';

export const AVATAR_SIZES = [128, 512];
export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const KEY_RE = /^[a-f0-9]{32}$/;
const PATH_PREFIX = '/api/avatars/';
const prefixFor = userId => `avatars/${userId}/`;
const objectKey = (userId, key, size) => `avatars/${userId}/${key}/${size}`;

const bad = (error, status = 400) => Response.json({ success: false, error }, { status });

// ---- Image checks (from the bytes, never the declared type) ----
export function sniffImage(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b)) return 'image/png';
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'image/webp';
  return null;
}

const u16be = (b, i) => (b[i] << 8) | b[i + 1];
const u32be = (b, i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
const u32le = (b, i) => b[i] + (b[i + 1] << 8) + (b[i + 2] << 16) + ((b[i + 3] << 24) >>> 0);
const u24le = (b, i) => b[i] + (b[i + 1] << 8) + (b[i + 2] << 16);

// Pixel size from the image's own header, or null if it can't be read.
export function imageSize(bytes, type) {
  try {
    if (type === 'image/png') return u32be(bytes, 12) === 0x49484452 ? { width: u32be(bytes, 16), height: u32be(bytes, 20) } : null;
    if (type === 'image/jpeg') {
      let i = 2;
      while (i + 9 < bytes.length) {
        if (bytes[i] !== 0xff) return null;
        const marker = bytes[i + 1];
        if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue; }
        const len = u16be(bytes, i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: u16be(bytes, i + 5), width: u16be(bytes, i + 7) };
        if (marker === 0xda) return null;
        i += 2 + len;
      }
      return null;
    }
    if (type === 'image/webp') {
      const chunk = String.fromCharCode(...bytes.slice(12, 16));
      if (chunk === 'VP8X') return { width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1 };
      if (chunk === 'VP8 ') return { width: (bytes[26] | (bytes[27] << 8)) & 0x3fff, height: (bytes[28] | (bytes[29] << 8)) & 0x3fff };
      if (chunk === 'VP8L') {
        const b = bytes.slice(21, 25);
        return { width: 1 + (((b[1] & 0x3f) << 8) | b[0]), height: 1 + (((b[3] & 0xf) << 10) | (b[2] << 2) | ((b[1] & 0xc0) >> 6)) };
      }
    }
  } catch (e) { /* unreadable */ }
  return null;
}

// Every metadata block removed: JPEG APP1-APP15 and COM segments (EXIF/GPS,
// XMP, ICC, comments); PNG text/EXIF/time chunks; WebP EXIF/XMP chunks (and
// their VP8X flags). The picture data itself is copied as-is.
export function stripMetadata(bytes, type) {
  if (type === 'image/jpeg') {
    const out = [bytes.slice(0, 2)];
    let i = 2;
    while (i + 4 <= bytes.length && bytes[i] === 0xff) {
      const marker = bytes[i + 1];
      if (marker === 0xda) break;                                   // start of scan: the rest is image data
      const len = u16be(bytes, i + 2);
      const isMeta = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;
      if (!isMeta) out.push(bytes.slice(i, i + 2 + len));
      i += 2 + len;
    }
    out.push(bytes.slice(i));
    return concat(out);
  }
  if (type === 'image/png') {
    const drop = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);
    const out = [bytes.slice(0, 8)];
    let i = 8;
    while (i + 12 <= bytes.length) {
      const len = u32be(bytes, i);
      const name = String.fromCharCode(...bytes.slice(i + 4, i + 8));
      const end = i + 12 + len;
      if (!drop.has(name)) out.push(bytes.slice(i, end));
      i = end;
      if (name === 'IEND') break;
    }
    return concat(out);
  }
  if (type === 'image/webp') {
    const chunks = [];
    let i = 12;
    while (i + 8 <= bytes.length) {
      const name = String.fromCharCode(...bytes.slice(i, i + 4));
      const len = u32le(bytes, i + 4);
      const end = i + 8 + len + (len % 2);
      if (name !== 'EXIF' && name !== 'XMP ') {
        const chunk = bytes.slice(i, Math.min(end, bytes.length));
        if (name === 'VP8X') chunk[8] &= ~0x0c;                     // clear the EXIF (0x08) and XMP (0x04) flags
        chunks.push(chunk);
      }
      i = end;
    }
    const body = concat(chunks);
    const head = new Uint8Array(12);
    head.set(bytes.slice(0, 4), 0);
    const size = 4 + body.length;
    head.set([size & 0xff, (size >> 8) & 0xff, (size >> 16) & 0xff, (size >>> 24) & 0xff], 4);
    head.set(bytes.slice(8, 12), 8);
    return concat([head, body]);
  }
  return bytes;
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const randomKey = () => [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');

// The avatar key of a stored custom picture ("/api/avatars/<key>"), else null.
export function customAvatarKey(avatarUrl) {
  if (typeof avatarUrl !== 'string' || !avatarUrl.startsWith(PATH_PREFIX)) return null;
  const key = avatarUrl.slice(PATH_PREFIX.length);
  return KEY_RE.test(key) ? key : null;
}

async function deleteUserAvatarFiles(bucket, userId, keepKey = null) {
  const keys = [];
  let cursor;
  for (let page = 0; page < 10; page++) {
    const res = await bucket.list({ prefix: prefixFor(userId), cursor });
    for (const o of (res && res.objects) || []) if (!keepKey || !o.key.startsWith(`${prefixFor(userId)}${keepKey}/`)) keys.push(o.key);
    if (!res || !res.truncated) break;
    cursor = res.cursor;
  }
  if (keys.length) await bucket.delete(keys);
}

export async function apiUploadAvatar(request, env) {
  const userId = await tesla.requireUserId(request, env);
  if (!userId) return Response.json({ authenticated: false }, { status: 401 });
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared && declared > MAX_AVATAR_BYTES + 64 * 1024) return bad('file_too_large', 413);

  let form;
  try { form = await request.formData(); } catch (e) { return bad('invalid_form_data'); }
  const variants = {};
  for (const [field, size] of [['large', 512], ['thumb', 128]]) {
    const file = form.get(field);
    if (!file || typeof file === 'string' || file.size === 0) return bad('missing_image');
    if (file.size > MAX_AVATAR_BYTES) return bad('file_too_large', 413);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const type = sniffImage(bytes);
    if (!type) return bad('unsupported_file_type');
    const dims = imageSize(bytes, type);
    if (!dims || dims.width !== size || dims.height !== size) return bad('invalid_dimensions');
    variants[size] = { bytes: stripMetadata(bytes, type), type };
  }

  const sql = env.cybercabhunter_db;
  const user = await sql.prepare(`SELECT id FROM users WHERE id = ?`).bind(userId).first();
  if (!user) return Response.json({ authenticated: false }, { status: 401 });
  const key = randomKey();
  for (const size of AVATAR_SIZES) {
    await env.EVIDENCE_BUCKET.put(objectKey(userId, key, size), variants[size].bytes, {
      httpMetadata: { contentType: variants[size].type, cacheControl: 'public, max-age=31536000, immutable' }
    });
  }
  const avatarUrl = `${PATH_PREFIX}${key}`;
  await sql.prepare(`UPDATE users SET avatar_url = ?, updated_at = datetime('now') WHERE id = ?`).bind(avatarUrl, userId).run();
  // The previous picture's files go (best effort; its key no longer resolves anyway).
  try { await deleteUserAvatarFiles(env.EVIDENCE_BUCKET, userId, key); } catch (e) { /* ignore */ }
  return Response.json({ success: true, avatar_url: avatarUrl });
}

export async function apiDeleteAvatar(request, env) {
  const userId = await tesla.requireUserId(request, env);
  if (!userId) return Response.json({ authenticated: false }, { status: 401 });
  const sql = env.cybercabhunter_db;
  await sql.prepare(`UPDATE users SET avatar_url = NULL, updated_at = datetime('now') WHERE id = ?`).bind(userId).run();
  try { await deleteUserAvatarFiles(env.EVIDENCE_BUCKET, userId); } catch (e) { /* the url is already cleared */ }
  return Response.json({ success: true, avatar_url: null });
}

export async function apiGetAvatar(request, env, key, size) {
  const notFound = () => new Response('Not found', { status: 404 });
  if (!KEY_RE.test(key) || !AVATAR_SIZES.includes(Number(size))) return notFound();
  const user = await env.cybercabhunter_db.prepare(`SELECT id FROM users WHERE avatar_url = ?`).bind(`${PATH_PREFIX}${key}`).first();
  if (!user) return notFound();
  const object = await env.EVIDENCE_BUCKET.get(objectKey(user.id, key, Number(size)));
  if (!object) return notFound();
  const type = object.httpMetadata && object.httpMetadata.contentType;
  return new Response(object.body, {
    headers: {
      'Content-Type': ['image/jpeg', 'image/png', 'image/webp'].includes(type) ? type : 'application/octet-stream',
      'Cache-Control': 'public, max-age=31536000, immutable',   // a new upload gets a new key
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'inline'
    }
  });
}
