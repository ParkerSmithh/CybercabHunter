// Rider search on the Community page (GET /api/rider-search, worker/community.js;
// js/rider-search.js).
//   - matching: case-insensitive; names that start with the query, then names
//     that contain it, alphabetical within each; at most 8
//   - 2–40 characters, else nothing; LIKE wildcards are literal
//   - only riders with a public profile (switch on + username); a private
//     account is never returned in any form; the system account never is
//   - the response is name, @handle and photo only — never ids or emails —
//     and never the whole user list
//   - rate limited per rider or IP
//   - a private account's profile is a 404 for everyone else
//   - the page: debounce, dropdown, keyboard, "No riders found", navigation
// Real SQL (every migration) + the REAL Worker router; the page runs in jsdom.
// Run: node tests/rider-search.test.mjs

import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { makeEnv, makeCheck } from './helpers/env.mjs';
import worker from '../worker/index.js';

const t = makeCheck();
const { check } = t;
const ROOT = new URL('..', import.meta.url).pathname;
const read = f => fs.readFileSync(`${ROOT}${f}`, 'utf8');
const SYS = 'muse-system';

// [user id, display name, handle, opted in]
const PEOPLE = [
  ['bobby', 'Bobby', 'bobby_b', 1],
  ['bojack', 'Bo Jackson', 'bojack', 1],
  ['robo', 'Robo Rider', 'robo', 1],
  ['bill', 'Bill', 'bill', 1],
  ['billy', 'Billy', 'billy', 1],
  ['zoe', 'Zoe', 'zoe', 1],
  ['bobpriv', 'Bob Private', 'bob_private', 0],     // switch off: never found
  ['boris', 'Boris NoHandle', null, 1],              // no username, so no profile page
  ['nameless', null, 'bonnie_h', 1],                 // no display name: matched by username
  [SYS, 'Bot System', 'botsystem', 1]                // the Muse connector's system account
];

async function makeApp() {
  const ctx = await makeEnv({ users: PEOPLE.map(p => p[0]) });
  ctx.env.MUSE_CONNECTOR_USER_ID = SYS;
  ctx.env.ASSETS = { fetch: async () => new Response('asset') };
  for (const [id, name, handle, optIn] of PEOPLE) {
    ctx.d1.prepare(`UPDATE users SET display_name = ?, handle = ?, leaderboard_opt_in = ?, avatar_url = ? WHERE id = ?`)
      .bind(name, handle, optIn, `https://lh3.googleusercontent.com/a/${id}`, id)._exec();
    ctx.d1.prepare(`INSERT INTO google_connections (id, user_id, google_sub, email) VALUES (?, ?, ?, ?)`).bind(`g-${id}`, id, `sub-${id}`, `${id}@example.com`)._exec();
    await ctx.env.TESLA_SESSIONS.put(`session:session-${id}`, JSON.stringify({ user_id: id }));
  }
  return ctx;
}
async function search(ctx, q, { session, ip = '203.0.113.7' } = {}) {
  const headers = { 'CF-Connecting-IP': ip, ...(session ? { Authorization: `Bearer ${session}` } : {}) };
  const r = await worker.fetch(new Request(`https://x/api/rider-search?q=${encodeURIComponent(q)}`, { headers }), ctx.env, {});
  const raw = await r.text();
  let json = null; try { json = JSON.parse(raw); } catch (e) { /* not json */ }
  return { status: r.status, json, raw, r };
}
const names = res => (res.json.results || []).map(x => x.name).join(', ');

