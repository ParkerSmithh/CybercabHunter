// Tests for the real sighting-drawer submission (js/main.js:initSightingDrawer,
// Phase 3D-B) — the first tests in this project to exercise js/main.js at
// all. Real SQL + the REAL Worker router (worker/index.js -> worker/sightings.js),
// via jsdom. calc.js + main.js are combined into ONE eval() call (jsdom does
// not share let/const script-scope bindings for CCC across separate eval()
// calls the way a browser shares scope across separate <script> tags), and
// IntersectionObserver is stubbed since jsdom doesn't implement it — neither
// is app behavior, both are just what it takes to run this file in Node.
// Run: node tests/sighting-drawer.test.mjs

import fs from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';
import { makeEnv, makeCheck } from './helpers/env.mjs';
import worker from '../worker/index.js';

const t = makeCheck();
const { check } = t;
const ROOT = new URL('..', import.meta.url).pathname;
const HTML = fs.readFileSync(`${ROOT}community.html`, 'utf8');
const CALC = fs.readFileSync(`${ROOT}js/calc.js`, 'utf8');
const MAIN = fs.readFileSync(`${ROOT}js/main.js`, 'utf8');
const COMBINED = `${CALC}\n${MAIN}\nCCC.init();`;

async function makeApp(users = ['u1']) {
  const ctx = await makeEnv({ users });
  for (const u of users) await ctx.env.TESLA_SESSIONS.put(`session:session-${u}`, JSON.stringify({ user_id: u }));
  return ctx;
}

// Opens community.html (representative — the drawer markup/behavior is
// identical across every page that has it) with an optional session and an
// optional fetch intercept, matching rider-data-ui.test.mjs's own pattern.
async function openPage(env, sessionId, intercept) {
  // jsdom cannot navigate, and reports every attempt as a "not implemented:
  // navigation" error. That is exactly the signal wanted here: it counts the
  // times the page tried to leave for another URL.
  const navigations = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', err => { if (/navigation/i.test(err.message)) navigations.push(err.message); });
  const dom = new JSDOM(HTML, { runScripts: 'outside-only', url: 'https://cybercabhunter.com/community.html', pretendToBeVisual: true, virtualConsole });
  const w = dom.window;
  w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  if (sessionId) w.localStorage.setItem('teslaSessionId', sessionId);
  // Only /api/vehicle-sightings calls are tracked here — a signed-in visitor
  // also triggers initAccountMenu()'s own unrelated /api/me request, which
  // must not be mistaken for (or block waiting on) the sighting submission.
  const requests = [];
  w.fetch = async (url, init = {}) => {
    const path = String(url).replace('https://cybercabhunter.contactjoeclos.workers.dev', '');
    if (path.startsWith('/api/vehicle-sightings')) requests.push({ path, method: init.method, body: init.body, headers: init.headers || {} });
    if (intercept) { const r = await intercept(path, init); if (r) return r; }
    return worker.fetch(new Request(`https://x${path}`, init), env, {});
  };
  w.eval(COMBINED);
  await new Promise(r => setTimeout(r, 20));
  const d = w.document;
  const page = {
    w, d, requests, navigations,
    drawerOpen: () => d.getElementById('sightingDrawer').classList.contains('is-open') && d.getElementById('sightingBackdrop').classList.contains('is-open'),
    text: id => d.getElementById(id).textContent.replace(/\s+/g, ' ').trim(),
    visible: id => !d.getElementById(id).classList.contains('hidden'),
    // Only the MOST RECENT toast — toast() leaves each one in the DOM for
    // ~3.2s, so within a fast test a root can hold more than one at once.
    toastText: () => {
      const root = d.getElementById('toastRoot');
      if (!root || !root.lastElementChild) return '';
      return root.lastElementChild.textContent.trim();
    },
    openDrawer: () => d.getElementById('openSightingDrawer').click(),
    fill: (serviceArea, loc, plate) => {
      d.getElementById('sightingServiceArea').value = serviceArea == null ? '' : serviceArea;
      d.getElementById('sightingLoc').value = loc == null ? '' : loc;
      d.getElementById('sightingVehicle').value = plate == null ? '' : plate;
    },
    submit: () => d.getElementById('sightingForm').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })),
    async waitFor(cond, label, ms = 1000) {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (cond()) return true; await new Promise(r => setTimeout(r, 5)); }
      console.log(`    (timed out waiting for: ${label})`);
      return false;
    }
  };
  return page;
}

