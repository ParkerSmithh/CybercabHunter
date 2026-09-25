// Submit-only entry point for the Muse connector: POST /api/connector/vehicle-sightings.
//
// Authenticated by ONE shared secret (env.MUSE_CONNECTOR_TOKEN, a Worker
// secret) — not a rider session, so it is accepted on this route only and
// nowhere else, and no session token is accepted here. Every submission is
// attributed to the single dedicated user in env.MUSE_CONNECTOR_USER_ID and
// goes through exactly the same handler as a rider's sighting, so it lands
// as 'pending'/'unverified' in the moderation queue and can never create or
// change a public registry vehicle. Public reads need no token at all and
// are untouched by this file.

import { apiCreateVehicleSighting } from './sightings.js';

export const CONNECTOR_DAILY_LIMIT = 50;

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

// Compares fixed-length digests so the comparison time doesn't depend on
// how much of the token a guess got right.
async function tokensMatch(provided, expected) {
  const [a, b] = await Promise.all([sha256(provided), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function readBearerToken(request) {
  const match = (request.headers.get('Authorization') || '').match(/^Bearer\s+(\S+)\s*$/i);
  return match ? match[1] : null;
}

export async function apiConnectorCreateVehicleSighting(request, env) {
  const expected = env.MUSE_CONNECTOR_TOKEN;
  const userId = env.MUSE_CONNECTOR_USER_ID;
  if (!expected || !userId) {
    return Response.json({ success: false, error: 'connector_not_configured' }, { status: 503 });
  }

  const provided = readBearerToken(request);
  if (!provided || !(await tokensMatch(provided, expected))) {
    return Response.json({ success: false, error: 'unauthorized' }, {
      status: 401, headers: { 'WWW-Authenticate': 'Bearer' }
    });
  }

  // Rolling 24h cap on created submissions (a duplicate replay creates none).
  // Concurrent requests can overshoot it by a few; it bounds damage from a
  // leaked token, it is not an exact quota.
  let n;
  try {
    ({ n } = await env.cybercabhunter_db.prepare(`
      SELECT COUNT(*) AS n FROM submissions
      WHERE user_id = ? AND submission_type = 'vehicle_sighting' AND submitted_at >= datetime('now', '-1 day')
    `).bind(userId).first());
  } catch (err) {
    return Response.json({ success: false, error: 'connector_unavailable' }, { status: 500 });
  }
  if (n >= CONNECTOR_DAILY_LIMIT) {
    return Response.json({ success: false, error: 'daily_limit_reached', limit: CONNECTOR_DAILY_LIMIT }, {
      status: 429, headers: { 'Retry-After': '3600' }
    });
  }

  return apiCreateVehicleSighting(request, env, userId);
}
