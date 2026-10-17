// Tests for the moderation page's Social tab (moderation.html #modPanelSocial,
// js/moderation-social.js) and its overview route (GET
// /api/moderation/social/overview, worker/social.js). Real SQL and the REAL
// Worker; the page runs in jsdom with fetch routed into the Worker.
// Run: node tests/moderation-social-tab.test.mjs

import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { makeEnv, makeCheck } from './helpers/env.mjs';
import worker from '../worker/index.js';

const t = makeCheck();
const { check } = t;
const ROOT = new URL('..', import.meta.url).pathname;
const read = f => fs.readFileSync(`${ROOT}public/${f}`, 'utf8');
const HTML = read('moderation.html');
const PAGE_JS = `${read('js/calc.js')}\n${read('js/main.js')}\nCCC.init();\n${read('js/moderation.js')}\n${read('js/moderation-news.js')}\n${read('js/moderation-social.js')}`;
const USERS = ['alice', 'bob', 'carol', 'mod'];

async function makeApp() {
  const ctx = await makeEnv({ users: USERS });
  for (const u of USERS) await ctx.env.TESLA_SESSIONS.put(`session:s-${u}`, JSON.stringify({ user_id: u }));
  ctx.d1.exec(`UPDATE users SET display_name = 'Alice A', handle = 'alice_a' WHERE id = 'alice'`);
  ctx.d1.exec(`UPDATE users SET display_name = 'Bob B', handle = 'bob_b' WHERE id = 'bob'`);
  ctx.d1.exec(`UPDATE users SET role = 'moderator', display_name = 'Owner', handle = 'owner' WHERE id = 'mod'`);
  return ctx;
}
async function call(ctx, method, path, { session, json, form } = {}) {
  const headers = {};
  if (session) headers.Authorization = `Bearer ${session}`;
  let body;
  if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  if (form) { body = new FormData(); for (const [k, v] of Object.entries(form)) body.append(k, v); }
  const r = await worker.fetch(new Request(`https://cybercabhunter.com${path}`, { method, headers, body }), ctx.env, { waitUntil() {} });
  let out = null; try { out = await r.clone().json(); } catch (e) { /* not JSON */ }
  return { status: r.status, json: out };
}
const newPost = async (ctx, who, body) => (await call(ctx, 'POST', '/api/social/posts', { session: `s-${who}`, form: { body } })).json.post.id;
const comment = (ctx, who, postId, body) => call(ctx, 'POST', `/api/social/posts/${postId}/comments`, { session: `s-${who}`, json: { body } });
const report = (ctx, who, type, id, reason) => call(ctx, 'POST', '/api/social/reports', { session: `s-${who}`, json: { target_type: type, target_id: id, reason } });
const overview = async (ctx, who) => call(ctx, 'GET', '/api/moderation/social/overview', { session: who ? `s-${who}` : undefined });

// A small Social community: 4 posts (1 later removed), comments, reports, pins.
async function seed(ctx) {
  const p1 = await newPost(ctx, 'alice', 'Gold Cybercab on South Congress this morning');
  const p2 = await newPost(ctx, 'bob', 'Two of them charging at the Domain');
  const p3 = await newPost(ctx, 'carol', 'Buy cheap followers here');
  const p4 = await newPost(ctx, 'alice', 'Saw one on Lamar');
  const c1 = (await comment(ctx, 'bob', p1, 'Nice shot')).json.comment.id;
  await comment(ctx, 'carol', p1, 'Where exactly?');
  await comment(ctx, 'alice', p2, 'How many?');
  await report(ctx, 'alice', 'post', p3, 'spam');
  await report(ctx, 'bob', 'post', p3, 'spam');
  await report(ctx, 'carol', 'comment', c1, 'off_topic');
  await call(ctx, 'PUT', `/api/social/posts/${p1}/pin`, { session: 's-mod' });
  await call(ctx, 'PUT', `/api/social/posts/${p2}/pin`, { session: 's-mod' });
  // Both pins land in the same second; make p1 the older one so the order is fixed.
  ctx.d1.prepare(`UPDATE social_posts SET pinned_at = datetime(pinned_at, '-1 hour') WHERE id = ?`).bind(p1)._exec();
  // A post a moderator already removed: never counted.
  await call(ctx, 'DELETE', `/api/social/posts/${p4}`, { session: 's-mod' });
  return { p1, p2, p3, p4, c1 };
}

