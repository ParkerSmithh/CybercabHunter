// Tests for the registry-vehicle visibility section of the moderator page
// (moderation.html + js/moderation.js, Phase 3E). Real SQL and the REAL Worker
// via jsdom, using the same harness pattern as tests/moderation-ui.test.mjs.
// Layout (390-1280px) is verified separately in a real browser.
// Run: node tests/moderation-vehicles-ui.test.mjs

import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { makeEnv, seedRide, makeCheck } from './helpers/env.mjs';
import worker from '../worker/index.js';

const t = makeCheck();
const { check } = t;
const ROOT = new URL('..', import.meta.url).pathname;
const HTML = fs.readFileSync(`${ROOT}moderation.html`, 'utf8');
const COMBINED = `${fs.readFileSync(`${ROOT}js/calc.js`, 'utf8')}\n${fs.readFileSync(`${ROOT}js/main.js`, 'utf8')}\nCCC.init();\n${fs.readFileSync(`${ROOT}js/moderation.js`, 'utf8')}`;

async function makeApp(users) {
  const ctx = await makeEnv({ users: Object.keys(users) });
  for (const [id, role] of Object.entries(users)) {
    await ctx.env.TESLA_SESSIONS.put(`session:session-${id}`, JSON.stringify({ user_id: id }));
    if (role && role !== 'user') ctx.d1.exec(`UPDATE users SET role = '${role}' WHERE id = '${id}'`);
  }
  return ctx;
}
let n = 0;
function vehicle(ctx, plate, { visibility = 'private', rides = 1, status = 'pending' } = {}) {
  n += 1; const id = `cccccccc-0000-4000-8000-${String(n).padStart(12, '0')}`;
  ctx.d1.prepare(`INSERT INTO robotaxi_vehicles (id, license_plate, visibility, first_seen_at, last_seen_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))`).bind(id, plate, visibility)._exec();
  for (let i = 0; i < rides; i++) seedRide(ctx.d1, { userId: 'rider', vehicleId: id, status });
  return id;
}
async function submitSighting(ctx, userId, fields) {
  const resp = await worker.fetch(new Request('https://x/api/vehicle-sightings', {
    method: 'POST', headers: { Origin: 'https://cybercabhunter.com', Authorization: `Bearer session-${userId}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ service_area: 'Austin', ...fields })
  }), ctx.env, {});
  return resp.json();
}

async function openPage(env, sessionId, intercept) {
  const dom = new JSDOM(HTML, { runScripts: 'outside-only', url: 'https://cybercabhunter.com/moderation.html', pretendToBeVisual: true });
  const w = dom.window;
  w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  if (sessionId) w.localStorage.setItem('teslaSessionId', sessionId);
  const requests = [];
  w.fetch = async (url, init = {}) => {
    const path = String(url).replace('https://cybercabhunter.contactjoeclos.workers.dev', '');
    if (path.startsWith('/api/moderation/')) requests.push({ path, method: init.method || 'GET', body: init.body });
    if (intercept) { const r = await intercept(path, init); if (r) return r; }
    return worker.fetch(new Request(`https://x${path}`, init), env, {});
  };
  w.eval(COMBINED);
  await new Promise(r => setTimeout(r, 60));
  const d = w.document;
  const page = {
    w, d, requests,
    visible: id => !d.getElementById(id).classList.contains('hidden'),
    cards: () => [...d.querySelectorAll('[data-vehicle-id]')],
    sightingCards: () => [...d.querySelectorAll('[data-submission-id]')],
    vehicleRequests: (method) => requests.filter(r => r.path.startsWith('/api/moderation/robotaxi-vehicles') && (!method || r.method === method)),
    toastText: () => { const root = d.getElementById('toastRoot'); return root && root.lastElementChild ? root.lastElementChild.textContent.trim() : ''; },
    click: el => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true })),
    submitSearch: () => d.getElementById('modVehicleSearch').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })),
    async waitFor(cond, label, ms = 1500) {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (cond()) return true; await new Promise(r => setTimeout(r, 5)); }
      console.log(`    (timed out waiting for: ${label})`);
      return false;
    }
  };
  return page;
}

// Approve and return are instant, single-click actions — no confirmation step.
function approveVia(page, i = 0) {
  page.click(page.cards()[i].querySelector('button[data-vehicle-action="approve"]'));
}
function returnVia(page, i = 0) {
  page.click(page.cards()[i].querySelector('button[data-vehicle-action="return"]'));
}

