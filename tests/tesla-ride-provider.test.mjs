// Tesla ride-history client (worker/tesla-ride-provider.js) against a mocked
// fetch: pagination, host fallback, the app-header retry, and 401 signalling.
// No network. Run: node tests/tesla-ride-provider.test.mjs
//
// These mocks follow the shapes in the reference exporter
// (EthanMcKanna/robotaxi-history-exporter). A LIVE verification pass against a
// Tesla account with Robotaxi rides is still needed (docs/tesla-ride-sync.md).

import { fetchRides, TokenExpiredError, RideHistoryError, RIDE_HISTORY_HOSTS, PAGE_SIZE } from '../worker/tesla-ride-provider.js';
import { makeCheck } from './helpers/env.mjs';

const t = makeCheck();
const { check } = t;
const [PRIMARY, FALLBACK] = RIDE_HISTORY_HOSTS;

const rides = (n, from = 0) => Array.from({ length: n }, (_, i) => ({ rideId: `r${from + i}` }));
const page = list => new Response(JSON.stringify({ code: 200, data: { rides: list } }), { status: 200 });

// A fetch double: `route(url, headers, call)` returns a Response (or throws).
function mock(route) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const u = new URL(url);
    const call = { url: u, host: u.origin, page: Number(u.searchParams.get('pageNo')), headers: opts.headers };
    calls.push(call);
    return route(call);
  };
  return { fetchImpl, calls };
}

