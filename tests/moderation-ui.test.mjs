// Tests for the moderator review UI (moderation.html + js/moderation.js,
// Phase 3D-C2). Real SQL + the REAL Worker router via jsdom, matching the
// harness pattern established for js/main.js in tests/sighting-drawer.test.mjs
// (calc.js + main.js + CCC.init() + this page's own script combined into
// ONE eval() call, IntersectionObserver stubbed — neither is app behavior,
// both are just what running a multi-<script> page takes in Node).
// Run: node tests/moderation-ui.test.mjs

import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { makeEnv, makeCheck } from './helpers/env.mjs';
import worker from '../worker/index.js';

const t = makeCheck();
const { check } = t;
const ROOT = new URL('..', import.meta.url).pathname;
const HTML = fs.readFileSync(`${ROOT}public/moderation.html`, 'utf8');
const CALC = fs.readFileSync(`${ROOT}public/js/calc.js`, 'utf8');
const MAIN = fs.readFileSync(`${ROOT}public/js/main.js`, 'utf8');
const MOD = fs.readFileSync(`${ROOT}public/js/moderation.js`, 'utf8');
const COMBINED = `${CALC}\n${MAIN}\nCCC.init();\n${MOD}`;

async function makeApp(users) {
  const ctx = await makeEnv({ users: Object.keys(users) });
  for (const [id, role] of Object.entries(users)) {
    await ctx.env.TESLA_SESSIONS.put(`session:session-${id}`, JSON.stringify({ user_id: id }));
    if (role && role !== 'user') ctx.d1.exec(`UPDATE users SET role = '${role}' WHERE id = '${id}'`);
  }
  return ctx;
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
    text: id => d.getElementById(id).textContent.replace(/\s+/g, ' ').trim(),
    reviews: () => requests.filter(r => r.method === 'PATCH'),
    toastText: () => { const root = d.getElementById('toastRoot'); return root && root.lastElementChild ? root.lastElementChild.textContent.trim() : ''; },
    cards: () => [...d.querySelectorAll('[data-submission-id]')],
    click: el => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true })),
    async waitFor(cond, label, ms = 1500) {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (cond()) return true; await new Promise(r => setTimeout(r, 5)); }
      console.log(`    (timed out waiting for: ${label})`);
      return false;
    }
  };
  return page;
}