const sightingRows = ctx => ctx.d1.query('SELECT * FROM vehicle_observations');

async function run() {
  console.log('1. Signed out: the submit button goes to the sign-in page instead of opening the drawer; nothing is sent or stored');
  {
    const ctx = await makeApp();
    const page = await openPage(ctx.env, null);
    page.openDrawer();
    await new Promise(r => setTimeout(r, 30));
    check('clicking the submit button leaves the page (one navigation attempt)', page.navigations.length === 1);
    check('the submit drawer and its backdrop are not opened', !page.drawerOpen());

    // The destination is the existing Google sign-in page.
    check('the navigation target is the existing sign-in page', /const SIGN_IN_PAGE = 'signin\.html'/.test(MAIN) && /window\.location\.href = SIGN_IN_PAGE/.test(MAIN));
    check('that page exists and offers Google sign-in', fs.existsSync(`${ROOT}signin.html`) && /oauth\/google\/start/.test(fs.readFileSync(`${ROOT}signin.html`, 'utf8')));

    // The same holds for the hero submit button, where a page has one.
    const hero = page.d.getElementById('heroSightingBtn');
    if (hero) { hero.click(); check('the hero submit button behaves the same', page.navigations.length === 2 && !page.drawerOpen()); }

    // Even a direct dispatch of submit (bypassing the UI entirely) must not
    // silently "succeed" for a signed-out visitor.
    page.fill('Dallas', 'S Congress Ave', 'XJR2195');
    page.submit();
    await new Promise(r => setTimeout(r, 30));
    check('no request was sent while signed out', page.requests.length === 0);
    check('no localStorage sighting entry was written', page.w.localStorage.getItem('cybercabCentral.sightings') === null);
    check('no success toast appeared', !/submitted for review/i.test(page.toastText()));
  }
  {
    // Every page that has the submit button loads the script that enforces this.
    const pages = fs.readdirSync(ROOT).filter(f => f.endsWith('.html')).filter(f => fs.readFileSync(`${ROOT}${f}`, 'utf8').includes('id="openSightingDrawer"'));
    check('the submit button exists on several pages', pages.length >= 5);
    check('every page with the submit button loads js/main.js', pages.every(f => /src="js\/main\.js/.test(fs.readFileSync(`${ROOT}${f}`, 'utf8'))));
  }

  console.log('2. Authenticated submit: correct endpoint, correct JSON fields, no user_id, no "Unlisted" sentinel');
  {
    const ctx = await makeApp();
    const page = await openPage(ctx.env, 'session-u1');
    page.openDrawer();
    check('the form is shown for a signed-in visitor', page.visible('sightingForm') && !page.visible('sightingSignInRequired'));
    check('the drawer opens and the visitor stays on the page', page.drawerOpen() && page.navigations.length === 0);
    page.fill('Dallas', 'S Congress Ave', 'xjr-2195');
    page.submit();
    await page.waitFor(() => page.requests.length > 0, 'the request to be sent');
    const req = page.requests[0];
    check('POSTs to the correct endpoint', req.path === '/api/vehicle-sightings' && req.method === 'POST');
    check('carries the bearer session, matching every other authenticated request', req.headers.Authorization === 'Bearer session-u1');
    const body = JSON.parse(req.body);
    check('sends exactly the fields the drawer collects — service_area, approx_location, license_plate', Object.keys(body).sort().join() === 'approx_location,license_plate,service_area');
    check('service_area is sent as entered', body.service_area === 'Dallas');
    check('approx_location carries the free-text location field', body.approx_location === 'S Congress Ave');
    check('license_plate is sent as-is — normalization is the backend\'s job, not duplicated here', body.license_plate === 'xjr-2195');
    check('no user_id is ever sent from the client', !('user_id' in body));
  }
  {
    const ctx = await makeApp();
    const page = await openPage(ctx.env, 'session-u1');
    page.openDrawer();
    page.fill('Austin', '', ''); // no location, no plate
    page.submit();
    await page.waitFor(() => page.requests.length > 0, 'the request to be sent');
    const body = JSON.parse(page.requests[0].body);
    check('an empty plate is simply omitted — never the old "Unlisted" fallback string', !('license_plate' in body) && !/Unlisted/i.test(page.requests[0].body));
    check('an empty approx_location is omitted too, not sent as an empty string', !('approx_location' in body));
    check('service_area alone is still a valid, sendable submission', body.service_area === 'Austin');
  }

  console.log('3. Success: correct wording, form resets/closes, nothing written to localStorage');
  {
    const ctx = await makeApp();
    const page = await openPage(ctx.env, 'session-u1');
    page.openDrawer();
    page.fill('Dallas', '', 'XJR2195');
    page.submit();
    await page.waitFor(() => sightingRows(ctx).length > 0, 'the sighting to be recorded');
    check('the success toast explains the sighting was submitted for review, not verified or public', /submitted for review/i.test(page.toastText()));
    check('the toast does NOT claim verification or public visibility', !/verified|public|added to the fleet/i.test(page.toastText()));
    await page.waitFor(() => !page.d.getElementById('sightingDrawer').classList.contains('is-open'), 'drawer to close');
    check('the drawer closes on success', !page.d.getElementById('sightingDrawer').classList.contains('is-open'));
    check('the form is reset', page.d.getElementById('sightingServiceArea').value === '');
    check('nothing was written to the old localStorage key', page.w.localStorage.getItem('cybercabCentral.sightings') === null);
    check('exactly one real observation was recorded server-side', sightingRows(ctx).length === 1);
  }

  console.log('4. Duplicate: distinct wording, no second local record, no extra request caused by the UI itself');
  {
    const ctx = await makeApp();
    const page = await openPage(ctx.env, 'session-u1');
    // First, a real submission…
    page.openDrawer();
    page.fill('Dallas', '', 'XJR2195');
    page.submit();
    await page.waitFor(() => sightingRows(ctx).length > 0, 'first sighting recorded');
    // …then immediately the same plate again (the backend's own accidental-
    // duplicate guard from 3D-A kicks in — this is not new UI-side dedupe).
    page.openDrawer();
    page.fill('Dallas', '', 'xjr2195');
    page.submit();
    await page.waitFor(() => /already submitted/i.test(page.toastText()), 'the duplicate toast to appear');
    check('the duplicate gets its own distinct message, not the normal success wording', /already submitted/i.test(page.toastText()) && !/submitted for review/i.test(page.toastText()));
    check('still only one real observation exists — the duplicate created nothing new', sightingRows(ctx).length === 1);
    check('exactly two requests were sent total — the UI itself never silently retries or double-posts', page.requests.length === 2);
  }

  console.log('5. Errors: 400, 401, 413, 500, and a network failure — entered fields survive every one of them');
  {
    const ctx = await makeApp();
    const page = await openPage(ctx.env, 'session-u1', (path) => (path.includes('/api/vehicle-sightings') ? new Response(JSON.stringify({ success: false, error: 'invalid_license_plate' }), { status: 400 }) : null));
    page.openDrawer();
    page.fill('Dallas', 'Main St', '!!!');
    page.submit();
    await page.waitFor(() => page.toastText().length > 0, '400 response handled');
    check('a 400 shows a human-readable message, not a raw JSON dump', /doesn't look like a valid license plate/i.test(page.toastText()) && !/"success":false/i.test(page.toastText()));
    check('the drawer stays open on error', page.d.getElementById('sightingDrawer').classList.contains('is-open'));
    check('every entered field is preserved — nothing has to be retyped', page.d.getElementById('sightingServiceArea').value === 'Dallas' && page.d.getElementById('sightingLoc').value === 'Main St' && page.d.getElementById('sightingVehicle').value === '!!!');
  }
  {
    const ctx = await makeApp();
    const page = await openPage(ctx.env, 'session-u1', (path) => (path.includes('/api/vehicle-sightings') ? new Response(JSON.stringify({ authenticated: false }), { status: 401 }) : null));
    page.openDrawer();
    page.fill('Dallas', '', 'XJR2195');
    page.submit();
    await page.waitFor(() => page.visible('sightingSignInRequired'), '401 -> sign-in state');
    check('a 401 mid-flow shows the sign-in requirement, not a generic error', page.visible('sightingSignInRequired') && !page.visible('sightingForm'));
    check('the stale session token is cleared', page.w.localStorage.getItem('teslaSessionId') === null);
  }
  {
    const ctx = await makeApp();
    const page = await openPage(ctx.env, 'session-u1', (path) => (path.includes('/api/vehicle-sightings') ? new Response(JSON.stringify({ success: false, error: 'too_large' }), { status: 413 }) : null));
    page.openDrawer();
    page.fill('Dallas', 'x'.repeat(50), 'XJR2195');
    page.submit();
    await page.waitFor(() => page.toastText().length > 0, '413 handled');
    check('a 413 tells the user the submission is too large', /too large/i.test(page.toastText()));
    check('fields are preserved on a 413 too', page.d.getElementById('sightingServiceArea').value === 'Dallas');
  }
  {
    const ctx = await makeApp();
    const page = await openPage(ctx.env, 'session-u1', (path) => (path.includes('/api/vehicle-sightings') ? new Response('{"success":false}', { status: 500 }) : null));
    page.openDrawer();
    page.fill('Dallas', '', 'XJR2195');
    page.submit();
    await page.waitFor(() => page.toastText().length > 0, '500 handled');
    check('a 500 shows the friendly "couldn\'t submit, try again" message', /couldn't submit the sighting.*try again/i.test(page.toastText()));
    check('no internal detail leaks', !/"success":false/i.test(page.toastText()));
    check('fields survive a server error', page.d.getElementById('sightingVehicle').value === 'XJR2195');
  }
  {
    const ctx = await makeApp();
    const page = await openPage(ctx.env, 'session-u1', (path) => { if (path.includes('/api/vehicle-sightings')) throw new TypeError('network down'); return null; });
    page.openDrawer();
    page.fill('Dallas', 'Main St', 'XJR2195');
    page.submit();
    await page.waitFor(() => /couldn't submit/i.test(page.toastText()), 'network failure handled');
    check('a network failure shows the same friendly message', /couldn't submit the sighting.*try again/i.test(page.toastText()));
    check('no exception text leaks into the toast', !/TypeError|network down/i.test(page.toastText()));
    check('fields are fully preserved after a network failure', page.d.getElementById('sightingServiceArea').value === 'Dallas' && page.d.getElementById('sightingLoc').value === 'Main St' && page.d.getElementById('sightingVehicle').value === 'XJR2195');
    check('the drawer remains open so the rider can just retry', page.d.getElementById('sightingDrawer').classList.contains('is-open'));
  }

  console.log('6. Double submit: a rapid repeated submit results in exactly one in-flight request');
  {
    const ctx = await makeApp();
    let resolveFirst;
    const gate = new Promise(r => { resolveFirst = r; });
    let calls = 0;
    const page = await openPage(ctx.env, 'session-u1', async (path) => {
      if (!path.includes('/api/vehicle-sightings')) return null;
      calls += 1;
      await gate; // hold the first request open until we've tried to double-submit
      return null; // let it fall through to the real worker once released
    });
    page.openDrawer();
    page.fill('Dallas', '', 'XJR2195');
    check('the submit button starts enabled', !page.d.getElementById('sightingSubmitBtn').disabled);
    page.submit();
    await page.waitFor(() => calls === 1, 'the first request to start');
    check('the submit button is disabled while the request is in flight', page.d.getElementById('sightingSubmitBtn').disabled);
    page.submit(); // a rapid second submit while the first is still pending
    page.submit();
    await new Promise(r => setTimeout(r, 20));
    check('only one request was actually sent despite three submit attempts', calls === 1);
    resolveFirst();
    await page.waitFor(() => sightingRows(ctx).length > 0, 'the held request to finally complete');
    check('the held request completed normally once released', sightingRows(ctx).length === 1);
    check('the submit button is re-enabled afterward', !page.d.getElementById('sightingSubmitBtn').disabled);
  }

  t.finish();
}

run().catch(err => { console.error(err); process.exit(1); });
