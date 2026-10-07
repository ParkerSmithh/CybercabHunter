// Link Gmail page (/link-gmail): the rider's forwarding address, the Gmail
// confirmation code, live status, and "get a new address". The REAL
// js/link-gmail.js runs in jsdom against the REAL Worker code and real SQL
// (node:sqlite + the project's migrations); fetch() is routed straight into
// worker.fetch, and mail arrives through the real handleIncomingEmail.
// Also: the Rider Data entry point and the /link-gmail route.
// Layout/CSS is not exercised (jsdom has no renderer).
// Run: node tests/link-gmail-ui.test.mjs

import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { makeEnv, makeCheck } from './helpers/env.mjs';
import { receiptBody, eml, inboundMessage } from './helpers/receipts.mjs';
import { handleIncomingEmail } from '../worker/receipt-ingestion.js';
import worker from '../worker/index.js';

const t = makeCheck();
const { check } = t;
const ROOT = new URL('..', import.meta.url).pathname;
const HTML = fs.readFileSync(`${ROOT}public/link-gmail.html`, 'utf8');
const JS = fs.readFileSync(`${ROOT}public/js/link-gmail.js`, 'utf8');
const WORKER_ORIGIN = 'https://cybercabhunter.contactjoeclos.workers.dev';
const CONFIRMATION = { from: 'forwarding-noreply@google.com', subject: 'Gmail Forwarding Confirmation - Receive Mail from rider@gmail.com', body: 'Confirmation code: 482913775' };

async function makeApp({ users = ['u1'] } = {}) {
  const ctx = await makeEnv({ users });
  for (const u of users) await ctx.env.TESLA_SESSIONS.put(`session:session-${u}`, JSON.stringify({ user_id: u }));
  ctx.env.ASSETS = { fetch: req => new Response('asset:' + new URL(req.url).pathname) };
  ctx.tokenOf = userId => ctx.d1.query("SELECT opaque_token FROM receipt_ingestion_addresses WHERE user_id = ? AND status = 'active'", userId)[0].opaque_token;
  ctx.mailTo = async (to, opts) => handleIncomingEmail(inboundMessage(eml({ ...opts, to }), to), ctx.env);
  ctx.email = async (userId, opts) => ctx.mailTo(`u_${ctx.tokenOf(userId)}@${ctx.env.RECEIPT_DOMAIN}`, opts);
  return ctx;
}

const opened = [];
// Opens the page as `userId` (null = signed out). `intercept(path, init)` may
// return a Response to simulate a failing server.
async function openPage(ctx, userId, { intercept, clipboard, search = '', storage = {} } = {}) {
  const dom = new JSDOM(HTML, { runScripts: 'outside-only', url: 'https://cybercabhunter.com/link-gmail' + search, pretendToBeVisual: true });
  const w = dom.window;
  opened.push(w);
  w.scrollTo = () => {};   // jsdom has no layout
  if (userId) w.localStorage.setItem('teslaSessionId', `session-${userId}`);
  for (const [k, v] of Object.entries(storage)) w.localStorage.setItem(k, v);
  const copied = [];
  if (clipboard !== false) Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: async s => { copied.push(s); } }, configurable: true });
  const requests = [];
  w.fetch = async (url, init = {}) => {
    const path = String(url).replace(WORKER_ORIGIN, '');
    requests.push({ method: init.method || 'GET', path, auth: (init.headers || {}).Authorization });
    if (intercept) { const r = await intercept(path, init); if (r) return r; }
    return worker.fetch(new Request(`https://x${path}`, { ...init, headers: { Origin: 'https://cybercabhunter.com', ...(init.headers || {}) } }), ctx.env, {});
  };
  w.eval(JS);
  const d = w.document;
  const page = {
    w, d, requests, copied,
    $: id => d.getElementById(id),
    text: id => d.getElementById(id).textContent.replace(/\s+/g, ' ').trim(),
    visible: id => !d.getElementById(id).classList.contains('hidden'),
    click: el => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true })),
    choose: value => {
      const input = d.querySelector(`input[name="lgMethod"][value="${value}"]`);
      input.checked = true;
      input.dispatchEvent(new w.Event('change', { bubbles: true }));
    },
    submitChoice: () => d.getElementById('lgChoose').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })),
    method: () => new URL(w.location.href).searchParams.get('method'),
    async waitFor(cond, label, ms = 3000) {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (cond()) return true; await new Promise(r => setTimeout(r, 10)); }
      console.log(`    (timed out waiting for: ${label})`);
      return false;
    },
    // Click "check now" and wait for the round trip to finish.
    async refresh() {
      const before = requests.length;
      page.click(page.$('lgRefresh'));
      await page.waitFor(() => requests.length > before && !page.$('lgRefresh').disabled, 'refresh');
    }
  };
  if (userId) await page.waitFor(() => page.visible('lgReady') || page.visible('lgError') || page.visible('lgSignedOut'), 'page to load');
  return page;
}