async function run() {
  console.log('1. Loading/empty/signed-out/forbidden/error states');
  {
    const ctx = await makeApp({ mod: 'moderator' });
    const page = await openPage(ctx.env, 'session-mod');
    await page.waitFor(() => page.visible('modQueue'), 'queue to load');
    check('an empty queue shows no cards and no error (there is no empty-state box)', page.cards().length === 0 && !page.visible('modError'));
  }
  {
    const ctx = await makeApp({});
    const page = await openPage(ctx.env, null);
    check('no session at all -> signed-out state immediately, no request made', page.visible('modSignedOut') && page.requests.length === 0);
  }
  {
    const ctx = await makeApp({ rider: 'user' });
    const page = await openPage(ctx.env, 'session-rider');
    await page.waitFor(() => page.visible('modForbidden'), 'forbidden state');
    check('an ordinary authenticated user sees "Not authorized", not the queue or a generic error', page.visible('modForbidden') && !page.visible('modQueue'));
  }
  {
    const ctx = await makeApp({ mod: 'moderator' });
    const page = await openPage(ctx.env, 'session-mod', (path) => (path.includes('/api/moderation/vehicle-sightings') ? Promise.reject(new TypeError('down')) : null));
    await page.waitFor(() => page.visible('modError'), 'error state');
    check('a network failure shows the error state with a retry button, not a crash', page.visible('modError') && !!page.d.getElementById('modRetry'));
  }

  console.log('2. Populated queue: fields render, approve removes the card and shows a distinct success message');
  {
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    const s = await submitSighting(ctx, 'rider', { license_plate: 'xjr-2195', model: 'Model Y', color: 'White', notes: 'Seen downtown' });
    const page = await openPage(ctx.env, 'session-mod');
    await page.waitFor(() => page.cards().length === 1, 'the sighting to render');
    const card = page.cards()[0];
    check('the plate renders (normalized, as stored)', /XJR2195/.test(card.textContent));
    check('model/color/notes render', /Model Y/.test(card.textContent) && /White/.test(card.textContent) && /Seen downtown/.test(card.textContent));
    check('an unknown plate is clearly labeled as unmatched', /unrecognized|No matching vehicle/i.test(card.textContent));

    page.click(card.querySelector('button[data-action="approve"]'));
    await page.waitFor(() => page.cards().length === 0, 'the card to be removed after approval');
    check('the approved sighting disappears from the queue', page.cards().length === 0);
    check('a distinct approval message is shown', /approved/i.test(page.toastText()));
  }

  console.log('3. Reject requires a reason: the inline flow, validation, and a distinct rejection message');
  {
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    const s = await submitSighting(ctx, 'rider', { license_plate: 'AAA1111' });
    const page = await openPage(ctx.env, 'session-mod');
    await page.waitFor(() => page.cards().length === 1, 'the sighting to render');

    // renderQueue() rebuilds #modList's innerHTML on every state change, so
    // each element reference below is re-queried fresh after the click that
    // triggered the re-render — the old node is detached, not updated.
    page.click(page.cards()[0].querySelector('button[data-action="ask-reject"]'));
    check('clicking Reject opens the inline reason box rather than rejecting immediately', !!page.cards()[0].querySelector('[data-reject-reason]') && page.reviews().length === 0);

    page.click(page.cards()[0].querySelector('button[data-action="confirm-reject"]'));
    await new Promise(r => setTimeout(r, 30));
    check('confirming with no reason typed is refused client-side — no review request sent', page.reviews().length === 0);
    check('the toast explains a reason is required', /reason is required/i.test(page.toastText()));

    page.cards()[0].querySelector('[data-reject-reason]').value = 'Could not confirm the plate.';
    page.click(page.cards()[0].querySelector('button[data-action="confirm-reject"]'));
    await page.waitFor(() => page.cards().length === 0, 'the card to be removed after rejection');
    check('the rejected sighting disappears from the queue', page.cards().length === 0);
    check('rejection gets its own distinct message, not the approval wording', /rejected/i.test(page.toastText()) && !/approved/i.test(page.toastText()));

    const stored = ctx.d1.query('SELECT rejection_reason FROM submissions WHERE id = ?', s.submission_id)[0];
    check('the typed reason was actually sent and stored', stored.rejection_reason === 'Could not confirm the plate.');
  }
  {
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    await submitSighting(ctx, 'rider', { license_plate: 'AAA1111' });
    const page = await openPage(ctx.env, 'session-mod');
    await page.waitFor(() => page.cards().length === 1, 'the sighting to render');
    page.click(page.cards()[0].querySelector('button[data-action="ask-reject"]'));
    page.click(page.cards()[0].querySelector('button[data-action="cancel-reject"]'));
    check('Cancel closes the reason box and returns to the plain Approve/Reject buttons, sending nothing', !!page.cards()[0].querySelector('button[data-action="approve"]') && page.reviews().length === 0);
  }

  console.log('4. Conflict handling: a sighting already reviewed elsewhere is cleanly removed from the queue, not left broken');
  {
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    const s = await submitSighting(ctx, 'rider', { license_plate: 'AAA1111' });
    const page = await openPage(ctx.env, 'session-mod');
    await page.waitFor(() => page.cards().length === 1, 'the sighting to render');
    // Someone else reviews it out from under this open page.
    await worker.fetch(new Request(`https://x/api/moderation/vehicle-sightings/${s.submission_id}`, {
      method: 'PATCH', headers: { Origin: 'https://cybercabhunter.com', Authorization: 'Bearer session-mod', 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'approve' })
    }), ctx.env, {});
    page.click(page.cards()[0].querySelector('button[data-action="approve"]'));
    await page.waitFor(() => page.cards().length === 0, 'the stale card to be removed');
    check('a 409 conflict removes the stale card rather than leaving it stuck or erroring loudly', page.cards().length === 0);
    check('the conflict message is distinct and non-alarming', /already reviewed/i.test(page.toastText()));
  }

  console.log('5. XSS: hostile plate/model/color/notes render as inert text, never as markup');
  {
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    const hostile = '<img src=x onerror=alert(1)>';
    await submitSighting(ctx, 'rider', { license_plate: 'AAA1111', model: hostile, color: hostile, notes: hostile });
    const page = await openPage(ctx.env, 'session-mod');
    await page.waitFor(() => page.cards().length === 1, 'the hostile sighting to render');
    check('no <img onerror> element was created anywhere in the queue', page.d.querySelectorAll('img[onerror]').length === 0);
    check('the hostile strings appear as literal escaped text, not executable markup', page.d.getElementById('modList').textContent.includes(hostile));
    check('the raw innerHTML never contains an unescaped onerror attribute', !page.d.getElementById('modList').innerHTML.includes('<img src=x onerror='));
  }

  console.log('6. Import Receipt replaces Refresh (see tests/moderator-receipt-import.test.mjs)');
  {
    const ctx = await makeApp({ mod: 'moderator' });
    const page = await openPage(ctx.env, 'session-mod');
    await page.waitFor(() => page.visible('modQueue'), 'queue to load');
    const link = page.d.getElementById('modImportReceipt');
    check('the queue header has an Import Receipt link to /moderation/import-receipt, and no Refresh button', !!link && link.getAttribute('href') === '/moderation/import-receipt' && !page.d.getElementById('modRefresh'));
  }

  console.log('N. Vehicles | Images sections: photo sightings are reviewed in their own compact grid');
  {
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    await submitSighting(ctx, 'rider', { license_plate: 'TEXT001' });   // no photo -> Vehicles
    const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
    for (const plate of ['PHOTO01', 'PHOTO02']) {
      const fd = new FormData();
      fd.append('photo', new File([PNG], 'p.png', { type: 'image/png' }));
      fd.append('license_plate', plate);
      await worker.fetch(new Request('https://x/api/vehicle-sightings/photo', { method: 'POST', headers: { Authorization: 'Bearer session-rider' }, body: fd }), ctx.env, {});
    }
    const page = await openPage(ctx.env, 'session-mod');
    await page.waitFor(() => page.visible('modQueue'), 'queue to load');
    const d = page.d;
    check('two section buttons, Vehicles selected by default', d.getElementById('modTabVehicles').getAttribute('aria-selected') === 'true' && d.getElementById('modTabImages').getAttribute('aria-selected') === 'false');
    check('Vehicles shows the sighting without a photo, and the registry section', page.visible('modPanelVehicles') && !page.visible('modPanelImages') && d.getElementById('modList').querySelectorAll('[data-submission-id]').length === 1 && /TEXT001/.test(page.text('modList')) && d.getElementById('modPanelVehicles').contains(d.getElementById('modVehicles')));
    check('Images holds the two photo sightings, as compact cards with a thumbnail slot', d.getElementById('modImageList').querySelectorAll('[data-submission-id]').length === 2 && d.getElementById('modImageList').querySelectorAll('img[data-sighting-photo]').length === 2 && !/PHOTO0/.test(page.text('modList')));
    check('each button shows its count', page.text('modCountVehicles') === '1' && page.text('modCountImages') === '2');
    page.click(d.getElementById('modTabImages'));
    check('the Images button switches sections', page.visible('modPanelImages') && !page.visible('modPanelVehicles') && d.getElementById('modTabImages').getAttribute('aria-selected') === 'true');
    const card = d.getElementById('modImageList').querySelector('[data-submission-id]');
    page.click(card.querySelector('button[data-action="approve"]'));
    await page.waitFor(() => d.getElementById('modImageList').querySelectorAll('[data-submission-id]').length === 1, 'the approved image to leave the grid');
    check('approving from the Images grid works like anywhere else', page.reviews().length === 1 && page.text('modCountImages') === '1');
    check('the choice is saved for next time', page.w.localStorage.getItem('moderationTab') === 'images');
  }

  t.finish();
}

run().catch(err => { console.error(err); process.exit(1); });