async function run() {
  console.log('1. Request shape');
  {
    const m = mock(() => page(rides(3)));
    const out = await fetchRides('tok-123', { fetchImpl: m.fetchImpl });
    const c = m.calls[0];
    check('one page, one call, to the primary host and the documented path', m.calls.length === 1 && c.host === PRIMARY && c.url.pathname === '/mobile-app/ride/history');
    check('pageNo=1, deviceLanguage=en, deviceCountry=US, ttpLocale=en_US', c.page === 1 && c.url.searchParams.get('deviceLanguage') === 'en' && c.url.searchParams.get('deviceCountry') === 'US' && c.url.searchParams.get('ttpLocale') === 'en_US');
    check('a plain Bearer token', c.headers.Authorization === 'Bearer tok-123');
    check('minimal headers by default (no app user agent)', !('X-Tesla-User-Agent' in c.headers));
    check('returns the raw rides array', Array.isArray(out) && out.length === 3 && out[0].rideId === 'r0');
  }

  console.log('2. Pagination: 100 a page until a short page');
  {
    const m = mock(c => page(c.page === 1 ? rides(PAGE_SIZE) : c.page === 2 ? rides(PAGE_SIZE, 100) : rides(37, 200)));
    const out = await fetchRides('tok', { fetchImpl: m.fetchImpl });
    check('three pages read (100 + 100 + 37)', m.calls.map(c => c.page).join(',') === '1,2,3' && out.length === 237);
    check('rides kept in order across pages', out[0].rideId === 'r0' && out[100].rideId === 'r100' && out[236].rideId === 'r236');

    const exact = mock(c => page(c.page === 1 ? rides(PAGE_SIZE) : []));
    const out2 = await fetchRides('tok', { fetchImpl: exact.fetchImpl });
    check('a full last page is followed by an empty one, which ends it', exact.calls.length === 2 && out2.length === 100);

    const none = mock(() => page([]));
    check('no rides at all: an empty array, one call', (await fetchRides('tok', { fetchImpl: none.fetchImpl })).length === 0 && none.calls.length === 1);

    const runaway = mock(c => page(rides(PAGE_SIZE, c.page * 100)));
    const out3 = await fetchRides('tok', { fetchImpl: runaway.fetchImpl, maxPages: 4 });
    check('a runaway guard stops after maxPages', runaway.calls.length === 4 && out3.length === 400);
  }

  console.log('3. Host fallback');
  {
    const m = mock(c => (c.host === PRIMARY ? new Response('down', { status: 503 }) : page(rides(2))));
    const out = await fetchRides('tok', { fetchImpl: m.fetchImpl });
    check('primary 503 -> fallback host answers', out.length === 2 && m.calls.map(c => c.host).join(',') === `${PRIMARY},${FALLBACK}`);

    const net = mock(c => { if (c.host === PRIMARY) throw new TypeError('network'); return page(rides(1)); });
    check('a network error on the primary also falls back', (await fetchRides('tok', { fetchImpl: net.fetchImpl })).length === 1);

    const sticky = mock(c => (c.host === PRIMARY ? new Response('', { status: 502 }) : page(c.page === 1 ? rides(PAGE_SIZE) : rides(5, 100))));
    await fetchRides('tok', { fetchImpl: sticky.fetchImpl });
    check('once the fallback works, later pages go straight to it', sticky.calls.map(c => `${c.host === PRIMARY ? 'P' : 'F'}${c.page}`).join(',') === 'P1,F1,F2');

    const bad = mock(c => (c.host === PRIMARY ? new Response('<html>', { status: 200 }) : page(rides(1))));
    check('a 200 with a body that is not ride history falls back too', (await fetchRides('tok', { fetchImpl: bad.fetchImpl })).length === 1);
  }

  console.log('4. App headers only when a host refuses the minimal request');
  {
    const m = mock(c => (c.headers['X-Tesla-User-Agent'] ? page(rides(1)) : new Response('', { status: 403 })));
    const out = await fetchRides('tok', { fetchImpl: m.fetchImpl });
    check('403 with minimal headers -> one retry on the same host with the app headers', out.length === 1 && m.calls.length === 2 && m.calls[1].host === PRIMARY && !!m.calls[1].headers['X-Tesla-User-Agent']);

    const s500 = mock(c => (c.host === PRIMARY ? new Response('', { status: 500 }) : page(rides(1))));
    await fetchRides('tok', { fetchImpl: s500.fetchImpl });
    check('a 500 is not "refused": no app-header retry, straight to the fallback', s500.calls.length === 2 && !s500.calls.some(c => c.headers['X-Tesla-User-Agent']));
  }

  console.log('5. 401 -> TokenExpiredError (the caller refreshes)');
  {
    const m = mock(() => new Response('', { status: 401 }));
    let err = null;
    try { await fetchRides('tok', { fetchImpl: m.fetchImpl }); } catch (e) { err = e; }
    check('a distinct TokenExpiredError', err instanceof TokenExpiredError);
    check('only after the app headers and the fallback host also answered 401', m.calls.length === 4 && m.calls.filter(c => c.headers['X-Tesla-User-Agent']).length === 2 && err.attempts.join() === '401,401,401,401');

    const appOnly = mock(c => (c.headers['X-Tesla-User-Agent'] ? page(rides(2)) : new Response('', { status: 401 })));
    const ok = await fetchRides('tok', { fetchImpl: appOnly.fetchImpl });
    check('LIVE CASE: 401 to the minimal request, 200 with the app headers -> the rides, no TokenExpiredError', ok.length === 2 && appOnly.calls.length === 2 && appOnly.calls[0].host === PRIMARY && !!appOnly.calls[1].headers['X-Tesla-User-Agent']);

    const later = mock(c => (c.page === 1 ? page(rides(PAGE_SIZE)) : new Response('', { status: 401 })));
    let err2 = null;
    try { await fetchRides('tok', { fetchImpl: later.fetchImpl }); } catch (e) { err2 = e; }
    check('a 401 on a later page also throws TokenExpiredError (no partial result)', err2 instanceof TokenExpiredError);

    const none = mock(() => page([]));
    let err3 = null;
    try { await fetchRides('', { fetchImpl: none.fetchImpl }); } catch (e) { err3 = e; }
    check('no token at all -> TokenExpiredError without a request', err3 instanceof TokenExpiredError && none.calls.length === 0);
  }

  console.log('6. Both hosts fail -> RideHistoryError with the status');
  {
    const m = mock(() => new Response('', { status: 502 }));
    let err = null;
    try { await fetchRides('tok', { fetchImpl: m.fetchImpl }); } catch (e) { err = e; }
    check('RideHistoryError carrying the last HTTP status', err instanceof RideHistoryError && err.status === 502);
    check('the error message never contains the token', !String(err.message).includes('tok'));

    const net = mock(() => { throw new TypeError('offline'); });
    let err2 = null;
    try { await fetchRides('tok', { fetchImpl: net.fetchImpl }); } catch (e) { err2 = e; }
    check('network failure everywhere -> RideHistoryError with status null', err2 instanceof RideHistoryError && err2.status === null);
  }

  console.log('7. Other response shapes the reference script accepts');
  {
    const bare = mock(() => new Response(JSON.stringify({ rides: rides(2) }), { status: 200 }));
    check('{ rides: [...] }', (await fetchRides('tok', { fetchImpl: bare.fetchImpl })).length === 2);
    const list = mock(() => new Response(JSON.stringify(rides(3)), { status: 200 }));
    check('a top-level array', (await fetchRides('tok', { fetchImpl: list.fetchImpl })).length === 3);
  }

  t.finish();
}

run().catch(err => { console.error(err); process.exit(1); });
