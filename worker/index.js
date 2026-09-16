import { tesla } from './tesla.js';

const ALLOWED_ORIGIN = 'https://parkersmithh.github.io';

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
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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

    // Cross-origin fetch() calls from the frontend — need CORS headers.
    if (url.pathname === '/oauth/tesla/status' && request.method === 'GET') {
      return withCors(await tesla.handleStatus(request, env), request);
    }
    if (url.pathname === '/oauth/tesla/disconnect' && request.method === 'POST') {
      return withCors(await tesla.handleDisconnect(request, env), request);
    }

    // Everything else falls through to the static site (same files GitHub Pages serves).
    return env.ASSETS.fetch(request);
  }
};