async function run() {
  console.log('1. Access: the vehicle controls only exist for an authorized moderator');
  {
    const ctx = await makeApp({ rider: 'user' });
    const page = await openPage(ctx.env, null);
    check('signed out: nothing is requested and the vehicle section is not shown', page.requests.length === 0 && page.visible('modSignedOut') && !page.visible('modQueue'));
  }
  {
    const ctx = await makeApp({ rider: 'user' });
    vehicle(ctx, 'SECRET01');
    const page = await openPage(ctx.env, 'session-rider');
    await page.waitFor(() => page.visible('modForbidden'), 'forbidden view');
    check('an ordinary user sees "Not authorized" and no registry data', page.visible('modForbidden') && !page.visible('modQueue') && page.cards().length === 0 && !page.d.body.textContent.includes('SECRET01'));
    check('no registry-vehicle request was ever made for them', page.vehicleRequests().length === 0);
  }

  console.log('2. Listing: the default view is "Private" — every private vehicle, approval candidates and not-yet-eligible alike');
  {
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    const a = vehicle(ctx, 'AWT0001', { rides: 2 });
    vehicle(ctx, 'NORIDES', { rides: 0 });
    const page = await openPage(ctx.env, 'session-mod');
    await page.waitFor(() => page.cards().length === 2, 'vehicle list');
    check('the scope dropdown defaults to "Private" (the "Private — has counted rides" option was removed)', page.d.getElementById('modVehicleScope').value === 'private');
    const byPlate = p => page.cards().find(c => c.textContent.includes(p));
    const card = byPlate('AWT0001');
    check('an awaiting vehicle is listed with its plate', card.dataset.vehicleId === a && /AWT0001/.test(card.textContent));
    check('it shows its counted-ride count', /2 counted rides/.test(card.textContent));
    check('it is labelled "Private — Needs Review" and "Eligible for Approval"', /Private — Needs Review/.test(card.textContent) && /Eligible for Approval/.test(card.textContent) && card.dataset.approvalState === 'eligible_for_approval');
    check('it offers "Approve" and no public-page link (it is not public)', /Approve/.test(card.textContent) && !!card.querySelector('button[data-vehicle-action="approve"]') && !card.querySelector('a'));
    check('a vehicle with no counted rides is ALSO listed now: "Private" is every private vehicle, not just approval candidates', !!byPlate('NORIDES'));
    check('the sighting queue above is unaffected', page.sightingCards().length === 0);
  }

  console.log('3. Approving and returning a vehicle: instant, single-click actions sent straight to the review endpoint, and each list stays in sync with the current scope');
  {
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    const id = vehicle(ctx, 'AWT0001');
    const page = await openPage(ctx.env, 'session-mod');
    await page.waitFor(() => page.cards().length === 1, 'vehicle list');

    page.click(page.cards()[0].querySelector('button[data-vehicle-action="approve"]'));
    // It is now public, so it must drop off the still-selected "Private" list immediately —
    // not sit there showing stale info until the moderator happens to reload.
    await page.waitFor(() => page.cards().length === 0, 'the now-public vehicle drops off the "Private" list');
    const sent = page.vehicleRequests('POST');
    check('one click sent exactly one POST straight to the review endpoint — no confirmation step, no reason field', sent.length === 1 && sent[0].path === `/api/moderation/robotaxi-vehicles/${id}/review` && JSON.parse(sent[0].body).action === 'approve_public' && !('reason' in JSON.parse(sent[0].body)));
    check('the legacy PATCH is no longer used by the page', page.vehicleRequests('PATCH').length === 0);
    check('the stored visibility changed', ctx.d1.query('SELECT visibility FROM robotaxi_vehicles WHERE id = ?', id)[0].visibility === 'public');
    check('a distinct success message is shown', /approved for the public registry/i.test(page.toastText()));
    check('it is gone from the "Private" list', page.cards().length === 0);

    const scope = page.d.getElementById('modVehicleScope');
    scope.value = 'public';
    scope.dispatchEvent(new page.w.Event('change', { bubbles: true }));
    await page.waitFor(() => page.cards().length === 1, 'switch to "Public"');
    check('switching to "Public" shows it there, labelled Public with "Return to Private"', /Public/.test(page.cards()[0].querySelector('span').textContent) && !!page.cards()[0].querySelector('button[data-vehicle-action="return"]'));
    check('a link to the public page appears (it is genuinely eligible)', page.cards()[0].querySelector('a').getAttribute('href') === `vehicle/${id}`);
    check('the card shows the audit line: who reviewed it and when', /Last review: Approved for public by/.test(page.cards()[0].textContent));

    // The exact bug this fixes: returning a vehicle to private while looking
    // at the "Public" list must remove it from that list right away, not
    // leave it showing "Private — Needs Review" mixed in among public ones.
    returnVia(page);
    await page.waitFor(() => page.cards().length === 0, 'returning it to private removes it from the still-selected "Public" list');
    check('taking it down sets it private in the database', ctx.d1.query('SELECT visibility FROM robotaxi_vehicles WHERE id = ?', id)[0].visibility === 'private');
    check('it is gone from the "Public" list, not left showing stale info', page.cards().length === 0);
    check('the message is distinct', /returned to private/i.test(page.toastText()));
    check('no ride, trip or observation data was touched', ctx.d1.query('SELECT COUNT(*) AS n FROM trips')[0].n === 1);
    check('two history rows exist, in order', ctx.d1.query('SELECT action FROM robotaxi_vehicle_reviews ORDER BY rowid').map(r => r.action).join() === 'approved_public,returned_private');

    scope.value = 'private';
    scope.dispatchEvent(new page.w.Event('change', { bubbles: true }));
    await page.waitFor(() => page.cards().length === 1, 'switch back to "Private" to see it again');
    check('back in "Private" it shows private again with its audit line, and no public-page link', /Private — Needs Review/.test(page.cards()[0].textContent) && /Last review: Returned to private by/.test(page.cards()[0].textContent) && !page.cards()[0].querySelector('a'));
  }

  console.log('4. Not eligible: the reasons are plain facts and there is no approve button');
  {
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    vehicle(ctx, 'ZERO001', { rides: 0 });
    const page = await openPage(ctx.env, 'session-mod');
    // The default "Private" list is every private vehicle, so this one (0 rides) is already there.
    await page.waitFor(() => page.cards().length === 1, 'default list settles');
    page.d.getElementById('modVehiclePlate').value = 'zero-001';
    page.submitSearch();
    await page.waitFor(() => page.cards().length === 1, 'search result');
    const card = page.cards()[0];
    check('a plate search finds it (formatting-insensitive)', /ZERO001/.test(card.textContent));
    check('it is labelled Not Eligible with the factual reasons', /Not Eligible/.test(card.textContent) && /No counted rides/.test(card.textContent) && /No rides on record \(orphaned\)/.test(card.textContent) && card.dataset.approvalState === 'not_eligible');
    check('there is no approve control, and it says why', !card.querySelector('button[data-vehicle-action="approve"]') && /Cannot be approved while the reasons above apply/.test(card.textContent));
    check('nothing was sent', page.vehicleRequests('POST').length === 0 && page.vehicleRequests('PATCH').length === 0);
  }
  {
    // A vehicle flagged public in the database but with no counted ride (e.g. its ride was deleted after approval).
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    vehicle(ctx, 'HID0001', { visibility: 'public', rides: 0 });
    const page = await openPage(ctx.env, 'session-mod');
    page.d.getElementById('modVehicleScope').value = 'public';
    page.d.getElementById('modVehicleScope').dispatchEvent(new page.w.Event('change', { bubbles: true }));
    await page.waitFor(() => page.cards().length === 1, 'public list');
    const card = page.cards()[0];
    check('an approved-but-ineligible vehicle says plainly it is hidden, with the reason', /Approved — Not Visible/.test(card.textContent) && /Not Eligible: approved, but hidden from the public/.test(card.textContent) && /No counted rides/.test(card.textContent));
    check('it offers Return to Private and no public-page link', !!card.querySelector('button[data-vehicle-action="return"]') && !card.querySelector('a'));
  }
  {
    // Facts about needs_review / rejected history, shown as plain notes.
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    vehicle(ctx, 'NRV0001', { rides: 1, status: 'needs_review' });
    vehicle(ctx, 'REJ0001', { rides: 2, status: 'rejected' });
    const page = await openPage(ctx.env, 'session-mod');
    page.d.getElementById('modVehicleScope').value = 'private';
    page.d.getElementById('modVehicleScope').dispatchEvent(new page.w.Event('change', { bubbles: true }));
    await page.waitFor(() => page.cards().length === 2, 'all private vehicles');
    const byPlate = p => page.cards().find(c => c.textContent.includes(p)).textContent.replace(/\s+/g, ' ');
    check('"All private vehicles" lists vehicles that have no counted rides too', page.cards().length === 2);
    check('needs_review-only: "Needs review ride present" and no counted rides, not approvable', /Needs review ride present/.test(byPlate('NRV0001')) && /No counted rides/.test(byPlate('NRV0001')) && !/Rejected-only history/.test(byPlate('NRV0001')));
    check('rejected-only: "Rejected-only history" and not approvable', /Rejected-only history/.test(byPlate('REJ0001')) && /2 rejected/.test(byPlate('REJ0001')));
    check('the attached-ride facts are shown', /Rides attached: 0 counted · 1 needs review · 0 rejected · 1 total trips on record/.test(byPlate('NRV0001')));
    check('no card offers approval', page.d.querySelectorAll('button[data-vehicle-action="approve"]').length === 0);
  }

  console.log('5. Scope, empty and search states');
  {
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    vehicle(ctx, 'PUB0001', { visibility: 'public' });
    const page = await openPage(ctx.env, 'session-mod');
    await page.waitFor(() => page.visible('modVehiclesEmpty'), 'empty awaiting list');
    check('with nothing awaiting approval an empty state is shown, not a blank box', page.visible('modVehiclesEmpty') && page.cards().length === 0);
    const scope = page.d.getElementById('modVehicleScope'); scope.value = 'public';
    scope.dispatchEvent(new page.w.Event('change', { bubbles: true }));
    await page.waitFor(() => page.cards().length === 1, 'public list');
    check('switching to "Public" lists public vehicles for audit', /PUB0001/.test(page.cards()[0].textContent) && !!page.cards()[0].querySelector('button[data-vehicle-action="return"]') && /Public/.test(page.cards()[0].querySelector('span').textContent));
    page.d.getElementById('modVehiclePlate').value = 'NOSUCH';
    page.submitSearch();
    await page.waitFor(() => page.visible('modVehiclesEmpty'), 'no-match empty state');
    check('a search with no match shows the empty state', page.visible('modVehiclesEmpty') && page.cards().length === 0);
  }

  console.log('6. Failures are local: a vehicle error never breaks the sighting queue');
  {
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    await submitSighting(ctx, 'rider', { license_plate: 'AAA1111' });
    const page = await openPage(ctx.env, 'session-mod', path => (path.startsWith('/api/moderation/robotaxi-vehicles') ? Promise.reject(new TypeError('down')) : null));
    await page.waitFor(() => page.visible('modVehiclesError'), 'vehicle error state');
    check('the vehicle section shows its own error with a retry button', page.visible('modVehiclesError') && !!page.d.getElementById('modVehiclesRetry'));
    check('the sighting queue still loaded and is usable', page.visible('modQueue') && page.sightingCards().length === 1);
    page.click(page.sightingCards()[0].querySelector('button[data-action="approve"]'));
    await page.waitFor(() => page.sightingCards().length === 0, 'sighting approval');
    check('approving a sighting still works while the vehicle section is in error', page.sightingCards().length === 0 && /approved/i.test(page.toastText()));
  }
  {
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    vehicle(ctx, 'AWT0001');
    let fail = true;
    const page = await openPage(ctx.env, 'session-mod', (path, init) => (fail && (init.method === 'POST') && path.startsWith('/api/moderation/robotaxi-vehicles') ? Promise.reject(new TypeError('down')) : null));
    await page.waitFor(() => page.cards().length === 1, 'vehicle list');
    approveVia(page);
    await page.waitFor(() => /reach the server/i.test(page.toastText()), 'error toast');
    check('a failed change shows an error toast and leaves the card usable (the Approve button re-enabled, not stuck disabled)', /Eligible for Approval/.test(page.cards()[0].textContent) && !!page.cards()[0].querySelector('button[data-vehicle-action="approve"]') && !page.cards()[0].querySelector('button[disabled]'));
    check('nothing changed in the database', ctx.d1.query("SELECT visibility FROM robotaxi_vehicles WHERE license_plate = 'AWT0001'")[0].visibility === 'private' && ctx.d1.query('SELECT COUNT(*) AS n FROM robotaxi_vehicle_reviews')[0].n === 0);
    fail = false;
    page.click(page.cards()[0].querySelector('button[data-vehicle-action="approve"]'));
    // It succeeds this time, and — now public — drops off the still-selected "Private" list.
    await page.waitFor(() => page.cards().length === 0, 'retry succeeds and the now-public vehicle drops off the list');
    check('retrying then succeeds, with exactly one history row', ctx.d1.query("SELECT visibility FROM robotaxi_vehicles WHERE license_plate = 'AWT0001'")[0].visibility === 'public' && ctx.d1.query('SELECT COUNT(*) AS n FROM robotaxi_vehicle_reviews')[0].n === 1);
  }
  {
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    const id = vehicle(ctx, 'GONE001');
    const page = await openPage(ctx.env, 'session-mod');
    await page.waitFor(() => page.cards().length === 1, 'vehicle list');
    ctx.d1.exec(`DELETE FROM trips WHERE robotaxi_vehicle_id = '${id}'`); ctx.d1.exec(`DELETE FROM robotaxi_vehicles WHERE id = '${id}'`);
    approveVia(page);
    await page.waitFor(() => page.cards().length === 0, 'stale card removal');
    check('a vehicle that vanished (404) is removed from the list with a clear message, not left stuck', page.cards().length === 0 && /no longer exists/i.test(page.toastText()));
  }
  {
    // A moderator demoted mid-session must be pushed to the forbidden view, not silently stay.
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    vehicle(ctx, 'AWT0001');
    const page = await openPage(ctx.env, 'session-mod');
    await page.waitFor(() => page.cards().length === 1, 'vehicle list');
    ctx.d1.exec(`UPDATE users SET role = 'user' WHERE id = 'mod'`);
    approveVia(page);
    await page.waitFor(() => page.visible('modForbidden'), 'forbidden after demotion');
    check('losing the moderator role mid-session switches to "Not authorized" and changes nothing', page.visible('modForbidden') && ctx.d1.query("SELECT visibility FROM robotaxi_vehicles WHERE license_plate = 'AWT0001'")[0].visibility === 'private');
  }

  console.log('7. Hostile plate strings render as inert text');
  {
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    const hostile = '<img src=x onerror=alert(1)>';
    vehicle(ctx, hostile);
    const page = await openPage(ctx.env, 'session-mod');
    await page.waitFor(() => page.cards().length === 1, 'hostile vehicle to render');
    check('no <img onerror> element was created', page.d.querySelectorAll('img[onerror]').length === 0);
    check('the hostile plate appears as literal text', page.d.getElementById('modVehicleList').textContent.includes(hostile));
    check('the raw markup never contains the unescaped tag', !page.d.getElementById('modVehicleList').innerHTML.includes('<img src=x onerror='));
  }

  console.log('8. Privacy: no rider, receipt, address or evidence data in the vehicle section');
  {
    const ctx = await makeApp({ 'rider': 'user', mod: 'moderator' });
    const id = vehicle(ctx, 'PRV0001');
    ctx.d1.exec(`UPDATE trips SET pickup_description = 'SECRET PICKUP ADDRESS', dropoff_description = 'SECRET DROPOFF' WHERE robotaxi_vehicle_id = '${id}'`);
    const page = await openPage(ctx.env, 'session-mod');
    await page.waitFor(() => page.cards().length === 1, 'vehicle list');
    const html = page.d.getElementById('modVehicles').innerHTML;
    check('no address, rider id, fare, evidence or email address appears', !/SECRET|rider|\$\d|evidence|pickup|dropoff|@/i.test(html.replace(/registry/gi, '')));
  }

  console.log('9. Provenance context on the cards (Phase 3G): descriptive facts, an explicit disclaimer, no trust language');
  {
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    const id = vehicle(ctx, 'PRV0001', { rides: 0 });
    seedRide(ctx.d1, { userId: 'rider', vehicleId: id, status: 'pending', source: 'receipt_email', rideDate: '2026-01-01' });
    seedRide(ctx.d1, { userId: 'rider', vehicleId: id, status: 'pending', source: 'receipt_email', rideDate: '2026-03-15' });
    seedRide(ctx.d1, { userId: 'rider', vehicleId: id, status: 'approved', source: 'receipt_import', rideDate: '2026-06-09' });
    seedRide(ctx.d1, { userId: 'rider', vehicleId: id, status: 'needs_review', source: 'receipt_import', rideDate: '2025-01-01' });   // not counted
    const page = await openPage(ctx.env, 'session-mod');
    await page.waitFor(() => page.cards().length === 1, 'vehicle list');
    const card = page.cards()[0]; const text = card.textContent.replace(/\s+/g, ' ');
    check('the card shows how the counted rides entered, per path', /How the counted rides entered/.test(text) && /Forwarded email: 2/.test(text) && /Import \(pasted text or \.eml file\): 1/.test(text) && /Other: 0/.test(text));
    check('an uncounted (needs_review) ride is not in the numbers', /3 counted rides/.test(text));
    check('first and latest counted ride dates are shown as calendar dates, not shifted by timezone', /First counted ride: Jan 1, 2026/.test(text) && /Latest counted ride: Jun 9, 2026/.test(text));
    check('the registry record dates are shown (created / last receipt activity)', /Vehicle record created/.test(text) && /Last receipt activity/.test(text));
    check('the card still shows plate, visibility and the approval state', /PRV0001/.test(text) && /Private — Needs Review/.test(text) && /Eligible for Approval/.test(text));
    check('the existing record status field is shown, labelled as a field', /Record field verification_status: unverified/.test(text));
    check('a first-seen timestamp is shown alongside created / last activity', /First seen/.test(text));
    check('approval is still offered', !!card.querySelector('button[data-vehicle-action="approve"]'));
    approveVia(page);
    // Now public, it drops off the default "Private" list; switch to "Public" to see it updated.
    await page.waitFor(() => page.cards().length === 0, 'drops off "Private"');
    const scope = page.d.getElementById('modVehicleScope'); scope.value = 'public';
    scope.dispatchEvent(new page.w.Event('change', { bubbles: true }));
    await page.waitFor(() => page.cards().length === 1, 'switch to "Public"');
    check('after a change the card still shows its provenance (from the server response)', /Forwarded email: 2/.test(page.cards()[0].textContent) && /Visible on the public registry/.test(page.cards()[0].textContent));

    const note = page.d.getElementById('modProvenanceNote').textContent.replace(/\s+/g, ' ').trim();
    check('the disclaimer says provenance describes how data entered and does not prove a receipt came from Tesla', note === 'Provenance describes how data entered Cybercab Hunter. It does not prove that a receipt was genuinely issued by Tesla.');
    check('the disclaimer is inside the registry section, visible without any interaction', page.d.getElementById('modVehicles').contains(page.d.getElementById('modProvenanceNote')));
    const section = page.d.getElementById('modVehicles').textContent.replace(/\s+/g, ' ');
    check('no restricted trust vocabulary anywhere in the registry section (trusted, verified, confidence, authentic, likely genuine)', !/trusted|verified|confidence|authentic|likely genuine/i.test(section.replace(/verification_status: \w+/g, '')));  // the existing DB field name/value is the one allowed use
    check('no score, percentage or ranking is shown', !/score|rank|\d+\s*%|out of \d+/i.test(section));
  }
  {
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    vehicle(ctx, 'ZERO001', { rides: 0 });
    const page = await openPage(ctx.env, 'session-mod');
    // The default "Private" list is every private vehicle, so this one (0 rides) is already there.
    await page.waitFor(() => page.cards().length === 1, 'default list settles');
    page.d.getElementById('modVehiclePlate').value = 'ZERO001'; page.submitSearch();
    await page.waitFor(() => page.cards().length === 1, 'search result');
    const text = page.cards()[0].textContent.replace(/\s+/g, ' ');
    check('zero counted rides: says there is no ride provenance instead of showing zeros or invented dates', /No counted rides yet, so there is no ride provenance to show/.test(text) && !/First counted ride|How the counted rides entered/.test(text));
  }
  {
    // A duplicated plate shows its warning alongside provenance; nothing is auto-resolved.
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    vehicle(ctx, 'DUPL005'); vehicle(ctx, 'dupl-005');
    const page = await openPage(ctx.env, 'session-mod');
    await page.waitFor(() => page.cards().length === 2, 'both duplicates');
    check('both duplicates carry the warning and their own provenance', page.cards().every(c => /Duplicate plate: 2 registry vehicles/.test(c.textContent) && /How the counted rides entered/.test(c.textContent)));
    check('duplicate plates are flagged as a blocking reason and neither can be approved', page.cards().every(c => /Duplicate plate/.test(c.textContent) && c.dataset.approvalState === 'not_eligible' && !c.querySelector('button[data-vehicle-action="approve"]')));
    check('there is no merge or resolve control on any card (Delete Vehicle is the only other action, alongside approve / return)', page.cards().every(c => [...c.querySelectorAll('button')].every(b => /^(Approve|Return to Private|Delete Vehicle)$/.test(b.textContent.trim()))) && !/merge|resolve/i.test(page.d.getElementById('modVehicleList').textContent));
  }
  {
    // Hostile values from the API stay inert text.
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    const hostile = '<img src=x onerror=alert(1)>';
    const fake = { id: 'eeeeeeee-0000-4000-8000-000000000001', license_plate: hostile, visibility: 'private', counted_ride_count: 3,
      counted_rides_by_source: { receipt_email: hostile, receipt_import: hostile, other: hostile },
      first_counted_ride_date: hostile, last_counted_ride_date: '<script>window.__pwned=1</script>',
      first_seen_at: hostile, last_seen_at: hostile, created_at: hostile, publicly_eligible: false, plate_vehicle_count: 1 };
    const page = await openPage(ctx.env, 'session-mod', path => (path.startsWith('/api/moderation/robotaxi-vehicles') ? new Response(JSON.stringify({ success: true, vehicles: [fake] }), { status: 200, headers: { 'Content-Type': 'application/json' } }) : null));
    await page.waitFor(() => page.cards().length === 1, 'hostile card');
    const list = page.d.getElementById('modVehicleList');
    check('no element was created from any hostile provenance value', list.querySelectorAll('img, script, [onerror]').length === 0 && page.w.__pwned === undefined);
    check('hostile counts render as literal, escaped text', list.textContent.includes(hostile) && !list.innerHTML.includes('<img src=x'));
    check('non-date values in the date fields render as an em dash, never "Invalid Date"', !/Invalid Date|NaN/.test(list.textContent) && /First counted ride: —/.test(list.textContent.replace(/\s+/g, ' ')));
  }
  {
    // Long content must not be able to break the card layout (real layout is verified in a browser).
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    const fake = { id: 'eeeeeeee-0000-4000-8000-000000000002', license_plate: 'X'.repeat(300), visibility: 'public', counted_ride_count: 999999,
      counted_rides_by_source: { receipt_email: 999999, receipt_import: 0, other: 0 }, first_counted_ride_date: '2026-01-01', last_counted_ride_date: '2026-06-09',
      first_seen_at: '2026-01-01 00:00:00', last_seen_at: '2026-06-09 12:34:56', created_at: '2026-01-01 00:00:00', publicly_eligible: true, plate_vehicle_count: 7 };
    const page = await openPage(ctx.env, 'session-mod', path => (path.startsWith('/api/moderation/robotaxi-vehicles') ? new Response(JSON.stringify({ success: true, vehicles: [fake] }), { status: 200, headers: { 'Content-Type': 'application/json' } }) : null));
    await page.waitFor(() => page.cards().length === 1, 'long card');
    check('the card opts in to anywhere-wrapping so a 300-character plate cannot force horizontal scroll', /overflow-wrap:anywhere/.test(page.cards()[0].className));
  }

  console.log('10. Deleting a vehicle from the registry: works regardless of visibility, and takes every ride/receipt logged against it with it');
  {
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    const id = vehicle(ctx, 'DEL0001', { rides: 2 });
    const page = await openPage(ctx.env, 'session-mod');
    await page.waitFor(() => page.cards().length === 1, 'vehicle list');
    page.click(page.cards()[0].querySelector('button[data-vehicle-action="ask-delete"]'));
    check('the first click only opens a confirmation — nothing is sent and nothing changes', page.vehicleRequests('DELETE').length === 0 && ctx.d1.query('SELECT COUNT(*) AS n FROM robotaxi_vehicles WHERE id = ?', id)[0].n === 1);
    check('the confirmation names the plate, warns it cannot be undone, and says the ride(s)/receipt(s) are deleted too', /cannot be undone/i.test(page.cards()[0].textContent) && /DEL0001/.test(page.cards()[0].textContent) && /ride\(s\)\/receipt\(s\)/i.test(page.cards()[0].textContent));
    page.click(page.cards()[0].querySelector('button[data-vehicle-action="cancel-review"]'));
    check('Cancel closes it without sending anything', !!page.cards()[0].querySelector('button[data-vehicle-action="ask-delete"]') && page.vehicleRequests('DELETE').length === 0);

    page.click(page.cards()[0].querySelector('button[data-vehicle-action="ask-delete"]'));
    page.click(page.cards()[0].querySelector('button[data-vehicle-action="confirm-delete"]'));
    await page.waitFor(() => page.cards().length === 0, 'card removed');
    const sent = page.vehicleRequests('DELETE');
    check('exactly one DELETE was sent, to the vehicle\'s own endpoint, with no extra params', sent.length === 1 && sent[0].path === `/api/moderation/robotaxi-vehicles/${id}`);
    check('the row is gone from the database', ctx.d1.query('SELECT COUNT(*) AS n FROM robotaxi_vehicles WHERE id = ?', id)[0].n === 0);
    check('a distinct success message explains the receipt can be resent', /ride history removed.*receipt can be resent/i.test(page.toastText()));
    check('the rider\'s trips are deleted too, not just unlinked — this is what frees the receipt to be resent', ctx.d1.query('SELECT COUNT(*) AS n FROM trips')[0].n === 0);
  }
  {
    // Delete works on a currently-public vehicle too, unlike the takedown PATCH which only demotes it.
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    const id = vehicle(ctx, 'PUBDEL01', { visibility: 'public' });
    const page = await openPage(ctx.env, 'session-mod');
    const scope = page.d.getElementById('modVehicleScope'); scope.value = 'public';
    scope.dispatchEvent(new page.w.Event('change', { bubbles: true }));
    await page.waitFor(() => page.cards().length === 1, 'public vehicle listed');
    check('a public vehicle also offers Delete Vehicle, alongside Return to Private', !!page.cards()[0].querySelector('button[data-vehicle-action="ask-delete"]') && !!page.cards()[0].querySelector('button[data-vehicle-action="return"]'));
    page.click(page.cards()[0].querySelector('button[data-vehicle-action="ask-delete"]'));
    page.click(page.cards()[0].querySelector('button[data-vehicle-action="confirm-delete"]'));
    await page.waitFor(() => page.cards().length === 0, 'public vehicle removed');
    check('a public vehicle can be deleted outright, not just returned to private', ctx.d1.query('SELECT COUNT(*) AS n FROM robotaxi_vehicles WHERE id = ?', id)[0].n === 0);
    check('the now-nonexistent vehicle is 404 on the public endpoint', (await worker.fetch(new Request(`https://x/api/robotaxi-vehicles/${id}`), ctx.env, {})).status === 404);
  }
  {
    // Stale card: already deleted (by someone else, or a prior click) by the time this one confirms.
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    const id = vehicle(ctx, 'GONEDEL1');
    const page = await openPage(ctx.env, 'session-mod');
    await page.waitFor(() => page.cards().length === 1, 'vehicle list');
    ctx.d1.exec(`DELETE FROM trips WHERE robotaxi_vehicle_id = '${id}'`); ctx.d1.exec(`DELETE FROM robotaxi_vehicles WHERE id = '${id}'`);
    page.click(page.cards()[0].querySelector('button[data-vehicle-action="ask-delete"]'));
    page.click(page.cards()[0].querySelector('button[data-vehicle-action="confirm-delete"]'));
    await page.waitFor(() => page.cards().length === 0, 'stale card removal');
    check('a vehicle already gone (404) is removed from the list with a clear message', page.cards().length === 0 && /no longer exists/i.test(page.toastText()));
  }
  {
    // A network failure leaves the confirmation open and usable, same as the review actions.
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    const id = vehicle(ctx, 'FAILDEL1');
    const page = await openPage(ctx.env, 'session-mod', (path, init) => ((init.method === 'DELETE') && path.startsWith('/api/moderation/robotaxi-vehicles') ? Promise.reject(new TypeError('down')) : null));
    await page.waitFor(() => page.cards().length === 1, 'vehicle list');
    page.click(page.cards()[0].querySelector('button[data-vehicle-action="ask-delete"]'));
    page.click(page.cards()[0].querySelector('button[data-vehicle-action="confirm-delete"]'));
    await page.waitFor(() => /reach the server/i.test(page.toastText()), 'error toast');
    check('a failed delete shows an error toast and leaves the confirmation open, nothing removed', !!page.cards()[0].querySelector('button[data-vehicle-action="confirm-delete"]') && ctx.d1.query('SELECT COUNT(*) AS n FROM robotaxi_vehicles WHERE id = ?', id)[0].n === 1);
  }

  t.finish();
}

run().catch(err => { console.error(err); process.exit(1); });