async function run() {
  console.log('1. Signed out');
  {
    const ctx = await makeApp();
    const page = await openPage(ctx, null);
    check('no session: the sign-in prompt is shown, nothing else', page.visible('lgSignedOut') && !page.visible('lgReady') && !page.visible('lgLoading'));
    check('...and no request is made', page.requests.length === 0);
    const signIn = page.d.querySelector('#lgSignedOut a');
    check('Sign In brings the rider back here afterwards', signIn.getAttribute('href') === 'signin.html?returnTo=%2Flink-gmail');

    const expired = await openPage(ctx, 'ghost');
    check('an expired session is shown as signed out, not as an error', expired.visible('lgSignedOut') && !expired.visible('lgError'));
  }

  console.log('2. The forwarding address');
  {
    const ctx = await makeApp();
    const page = await openPage(ctx, 'u1');
    check('the page loads into the ready view', page.visible('lgReady'));
    check('the full address is shown', page.text('lgAddress') === ctx.addressFor('u1'));
    check('every request carries only the rider\'s own session', page.requests.every(r => r.auth === 'Bearer session-u1'));
    check('the "treat it like a password" warning is shown', /Treat this address like a password/.test(page.text('lgAddressReady')));
    const copyButtons = [...page.d.querySelectorAll('[data-copy="address"]')];
    check('every "Copy address" button is enabled', copyButtons.length >= 3 && copyButtons.every(b => !b.disabled));
    page.click(copyButtons[0]);
    await page.waitFor(() => copyButtons[0].querySelector('[data-copy-label]').textContent === 'Copied', 'copy');
    check('Copy puts the exact address on the clipboard', page.copied[0] === ctx.addressFor('u1'));
    check('...and says so', copyButtons[0].querySelector('[data-copy-label]').textContent === 'Copied');
    page.click(page.d.querySelector('[data-copy="tesla.com"]'));
    await page.waitFor(() => page.copied.length === 2, 'copy filter text');
    check('the filter text (tesla.com) can be copied too', page.copied[1] === 'tesla.com');
  }

  console.log('3. Status and the Gmail confirmation code, without reloading the page');
  {
    const ctx = await makeApp();
    const page = await openPage(ctx, 'u1');
    check('before anything arrives: "Not receiving yet"', page.visible('lgStateOff') && !page.visible('lgStateOn'));
    check('step 3 waits for Gmail\'s code', page.visible('lgCodeWaiting') && !page.visible('lgCodeShown'));
    check('totals start at 0 and the last receipt is "Never"', page.text('lgProcessed') === '0' && page.text('lgAdded') === '0' && page.text('lgLastReceived') === 'Never');

    await ctx.email('u1', CONFIRMATION);
    await page.refresh();
    check('Gmail\'s code appears on the page', page.visible('lgCodeShown') && page.text('lgCode') === '482913775');
    check('...and the waiting message goes away', !page.visible('lgCodeWaiting'));
    page.click(page.d.querySelector('[data-copy="code"]'));
    await page.waitFor(() => page.copied.length === 1, 'copy code');
    check('the code can be copied', page.copied[0] === '482913775');
    check('a code alone does not mean receipts are arriving', page.visible('lgStateOff'));

    await ctx.email('u1', { body: receiptBody() });
    await page.refresh();
    check('after a real receipt: "Receiving receipts"', page.visible('lgStateOn') && !page.visible('lgStateOff'));
    // "Emails processed" counts every message read, Gmail's confirmation included.
    check('...the totals show it (2 emails processed, 1 ride added)', page.text('lgProcessed') === '2' && page.text('lgAdded') === '1');
    check('...the last receipt time is filled in', page.text('lgLastReceived') !== 'Never');
    check('...and step 3 shows forwarding as confirmed', page.visible('lgCodeDone') && !page.visible('lgCodeShown') && !page.visible('lgCodeWaiting'));

    await ctx.email('u1', { body: receiptBody() });
    await page.refresh();
    check('forwarding the same receipt again is a duplicate, not a second ride', page.text('lgAdded') === '1' && page.text('lgDuplicates') === '1');

    const before = page.requests.length;
    page.d.dispatchEvent(new page.w.Event('visibilitychange'));
    await page.waitFor(() => page.requests.length > before, 'refresh on return to tab');
    check('coming back to the tab re-checks the status', page.requests.slice(before).some(r => r.path === '/api/rides/sync-status'));
  }

  console.log('4. Only the signed-in rider\'s own address and status');
  {
    const ctx = await makeApp({ users: ['u1', 'u2'] });
    await ctx.email('u1', CONFIRMATION);
    await ctx.email('u1', { body: receiptBody() });
    const page = await openPage(ctx, 'u2');
    check('u2 sees their own address', page.text('lgAddress') === ctx.addressFor('u2'));
    check('...never u1\'s address', !page.d.body.textContent.includes(ctx.addressFor('u1')));
    check('...nor u1\'s status', page.visible('lgStateOff') && page.text('lgProcessed') === '0' && page.visible('lgCodeWaiting'));
  }

  console.log('5. Get a new address');
  {
    const ctx = await makeApp();
    await ctx.email('u1', CONFIRMATION);
    const page = await openPage(ctx, 'u1');
    const oldAddress = page.text('lgAddress');
    page.click(page.$('lgRotateOpen'));
    check('asking first: the confirmation explains the old address stops working', page.visible('lgRotateConfirm') && /stops working immediately/.test(page.text('lgRotateConfirm')));
    page.click(page.$('lgRotateCancel'));
    check('"Keep this one" closes it and changes nothing', !page.visible('lgRotateConfirm') && page.text('lgAddress') === oldAddress && !page.requests.some(r => r.method === 'POST'));

    page.click(page.$('lgRotateOpen'));
    page.click(page.$('lgRotateConfirmBtn'));
    await page.waitFor(() => page.visible('lgRotateNotice'), 'rotate');
    const newAddress = page.text('lgAddress');
    check('a new address is shown', newAddress !== oldAddress && newAddress === `u_${ctx.tokenOf('u1')}@${ctx.env.RECEIPT_DOMAIN}`);
    check('...with a note to update Gmail', /old one no longer works/.test(page.text('lgRotateNotice')));
    await page.waitFor(() => page.visible('lgCodeWaiting'), 'status after rotate');
    check('...and the old address\'s confirmation code is gone', !page.visible('lgCodeShown'));
    page.click(page.d.querySelector('[data-copy="address"]'));
    await page.waitFor(() => page.copied.length === 1, 'copy');
    check('Copy now gives the new address', page.copied[0] === newAddress);

    await ctx.mailTo(oldAddress, { body: receiptBody() });
    check('mail to the old address no longer adds a ride', ctx.d1.query("SELECT COUNT(*) AS n FROM trips WHERE user_id = 'u1'")[0].n === 0);
  }

  console.log('6. No receipt domain configured: "coming soon"');
  {
    const ctx = await makeApp();
    ctx.env.RECEIPT_DOMAIN = '';
    const page = await openPage(ctx, 'u1');
    check('the address section says "Coming soon"', page.visible('lgAddressPending') && !page.visible('lgAddressReady'));
    check('...and no address is offered for copying', [...page.d.querySelectorAll('[data-copy="address"]')].every(b => b.disabled));
    check('...nor shown anywhere on the page', !/u_[0-9a-f]{8,}/.test(page.d.body.textContent));
  }

  console.log('7. Errors are not "signed out"');
  {
    const ctx = await makeApp();
    let fail = true;
    const page = await openPage(ctx, 'u1', { intercept: path => (fail && path === '/api/rides/sync-status' ? new Response('{}', { status: 500 }) : null) });
    check('a server error shows the error view with its code', page.visible('lgError') && !page.visible('lgSignedOut') && /code 500/.test(page.text('lgErrorDetail')));
    fail = false;
    page.click(page.$('lgRetry'));
    await page.waitFor(() => page.visible('lgReady'), 'retry');
    check('Try again recovers', page.visible('lgReady') && page.text('lgAddress') === ctx.addressFor('u1'));
    fail = true;
    await page.refresh();
    check('a failed background check keeps the page and says so quietly', page.visible('lgReady') && page.visible('lgStatusError'));
  }

  console.log('8. Entry points and the route');
  {
    const ctx = await makeApp();
    const route = await worker.fetch(new Request('https://x/link-gmail'), ctx.env, {});
    check('/link-gmail is served from the static site (link-gmail.html)', (await route.text()) === 'asset:/link-gmail');
    const rider = fs.readFileSync(`${ROOT}public/rider-data.html`, 'utf8');
    check('Rider Data has one "Link Gmail" button pointing at the setup page', (rider.match(/id="linkGmailBtn"/g) || []).length === 1 && /id="linkGmailBtn" href="\/link-gmail"/.test(rider));
    check('Rider Data does not hold the forwarding setup itself', !/lgAddress|Forwarding and POP\/IMAP/.test(rider));
  }

  console.log('9. Copy');
  {
    const text = new JSDOM(HTML).window.document.body.textContent;
    check('no em or en dashes anywhere on the page', !/[–—]/.test(HTML) && !/[–—]/.test(JS));
    const options = [...new JSDOM(HTML).window.document.querySelectorAll('#lgChoose input[name="lgMethod"]')].map(i => i.value);
    check('the question offers "Forward automatically" first, then "Forward each receipt"', options.join() === 'auto,manual');
    check('the backfill says duplicates are handled', /never counted twice/.test(text));
  }

  console.log('10. Step 1: "How do you want to send your receipts?"');
  {
    const ctx = await makeApp();
    const page = await openPage(ctx, 'u1');
    check('arriving on the page asks the question first; no setup is shown yet', page.visible('lgChoose') && !page.visible('lgSetup'));
    check('it is a multiple-choice question: a fieldset with a legend and two radio options', page.d.querySelector('#lgChoose fieldset legend').textContent === 'How do you want to send your receipts?' && page.d.querySelectorAll('#lgChoose input[type="radio"][name="lgMethod"]').length === 2);
    const labels = [...page.d.querySelectorAll('.lg-choice')].map(l => [l.querySelector('.lg-choice-letter').textContent, l.querySelector('.font-display').textContent]);
    check('A is "Forward automatically", B is "Forward each receipt"', JSON.stringify(labels) === JSON.stringify([['A', 'FORWARD AUTOMATICALLY'], ['B', 'FORWARD EACH RECEIPT']]));
    check('nothing is preselected and Continue waits for an answer', !page.d.querySelector('input[name="lgMethod"]:checked') && page.$('lgContinue').disabled);
    page.submitChoice();
    check('submitting without an answer goes nowhere', page.visible('lgChoose') && page.method() === null);

    page.choose('auto');
    check('choosing an option highlights it and enables Continue', page.d.querySelector('[data-choice="auto"]').classList.contains('is-selected') && !page.d.querySelector('[data-choice="manual"]').classList.contains('is-selected') && !page.$('lgContinue').disabled);
    page.submitChoice();
    check('Continue with "Forward automatically" opens its setup (?method=auto)', page.method() === 'auto' && page.visible('lgSetup') && !page.visible('lgChoose') && page.text('lgSetupTitle') === 'FORWARD AUTOMATICALLY');
    check('...with the address, the Gmail steps, past rides and status', page.visible('lgAddressReady') && page.visible('lgAuto') && !page.visible('lgManual') && !!page.d.getElementById('lgBackfillHeading') && /Forwarding and POP\/IMAP/.test(page.text('lgAuto')));
    check('...and method-specific wording only for this method', [...page.d.querySelectorAll('[data-for="auto"]')].every(e => !e.classList.contains('hidden')) && [...page.d.querySelectorAll('[data-for="manual"]')].every(e => e.classList.contains('hidden')));
    check('focus moves to the setup heading', page.d.activeElement === page.$('lgSetupTitle'));

    page.click(page.$('lgChangeMethod'));
    check('"Change method" goes back to the question, keeping the current answer selected', page.visible('lgChoose') && page.method() === null && page.d.querySelector('input[name="lgMethod"]:checked').value === 'auto');
    page.choose('manual');
    page.submitChoice();
    check('Continue with "Forward each receipt" opens its setup (?method=manual)', page.method() === 'manual' && page.text('lgSetupTitle') === 'FORWARD EACH RECEIPT' && page.visible('lgManual') && !page.visible('lgAuto'));
    check('...the manual steps need no Gmail settings', !/Forwarding and POP\/IMAP|Create a new filter/.test(page.text('lgManual')) && /Tap Forward/.test(page.text('lgManual')));
    const manualCopy = page.d.querySelector('#lgManual [data-copy="address"]');
    page.click(manualCopy);
    await page.waitFor(() => page.copied.length === 1, 'copy from manual');
    check('...and its Copy address button copies the address', page.copied[0] === ctx.addressFor('u1'));

    page.click(page.d.querySelector('[data-method-switch="auto"]'));
    check('"Set up automatic forwarding" switches to the automatic setup', page.method() === 'auto' && page.visible('lgAuto'));

    page.w.history.back();
    await page.waitFor(() => page.method() === 'manual' && page.visible('lgManual'), 'back to manual');
    check('the browser Back button returns to the previous step', page.method() === 'manual' && page.visible('lgManual'));

    const keys = await openPage(ctx, 'u1');
    keys.$('lgChoose').dispatchEvent(new keys.w.KeyboardEvent('keydown', { key: 'b', bubbles: true }));
    check('pressing B picks option B (multiple-choice keys)', keys.d.querySelector('input[name="lgMethod"]:checked').value === 'manual' && !keys.$('lgContinue').disabled);

    const again = await openPage(ctx, 'u1', { storage: { linkGmailMethod: 'manual' } });
    check('a returning rider is still asked, with their last answer preselected', again.visible('lgChoose') && again.d.querySelector('input[name="lgMethod"]:checked').value === 'manual');

    const direct = await openPage(ctx, 'u1', { search: '?method=auto' });
    check('a link to ?method=auto opens that setup directly (refresh keeps the step)', direct.visible('lgSetup') && direct.visible('lgAuto') && !direct.visible('lgChoose'));
    const junk = await openPage(ctx, 'u1', { search: '?method=nope' });
    check('an unknown ?method shows the question', junk.visible('lgChoose') && !junk.visible('lgSetup'));
  }

  console.log('11. Bug 2026-10-05: a fresh confirmation code always shows, even after receipts have arrived');
  {
    const ctx = await makeApp();
    await ctx.email('u1', { body: receiptBody() });                         // forwarding worked before
    const page = await openPage(ctx, 'u1', { search: '?method=auto' });
    check('before any new code: receipts are arriving, step 3 says no code is waiting', page.visible('lgStateOn') && page.visible('lgCodeDone') && !page.visible('lgCodeShown'));
    check('...without claiming the setup is finished (a rider may be re-adding the address)', /new confirmation will appear here/i.test(page.text('lgCodeDone')));

    await ctx.email('u1', CONFIRMATION);                                    // rider re-adds the address in Gmail
    await page.refresh();
    check('the new code is shown in step 3 even though receipts arrived before', page.visible('lgCodeShown') && page.text('lgCode') === '482913775');
    check('...and the stale "confirmed" state is hidden', !page.visible('lgCodeDone') && !page.visible('lgCodeWaiting'));
    // Digits are spaced so screen readers read them one by one.
    check('...marked as new, and announced', page.visible('lgCodeNew') && page.text('lgCodeAnnounce').replace(/\s/g, '').endsWith('482913775'));
    check('status says "Not receiving yet" while a code waits to be typed into Gmail (setup unfinished)', page.visible('lgStateOff') && !page.visible('lgStateOn'));

    ctx.d1.exec("UPDATE receipt_ingestion_addresses SET forwarding_code_received_at = datetime('now', '-2 minutes') WHERE user_id = 'u1'");
    await ctx.email('u1', { ...CONFIRMATION, body: 'Confirmation code: 555000111' });   // Gmail sends a newer code
    await page.refresh();
    check('a newer code replaces the older one', page.text('lgCode') === '555000111' && page.visible('lgCodeNew'));

    const fresh = await openPage(ctx, 'u1', { search: '?method=auto' });
    check('opening the page with a stored code shows it straight away', fresh.visible('lgCodeShown') && fresh.text('lgCode') === '555000111');

    await ctx.email('u1', { body: receiptBody({ pickupTime: '9:40 am' }) });       // forwarding confirmed: Gmail sends a receipt
    await page.refresh();
    check('once a receipt arrives after the code, the code is used up and step 3 settles', !page.visible('lgCodeShown') && page.visible('lgCodeDone'));

    const before = page.requests.length;
    const polled = await page.waitFor(() => page.requests.length > before, 'auto-view poll', 9500);
    check('while waiting for a code on the automatic setup, the page re-checks within ~8 seconds even after receipts', polled);
  }

  console.log('12. Bug 2026-10-05: "Receiving receipts" only when the CURRENT address is linked');
  {
    const ctx = await makeApp();
    await ctx.email('u1', { body: receiptBody() });                         // receipts arrived in the past...
    ctx.d1.exec("UPDATE receipt_ingestion_addresses SET opaque_token = 'fresh0token', last_received_at = NULL WHERE user_id = 'u1'");   // ...then a new address (rotate)
    const page = await openPage(ctx, 'u1', { search: '?method=auto' });
    check('past receipts alone do not make the headline say "Receiving receipts"', page.visible('lgStateOff') && !page.visible('lgStateOn'));
    check('...step 3 waits for Gmail\'s code instead of saying receipts are reaching the address', page.visible('lgCodeWaiting') && !page.visible('lgCodeDone'));
    check('...the historical totals still show below', page.text('lgProcessed') === '1' && page.text('lgAdded') === '1');

    await ctx.email('u1', CONFIRMATION);                                    // mid-setup in Gmail
    await page.refresh();
    check('a confirmation code waiting to be typed into Gmail is "Not receiving yet"', page.visible('lgStateOff') && page.visible('lgCodeShown'));

    await ctx.email('u1', { body: receiptBody({ pickupTime: '9:40 am' }) });   // Gmail verified and forwarded a receipt
    await page.refresh();
    check('a receipt at the current address, with no code pending: "Receiving receipts"', page.visible('lgStateOn') && !page.visible('lgStateOff') && page.visible('lgCodeDone'));
  }

  console.log('13. Bug 2026-10-05: Gmail\'s link-only confirmation shows a "Confirm in Gmail" button');
  {
    const ctx = await makeApp();
    const link = 'https://mail-settings.google.com/mail/vf-%5BANGjdJ8xQ%5D-Zk3pQ9wYx2';
    const page = await openPage(ctx, 'u1', { search: '?method=auto' });
    check('before Gmail sends anything: step 3 waits', page.visible('lgCodeWaiting') && !page.visible('lgCodeShown'));
    await ctx.email('u1', { from: 'Gmail Team <forwarding-noreply@google.com>', subject: '(Gmail Forwarding Confirmation - Receive Mail from rider@gmail.com', body: `rider@gmail.com has requested to automatically forward mail to your email address.\nTo allow it, please click the link below to confirm the request:\n\n${link}\n\nIf you click the link and it appears to be broken, copy it into a new window.` });
    await page.refresh();
    check('the confirmation shows with a "Confirm in Gmail" button to Gmail\'s link', page.visible('lgCodeShown') && page.visible('lgConfirmLinkWrap') && page.$('lgConfirmLink').href === link);
    check('...opening in a new tab without handing this page to Gmail', page.$('lgConfirmLink').target === '_blank' && /noopener/.test(page.$('lgConfirmLink').rel));
    check('...naming the Gmail account that asked, to check it is theirs', page.visible('lgRequestedBy') && /rider@gmail\.com/.test(page.text('lgRequestedBy')));
    check('...no code box (there is no code), marked new and announced', !page.visible('lgCodeWrap') && page.visible('lgCodeNew') && /Confirm in Gmail/.test(page.text('lgCodeAnnounce')));
    check('...and the headline stays "Not receiving yet" until forwarding is confirmed', page.visible('lgStateOff'));

    ctx.d1.exec("UPDATE receipt_ingestion_addresses SET forwarding_link = 'https://evil.example.com/mail/vf-x' WHERE user_id = 'u1'");
    await page.refresh();
    check('a stored link that is not Google\'s mail settings is never used as the button', !page.visible('lgConfirmLinkWrap') && page.$('lgConfirmLink').href !== 'https://evil.example.com/mail/vf-x');

    ctx.d1.exec(`UPDATE receipt_ingestion_addresses SET forwarding_link = '${link}' WHERE user_id = 'u1'`);
    await ctx.email('u1', { body: receiptBody() });
    await page.refresh();
    check('once forwarding works (a receipt arrives), the link is used up: "Receiving receipts"', !page.visible('lgCodeShown') && page.visible('lgCodeDone') && page.visible('lgStateOn'));
  }

  opened.forEach(w => w.close());
  t.finish();
}

run().catch(err => { console.error(err); process.exit(1); });
