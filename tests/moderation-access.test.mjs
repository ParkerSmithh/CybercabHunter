// The production path to the moderator page: https://cybercabhunter.com/moderation.
//   - signed out -> the page's Sign In goes through the EXISTING sign-in page/Google flow with a return page
//   - the Worker returns the visitor to that page (never anywhere off-site) instead of the home page
//   - moderators get a "Moderation" link in the account menu; nobody else does
//   - the backend stays the only authority: the moderation APIs still refuse non-moderators
// Real Worker router + real SQL; the front end runs in jsdom. Google's own endpoints are the only thing stubbed.
// Run: node tests/moderation-access.test.mjs

import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { makeEnv, makeCheck } from './helpers/env.mjs';
import worker from '../worker/index.js';
import { sanitizeReturnPath } from '../worker/google-auth.js';

const t = makeCheck();
const { check } = t;
const ROOT = new URL('..', import.meta.url).pathname;
const read = f => fs.readFileSync(`${ROOT}${f}`, 'utf8');
const CALC = read('js/calc.js'), MAIN = read('js/main.js'), MOD = read('js/moderation.js');
const WORKER_ORIGIN = 'https://cybercabhunter.contactjoeclos.workers.dev';

async function makeApp() {
  const ctx = await makeEnv({ users: ['mod', 'rider'] });
  ctx.d1.exec("UPDATE users SET role = 'moderator' WHERE id = 'mod'");
  for (const u of ['mod', 'rider']) await ctx.env.TESLA_SESSIONS.put(`session:session-${u}`, JSON.stringify({ user_id: u }));
  ctx.env.ASSETS = { fetch: async () => new Response('static asset', { status: 404 }) };   // anything the Worker does not handle falls through to static files
  Object.assign(ctx.env, { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'secret', GOOGLE_REDIRECT_URI: 'https://cybercabhunter.com/oauth/google/callback' });
  return ctx;
}
const call = (ctx, path, headers = {}, init = {}) => worker.fetch(new Request(`https://x${path}`, { ...init, headers: { Origin: 'https://cybercabhunter.com', ...headers } }), ctx.env, {});
const as = u => ({ Authorization: `Bearer session-${u}` });

// Runs a page's real scripts in jsdom, with API calls routed into the real Worker.
async function openPage(ctx, file, { url, session, scripts } = {}) {
  const dom = new JSDOM(read(file), { runScripts: 'outside-only', url, pretendToBeVisual: true });
  const w = dom.window;
  w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  if (session) w.localStorage.setItem('teslaSessionId', session);
  const requests = [];
  w.fetch = async (u, init = {}) => {
    const path = String(u).replace(WORKER_ORIGIN, '');
    requests.push({ path, method: init.method || 'GET' });
    return worker.fetch(new Request(`https://x${path}`, { ...init, headers: { Origin: 'https://cybercabhunter.com', ...(init.headers || {}) } }), ctx.env, {});
  };
  w.eval(scripts || `${CALC}\n${MAIN}\nCCC.init();`);
  await new Promise(r => setTimeout(r, 80));
  return { w, d: w.document, requests, visible: id => !w.document.getElementById(id).classList.contains('hidden') };
}

// The page's own inline <script> (jsdom does not run inline scripts by itself here).
const inlineScript = (file, needle) => [...read(file).matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).find(x => x.includes(needle));

