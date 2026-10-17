// Tests for the moderation page's Gmail Link tab (moderation.html #modPanelGmail,
// js/moderation-gmail.js) and its detail route (GET /api/moderation/forwarding-detail,
// worker/moderation.js), plus the page clean-up that came with it: no Fare &
// wait card, headings in capitals. Real SQL and the REAL Worker; the page runs
// in jsdom with fetch routed into the Worker.
// Run: node tests/moderation-gmail-tab.test.mjs

import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { makeEnv, makeCheck } from './helpers/env.mjs';
import { apiModerationForwardingDetail } from '../worker/moderation.js';
import worker from '../worker/index.js';

const t = makeCheck();
const { check } = t;
const ROOT = new URL('..', import.meta.url).pathname;
const read = f => fs.readFileSync(`${ROOT}public/${f}`, 'utf8');
const HTML = read('moderation.html');
const PAGE_JS = ['js/calc.js', 'js/main.js'].map(read).join('\n') + '\nCCC.init();\n' + ['js/moderation.js', 'js/moderation-news.js', 'js/moderation-social.js', 'js/moderation-gmail.js'].map(read).join('\n');
const USERS = ['r1', 'r2', 'r3', 'r4', 'r5', 'mod'];
const NOW = Date.parse('2026-10-17T18:00:00Z');   // Oct 17, 1 PM CDT
const ago = h => new Date(NOW - h * 3600e3).toISOString().slice(0, 19).replace('T', ' ');

async function makeApp() {
  const ctx = await makeEnv({ users: USERS });   // one active forwarding address per user
  for (const u of USERS) await ctx.env.TESLA_SESSIONS.put(`session:s-${u}`, JSON.stringify({ user_id: u }));
  ctx.d1.exec(`UPDATE users SET role = 'moderator' WHERE id = 'mod'`);
  const d1 = ctx.d1;
  d1.exec(`UPDATE receipt_ingestion_addresses SET forwarding_code_received_at = '${ago(200)}' WHERE user_id IN ('r1', 'r2', 'r3')`);
  d1.exec(`UPDATE receipt_ingestion_addresses SET forwarding_link = 'https://mail-settings.google.com/mail/vf-SECRETLINK' WHERE user_id = 'r4'`);
  d1.exec(`UPDATE receipt_ingestion_addresses SET setup_completed_at = '${ago(100)}' WHERE user_id IN ('r1', 'r2')`);
  d1.exec(`UPDATE receipt_ingestion_addresses SET last_received_at = '${ago(5)}' WHERE user_id = 'r1'`);
  d1.exec(`UPDATE receipt_ingestion_addresses SET last_received_at = '${ago(300)}' WHERE user_id = 'r2'`);
  d1.exec(`UPDATE receipt_ingestion_addresses SET status = 'revoked', revoked_at = '${ago(1)}' WHERE user_id = 'r5'`);
  const rows = [['accepted', 2], ['accepted', 30], ['duplicate', 30], ['needs_review', 100], ['rejected', 200], ['parse_error', 400], ['accepted', 900]];
  rows.forEach(([status, h], i) => d1.prepare(`INSERT INTO receipt_ingestions (id, user_id, message_id, status, received_at) VALUES (?, 'r1', ?, ?, ?)`).bind(`ri-${i}`, `msg-${i}@private.example`, status, ago(h))._exec());
  d1.exec(`INSERT INTO gmail_connections (id, user_id, google_sub, email, status, backfill_completed_at, last_success_at) VALUES
    ('g1', 'r1', 'sub1', 'rider.one@private.example', 'active', '${ago(50)}', '${ago(3)}'),
    ('g2', 'r2', 'sub2', 'rider.two@private.example', 'active', NULL, '${ago(10)}'),
    ('g3', 'r3', 'sub3', 'rider.three@private.example', 'error', NULL, NULL)`);
  return ctx;
}
const detail = (ctx, who, now = NOW) => apiModerationForwardingDetail(new Request('https://x/api/moderation/forwarding-detail', { headers: who ? { Authorization: `Bearer s-${who}` } : {} }), ctx.env, now);

async function openPage(ctx, session) {
  const dom = new JSDOM(HTML, { runScripts: 'outside-only', url: 'https://cybercabhunter.com/moderation.html', pretendToBeVisual: true });
  const w = dom.window;
  w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.Element.prototype.scrollIntoView = function () {};
  if (session) w.localStorage.setItem('teslaSessionId', session);
  w.fetch = async (u, init = {}) => worker.fetch(new Request(`https://cybercabhunter.com${String(u).replace(/^https:\/\/[^/]+/, '')}`, init), ctx.env, { waitUntil() {} });
  w.eval(PAGE_JS);
  const d = w.document;
  const page = {
    w, d,
    visible: id => !d.getElementById(id).classList.contains('hidden'),
    text: id => d.getElementById(id).textContent.replace(/\s+/g, ' ').trim(),
    click: el => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true })),
    async waitFor(cond, label, ms = 3000) {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (cond()) return true; await new Promise(r => setTimeout(r, 10)); }
      console.log(`    (timed out waiting for: ${label})`);
      return false;
    }
  };
  await new Promise(r => setTimeout(r, 80));
  return page;
}

