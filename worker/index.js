import { tesla } from './tesla.js';
import { apiCreateSubmission, apiListSubmissions, apiDeleteSubmission, apiGetEvidence } from './submissions.js';
import { handleIncomingEmail, apiGetIngestionAddress, apiGetSyncStatus } from './receipt-ingestion.js';
import { apiImportReceipts } from './receipt-import.js';
import { apiTeslaDebugCapabilities } from './tesla-debug.js';
import { robotaxiOwnerAuth } from './robotaxi-owner-auth.js';
import { apiListTrips, apiDeleteTrip, apiDeleteAllTrips } from './trips.js';
import { apiGetProfile, apiUpdateProfile } from './profile.js';
import { teslaRides } from './tesla-rides.js';
import { googleAuth } from './google-auth.js';

const ALLOWED_ORIGIN = 'https://cybercabhunter.com';

function withCors(response, request) {
  const origin = request.headers.get('Origin');
  if (origin !== ALLOWED_ORIGIN) return response;
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  headers.set('Vary', 'Origin');
  return new Response(response.body, { status: response.status, headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      const origin = request.headers.get('Origin');
      if (origin === ALLOWED_ORIGIN) {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
            'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            'Vary': 'Origin'
          }
        });
      }
      return new Response(null, { status: 204 });
    }

    if (url.pathname === '/health') {
      return Response.json({
        status: 'ok',
        service: 'cybercabhunter-worker',
        time: new Date().toISOString()
      });
    }

    // Full-page navigations (browser follows these directly) — no CORS needed.
    if (url.pathname === '/oauth/tesla/start') {
      return tesla.startOAuth(request, env);
    }
    if (url.pathname === '/oauth/tesla/callback') {
      return tesla.handleCallback(request, env);
    }

    // Google Sign-In — primary account creation, separate from the Tesla
    // Fleet API OAuth above. See worker/google-auth.js.
    if (url.pathname === '/oauth/google/start') {
      return googleAuth.startOAuth(request, env);
    }
    if (url.pathname === '/oauth/google/callback') {
      return googleAuth.handleCallback(request, env);
    }

    // Cross-origin fetch() calls from the frontend — need CORS headers.
    if (url.pathname === '/oauth/tesla/status' && request.method === 'GET') {
      return withCors(await tesla.handleStatus(request, env), request);
    }
    if (url.pathname === '/oauth/tesla/link' && request.method === 'POST') {
      return withCors(await tesla.apiCreateLinkToken(request, env), request);
    }
    if (url.pathname === '/oauth/tesla/disconnect' && request.method === 'POST') {
      return withCors(await tesla.handleDisconnect(request, env), request);
    }

    // Phase 1 private API — every handler resolves the authenticated user
    // itself from the bearer session; none trust an ID from the request.
    if (url.pathname === '/api/me' && request.method === 'GET') {
      return withCors(await tesla.apiMe(request, env), request);
    }
    if (url.pathname === '/api/tesla/status' && request.method === 'GET') {
      return withCors(await tesla.apiTeslaStatus(request, env), request);
    }
    if (url.pathname === '/api/tesla/vehicles' && request.method === 'GET') {
      return withCors(await tesla.apiVehicles(request, env), request);
    }
    if (url.pathname === '/api/tesla/sync' && request.method === 'POST') {
      return withCors(await tesla.apiSync(request, env), request);
    }
    if (url.pathname === '/api/tesla/disconnect' && request.method === 'POST') {
      return withCors(await tesla.apiDisconnect(request, env), request);
    }
    if (url.pathname === '/api/tesla/data' && request.method === 'DELETE') {
      return withCors(await tesla.apiDeleteData(request, env), request);
    }

    // Ride-submission evidence API — every route resolves and requires the
    // authenticated user itself; none trust an ID from the request.
    if (url.pathname === '/api/submissions' && request.method === 'POST') {
      const userId = await tesla.requireUserId(request, env);
      if (!userId) return withCors(Response.json({ authenticated: false }, { status: 401 }), request);
      return withCors(await apiCreateSubmission(request, env, userId), request);
    }
    if (url.pathname === '/api/submissions' && request.method === 'GET') {
      const userId = await tesla.requireUserId(request, env);
      if (!userId) return withCors(Response.json({ authenticated: false }, { status: 401 }), request);
      return withCors(await apiListSubmissions(request, env, userId), request);
    }
    const evidenceMatch = url.pathname.match(/^\/api\/submissions\/([^/]+)\/evidence$/);
    if (evidenceMatch && request.method === 'GET') {
      const userId = await tesla.requireUserId(request, env);
      if (!userId) return withCors(Response.json({ authenticated: false }, { status: 401 }), request);
      return withCors(await apiGetEvidence(request, env, userId, evidenceMatch[1]), request);
    }
    const submissionIdMatch = url.pathname.match(/^\/api\/submissions\/([^/]+)$/);
    if (submissionIdMatch && request.method === 'DELETE') {
      const userId = await tesla.requireUserId(request, env);
      if (!userId) return withCors(Response.json({ authenticated: false }, { status: 401 }), request);
      return withCors(await apiDeleteSubmission(request, env, userId, submissionIdMatch[1]), request);
    }

    if (url.pathname === '/api/receipt-ingestion/address' && request.method === 'GET') {
      const userId = await tesla.requireUserId(request, env);
      if (!userId) return withCors(Response.json({ authenticated: false }, { status: 401 }), request);
      return withCors(await apiGetIngestionAddress(request, env, userId), request);
    }

    if (url.pathname === '/api/trips' && request.method === 'GET') {
      const userId = await tesla.requireUserId(request, env);
      if (!userId) return withCors(Response.json({ authenticated: false }, { status: 401 }), request);
      return withCors(await apiListTrips(request, env, userId), request);
    }
    if (url.pathname === '/api/trips' && request.method === 'DELETE') {
      const userId = await tesla.requireUserId(request, env);
      if (!userId) return withCors(Response.json({ authenticated: false }, { status: 401 }), request);
      return withCors(await apiDeleteAllTrips(request, env, userId), request);
    }
    const tripIdMatch = url.pathname.match(/^\/api\/trips\/([^/]+)$/);
    if (tripIdMatch && request.method === 'DELETE') {
      const userId = await tesla.requireUserId(request, env);
      if (!userId) return withCors(Response.json({ authenticated: false }, { status: 401 }), request);
      return withCors(await apiDeleteTrip(request, env, userId, tripIdMatch[1]), request);
    }

    // Receipt sync: historical import and the rider's sync/forwarding status.
    if (url.pathname === '/api/rides/import' && request.method === 'POST') {
      const userId = await tesla.requireUserId(request, env);
      if (!userId) return withCors(Response.json({ authenticated: false }, { status: 401 }), request);
      return withCors(await apiImportReceipts(request, env, userId), request);
    }
    if (url.pathname === '/api/rides/sync-status' && request.method === 'GET') {
      const userId = await tesla.requireUserId(request, env);
      if (!userId) return withCors(Response.json({ authenticated: false }, { status: 401 }), request);
      return withCors(await apiGetSyncStatus(request, env, userId), request);
    }

    if (url.pathname === '/api/profile' && request.method === 'GET') {
      const userId = await tesla.requireUserId(request, env);
      if (!userId) return withCors(Response.json({ authenticated: false }, { status: 401 }), request);
      return withCors(await apiGetProfile(request, env, userId), request);
    }
    if (url.pathname === '/api/profile' && request.method === 'PATCH') {
      const userId = await tesla.requireUserId(request, env);
      if (!userId) return withCors(Response.json({ authenticated: false }, { status: 401 }), request);
      return withCors(await apiUpdateProfile(request, env, userId), request);
    }

    // Tesla Ride Sync — a separate OAuth subsystem from the Fleet API
    // routes above and from the earlier /oauth/robotaxi/* experiment. See
    // worker/tesla-rides.js. No ride-history endpoint exists yet.
    if (url.pathname === '/api/tesla/rides/connect' && request.method === 'GET') {
      return withCors(await teslaRides.startAuthorization(request, env), request);
    }
    // Reached by Tesla's own redirect, not a fetch() — no CORS handling,
    // matching /oauth/tesla/callback and /oauth/robotaxi/callback.
    if (url.pathname === '/api/tesla/rides/callback' && request.method === 'GET') {
      return await teslaRides.handleCallback(request, env);
    }
    if (url.pathname === '/api/tesla/rides/status' && request.method === 'GET') {
      return withCors(await teslaRides.apiStatus(request, env), request);
    }
    if (url.pathname === '/api/tesla/rides/disconnect' && request.method === 'POST') {
      return withCors(await teslaRides.apiDisconnect(request, env), request);
    }

    // TEMPORARY — Tesla Fleet API capability audit. Delete this route (and
    // worker/tesla-debug.js) once the audit is done; see that file's header.
    if (url.pathname === '/api/tesla/debug/capabilities' && request.method === 'GET') {
      return withCors(await apiTeslaDebugCapabilities(request, env), request);
    }

    // Robotaxi ride-history (ownerapi) authentication — fully separate from
    // the Fleet API routes above. See worker/robotaxi-owner-auth.js.
    // /oauth/robotaxi/start requires the bearer session (fetch, not a link
    // click) since it needs to know which user is linking before handing
    // off to Tesla, so unlike /oauth/tesla/start it goes through withCors.
    if (url.pathname === '/oauth/robotaxi/start' && request.method === 'GET') {
      return withCors(await robotaxiOwnerAuth.startOAuth(request, env), request);
    }
    // Tesla's void-callback page isn't on our domain (see that module's
    // header) — reached by the user pasting the resulting URL, not a
    // cross-origin fetch, so no CORS handling here, matching /oauth/tesla/callback.
    if (url.pathname === '/oauth/robotaxi/callback' && request.method === 'GET') {
      return await robotaxiOwnerAuth.handleCallback(request, env);
    }
    if (url.pathname === '/api/robotaxi/status' && request.method === 'GET') {
      return withCors(await robotaxiOwnerAuth.apiStatus(request, env), request);
    }
    if (url.pathname === '/api/robotaxi/disconnect' && request.method === 'POST') {
      return withCors(await robotaxiOwnerAuth.apiDisconnect(request, env), request);
    }

    // Everything else falls through to the static site (same files GitHub Pages serves).
    return env.ASSETS.fetch(request);
  },

  // Handles inbound receipt-forwarding email once Cloudflare Email Routing
  // is configured for a real domain (see docs/receipt-ingestion.md — this
  // cannot go live until that domain exists; the handler itself is ready
  // and tested against synthetic messages in the meantime).
  async email(message, env, ctx) {
    return handleIncomingEmail(message, env);
  }
};
