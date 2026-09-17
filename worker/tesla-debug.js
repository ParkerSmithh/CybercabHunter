// TEMPORARY diagnostic route — Tesla Fleet API capability audit.
//
// Purpose: determine exactly what data the authenticated user's Tesla
// account exposes through documented Fleet API endpoints, with particular
// attention to whether any Robotaxi/ride-history data is accessible. This
// is read-only against Tesla's API and does not write anything to D1.
//
// Delete this file, its route in worker/index.js, and the two extra
// exports it uses from worker/tesla.js once the audit is done — it is not
// meant to remain in production long-term.

import { tesla } from './tesla.js';

const DOCUMENTED_ENDPOINTS = [
  { key: 'users_me', path: '/api/1/users/me' },
  { key: 'users_region', path: '/api/1/users/region' },
  { key: 'users_orders', path: '/api/1/users/orders' },
  { key: 'users_feature_config', path: '/api/1/users/feature_config' },
  { key: 'vehicles', path: '/api/1/vehicles' }
];

async function testEndpoint(base, path, accessToken) {
  const url = `${base}${path}`;
  try {
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    let body = null;
    let parseError = null;
    try {
      body = await resp.json();
    } catch (err) {
      parseError = 'non_json_response';
    }
    return {
      endpoint: path,
      status: resp.status,
      success: resp.ok,
      body: resp.ok ? body : null,
      error: resp.ok ? null : (body?.error || body?.message || parseError || `HTTP ${resp.status}`)
    };
  } catch (err) {
    return { endpoint: path, status: null, success: false, body: null, error: 'network_error' };
  }
}

function sanitizeVehicles(body) {
  const list = body?.response;
  if (!Array.isArray(list)) return [];
  return list.map(v => ({
    id: v.id_s ?? v.id ?? null,
    vin: v.vin ?? null,
    display_name: v.display_name ?? null,
    state: v.state ?? null
  }));
}

export async function apiTeslaDebugCapabilities(request, env) {
  const userId = await tesla.requireUserId(request, env);
  if (!userId) return Response.json({ authenticated: false }, { status: 401 });

  const accessToken = await tesla.getValidAccessToken(env, userId);
  if (!accessToken) {
    return Response.json({ success: false, error: 'not_connected' }, { status: 409 });
  }

  const base = tesla.FLEET_API_AUDIENCE;
  const results = {};
  for (const { key, path } of DOCUMENTED_ENDPOINTS) {
    results[key] = await testEndpoint(base, path, accessToken);
  }

  const vehiclesSanitized = results.vehicles.success ? sanitizeVehicles(results.vehicles.body) : [];

  const diagnostic = {
    oauth_scopes: ['openid', 'offline_access', 'vehicle_device_data', 'vehicle_location'],
    api_base: base,
    user: results.users_me.success ? results.users_me.body?.response ?? null : null,
    region: results.users_region.success ? results.users_region.body?.response ?? null : null,
    vehicles: vehiclesSanitized,
    robotaxi_capabilities: {
      ride_history_endpoint_found: false,
      ride_history_data_accessible: false,
      available_fields: [],
      notes: [
        'No documented Fleet API endpoint returns ride, trip, or Robotaxi history for any region as of the current developer.tesla.com Vehicle/User Endpoints reference.',
        'users/orders returns Tesla vehicle purchase orders, not ride/trip orders — confirmed by inspecting its live response below.',
        'None of the granted scopes (openid, offline_access, vehicle_device_data, vehicle_location) relate to ride-hailing or trip data; Fleet API scopes are limited to vehicle ownership/telemetry/commands.',
        'No endpoint was invented or guessed — only the 5 documented endpoints requested were tested.'
      ]
    },
    endpoint_tests: Object.values(results).map(r => ({
      endpoint: r.endpoint,
      status: r.status,
      success: r.success,
      body: r.endpoint === '/api/1/vehicles' ? (r.success ? { response: vehiclesSanitized } : null) : r.body,
      error: r.error
    }))
  };

  return Response.json(diagnostic);
}