async function openPage(ctx, session, url = 'https://cybercabhunter.com/moderation.html') {
  const dom = new JSDOM(HTML, { runScripts: 'outside-only', url, pretendToBeVisual: true });
  const w = dom.window;
  w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.Element.prototype.scrollIntoView = function () {};   // not in jsdom
  w.confirm = () => true;
  w.prompt = (q, def) => def;
  if (session) w.localStorage.setItem('teslaSessionId', session);
  w.fetch = async (u, init = {}) => {
    const path = String(u).replace(/^https:\/\/[^/]+/, '');
    return worker.fetch(new Request(`https://cybercabhunter.com${path}`, init), ctx.env, { waitUntil() {} });
  };
  w.eval(PAGE_JS);
  const d = w.document;
  const page = {
    w, d,
    visible: id => !d.getElementById(id).classList.contains('hidden'),
    text: id => d.getElementById(id).textContent.replace(/\s+/g, ' ').trim(),
    click: el => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true })),
    stat: k => d.querySelector(`[data-social-stat="${k}"]`).textContent,
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
  console.log('1. The overview route: moderators only, accurate counts');
  {
    const ctx = await makeApp();
    const ids = await seed(ctx);
    check('signed out: 401', (await overview(ctx, null)).status === 401);
    check('a rider: 403, nothing returned', (await overview(ctx, 'alice')).status === 403);
    const o = (await overview(ctx, 'mod')).json;
    check('posts: the 3 shown (a removed post is not counted)', o.stats.posts === 3);
    check('comments: the 3 visible ones', o.stats.comments === 3);
    check('pending reports: 2 reported items (the queue\'s entries), 3 reports in all', o.stats.open_report_items === 2 && o.stats.open_reports === 3);
    check('pinned: 2, newest pin first, with author, excerpt and link', o.stats.pinned === 2 && o.pinned.map(p => p.id).join() === [ids.p2, ids.p1].join() && o.pinned[0].author.handle === 'bob_b' && o.pinned[1].url === `/community?post=${ids.p1}` && o.max_pins === 3);
    check('the counts match the tables', o.stats.posts === ctx.d1.query(`SELECT COUNT(*) AS n FROM social_posts WHERE status = 'visible'`)[0].n
      && o.stats.open_reports === ctx.d1.query(`SELECT COUNT(*) AS n FROM social_reports WHERE status = 'open'`)[0].n);
    check('no caching of moderator data', /no-store/.test((await worker.fetch(new Request('https://cybercabhunter.com/api/moderation/social/overview', { headers: { Authorization: 'Bearer s-mod' } }), ctx.env, {})).headers.get('Cache-Control')));
  }

  console.log('2. The page: a fourth section button, Social in its own tab');
  {
    const ctx = await makeApp();
    const ids = await seed(ctx);
    const page = await openPage(ctx, 's-mod');
    const d = page.d;
    const tabs = [...d.querySelectorAll('#modTabs [role="tab"]')];
    check('buttons: VEHICLES | IMAGES | NEWS | SOCIAL | GMAIL LINK, same style', tabs.map(b => b.textContent.trim().replace(/\s+\d+$/, '')).join(' | ') === 'VEHICLES | IMAGES | NEWS | SOCIAL | GMAIL LINK'
      && new Set(tabs.map(b => b.className)).size === 1);
    check('Social starts hidden; Vehicles is selected', !page.visible('modPanelSocial') && page.visible('modPanelVehicles') && d.getElementById('modTabSocial').getAttribute('aria-selected') === 'false');
    check('no Social section outside the Social tab', ['social-reports', 'social-announcement', 'social-pins', 'modSocialAnnouncement'].every(id => d.getElementById(id).closest('#modPanelSocial')));
    await page.waitFor(() => page.text('modCountSocial') === '2', 'report count on the button');
    check('the button shows the open report count (2)', page.text('modCountSocial') === '2');

    page.click(d.getElementById('modTabSocial'));
    await page.waitFor(() => page.stat('posts') === '3', 'overview');
    check('clicking Social shows it (and hides the rest), selected, remembered', page.visible('modPanelSocial') && !page.visible('modPanelVehicles') && !page.visible('modPanelImages') && !page.visible('modPanelNews')
      && d.getElementById('modTabSocial').getAttribute('aria-selected') === 'true' && page.w.localStorage.getItem('moderationTab') === 'social');
    check('overview: 3 posts, 3 comments, 2 pending reports (3 in all), 2 pinned', page.stat('posts') === '3' && page.stat('comments') === '3' && page.stat('open_report_items') === '2' && /3 reports in all/.test(page.text('modSocialReportDetail')) && page.stat('pinned') === '2');
    check('the reports queue: both items, reasons and history', d.querySelectorAll('#modSocialList > li').length === 2 && /Spam/.test(page.text('modSocialList')) && /Author history/.test(page.text('modSocialList')));
    check('pinned posts: both listed, with Open and Unpin', d.querySelectorAll('#modSocialPins > li').length === 2 && /2 of 3 pins in use/.test(page.text('modSocialPinsStatus'))
      && d.querySelector('#modSocialPins a').getAttribute('href') === `/community?post=${ids.p2}`);

    // Unpin through the existing pin route.
    const unpin = [...d.querySelectorAll('#modSocialPins button')].find(b => b.textContent === 'Unpin');
    page.click(unpin);
    await page.waitFor(() => page.stat('pinned') === '1', 'unpin');
    check('Unpin: the post is unpinned (same pin column the feed uses) and the list and count update', page.stat('pinned') === '1' && d.querySelectorAll('#modSocialPins > li').length === 1
      && ctx.d1.query(`SELECT pinned FROM social_posts WHERE id = ?`, ids.p2)[0].pinned === 0);

    // Dismiss one report, remove the other.
    const items = () => [...d.querySelectorAll('#modSocialList > li')];
    const dismiss = items().find(li => /Comment by/.test(li.textContent)).querySelector('button:nth-child(2)');
    page.click(dismiss);
    await page.waitFor(() => items().length === 1, 'dismiss');
    check('Dismiss: the item leaves the queue, the report is kept (dismissed), the count updates', items().length === 1 && page.text('modCountSocial') === '1'
      && ctx.d1.query(`SELECT status FROM social_reports WHERE target_id = ?`, ids.c1)[0].status === 'dismissed');
    page.click(items()[0].querySelector('button'));
    await page.waitFor(() => items().length === 0, 'remove');
    await page.waitFor(() => page.stat('posts') === '2', 'overview after remove');
    check('Remove: the post is hidden for everyone and logged; reports kept; overview recounts', ctx.d1.query(`SELECT status FROM social_posts WHERE id = ?`, ids.p3)[0].status === 'removed'
      && ctx.d1.query(`SELECT COUNT(*) AS n FROM social_reports WHERE target_id = ?`, ids.p3)[0].n === 2
      && ctx.d1.query(`SELECT COUNT(*) AS n FROM social_mod_actions WHERE action = 'remove_post' AND target_id = ?`, ids.p3)[0].n === 1
      && page.stat('posts') === '2' && page.stat('open_report_items') === '0' && page.text('modCountSocial') === '');

    // The announcement.
    await page.waitFor(() => /Current: none/.test(page.text('modSocialAnnCurrent')), 'current announcement');
    check('the current announcement is shown (none yet)', /Current: none/.test(page.text('modSocialAnnCurrent')));
    d.getElementById('modSocialAnnBody').value = 'Meetup Saturday at the Domain';
    d.getElementById('modSocialAnnouncement').dispatchEvent(new page.w.Event('submit', { cancelable: true }));
    await page.waitFor(() => /Published/.test(page.text('modSocialAnnStatus')), 'publish');
    check('Publish: stored and shown as current', /Published/.test(page.text('modSocialAnnStatus')) && /Meetup Saturday/.test(page.text('modSocialAnnCurrent'))
      && ctx.d1.query(`SELECT body FROM social_announcements`)[0].body === 'Meetup Saturday at the Domain');
    page.click(d.getElementById('modSocialAnnClear'));
    await page.waitFor(() => /Cleared/.test(page.text('modSocialAnnStatus')), 'clear');
    check('Clear: removed, current shows none', ctx.d1.query(`SELECT COUNT(*) AS n FROM social_announcements`)[0].n === 0 && /Current: none/.test(page.text('modSocialAnnCurrent')));

    // The other tabs still work.
    page.click(d.getElementById('modTabNews'));
    check('News still switches', page.visible('modPanelNews') && !page.visible('modPanelSocial'));
    page.click(d.getElementById('modTabImages'));
    check('Images still switches', page.visible('modPanelImages') && !page.visible('modPanelSocial'));
    page.click(d.getElementById('modTabVehicles'));
    check('Vehicles still switches', page.visible('modPanelVehicles') && !page.visible('modPanelSocial'));
  }

  console.log('3. The Social menu\'s "Review reports" link (moderation.html#social-reports) opens the Social tab');
  {
    const ctx = await makeApp();
    await seed(ctx);
    const page = await openPage(ctx, 's-mod', 'https://cybercabhunter.com/moderation.html#social-reports');
    await page.waitFor(() => page.stat('posts') === '3', 'overview via hash');
    check('opens on Social, with the queue loaded', page.visible('modPanelSocial') && page.d.getElementById('modTabSocial').getAttribute('aria-selected') === 'true' && page.d.querySelectorAll('#modSocialList > li').length === 2);
  }

  console.log('4. Not a moderator');
  {
    const ctx = await makeApp();
    await seed(ctx);
    const page = await openPage(ctx, 's-alice');
    await page.waitFor(() => page.visible('modForbidden'), 'forbidden');
    check('a rider gets the "not allowed" view; no Social data is loaded', page.visible('modForbidden') && page.d.querySelectorAll('#modSocialList > li').length === 0 && page.stat('posts') === '—');
    const resolve = await call(ctx, 'POST', '/api/moderation/social/resolve', { session: 's-alice', json: { target_type: 'post', target_id: '00000000-0000-4000-8000-000000000000', action: 'dismiss' } });
    const unpin = await call(ctx, 'DELETE', `/api/social/posts/00000000-0000-4000-8000-000000000000/pin`, { session: 's-alice' });
    check('and the routes refuse a rider (reports, resolve, pin)', (await call(ctx, 'GET', '/api/moderation/social/reports', { session: 's-alice' })).status === 403 && resolve.status === 403 && [403, 404].includes(unpin.status));
  }

  console.log('5. Mobile');
  {
    const tabs = HTML.slice(HTML.indexOf('id="modTabs"'), HTML.indexOf('</div>', HTML.indexOf('id="modTabs"')));
    check('the buttons wrap (flex-wrap) and keep 44px touch targets', /flex-wrap/.test(tabs) && (tabs.match(/min-h-\[44px\]/g) || []).length === 5);
    const panel = HTML.slice(HTML.indexOf('id="modPanelSocial"'), HTML.indexOf('id="modPanelGmail"'));
    check('the Social cards use the page\'s card style and phone padding; stats are 2 across on phones', (panel.match(/glass rounded-2xl p-5 mb-8 max-sm:p-4 max-sm:mb-5/g) || []).length === 4 && /grid-cols-2 lg:grid-cols-4/.test(panel));
  }

  t.finish();
}
run().catch(err => { console.error(err); process.exit(1); });
