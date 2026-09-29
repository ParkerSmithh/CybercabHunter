// Tests for the real sighting-drawer submission (js/main.js:initSightingDrawer)
// — a required photo plus optional fields, POSTed as multipart/form-data to
// /api/vehicle-sightings/photo. Real SQL + the REAL Worker router
// (worker/index.js -> worker/sightings.js), via jsdom. calc.js + main.js are
// combined into ONE eval() call (jsdom does not share let/const script-scope
// bindings for CCC across separate eval() calls the way a browser shares
// scope across separate <script> tags), and IntersectionObserver is stubbed
// since jsdom doesn't implement it. jsdom has no createImageBitmap, so the
// photo is uploaded as picked (the browser-only re-encode step falls back to
// the original file, exactly as it does in a browser without that API).
// Run: node tests/sighting-drawer.test.mjs

import fs from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';
import { makeEnv, makeCheck } from './helpers/env.mjs';
import worker from '../worker/index.js';
import { installPhotonStub, placeIdFor } from './helpers/places.mjs';

installPhotonStub();

const t = makeCheck();
const { check } = t;
const ROOT = new URL('..', import.meta.url).pathname;
const HTML = fs.readFileSync(`${ROOT}public/community.html`, 'utf8');
const CALC = fs.readFileSync(`${ROOT}public/js/calc.js`, 'utf8');
const MAIN = fs.readFileSync(`${ROOT}public/js/main.js`, 'utf8');
const COMBINED = `${CALC}\n${MAIN}\nCCC.init();`;

// A tiny but real PNG (the server checks the file's own bytes).
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));

async function makeApp(users = ['u1']) {
  const ctx = await makeEnv({ users });
  for (const u of users) await ctx.env.TESLA_SESSIONS.put(`session:session-${u}`, JSON.stringify({ user_id: u }));
  return ctx;
}

// jsdom's FormData/File are not Node's; rebuild the body so the real Worker
// parses exactly what a browser would send.
async function toNodeInit(w, init) {
  if (!(init.body instanceof w.FormData)) return init;
  const fd = new FormData();
  for (const [key, value] of init.body.entries()) {
    if (typeof value === 'string') fd.append(key, value);
    else fd.append(key, new File([new Uint8Array(await value.arrayBuffer())], value.name, { type: value.type }));
  }
  return { ...init, body: fd };
}

