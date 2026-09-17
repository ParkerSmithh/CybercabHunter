// AES-256-GCM helpers for encrypting Tesla tokens at rest in D1, using the
// Workers-native Web Crypto API (no dependency). The key itself only ever
// exists as the Cloudflare Worker secret TESLA_TOKEN_ENCRYPTION_KEY — never
// in source, D1, KV, or anywhere the frontend can reach.

function base64ToBytes(b64) {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

function bytesToBase64(bytes) {
  let binary = '';
  bytes.forEach(b => { binary += String.fromCharCode(b); });
  return btoa(binary);
}

async function importKey(keyB64) {
  return crypto.subtle.importKey('raw', base64ToBytes(keyB64), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

// Returns one base64 string: a random 12-byte IV followed by the ciphertext.
async function encrypt(plaintext, keyB64) {
  const key = await importKey(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return bytesToBase64(combined);
}

async function decrypt(payloadB64, keyB64) {
  const key = await importKey(keyB64);
  const combined = base64ToBytes(payloadB64);
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const plaintextBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return new TextDecoder().decode(plaintextBuf);
}

export const tokenCrypto = { encrypt, decrypt };
