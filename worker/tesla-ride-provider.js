// Tesla Robotaxi ride history — the client for Tesla's own ride-history
// endpoint, as used by the Tesla mobile app:
//
//   GET https://ownership.tesla.com/mobile-app/ride/history
//   GET https://akamai-apigateway-charging-ownership.tesla.com/mobile-app/ride/history  (fallback)
//
// Verified by Ethan McKanna's public, MIT-licensed exporter
// (https://github.com/EthanMcKanna/robotaxi-history-exporter,
// robotaxi_history.py, Jan 2026; its MIT notice is reproduced in
// worker/robotaxi-owner-auth.js), which calls exactly this endpoint with a
// token from Tesla's first-party `ownerapi` OAuth client (worker/tesla-rides.js
// holds that flow). It is the rider's OWN data, fetched with their explicit
// consent and their own token. It is also UNDOCUMENTED: Tesla can change or
// remove it without notice, which is why receipt forwarding stays as the
// fallback ride source (docs/tesla-ride-sync.md).
//
// Request: a plain Bearer token plus pageNo / deviceLanguage / deviceCountry /
// ttpLocale. Response: {"code":200,"data":{"rides":[...]}}, 100 rides a page;
// pages are read until a short (or empty) one.
//
// Headers start minimal. The reference script also sends the mobile app's
// headers (X-Tesla-User-Agent etc.); those are added only when a host refuses
// the minimal request (400 / 401 / 403 / 406), never by default. A 401 to the
// minimal request is NOT taken as an expired token until the app headers and
// the fallback host have been tried too: the endpoint can answer 401 to a
// request that lacks the app headers.
//
// NEEDS A LIVE VERIFICATION PASS: everything here is covered by mocked tests
// (tests/tesla-ride-provider.test.mjs); it has not yet been run against a
// Tesla account that has Robotaxi rides.
//
// Never logs the token or a response body.

export const RIDE_HISTORY_HOSTS = [
  'https://ownership.tesla.com',
  'https://akamai-apigateway-charging-ownership.tesla.com'
];
export const RIDE_HISTORY_PATH = '/mobile-app/ride/history';
export const PAGE_SIZE = 100;
// A runaway guard, far above any rider's history (100 rides a page).
export const MAX_PAGES = 50;

const APP_HEADERS = {
  'X-Tesla-User-Agent': 'TeslaApp/4.36.5-2659/abc123/ios/18.0',
  'Accept-Language': 'en-US',
  'Cache-Control': 'no-cache'
};
// Statuses that mean "this request shape may have been refused", worth one
// retry with the app headers. 401 is one of them: the live endpoint answered a
// fresh, valid ownerapi token with 401 when the app headers were missing.
const RETRY_WITH_APP_HEADERS = new Set([400, 401, 403, 406]);

// The access token is expired or revoked: the caller refreshes and retries.
// `attempts` lists the HTTP status of each host/header attempt (no token data).
export class TokenExpiredError extends Error {
  constructor(attempts = []) {
    super('Tesla ride history: access token rejected (401)');
    this.name = 'TokenExpiredError';
    this.status = 401;
    this.attempts = attempts;
  }
}

// Neither host returned the ride history. `status` is the last HTTP status
// seen (null when every attempt failed at the network level).
export class RideHistoryError extends Error {
  constructor(status, attempts = []) {
    super(`Tesla ride history unavailable${status ? ` (HTTP ${status})` : ''}`);
    this.name = 'RideHistoryError';
    this.status = status || null;
    this.attempts = attempts;
  }
}

function pageUrl(host, page) {
  const url = new URL(RIDE_HISTORY_PATH, host);
  url.searchParams.set('pageNo', String(page));
  url.searchParams.set('deviceLanguage', 'en');
  url.searchParams.set('deviceCountry', 'US');
  url.searchParams.set('ttpLocale', 'en_US');
  return url.toString();
}

function headersFor(accessToken, withAppHeaders) {
  const base = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' };
  return withAppHeaders ? { ...base, ...APP_HEADERS } : base;
}

// The rides array out of a page body, or null when the body isn't the
// documented shape. Mirrors the reference script's tolerance: data.rides,
// a bare rides array, or a top-level list.
function ridesFromBody(body) {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    if (body.data && typeof body.data === 'object' && Array.isArray(body.data.rides)) return body.data.rides;
    if (Array.isArray(body.rides)) return body.rides;
    if (Array.isArray(body.data)) return body.data;
    return null;
  }
  return Array.isArray(body) ? body : null;
}

// One page from one host: { rides } on success, { status } on a refusal
// (401 included — the caller decides what a 401 means).
async function tryPage(fetchImpl, host, page, accessToken, withAppHeaders) {
  let resp;
  try {
    resp = await fetchImpl(pageUrl(host, page), { method: 'GET', headers: headersFor(accessToken, withAppHeaders) });
  } catch (err) {
    return { status: null };
  }
  if (resp.status !== 200) return { status: resp.status };
  let body;
  try { body = await resp.json(); } catch (err) { return { status: resp.status, malformed: true }; }
  const rides = ridesFromBody(body);
  return rides ? { rides } : { status: resp.status, malformed: true };
}

// All of a rider's rides, raw, in the API's order. Until a host answers, every
// host and header set is tried; if none works and any answered 401, throws
// TokenExpiredError (so the caller can refresh and call again), otherwise
// RideHistoryError. Once a host (and header set) works, the remaining pages
// use the same one, and a 401 there is TokenExpiredError at once.
export async function fetchRides(accessToken, { fetchImpl = (...a) => fetch(...a), maxPages = MAX_PAGES } = {}) {
  if (!accessToken) throw new TokenExpiredError();
  const all = [];
  let working = null;   // { host, withAppHeaders }
  for (let page = 1; page <= maxPages; page++) {
    let rides = null;
    let lastStatus = null;
    const seen = [];   // statuses of this page's attempts, for the error
    const attempts = working
      ? [working]
      : RIDE_HISTORY_HOSTS.flatMap(host => [{ host, withAppHeaders: false }, { host, withAppHeaders: true }]);
    for (const attempt of attempts) {
      // The app headers are only tried after the same host refused the minimal request.
      if (attempt.withAppHeaders && !working && !RETRY_WITH_APP_HEADERS.has(lastStatus)) continue;
      const result = await tryPage(fetchImpl, attempt.host, page, accessToken, attempt.withAppHeaders);
      if (result.rides) { rides = result.rides; working = attempt; break; }
      lastStatus = result.status;
      seen.push(result.status);
      if (working && result.status === 401) throw new TokenExpiredError(seen);
    }
    if (!rides) {
      if (seen.includes(401)) throw new TokenExpiredError(seen);
      throw new RideHistoryError(lastStatus, seen);
    }
    all.push(...rides);
    if (rides.length < PAGE_SIZE) break;
  }
  return all;
}

export const teslaRideProvider = { fetchRides };