async function run() {
  console.log('1. Matching and ranking');
  {
    const ctx = await makeApp();
    const bo = await search(ctx, 'bo');
    check('"bo": starts-with first (Bo Jackson, Bobby, the username-only bonnie_h), then contains (Robo Rider)', names(bo) === 'Bo Jackson, Bobby, bonnie_h, Robo Rider', names(bo));
    check('"bo" does not return Zoe, Bill or Billy', !/Zoe|Bill/.test(names(bo)));
    check('case-insensitive: "BO" and "bO" give the same answer', names(await search(ctx, 'BO')) === names(bo) && names(await search(ctx, 'bO')) === names(bo));
    check('"bi": Bill, then Billy (alphabetical)', names(await search(ctx, 'bi')) === 'Bill, Billy');
    check('"bill" still finds both; "billy" only Billy', names(await search(ctx, 'bill')) === 'Bill, Billy' && names(await search(ctx, 'billy')) === 'Billy');
    check('"jack" (inside a name) finds Bo Jackson', names(await search(ctx, 'jack')) === 'Bo Jackson');
    check('extra spaces are ignored', names(await search(ctx, '  bo  ')) === names(bo));
    const none = await search(ctx, 'xq');
    check('no match: an empty list', none.status === 200 && none.json.results.length === 0);
  }

  console.log('2. Length limits and wildcards');
  {
    const ctx = await makeApp();
    check('empty query: nothing', (await search(ctx, '')).json.results.length === 0);
    check('one character: nothing (not even a broad match)', (await search(ctx, 'b')).json.results.length === 0 && (await search(ctx, 'o')).json.results.length === 0);
    check('over 40 characters: nothing', (await search(ctx, 'b'.repeat(41))).json.results.length === 0);
    check('"%%" and "__" are literal, not wildcards: nothing', (await search(ctx, '%%')).json.results.length === 0 && (await search(ctx, '__')).json.results.length === 0);
    for (let i = 0; i < 12; i++) {
      ctx.d1.prepare(`INSERT INTO users (id, display_name, handle, leaderboard_opt_in, profile_visibility) VALUES (?, ?, ?, 1, 'public')`).bind(`many${i}`, `Bolt ${String(i).padStart(2, '0')}`, `bolt${i}`)._exec();
    }
    const many = await search(ctx, 'bol');
    check('at most 8 results', many.json.results.length === 8 && many.json.results[0].name === 'Bolt 00');
  }

  console.log('3. Privacy: private accounts are never returned');
  {
    const ctx = await makeApp();
    const all = [];
    for (const q of ['bo', 'bob', 'bob p', 'private', 'bob_private', 'boris', 'bot', 'system', 'sys']) all.push(await search(ctx, q));
    const raw = all.map(r => JSON.stringify(r.json.results)).join('\n');   // the results, not the echoed query
    check('a private account (switch off) never appears, by name or username', !/Bob Private|bob_private/i.test(raw));
    check('...and leaves no "private account" row or count behind', all.every(r => r.json.results.every(x => x.handle)) && !/private account|Private spotter|"count"|"total"/i.test(raw));
    check('an account without a username (no profile page) never appears', !/Boris/.test(raw));
    check('the system account never appears', !/Bot System|botsystem/.test(raw));
    check('each result is name, @handle and photo — no ids, emails or anything else', all.flatMap(r => r.json.results).every(x => JSON.stringify(Object.keys(x)) === '["name","handle","avatar_url"]') && !/@example\.com|"id"|user_id|"bobby"(?!_)/.test(raw.replace(/"handle":"[^"]*"/g, '')));
    check('signed in makes no difference: still no private accounts', !/Bob Private/.test((await search(ctx, 'bob', { session: 'session-bobby' })).raw));
    ctx.d1.exec(`UPDATE users SET leaderboard_opt_in = 0 WHERE id = 'bobby'`);
    check('turning the switch off removes a rider at once (never cached)', !/Bobby/.test(names(await search(ctx, 'bo'))) && (await search(ctx, 'bo')).r.headers.get('Cache-Control') === 'no-store');
    const ever = new Set();
    for (const q of ['bo', 'bi', 'ro', 'zo', 'ja', 'ck', 'ly', 'll', 'ob', 'er']) for (const x of (await search(ctx, q)).json.results) ever.add(x.handle);
    check('the full user list never leaves the server: even a sweep of queries returns only matching public riders', [...ever].every(h => ['bojack', 'robo', 'bill', 'billy', 'zoe', 'bonnie_h'].includes(h)));
  }

  console.log('4. Rate limiting');
  {
    const ctx = await makeApp();
    const seen = [];
    ctx.env.SEARCH_LIMITER = { limit: async ({ key }) => { seen.push(key); return { success: seen.filter(k => k === key).length <= 3 }; } };
    for (let i = 0; i < 3; i++) await search(ctx, 'bo');
    const fourth = await search(ctx, 'bo');
    check('past the limit: 429 rate_limited with Retry-After', fourth.status === 429 && fourth.json.error === 'rate_limited' && fourth.r.headers.get('Retry-After') === '60');
    check('keyed by a hash, never the raw IP', seen.every(k => /^rider-search:[a-f0-9]{64}$/.test(k)) && !seen.some(k => k.includes('203.0.113.7')));
    check('another IP has its own allowance', (await search(ctx, 'bo', { ip: '198.51.100.2' })).status === 200);
    check('a signed-in rider is counted by account, not by the shared IP', (await search(ctx, 'bo', { session: 'session-zoe' })).status === 200);
    const before = seen.length;
    const short = await search(ctx, 'b');
    check('too-short queries are answered without touching the limiter', short.status === 200 && seen.length === before);
    ctx.env.SEARCH_LIMITER = { limit: async () => { throw new Error('down'); } };
    check('a limiter outage fails open', (await search(ctx, 'bo')).status === 200);
  }

  console.log('5. Profiles reached from search');
  {
    const ctx = await makeApp();
    const get = (path, session) => worker.fetch(new Request(`https://x${path}`, { headers: session ? { Authorization: `Bearer ${session}` } : {} }), ctx.env, {});
    const priv = await get('/api/riders/bob_private');
    const unknown = await get('/api/riders/nobody_here');
    check('a private account\'s profile is a 404 for a visitor, identical to an unknown username', priv.status === 404 && unknown.status === 404 && (await priv.text()) === (await unknown.text()));
    check('...and a 404 for another signed-in rider', (await get('/api/riders/bob_private', 'session-bobby')).status === 404);
    const pub = await (await get('/api/riders/bobby_b')).json();
    check('a public profile from a search result carries only public fields', pub.rider.name === 'Bobby' && !/@example\.com|"id":"bobby"|user_id|email/.test(JSON.stringify(pub)));
    ctx.d1.prepare(`INSERT INTO users (id, display_name, handle, leaderboard_opt_in, profile_visibility) VALUES ('srch', 'Sam Search', 'search', 1, 'public')`)._exec();
    check('a rider whose username is "search" still reaches their profile (the endpoint is /api/rider-search)', (await get('/api/riders/search')).status === 200 && names(await search(ctx, 'sam')) === 'Sam Search');
  }

  console.log('6. The page (jsdom)');
  {
    const ctx = await makeApp();
    const calls = [];
    const html = read('public/community.html').replace(/<script src="https?:[^"]*"><\/script>/g, '');
    const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://cybercabhunter.com/community', pretendToBeVisual: true });
    const w = dom.window, d = w.document;
    w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
    w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    w.scrollTo = () => {}; w.HTMLElement.prototype.scrollIntoView = () => {};
    w.fetch = async (url, opts = {}) => {
      const u = String(url).replace(/^https:\/\/[^/]+/, '');
      if (u.startsWith('/api/rider-search')) calls.push(u);
      if (u.startsWith('/api/')) return worker.fetch(new Request(`https://x${u}`, opts), ctx.env, {});
      return new Response('{}', { status: 404 });
    };
    w.eval(`${read('public/js/calc.js')}\n${read('public/js/main.js')}\nCCC.init();\n${read('public/js/rider-search.js')}`);
    const went = [];
    w.CCCRiderSearch.navigate = url => went.push(url);
    const input = d.getElementById('riderSearchInput');
    const list = d.getElementById('riderSearchList');
    const type = v => { input.value = v; input.dispatchEvent(new w.Event('input', { bubbles: true })); };
    const key = k => input.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const options = () => [...list.querySelectorAll('[role="option"]')];

    check('the box is labelled "Find riders" and is a combobox', d.querySelector('label[for="riderSearchInput"]').textContent === 'Find riders' && input.getAttribute('role') === 'combobox' && input.getAttribute('aria-controls') === 'riderSearchList');
    type('b');
    await wait(320);
    check('one character: no request, no list', calls.length === 0 && list.classList.contains('hidden'));
    type('bo'); await wait(80); type('bob'); await wait(80); type('bo');
    await wait(330);
    check('typing quickly sends ONE request (debounced ~250ms) for the final text', calls.length === 1 && calls[0] === '/api/rider-search?q=bo');
    check('the dropdown shows the matches with name and @username', !list.classList.contains('hidden') && options().length === 4 && /Bo Jackson/.test(options()[0].textContent) && /@bojack/.test(options()[0].textContent) && input.getAttribute('aria-expanded') === 'true');
    check('each suggestion has an avatar', options().every(o => o.querySelector('span.w-8')));
    key('ArrowDown'); key('ArrowDown');
    check('arrow keys move the highlight', options()[1].getAttribute('aria-selected') === 'true' && input.getAttribute('aria-activedescendant') === options()[1].id);
    key('ArrowUp');
    check('...up as well', options()[0].getAttribute('aria-selected') === 'true');
    key('Enter');
    check('Enter opens that rider\'s profile', went[0] === '/rider/bojack');
    key('Escape');
    check('Escape closes the list', list.classList.contains('hidden') && input.getAttribute('aria-expanded') === 'false');
    input.dispatchEvent(new w.Event('focus'));
    check('focusing the box again reopens it', !list.classList.contains('hidden'));
    options()[1].dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    check('clicking a suggestion opens that profile', went[1] === '/rider/bobby_b');
    d.body.dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true }));
    check('a click outside closes the list', list.classList.contains('hidden'));
    type('xq');
    await wait(330);
    check('"No riders found" when nothing matches', !list.classList.contains('hidden') && list.textContent.trim() === 'No riders found' && options().length === 0);
    type('bob p');
    await wait(330);
    check('searching for a private account shows "No riders found", nothing about them', list.textContent.trim() === 'No riders found' && !/Bob Private/.test(list.innerHTML));
    type('a');
    check('back under 2 characters: the list closes', list.classList.contains('hidden'));
    w.close();
  }

  console.log('7. Wiring');
  {
    check('a SEARCH_LIMITER rate-limit binding is configured', /"name": "SEARCH_LIMITER"/.test(read('wrangler.jsonc')));
    check('the Community page loads the search script', /<script src="js\/rider-search\.js[^"]*"><\/script>/.test(read('public/community.html')));
  }

  t.finish();
}

run().catch(e => { console.error(e); process.exit(1); });