async function run() {
  console.log('1. The detail route: moderators only, aggregate counts only');
  {
    const ctx = await makeApp();
    check('signed out: 401; a rider: 403', (await detail(ctx, null)).status === 401 && (await detail(ctx, 'r1')).status === 403);
    const r = await detail(ctx, 'mod');
    const raw = await r.clone().text();
    const d = await r.json();
    check('funnel: 5 active issued, 4 confirmation received, 2 setup, 2 receiving (1 in 7 days), 1 revoked', JSON.stringify(d.funnel) === JSON.stringify({ issued: 5, confirmation_received: 4, setup_completed: 2, receiving: 2, receiving_7d: 1, revoked: 1 }));
    check('receipts: 1 in 24 h, 4 in 7 days, 6 in 30 days, 7 in all', d.receipts.last_24h === 1 && d.receipts.last_7d === 4 && d.receipts.last_30d === 6 && d.receipts.total === 7);
    check('by outcome: 3 accepted, 1 each of the rest', JSON.stringify(d.receipts.by_status) === JSON.stringify({ accepted: 3, needs_review: 1, rejected: 1, duplicate: 1, parse_error: 1 }));
    check('the last receipt time', d.receipts.last_received_at === new Date(NOW - 2 * 3600e3).toISOString().replace(/\.000Z$/, 'Z'));
    const daily = d.receipts.daily;
    check('14 Central days, oldest first, zeros included; receipts land on their Central date', daily.length === 14 && daily[13].date === '2026-10-17' && daily[0].date === '2026-10-04'
      && daily[13].n === 1 && daily.find(x => x.date === '2026-10-16').n === 2 && daily.reduce((a, x) => a + x.n, 0) === 5 && daily.find(x => x.date === '2026-10-09').n === 1);
    check('Gmail API: 2 connected, 1 needs reconnecting, 1 history imported, last sync', JSON.stringify({ ...d.gmail_api, last_success_at: undefined }) === JSON.stringify({ active: 2, error: 1, revoked: 0, backfill_done: 1 }) && !!d.gmail_api.last_success_at);
    check('no rider, address, email, link or message id in the response', !/r1|r2|rider\.|@private|SECRETLINK|u_|msg-|sub1/.test(raw));
    check('never cached', r.headers.get('Cache-Control') === 'private, no-store');
    const routed = await worker.fetch(new Request('https://x/api/moderation/forwarding-detail', { headers: { Authorization: 'Bearer s-mod' } }), ctx.env, {});
    check('routed at /api/moderation/forwarding-detail', routed.status === 200);
  }

  console.log('2. The page');
  {
    const ctx = await makeApp();
    const page = await openPage(ctx, 's-mod');
    const d = page.d;
    check('the Fare & wait card is gone (and its script)', !/Fare &amp; wait|Fare & wait/.test(HTML) && !d.getElementById('modFareReports') && !/moderation-fare-reports/.test(HTML));
    check('a GMAIL LINK button after SOCIAL, same style', d.querySelector('#modTabs [role="tab"]:last-child').id === 'modTabGmail' && page.text('modTabGmail') === 'GMAIL LINK' && d.getElementById('modTabGmail').className === d.getElementById('modTabNews').className);
    check('the Gmail linking card now lives only in the Gmail Link tab', !!d.getElementById('modForwardingStats').closest('#modPanelGmail') && !page.visible('modPanelGmail'));
    check('headings in capitals', ['RIDER GMAIL LINKING', 'APPROVED IMAGES', 'SOCIAL OVERVIEW', 'SOCIAL REPORTS', 'PINNED ANNOUNCEMENT', 'PINNED POSTS'].every(h => [...d.querySelectorAll('h2')].some(x => x.textContent.trim() === h)));
    check('the detail is not fetched until the tab opens', page.text('modGmailFunnel') === 'Loading');
    page.click(d.getElementById('modTabGmail'));
    await page.waitFor(() => d.querySelectorAll('#modGmailFunnel li').length === 5, 'detail');
    check('opening it: the panel shows, selected, the others hidden', page.visible('modPanelGmail') && !page.visible('modPanelVehicles') && !page.visible('modPanelSocial') && d.getElementById('modTabGmail').getAttribute('aria-selected') === 'true');
    await page.waitFor(() => page.visible('modForwardingStatsValues'), 'headline counts');
    check('the six headline counts are there', page.visible('modForwardingStatsValues') && d.querySelector('[data-forwarding-stat="addresses_issued"]').textContent === '5');
    check('funnel: five steps with shares of issued', /Addresses issued\s*5\s*100%/.test(page.text('modGmailFunnel')) && /Setup completed\s*2\s*40%/.test(page.text('modGmailFunnel')) && /1 address revoked/.test(page.text('modGmailRevoked')));
    check('receipts by period and outcome, with the last receipt time', /Last 24 hours\s*1/.test(page.text('modGmailReceipts')) && /All time\s*7/.test(page.text('modGmailReceipts')) && /Accepted \(ride recorded\)\s*3\s*43%/.test(page.text('modGmailOutcomes')) && /CT\.$/.test(page.text('modGmailLastReceipt')));
    check('14 daily bars with dates on the axis', d.querySelectorAll('#modGmailDaily > div').length === 14 && /\w{3} \d+\s*\w{3} \d+/.test(page.text('modGmailDailyAxis')));
    check('Gmail API connections', /Connected\s*2/.test(page.text('modGmailApi')) && /Needs reconnecting\s*1/.test(page.text('modGmailApi')) && /Last successful sync: /.test(page.text('modGmailApiLast')));
    check('no rider email or address on the page', !/@private|SECRETLINK|u_[a-z0-9]/.test(d.getElementById('modPanelGmail').textContent));
    page.click(d.getElementById('modTabVehicles'));
    check('the other tabs still switch', page.visible('modPanelVehicles') && !page.visible('modPanelGmail'));
  }

  console.log('3. A rider');
  {
    const ctx = await makeApp();
    const page = await openPage(ctx, 's-r1');
    await page.waitFor(() => page.visible('modForbidden'), 'forbidden');
    check('gets the not-allowed view and no numbers', page.visible('modForbidden') && page.text('modGmailFunnel') === 'Loading');
  }

  t.finish();
}
run().catch(err => { console.error(err); process.exit(1); });
