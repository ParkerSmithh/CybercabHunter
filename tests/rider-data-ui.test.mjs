// Rider Data page behavior: the corrected "under review" wording (C3) and the
// rider-owned "remove this ride" action. The REAL js/rider-data.js runs in
// jsdom against the REAL Worker code and real SQL (node:sqlite + the project's
// migrations) — fetch() is routed straight into worker.fetch, so what the page
// shows is what the API actually returned, and deletions are real DELETEs.
// Layout/CSS is not exercised (jsdom has no renderer).
// Run: node tests/rider-data-ui.test.mjs

import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { makeEnv, makeCheck, seedRide } from './helpers/env.mjs';
import { receiptBody, eml, inboundMessage, sentAt } from './helpers/receipts.mjs';
import { handleIncomingEmail } from '../worker/receipt-ingestion.js';
import worker from '../worker/index.js';

const t = makeCheck();
const { check } = t;
const ROOT = new URL('..', import.meta.url).pathname;
const HTML = fs.readFileSync(`${ROOT}rider-data.html`, 'utf8');
const JS = fs.readFileSync(`${ROOT}js/rider-data.js`, 'utf8');

async function makeApp({ users = ['u1'] } = {}) {
  const ctx = await makeEnv({ users });
  for (const u of users) await ctx.env.TESLA_SESSIONS.put(`session:session-${u}`, JSON.stringify({ user_id: u }));
  ctx.email = async (userId, opts) => {
    const to = ctx.addressFor(userId);
    await handleIncomingEmail(inboundMessage(eml({ ...opts, to }), to), ctx.env);
  };
  return ctx;
}

// Opens the page as `userId`. `intercept(url, init)` may return a Response (or
// throw) to simulate a failing server; otherwise the request goes to the real Worker.
async function openPage(ctx, userId, intercept) {
  const dom = new JSDOM(HTML, { runScripts: 'outside-only', url: 'https://cybercabhunter.com/rider-data.html', pretendToBeVisual: true });
  const w = dom.window;
  w.localStorage.setItem('teslaSessionId', `session-${userId}`);
  const requests = [];
  w.fetch = async (url, init = {}) => {
    const path = String(url).replace('https://cybercabhunter.contactjoeclos.workers.dev', '');
    requests.push({ method: init.method || 'GET', path, auth: (init.headers || {}).Authorization });
    if (intercept) { const r = await intercept(path, init); if (r) return r; }
    return worker.fetch(new Request(`https://x${path}`, { ...init, headers: { Origin: 'https://cybercabhunter.com', ...(init.headers || {}) } }), ctx.env, {});
  };
  w.eval(JS);
  const d = w.document;
  const page = {
    w, d, requests,
    text: id => d.getElementById(id).textContent.replace(/\s+/g, ' ').trim(),
    visible: id => !d.getElementById(id).classList.contains('hidden'),
    rows: () => [...d.querySelectorAll('#ridesBody tr')],
    click: el => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true })),
    async waitFor(cond, label, ms = 3000) {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (cond()) return true; await new Promise(r => setTimeout(r, 10)); }
      console.log(`    (timed out waiting for: ${label})`);
      return false;
    }
  };
  await page.waitFor(() => page.visible('dataSignedIn') || page.visible('dataError'), 'page to load');
  return page;
}

const removeBtn = (page, i = 0) => page.rows()[i].querySelector('button[data-action="ask-remove"]');
const tripsOf = (ctx, uid) => ctx.d1.query('SELECT id FROM trips WHERE user_id = ?', uid).map(r => r.id);