// Opens community.html (representative — the drawer markup/behavior is
// identical across every page that has it) with an optional session and an
// optional fetch intercept.
async function openPage(env, sessionId, intercept) {
  // jsdom cannot navigate, and reports every attempt as a "not implemented:
  // navigation" error — used here to count attempts to leave the page.
  const navigations = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', err => { if (/navigation/i.test(err.message)) navigations.push(err.message); });
  const dom = new JSDOM(HTML, { runScripts: 'outside-only', url: 'https://cybercabhunter.com/community.html', pretendToBeVisual: true, virtualConsole });
  const w = dom.window;
  w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  if (sessionId) w.localStorage.setItem('teslaSessionId', sessionId);
  // Only sighting calls are tracked — a signed-in visitor also triggers the
  // account menu's own unrelated /api/me request.
  const requests = [];
  w.fetch = async (url, init = {}) => {
    const path = String(url).replace('https://cybercabhunter.contactjoeclos.workers.dev', '');
    if (path.startsWith('/api/vehicle-sightings')) {
      const fields = {};
      if (init.body instanceof w.FormData) for (const [k, v] of init.body.entries()) fields[k] = typeof v === 'string' ? v : { name: v.name, type: v.type, size: v.size };
      requests.push({ path, method: init.method, fields, headers: init.headers || {} });
    }
    if (intercept) { const r = await intercept(path, init); if (r) return r; }
    return worker.fetch(new Request(`https://x${path}`, await toNodeInit(w, init)), env, {});
  };
  w.eval(COMBINED);
  await new Promise(r => setTimeout(r, 20));
  const d = w.document;
  const page = {
    w, d, requests, navigations,
    drawerOpen: () => d.getElementById('sightingDrawer').classList.contains('is-open') && d.getElementById('sightingBackdrop').classList.contains('is-open'),
    visible: id => !d.getElementById(id).classList.contains('hidden'),
    val: id => d.getElementById(id).value,
    toastText: () => {
      const root = d.getElementById('toastRoot');
      return root && root.lastElementChild ? root.lastElementChild.textContent.trim() : '';
    },
    photoError: () => (page.visible('sightingPhotoError') ? d.getElementById('sightingPhotoError').textContent : ''),
    openDrawer: () => d.getElementById('openSightingDrawer').click(),
    pickPhoto: (bytes = PNG, name = 'cybercab.png', type = 'image/png') => {
      const input = d.getElementById('sightingPhoto');
      const file = new w.File([bytes], name, { type });
      Object.defineProperty(input, 'files', { configurable: true, value: [file] });
      input.dispatchEvent(new w.Event('change', { bubbles: true }));
    },
    fill: ({ area = '', loc = '', plate = '', notes = '', date = '' } = {}) => {
      d.getElementById('sightingServiceArea').value = area;
      d.getElementById('sightingLoc').value = loc;
      // As if the place had been picked from the suggestions list.
      d.getElementById('sightingLocId').value = loc ? placeIdFor(loc) : '';
      d.getElementById('sightingVehicle').value = plate;
      d.getElementById('sightingNotes').value = notes;
      d.getElementById('sightingDate').value = date;
    },
    submit: () => d.getElementById('sightingForm').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })),
    async waitFor(cond, label, ms = 1500) {
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
    check('the navigation target is the existing sign-in page', /const SIGN_IN_PAGE = 'signin\.html'/.test(MAIN) && /window\.location\.href = SIGN_IN_PAGE/.test(MAIN));
    const hero = page.d.getElementById('heroSightingBtn');
    if (hero) { hero.click(); check('the hero submit button behaves the same', page.navigations.length === 2 && !page.drawerOpen()); }
    // Even a direct dispatch of submit must not silently "succeed".
    page.pickPhoto();
    page.fill({ area: 'Dallas', plate: 'XJR2195' });
    page.submit();
    await new Promise(r => setTimeout(r, 30));
    check('no request was sent while signed out', page.requests.length === 0);
    check('nothing was recorded', sightingRows(ctx).length === 0);
  }
  {
    const pages = fs.readdirSync(`${ROOT}public`).filter(f => f.endsWith('.html')).filter(f => fs.readFileSync(`${ROOT}public/${f}`, 'utf8').includes('id="openSightingDrawer"'));
    check('the submit button exists on several pages', pages.length >= 5);
    check('every page with the submit button loads js/main.js', pages.every(f => /src="js\/main\.js/.test(fs.readFileSync(`${ROOT}public/${f}`, 'utf8'))));
    check('every page has the photo form (identical drawer everywhere)', pages.every(f => { const s = fs.readFileSync(`${ROOT}public/${f}`, 'utf8'); return s.includes('id="sightingPhoto"') && s.includes('SUBMIT A SIGHTING') && s.includes('id="sightingSuccess"'); }));
  }

  console.log('2. The form: photo (required), then optional City, Location, Date spotted, Description, License plate');
  {
    const ctx = await makeApp();
    const page = await openPage(ctx.env, 'session-u1');
    page.openDrawer();
    const d = page.d;
    check('the form is shown for a signed-in visitor, and the visitor stays on the page', page.visible('sightingForm') && page.drawerOpen() && page.navigations.length === 0);
    const photo = d.getElementById('sightingPhoto');
    check('the photo input is a file picker limited to JPEG, PNG and WebP', photo.type === 'file' && photo.accept === 'image/jpeg,image/png,image/webp');
    check('City / Service Area is no longer required', !d.getElementById('sightingServiceArea').required);
    const city = d.getElementById('sightingServiceArea');
    check('City is a dropdown whose only choices are Austin and Dallas (or none)', city.tagName === 'SELECT' && [...city.options].map(o => o.value).join() === ',Austin,Dallas' && !d.getElementById('sightingServiceAreaOptions'));
    check('Date spotted is a DATE picker (no time — that is recorded automatically), capped at today', d.getElementById('sightingDate').type === 'date' && /^\d{4}-\d\d-\d\d$/.test(d.getElementById('sightingDate').max) && /time is recorded automatically/i.test(d.getElementById('sightingDateHelp').textContent));
    check('Description is a short text area (280 characters, matching the server)', d.getElementById('sightingNotes').maxLength === 280);
    check('the button reads "Submit"', d.getElementById('sightingSubmitBtn').textContent.trim() === 'Submit');

    page.submit();
    await new Promise(r => setTimeout(r, 30));
    check('submitting without a photo is stopped in the form, with a clear message', page.requests.length === 0 && /add a photo/i.test(page.photoError()));

    page.pickPhoto(new Uint8Array([1, 2, 3]), 'notes.txt', 'text/plain');
    check('picking a non-image shows a file-type message and clears the pick', /JPEG, PNG or WebP/.test(page.photoError()) && d.getElementById('sightingPhoto').value === '');
    page.pickPhoto();
    check('picking a valid photo clears the message and offers "Change Photo"', page.photoError() === '' && d.getElementById('sightingPhotoPrompt').textContent === 'Change Photo');
  }

  console.log('3. Authenticated submit: correct endpoint, multipart fields, no user_id');
  {
    const ctx = await makeApp();
    const page = await openPage(ctx.env, 'session-u1');
    page.openDrawer();
    page.pickPhoto();
    page.fill({ area: 'Dallas', loc: 'S Congress Ave', plate: 'xjr-2195', notes: 'Parked by the curb', date: '2026-09-20' });
    page.submit();
    await page.waitFor(() => page.requests.length > 0, 'the request to be sent');
    const req = page.requests[0];
    check('POSTs to the photo endpoint', req.path === '/api/vehicle-sightings/photo' && req.method === 'POST');
    check('carries the bearer session and lets the browser set the multipart Content-Type', req.headers.Authorization === 'Bearer session-u1' && !('Content-Type' in req.headers));
    check('sends the photo and exactly the fields filled in (plus the picked place\'s id and the browser time zone)', Object.keys(req.fields).sort().join() === 'approx_location,license_plate,location_id,notes,observed_date,photo,service_area,time_zone' && req.fields.location_id === placeIdFor('S Congress Ave'));
    check('the photo is the picked image', req.fields.photo.type === 'image/png' && req.fields.photo.size === PNG.length);
    check('text fields are sent as entered (normalization is the backend\'s job)', req.fields.service_area === 'Dallas' && req.fields.approx_location === 'S Congress Ave' && req.fields.license_plate === 'xjr-2195' && req.fields.notes === 'Parked by the curb');
    check('only the chosen DATE is sent — never a client-chosen time', req.fields.observed_date === '2026-09-20' && !('observed_at' in req.fields) && req.fields.time_zone === Intl.DateTimeFormat().resolvedOptions().timeZone);
    check('no user_id is ever sent from the client', !('user_id' in req.fields));
  }
  {
    const ctx = await makeApp();
    const page = await openPage(ctx.env, 'session-u1');
    page.openDrawer();
    page.pickPhoto();
    page.submit();   // photo only
    await page.waitFor(() => page.requests.length > 0, 'the request to be sent');
    check('a photo alone is a valid submission — empty optional fields are simply omitted', Object.keys(page.requests[0].fields).sort().join() === 'photo,time_zone');
  }

  console.log('4. Success: the confirmation panel, the record is pending, nothing public or local');
  {
    const ctx = await makeApp();
    const page = await openPage(ctx.env, 'session-u1');
    page.openDrawer();
    page.pickPhoto();
    page.fill({ area: 'Austin', notes: 'Near the Domain' });
    page.submit();
    await page.waitFor(() => page.visible('sightingSuccess'), 'the confirmation');
    check('shows "Sighting submitted!"', /Sighting submitted!/.test(page.d.getElementById('sightingSuccess').textContent));
    check('...and "Your photo has been received and is awaiting review."', /Your photo has been received and is awaiting review\./.test(page.d.getElementById('sightingSuccess').textContent));
    check('the form is hidden behind the confirmation and the drawer stays open (no redirect)', !page.visible('sightingForm') && page.drawerOpen() && page.navigations.length === 0);
    check('the form was reset for next time', page.val('sightingServiceArea') === '' && page.val('sightingNotes') === '' && page.d.getElementById('sightingPhotoPrompt').textContent === 'Upload Photo');
    const rows = sightingRows(ctx);
    const sub = ctx.d1.query('SELECT * FROM submissions')[0];
    check('exactly one pending sighting with its photo was recorded', rows.length === 1 && sub.status === 'pending' && sub.evidence_type === 'photo' && ctx.env.EVIDENCE_BUCKET._objects.has(sub.evidence_ref));
    check('nothing was written to the old localStorage key', page.w.localStorage.getItem('cybercabCentral.sightings') === null);

    page.d.getElementById('sightingAnother').click();
    check('"Submit another" brings the empty form back', page.visible('sightingForm') && !page.visible('sightingSuccess'));
    page.d.getElementById('closeSightingDrawer').click();
    page.openDrawer();
    check('reopening the drawer shows the form, not a stale confirmation', page.visible('sightingForm') && !page.visible('sightingSuccess'));
    page.pickPhoto();
    page.submit();
    await page.waitFor(() => page.visible('sightingSuccess'), 'the second confirmation');
    page.d.getElementById('sightingDone').click();
    check('"Done" on the confirmation closes the drawer', !page.drawerOpen() && sightingRows(ctx).length === 2);
  }

  console.log('5. Duplicate: distinct wording, nothing new recorded, no extra request caused by the UI itself');
  {
    const ctx = await makeApp();
    const page = await openPage(ctx.env, 'session-u1');
    page.openDrawer();
    page.pickPhoto();
    page.fill({ area: 'Dallas', plate: 'XJR2195' });
    page.submit();
    await page.waitFor(() => page.visible('sightingSuccess'), 'first sighting recorded');
    page.d.getElementById('sightingAnother').click();
    page.pickPhoto();
    page.fill({ area: 'Dallas', plate: 'xjr2195' });
    page.submit();
    await page.waitFor(() => /already submitted/i.test(page.toastText()), 'the duplicate toast');
    check('the duplicate gets its own distinct message', /already submitted/i.test(page.toastText()));
    check('still only one observation and one stored photo', sightingRows(ctx).length === 1 && ctx.env.EVIDENCE_BUCKET._objects.size === 1);
    check('exactly two requests were sent total', page.requests.length === 2);
  }

  console.log('6. Errors: 400, 401, 413, 502, and a network failure — the photo and fields survive every one of them');
  const failWith = (status, body) => path => (path.includes('/api/vehicle-sightings') ? new Response(JSON.stringify(body), { status }) : null);
  {
    const ctx = await makeApp();
    const page = await openPage(ctx.env, 'session-u1', failWith(400, { success: false, error: 'invalid_license_plate' }));
    page.openDrawer(); page.pickPhoto(); page.fill({ area: 'Dallas', loc: 'Main St', plate: '!!!' }); page.submit();
    await page.waitFor(() => page.toastText().length > 0, '400 handled');
    check('a 400 shows a human-readable message, not raw JSON', /doesn't look like a valid license plate/i.test(page.toastText()) && !/"success":false/.test(page.toastText()));
    check('the drawer stays open and every field is preserved', page.drawerOpen() && page.val('sightingServiceArea') === 'Dallas' && page.val('sightingLoc') === 'Main St' && page.val('sightingVehicle') === '!!!');
  }
  {
    const ctx = await makeApp();
    const page = await openPage(ctx.env, 'session-u1', failWith(400, { success: false, error: 'unsupported_file_type' }));
    page.openDrawer(); page.pickPhoto(); page.submit();
    await page.waitFor(() => page.photoError().length > 0, 'photo 400 handled');
    check('a rejected photo is reported next to the photo field', /JPEG, PNG or WebP/.test(page.photoError()));
  }
  {
    const ctx = await makeApp();
    const page = await openPage(ctx.env, 'session-u1', failWith(401, { authenticated: false }));
    page.openDrawer(); page.pickPhoto(); page.submit();
    await page.waitFor(() => page.visible('sightingSignInRequired'), '401 -> sign-in state');
    check('a 401 mid-flow shows the sign-in requirement and clears the stale session', !page.visible('sightingForm') && page.w.localStorage.getItem('teslaSessionId') === null);
  }
  {
    const ctx = await makeApp();
    const page = await openPage(ctx.env, 'session-u1', failWith(413, { success: false, error: 'file_too_large' }));
    page.openDrawer(); page.pickPhoto(); page.fill({ area: 'Dallas' }); page.submit();
    await page.waitFor(() => page.photoError().length > 0, '413 handled');
    check('a 413 says the photo is too large (under 10 MB)', /too large.*10 MB/i.test(page.photoError()));
    check('fields are preserved on a 413', page.val('sightingServiceArea') === 'Dallas');
  }
  {
    const ctx = await makeApp();
    const page = await openPage(ctx.env, 'session-u1', failWith(502, { success: false, error: 'upload_failed' }));
    page.openDrawer(); page.pickPhoto(); page.fill({ plate: 'XJR2195' }); page.submit();
    await page.waitFor(() => page.toastText().length > 0, '502 handled');
    check('a server/storage failure shows the friendly "try again" message', /couldn't submit the sighting.*try again/i.test(page.toastText()));
    check('fields survive it', page.val('sightingVehicle') === 'XJR2195' && page.d.getElementById('sightingPhoto').files.length === 1);
  }
  {
    const ctx = await makeApp();
    const page = await openPage(ctx.env, 'session-u1', path => { if (path.includes('/api/vehicle-sightings')) throw new TypeError('network down'); return null; });
    page.openDrawer(); page.pickPhoto(); page.fill({ area: 'Dallas', loc: 'Main St' }); page.submit();
    await page.waitFor(() => /couldn't submit/i.test(page.toastText()), 'network failure handled');
    check('a network failure shows the same friendly message, with no exception text', /try again/i.test(page.toastText()) && !/TypeError|network down/.test(page.toastText()));
    check('the drawer stays open with everything preserved, ready to retry', page.drawerOpen() && page.val('sightingLoc') === 'Main St' && !page.d.getElementById('sightingSubmitBtn').disabled);
  }

  console.log('7. Double submit: the button is disabled while uploading; repeated submits send one request');
  {
    const ctx = await makeApp();
    let release;
    const gate = new Promise(r => { release = r; });
    let calls = 0;
    const page = await openPage(ctx.env, 'session-u1', async path => {
      if (!path.includes('/api/vehicle-sightings')) return null;
      calls += 1;
      await gate;
      return null;
    });
    page.openDrawer(); page.pickPhoto(); page.fill({ plate: 'XJR2195' });
    check('the submit button starts enabled', !page.d.getElementById('sightingSubmitBtn').disabled);
    page.submit();
    await page.waitFor(() => calls === 1, 'the first request to start');
    const btn = page.d.getElementById('sightingSubmitBtn');
    check('the button is disabled and reads "Uploading…" while in flight', btn.disabled && btn.textContent === 'Uploading…');
    page.submit(); page.submit();
    await new Promise(r => setTimeout(r, 20));
    check('only one request was sent despite three submit attempts', calls === 1);
    release();
    await page.waitFor(() => sightingRows(ctx).length > 0, 'the held request to complete');
    check('the held request completed normally', sightingRows(ctx).length === 1 && ctx.env.EVIDENCE_BUCKET._objects.size === 1);
    check('the button is re-enabled afterward', !btn.disabled && btn.textContent === 'Submit');
  }

  t.finish();
}

run().catch(err => { console.error(err); process.exit(1); });