async function run() {
  console.log('1. Return path validation: only a same-site path is ever accepted');
  {
    const ok = { '/moderation': '/moderation', '/moderation?x=1': '/moderation?x=1', '/moderation#frag': '/moderation', '/rider-data.html': '/rider-data.html' };
    for (const [input, out] of Object.entries(ok)) check(`accepts ${input}`, sanitizeReturnPath(input) === out);
    const bad = ['https://evil.example', 'http://evil.example/moderation', '//evil.example', '//evil.example/moderation', '/\\evil.example', '\\\\evil.example', '/\tevil.example', '/\nevil.example', '/ evil.example', '/.//evil.example',
      'javascript:alert(1)', 'moderation', '', null, undefined, 42, {}, ['/moderation'], '/' + 'a'.repeat(300), '/api/me', '/oauth/google/start', '/api', 'data:text/html,x', '/\u0000x'];
    for (const input of bad) check(`rejects ${JSON.stringify(input)}`, sanitizeReturnPath(input) === null);
  }

  console.log('2. Sign-in round trip through the real Worker: back to /moderation, never off-site');
  {
    const ctx = await makeApp();
    const realFetch = globalThis.fetch;
    globalThis.fetch = async u => {
      const s = String(u);
      if (s.startsWith('https://oauth2.googleapis.com/token')) return Response.json({ access_token: 'at' });
      if (s.startsWith('https://www.googleapis.com/oauth2/v3/userinfo')) return Response.json({ sub: 'g-1', email: 'm@example.com', name: 'Mod Erator' });
      throw new Error('unexpected network call: ' + s);
    };
    try {
      const signIn = async returnTo => {
        const start = await call(ctx, `/oauth/google/start${returnTo === undefined ? '' : '?returnTo=' + encodeURIComponent(returnTo)}`);
        const state = new URL(start.headers.get('Location')).searchParams.get('state');
        const cb = await call(ctx, `/oauth/google/callback?code=abc&state=${state}`);
        return { start, state, cb, location: cb.headers.get('Location') };
      };

      let r = await signIn('/moderation');
      check('start redirects to Google and does not pass the return page to Google', r.start.status === 302 && r.start.headers.get('Location').startsWith('https://accounts.google.com/') && !r.start.headers.get('Location').includes('moderation'));
      check('the callback returns to /moderation on the production domain', r.location.startsWith('https://cybercabhunter.com/moderation?signin=success#tesla_session='));
      const sid = r.location.split('#tesla_session=')[1];
      check('the session it hands back is a real session', !!(await ctx.env.TESLA_SESSIONS.get(`session:${sid}`)));
      check('the state was single-use', (await ctx.env.TESLA_SESSIONS.get(`google_state:${r.state}`)) === null);

      r = await signIn('/moderation?tab=vehicles');
      check('an existing query string is kept alongside signin=success', r.location.startsWith('https://cybercabhunter.com/moderation?tab=vehicles&signin=success#tesla_session='));

      r = await signIn(undefined);
      check('no return page: the home page, exactly as before', r.location.startsWith('https://cybercabhunter.com/?signin=success#tesla_session='));

      for (const evil of ['https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)', '/api/me']) {
        r = await signIn(evil);
        check(`a hostile returnTo (${evil}) is ignored: the visitor lands on the home page`, r.location.startsWith('https://cybercabhunter.com/?signin=success#tesla_session='));
      }

      // Defense in depth: even if a bad value were somehow in the state store, the callback would not follow it.
      for (const planted of ['//evil.example', 'https://evil.example/x', '/\\evil.example']) {
        await ctx.env.TESLA_SESSIONS.put('google_state:planted', planted);
        const cb = await call(ctx, '/oauth/google/callback?code=abc&state=planted');
        check(`a planted state value (${planted}) is not followed`, cb.headers.get('Location').startsWith('https://cybercabhunter.com/?signin=success#'));
      }
      const cancelled = await call(ctx, '/oauth/google/callback?error=access_denied&state=x');
      check('a cancelled sign-in still goes to the home page with signin=cancelled', cancelled.headers.get('Location') === 'https://cybercabhunter.com/?signin=cancelled');
    } finally { globalThis.fetch = realFetch; }
  }

  console.log('3. Pages: the sign-in flow carries the return page');
  {
    const ctx = await makeApp();
    const mod = await openPage(ctx, 'moderation.html', { url: 'https://cybercabhunter.com/moderation', scripts: `${CALC}\n${MAIN}\nCCC.init();\n${MOD}` });
    const signInLink = mod.d.querySelector('#modSignedOut a');
    check('signed out: /moderation shows the sign-in prompt', mod.visible('modSignedOut') && !mod.visible('modQueue'));
    check('its Sign In goes to the existing sign-in page and asks to come back to /moderation', /^signin\.html\?returnTo=%2Fmoderation$/.test(signInLink.getAttribute('href')));

    const SIGNIN_SCRIPT = `${CALC}\n${MAIN}\n${inlineScript('signin.html', 'signInGoogle')}`;
    const sign = await openPage(ctx, 'signin.html', { url: 'https://cybercabhunter.com/signin?returnTo=%2Fmoderation', scripts: SIGNIN_SCRIPT });
    const google = sign.d.getElementById('signInGoogle');
    check('the sign-in page passes the return page to the Worker\'s Google start', google.getAttribute('href') === `${WORKER_ORIGIN}/oauth/google/start?returnTo=%2Fmoderation`);
    for (const evil of ['https%3A%2F%2Fevil.example', '%2F%2Fevil.example', '%2F%5Cevil.example']) {
      const p = await openPage(ctx, 'signin.html', { url: `https://cybercabhunter.com/signin?returnTo=${evil}`, scripts: SIGNIN_SCRIPT });
      check(`a hostile returnTo (${decodeURIComponent(evil)}) is not passed on`, p.d.getElementById('signInGoogle').getAttribute('href') === `${WORKER_ORIGIN}/oauth/google/start`);
    }
    const plain = await openPage(ctx, 'signin.html', { url: 'https://cybercabhunter.com/signin', scripts: SIGNIN_SCRIPT });
    check('with no returnTo the sign-in page is unchanged', plain.d.getElementById('signInGoogle').getAttribute('href') === `${WORKER_ORIGIN}/oauth/google/start`);
  }

  console.log('4. After sign-in the moderation page opens for a moderator and stays closed for everyone else');
  {
    const ctx = await makeApp();
    // Exactly what the callback redirects to: /moderation?signin=success#tesla_session=<id>
    const landing = who => openPage(ctx, 'moderation.html', { url: `https://cybercabhunter.com/moderation?signin=success#tesla_session=session-${who}`, scripts: `${CALC}\n${MAIN}\nCCC.init();\n${MOD}` });
    const m = await landing('mod');
    check('the session from the sign-in redirect is stored', m.w.localStorage.getItem('teslaSessionId') === 'session-mod');
    check('a moderator sees the moderation page', m.visible('modQueue') && !m.visible('modForbidden') && !m.visible('modSignedOut'));
    check('the address bar is scrubbed of the session id', !m.w.location.href.includes('tesla_session') && m.w.location.pathname === '/moderation');
    const r = await landing('rider');
    check('an ordinary signed-in user is shown "Not authorized"', r.visible('modForbidden') && !r.visible('modQueue'));
  }

  console.log('5. The backend is still the authority: moderation APIs refuse non-moderators');
  {
    const ctx = await makeApp();
    for (const path of ['/api/moderation/vehicle-sightings', '/api/moderation/robotaxi-vehicles']) {
      check(`${path}: no session -> 401`, (await call(ctx, path)).status === 401);
      check(`${path}: ordinary user -> 403`, (await call(ctx, path, as('rider'))).status === 403);
      check(`${path}: moderator -> 200`, (await call(ctx, path, as('mod'))).status === 200);
    }
    const write = await call(ctx, '/api/moderation/robotaxi-vehicles/00000000-0000-4000-8000-000000000000/review', { ...as('rider'), 'Content-Type': 'application/json' }, { method: 'POST', body: JSON.stringify({ action: 'approve_public' }) });
    check('an ordinary user cannot use the review action', write.status === 403);
    check('a forged role in the request body/query changes nothing', (await call(ctx, '/api/moderation/robotaxi-vehicles?role=moderator&is_moderator=true', { ...as('rider'), 'X-Role': 'moderator' })).status === 403);
  }

  console.log('6. /api/moderation/access reports only the caller\'s own status');
  {
    const ctx = await makeApp();
    check('signed out -> 401', (await call(ctx, '/api/moderation/access')).status === 401);
    check('a bad session -> 401', (await call(ctx, '/api/moderation/access', { Authorization: 'Bearer nope' })).status === 401);
    let resp = await call(ctx, '/api/moderation/access', as('rider'));
    let body = await resp.json();
    check('an ordinary user -> 200 moderator:false (no error on every page load)', resp.status === 200 && body.moderator === false && body.authenticated === true);
    resp = await call(ctx, '/api/moderation/access', as('mod'));
    body = await resp.json();
    check('a moderator -> 200 moderator:true', resp.status === 200 && body.moderator === true);
    check('the response carries nothing else about the account', Object.keys(body).sort().join() === 'authenticated,moderator');
    check('/api/me still reveals no role', !('role' in (await (await call(ctx, '/api/me', as('mod'))).json()).user));
    ctx.d1.exec("UPDATE users SET role = 'user' WHERE id = 'mod'");
    check('the role is read from the database each time (demotion takes effect at once)', (await (await call(ctx, '/api/moderation/access', as('mod'))).json()).moderator === false);
    check('it accepts GET only', (await call(ctx, '/api/moderation/access', as('mod'), { method: 'POST' })).status !== 200);
  }

  console.log('7. Account menu: a Moderation link for moderators only, beside Profile and Rider Data');
  {
    const ctx = await makeApp();
    const pages = fs.readdirSync(ROOT).filter(f => f.endsWith('.html') && read(f).includes('id="accountDrawer"'));
    check('several pages have the account menu', pages.length >= 6);
    for (const file of pages) {
      const m = await openPage(ctx, file, { url: `https://cybercabhunter.com/${file}`, session: 'session-mod' });
      const link = m.d.getElementById('accountMenuModeration');
      check(`${file}: a moderator gets the link, pointing at /moderation`, !!link && link.getAttribute('href') === '/moderation' && /Moderation/.test(link.textContent));
      const r = await openPage(ctx, file, { url: `https://cybercabhunter.com/${file}`, session: 'session-rider' });
      check(`${file}: an ordinary user does not`, r.d.getElementById('accountMenuModeration') === null && !/Moderation/i.test(r.d.getElementById('accountDrawer').textContent));
    }
    const s = await openPage(ctx, 'index.html', { url: 'https://cybercabhunter.com/', session: null });
    check('signed out: no link and no moderation request', s.d.getElementById('accountMenuModeration') === null && !s.requests.some(x => x.path.includes('/api/moderation')));
    const bad = await openPage(ctx, 'index.html', { url: 'https://cybercabhunter.com/', session: 'stale-session' });
    check('a stale session: no link and no moderation request', bad.d.getElementById('accountMenuModeration') === null && !bad.requests.some(x => x.path.includes('/api/moderation')));

    const m = await openPage(ctx, 'index.html', { url: 'https://cybercabhunter.com/', session: 'session-mod' });
    const hrefs = [...m.d.querySelectorAll('#accountDrawer a')].map(a => a.getAttribute('href'));
    check('it sits with the other account links (Profile, Rider Data, Moderation)', hrefs.join() === 'profile.html,rider-data.html,/moderation');
    const rider = m.d.querySelector('#accountDrawer a[href="rider-data.html"]'), mod = m.d.getElementById('accountMenuModeration');
    check('it uses the same styling as the other links', mod.className === rider.className);
    check('the Profile and Rider Data links are unchanged', hrefs[0] === 'profile.html' && hrefs[1] === 'rider-data.html');

    // A failing or odd answer never produces a link.
    for (const [label, reply] of [['a server error', () => new Response('{}', { status: 500 })], ['moderator:"true" (a string)', () => Response.json({ authenticated: true, moderator: 'true' })], ['not JSON', () => new Response('nope', { status: 200 })]]) {
      const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', url: 'https://cybercabhunter.com/', pretendToBeVisual: true });
      const w = dom.window; w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
      w.localStorage.setItem('teslaSessionId', 'session-mod');
      w.fetch = async u => (String(u).includes('/api/moderation/access') ? reply() : worker.fetch(new Request(`https://x${String(u).replace(WORKER_ORIGIN, '')}`, { headers: { Authorization: 'Bearer session-mod', Origin: 'https://cybercabhunter.com' } }), ctx.env, {}));
      w.eval(`${CALC}\n${MAIN}\nCCC.init();`);
      await new Promise(r => setTimeout(r, 80));
      check(`${label}: no link`, w.document.getElementById('accountMenuModeration') === null);
    }
  }

  console.log('8. Sign out and the other account pages still work');
  {
    const ctx = await makeApp();
    const m = await openPage(ctx, 'index.html', { url: 'https://cybercabhunter.com/', session: 'session-mod' });
    check('the moderator is shown as signed in', m.visible('accountSignedIn') && !m.visible('accountSignedOut'));
    m.d.getElementById('accountMenuSignOut').click();
    await new Promise(r => setTimeout(r, 60));
    check('Sign out clears the stored session', m.w.localStorage.getItem('teslaSessionId') === null);
    check('Sign out calls the existing disconnect endpoint', m.requests.some(x => x.method === 'POST' && x.path === '/oauth/tesla/disconnect'));
    check('the session is really gone server-side: the moderation APIs now answer 401', (await call(ctx, '/api/moderation/access', as('mod'))).status === 401);

    const ctx2 = await makeApp();
    const profile = await call(ctx2, '/api/profile', as('rider'));
    check('Profile still works', profile.status === 200);
    const rides = await call(ctx2, '/api/trips?page=1&page_size=10', as('rider'));
    check('Rider Data\'s API still works', rides.status === 200 && (await call(ctx2, '/api/me', as('rider'))).status === 200);
    const rd = await openPage(ctx2, 'rider-data.html', { url: 'https://cybercabhunter.com/rider-data', session: 'session-rider', scripts: `${CALC}\n${MAIN}\nCCC.init();\n${read('js/rider-data.js')}` });
    check('the Rider Data page still loads for a signed-in rider', rd.visible('dataSignedIn'));
    const prof = await openPage(ctx2, 'profile.html', { url: 'https://cybercabhunter.com/profile', session: 'session-rider' });
    check('the Profile page still loads for a signed-in rider', prof.visible('accountSignedIn'));
  }

  console.log('9. Routing: /moderation is served by the existing static page, with no duplicate page');
  {
    const htmls = fs.readdirSync(ROOT).filter(f => f.endsWith('.html'));
    check('exactly one moderation page exists', htmls.filter(f => /moderation/i.test(f)).join() === 'moderation.html');
    check('the Worker adds no route of its own for the page (Cloudflare static assets serve /moderation from moderation.html)', !/['"`]\/moderation['"`]/.test(read('worker/index.js')));
    check('the page is not excluded from the static assets', !/moderation/i.test(read('.assetsignore')));
    check('the account link and the sign-in return both use the canonical path /moderation', /setAttribute\('href', '\/moderation'\)/.test(MAIN) && /returnTo=%2Fmoderation/.test(read('moderation.html')));
  }

  t.finish();
}

run().catch(err => { console.error(err); process.exit(1); });