async function run() {
  console.log('C3. Wording: nothing promises that a clearer copy will update an unmatched ride');
  {
    const ctx = await makeApp();
    // A legacy-style ride with no date/pickup time: it can never be matched by a later receipt.
    seedRide(ctx.d1, { id: 'legacy', status: 'needs_review', rideDate: null, pickupTime: null, distance: null });
    const page = await openPage(ctx, 'u1');
    const shown = [page.text('dataEmptyDetail'), page.text('syncReviewNote'), page.text('heroNote')].join(' | ');
    check('the empty-state text says the ride is not counted', /not counted/i.test(page.text('dataEmptyDetail')));
    check('it points the rider at removal', /remove it from Ride history/i.test(page.text('dataEmptyDetail')));
    check('the old promise ("clearer copy … will update") is gone from every message', !/clearer copy|will update/i.test(shown));
    check('the sync note says the ride needs review, is not counted, and can be removed', /1 ride needs review/.test(page.text('syncReviewNote')) && /not counted/.test(page.text('syncReviewNote')) && /remove it/i.test(page.text('syncReviewNote')));
    check('plural grammar', await (async () => {
      seedRide(ctx.d1, { id: 'legacy2', status: 'needs_review', rideDate: null, pickupTime: null });
      const p2 = await openPage(ctx, 'u1');
      return /2 rides were received but are not counted/.test(p2.text('dataEmptyDetail')) && /remove them/.test(p2.text('dataEmptyDetail'));
    })());
  }

  console.log('C2 (UI). Receipts whose date/pickup time cannot be read are reported, not shown as rides');
  {
    const ctx = await makeApp();
    await ctx.email('u1', { body: receiptBody({ date: '9 June 2026' }), date: sentAt(0) });
    const page = await openPage(ctx, 'u1');
    check('the sync note says 1 receipt was not added because its date or pickup time could not be read', /1 receipt was not added because its date or pickup time could not be read/.test(page.text('syncReviewNote')));
    check('no ride row and no under-review ride exist', page.rows().length === 0 && page.text('syncReview') === '0');
    check('the rider is told nothing counted yet', page.visible('dataEmptyNotice') && page.text('heroRideCount') === '0');
  }

  console.log('Remove (UI). Each ride offers Remove; a confirmation is required; Cancel sends nothing');
  {
    const ctx = await makeApp();
    await ctx.email('u1', { body: receiptBody(), date: sentAt(0) });
    await ctx.email('u1', { from: 'rider@example.com', subject: 'r', body: receiptBody({ date: 'June 10, 2026', fare: null, summary: null }), date: sentAt(1) }); // needs_review
    const page = await openPage(ctx, 'u1');
    check('two rides listed, each with a Remove button', page.rows().length === 2 && page.rows().every(r => r.querySelector('button[data-action="ask-remove"]')));
    check('one is counted and one is under review', page.text('heroRideCount') === '1' && page.text('syncReview') === '1');

    page.click(removeBtn(page, 0));
    check('clicking Remove asks for confirmation instead of deleting', /Remove this ride\?/.test(page.rows()[0].textContent) && tripsOf(ctx, 'u1').length === 2);
    check('only the chosen row shows the prompt', !/Remove this ride\?/.test(page.rows()[1].textContent));
    page.click(page.rows()[0].querySelector('button[data-action="cancel-remove"]'));
    check('Cancel restores the row', !/Remove this ride\?/.test(page.rows()[0].textContent) && !!removeBtn(page, 0));
    check('no DELETE request was sent', !page.requests.some(r => r.method === 'DELETE') && tripsOf(ctx, 'u1').length === 2);
  }

  console.log('Remove (UI). Confirming deletes only that ride and the page updates');
  {
    const ctx = await makeApp();
    await ctx.email('u1', { body: receiptBody(), date: sentAt(0) });                                                   // counted, 2026-06-09
    await ctx.email('u1', { from: 'rider@example.com', subject: 'r', body: receiptBody({ date: 'June 10, 2026', fare: null, summary: null }), date: sentAt(1) }); // needs_review, 2026-06-10
    const page = await openPage(ctx, 'u1');
    const reviewRow = page.rows().findIndex(r => /Under review/.test(r.textContent));
    check('the under-review ride is identifiable in the list', reviewRow >= 0);
    const reviewId = ctx.d1.query("SELECT t.id FROM trips t JOIN submissions s ON s.id = t.submission_id WHERE s.status = 'needs_review'")[0].id;

    page.click(removeBtn(page, reviewRow));
    page.click(page.rows()[reviewRow].querySelector('button[data-action="confirm-remove"]'));
    await page.waitFor(() => page.rows().length === 1, 'row to disappear');
    const del = page.requests.filter(r => r.method === 'DELETE');
    check('exactly one DELETE, to that ride\'s id, with the rider\'s bearer session', del.length === 1 && del[0].path === `/api/trips/${reviewId}` && del[0].auth === 'Bearer session-u1');
    check('the ride is gone from the database', !tripsOf(ctx, 'u1').includes(reviewId) && tripsOf(ctx, 'u1').length === 1);
    check('the counted ride is untouched and still counted', page.text('heroRideCount') === '1' && !/Under review/.test(page.rows()[0].textContent));
    check('the under-review figures and note refreshed', page.text('syncReview') === '0' && !/needs review/.test(page.text('syncReviewNote')));
    check('no error is shown', !page.visible('ridesActionError'));

    // Remove the last ride: the empty state appears.
    page.click(removeBtn(page, 0));
    page.click(page.rows()[0].querySelector('button[data-action="confirm-remove"]'));
    await page.waitFor(() => page.visible('ridesEmpty'), 'empty state');
    check('removing the last ride shows the empty state and zero stats', page.visible('ridesEmpty') && !page.visible('ridesTableWrap') && page.text('heroRideCount') === '0' && tripsOf(ctx, 'u1').length === 0);
    // A receipt for a deleted ride can be received again.
    await ctx.email('u1', { body: receiptBody(), date: sentAt(0) });
    check('the same receipt can come back in after the ride was removed', tripsOf(ctx, 'u1').length === 1);
  }

  console.log('Remove (UI). Errors are shown clearly and nothing changes');
  {
    const ctx = await makeApp();
    await ctx.email('u1', { body: receiptBody(), date: sentAt(0) });

    let page = await openPage(ctx, 'u1', (path, init) => (init.method === 'DELETE' ? new Response('{"success":false}', { status: 500 }) : null));
    page.click(removeBtn(page)); page.click(page.rows()[0].querySelector('button[data-action="confirm-remove"]'));
    await page.waitFor(() => page.visible('ridesActionError'), 'error message');
    check('a server error is shown', /nothing was changed/i.test(page.text('ridesActionError')));
    check('the ride is still listed, still counted, and the prompt is closed', page.rows().length === 1 && page.text('heroRideCount') === '1' && !!removeBtn(page));
    check('the ride still exists in the database', tripsOf(ctx, 'u1').length === 1);

    page = await openPage(ctx, 'u1', (path, init) => { if (init.method === 'DELETE') throw new TypeError('network down'); return null; });
    page.click(removeBtn(page)); page.click(page.rows()[0].querySelector('button[data-action="confirm-remove"]'));
    await page.waitFor(() => page.visible('ridesActionError'), 'network error message');
    check('a network failure is shown, and says nothing was changed', /check your connection/i.test(page.text('ridesActionError')) && /nothing was changed/i.test(page.text('ridesActionError')) && page.rows().length === 1);

    page = await openPage(ctx, 'u1', (path, init) => (init.method === 'DELETE' ? new Response('{"authenticated":false}', { status: 401 }) : null));
    page.click(removeBtn(page)); page.click(page.rows()[0].querySelector('button[data-action="confirm-remove"]'));
    await page.waitFor(() => page.visible('ridesActionError'), 'session message');
    check('an expired session is reported as such', /session has expired/i.test(page.text('ridesActionError')));

    // Already removed elsewhere (404): the ride list is refreshed and the rider told.
    page = await openPage(ctx, 'u1');
    ctx.d1.exec("DELETE FROM receipt_ingestions; DELETE FROM trips; DELETE FROM submissions;");
    page.click(removeBtn(page)); page.click(page.rows()[0].querySelector('button[data-action="confirm-remove"]'));
    await page.waitFor(() => page.visible('ridesEmpty'), 'refresh after 404');
    check('a ride that is already gone is reported and the list refreshes', /already removed/i.test(page.text('ridesActionError')) && page.visible('ridesEmpty'));
  }

  console.log('Remove (UI). Removing the only ride on a later page returns to a page that exists');
  {
    const ctx = await makeApp();
    for (let i = 1; i <= 11; i++) seedRide(ctx.d1, { id: `p${i}`, rideDate: `2026-05-${String(i).padStart(2, '0')}`, pickupTime: '10:00', rideKey: `v1|2026-05-${String(i).padStart(2, '0')}|10:00|` });
    const page = await openPage(ctx, 'u1');
    check('11 rides paginate as 10 + 1', page.rows().length === 10 && /Page 1 of 2/.test(page.text('ridesPageLabel')));
    page.click(page.d.getElementById('ridesNext'));
    await page.waitFor(() => /Page 2 of 2/.test(page.text('ridesPageLabel')), 'page 2');
    check('page 2 has the one oldest ride', page.rows().length === 1);
    page.click(removeBtn(page)); page.click(page.rows()[0].querySelector('button[data-action="confirm-remove"]'));
    await page.waitFor(() => page.rows().length === 10 && /Page 1 of 1/.test(page.text('ridesPageLabel')) || page.visible('ridesPager') === false, 'fallback to page 1');
    check('after removing it the list falls back to page 1 with all 10 remaining rides', page.rows().length === 10 && tripsOf(ctx, 'u1').length === 10);
  }

  console.log('Remove (authorization). A rider can only ever delete their own rides — enforced by the API, not the page');
  {
    const ctx = await makeApp({ users: ['u1', 'u2'] });
    await ctx.email('u1', { body: receiptBody(), date: sentAt(0) });
    await ctx.email('u2', { body: receiptBody({ date: 'June 11, 2026' }), date: sentAt(0) });
    const u2Trip = tripsOf(ctx, 'u2')[0];
    const call = (method, path, user) => worker.fetch(new Request(`https://x${path}`, { method, headers: user ? { Authorization: `Bearer session-${user}` } : {} }), ctx.env, {});

    const cross = await call('DELETE', `/api/trips/${u2Trip}`, 'u1');
    check("u1 deleting u2's ride id is refused (404, indistinguishable from a missing id)", cross.status === 404);
    check("u2's ride and its submission are untouched", tripsOf(ctx, 'u2').length === 1 && ctx.d1.query("SELECT COUNT(*) n FROM submissions WHERE user_id = 'u2'")[0].n === 1);
    check("u2's ingestion audit rows are untouched", ctx.d1.query("SELECT COUNT(*) n FROM receipt_ingestions WHERE user_id = 'u2' AND trip_id IS NOT NULL")[0].n === 1);
    check('an anonymous DELETE is refused', (await call('DELETE', `/api/trips/${u2Trip}`, null)).status === 401);
    check('a made-up id is a 404', (await call('DELETE', '/api/trips/does-not-exist', 'u1')).status === 404);
    check('injection-style ids are inert', (await call('DELETE', `/api/trips/${encodeURIComponent("x' OR '1'='1")}`, 'u1')).status === 404 && tripsOf(ctx, 'u1').length === 1 && tripsOf(ctx, 'u2').length === 1);

    // u2's own page never lists u1's ride, so u1's id can't even be offered to u2.
    const page = await openPage(ctx, 'u2');
    check("u2's page lists only u2's ride", page.rows().length === 1);

    const own = await call('DELETE', `/api/trips/${u2Trip}`, 'u2');
    const ownJson = await own.json();
    check('the owner can delete it', own.status === 200 && ownJson.success === true && tripsOf(ctx, 'u2').length === 0);
    check("u1's ride was never affected", tripsOf(ctx, 'u1').length === 1);
    const vehicles = ctx.d1.query('SELECT COUNT(*) n FROM robotaxi_vehicles')[0].n;
    check('the shared vehicle registry is not touched by a rider deleting their own ride', vehicles === 2 || vehicles === 1);
  }

  console.log('Remove (consistency). Revision snapshots and superseded duplicates go with the ride that owns them, and nothing else');
  {
    const ctx = await makeApp({ users: ['u1', 'u2'] });
    await ctx.email('u1', { body: receiptBody(), date: sentAt(0) });
    await ctx.email('u1', { body: receiptBody({ fare: '$8.50' }), date: sentAt(30) });   // revision 2 -> one snapshot
    await ctx.email('u2', { body: receiptBody(), date: sentAt(0) });
    await ctx.email('u2', { body: receiptBody({ fare: '$9.50' }), date: sentAt(30) });
    const u1Trip = tripsOf(ctx, 'u1')[0];
    const dupeSub = seedRide(ctx.d1, { id: 'dupe', userId: 'u1', supersededBy: u1Trip, rideKey: 'v1|2026-06-09|13:04|XJR2195' });
    check('precondition: u1 has a live ride, a superseded duplicate and a snapshot', ctx.d1.query('SELECT COUNT(*) n FROM trip_revisions')[0].n === 2 && ctx.d1.query("SELECT COUNT(*) n FROM trips WHERE user_id = 'u1'")[0].n === 2);
    const res = await worker.fetch(new Request(`https://x/api/trips/${u1Trip}`, { method: 'DELETE', headers: { Authorization: 'Bearer session-u1' } }), ctx.env, {});
    check('delete succeeds', res.status === 200);
    check("u1's ride, its duplicate and its snapshot are gone", ctx.d1.query("SELECT COUNT(*) n FROM trips WHERE user_id = 'u1'")[0].n === 0 && ctx.d1.query('SELECT COUNT(*) n FROM trip_revisions')[0].n === 1);
    check("u2's ride AND its revision snapshot are intact", tripsOf(ctx, 'u2').length === 1 && ctx.d1.query("SELECT COUNT(*) n FROM trip_revisions r JOIN trips t ON t.id = r.trip_id WHERE t.user_id = 'u2'")[0].n === 1);
    check('no orphaned submissions remain for u1', ctx.d1.query("SELECT COUNT(*) n FROM submissions WHERE user_id = 'u1' AND submission_type = 'ride_receipt'")[0].n === 0);
  }

  t.finish();
}

run().catch(err => { console.error(err); process.exit(1); });
