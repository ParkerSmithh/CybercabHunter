// Community Social, end to end in a real browser (Chromium via Playwright).
// The real page and the REAL Worker over an isolated in-memory database
// (tests/e2e/harness.mjs): two riders (alice, bob) and a moderator. Nothing
// here talks to production.
//
//   node tests/e2e/social-browser.mjs [outDir]
//   TAILWIND_CSS=path/to/compiled.css  — serve Tailwind locally (offline)
//
// Covers: sorting and filters (with pagination), the character counter, posts
// (text, photos, ride review with the star picker), Cybercab attachments
// (search, publish, card, vehicle page, change, remove), likes, comments,
// replies, edit/delete, saves, share links, pins, reports, moderator removal,
// notifications between two accounts, migrated reviews, privacy of the
// Top Contributors, and the layout at 1440, 768, 390 and 375 px wide in dark
// and light themes.
import fs from 'node:fs';
import { makeApp, startServer, newContext, loadPlaywright, jpegBytes, V1, V2 } from './harness.mjs';
import worker from '../../worker/index.js';
import { makeCheck, seedVehicle, approveVehicle } from '../helpers/env.mjs';

const pw = loadPlaywright();
if (!pw) { console.log('Playwright is not installed: skipping the browser tests.'); process.exit(0); }
const t = makeCheck();
const { check } = t;
const OUT = process.argv[2] || null;
if (OUT) fs.mkdirSync(OUT, { recursive: true });
const shot = async (page, name, opts = {}) => { if (OUT) await page.screenshot({ path: `${OUT}/${name}.png`, ...opts }); };

const app = await makeApp();
const { server, origin } = await startServer(app);
const browser = await pw.chromium.launch(fs.existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {});
const pageErrors = [];
const count = (sql, ...a) => app.d1.query(sql, ...a)[0].n;
const xpRows = () => count('SELECT COUNT(*) AS n FROM xp_ledger');
const api = async (method, p, { session, json, form } = {}) => {
  const headers = { Origin: 'https://cybercabhunter.com' };
  if (session) headers.Authorization = `Bearer ${session}`;
  let body;
  if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  if (form) { body = new FormData(); for (const [k, v] of Object.entries(form)) body.append(k, v); }
  const r = await worker.fetch(new Request(`https://cybercabhunter.com${p}`, { method, headers, body }), app.env, {});
  let out = null; try { out = await r.json(); } catch (e) { /* none */ }
  return { status: r.status, json: out };
};
async function open(session, { width = 1440, height = 900, mobile = false, path = '/community', theme } = {}) {
  const ctx = await newContext(browser, { session, width, height, mobile, origin });
  if (theme) await ctx.addInitScript(th => { try { localStorage.setItem('cchTheme', th); } catch (e) { /* none */ } }, theme);
  const page = await ctx.newPage();
  page.on('pageerror', e => pageErrors.push(`${path}: ${e.message}`));
  await page.goto(origin + path);
  await page.waitForTimeout(700);
  return { ctx, page };
}
const feedIds = page => page.$$eval('#socialFeed [data-post]', els => els.map(e => e.dataset.post));
const postEl = (id, root = '#socialFeed') => `${root} [data-post="${id}"]`;
const wait = (page, ms = 300) => page.waitForTimeout(ms);
const tmpJpg = `/tmp/social-e2e-${process.pid}.jpg`;
fs.copyFileSync(new URL('../../public/images/CybercabAnimation-poster.jpg', import.meta.url).pathname, tmpJpg);

async function publish(page, text) {
  await page.fill('#socialBody', text);
  await page.click('#socialPublish');
  await wait(page, 700);
}
const newestId = async () => app.d1.query(`SELECT id FROM social_posts ORDER BY created_at DESC, rowid DESC LIMIT 1`)[0].id;

try {
  console.log('1. Sorting and filters');
  {
    // 12 review posts with different ages and likes, 3 photo posts.
    const ids = [];
    for (let i = 0; i < 12; i++) {
      const r = await api('POST', '/api/social/posts', { session: 's-bob', form: { body: `Review number ${i}`, review: '1', rating: String(1 + (i % 5)) } });
      ids.push(r.json.post.id);
      app.d1.exec(`UPDATE social_posts SET created_at = datetime('now', '-${i} hours') WHERE id = '${r.json.post.id}'`);
    }
    // Engagement that outweighs age: likes + 2 × comments, decaying with hours.
    for (const who of ['s-alice', 's-mod']) {
      await api('PUT', `/api/social/posts/${ids[7]}/like`, { session: who });
      await api('POST', `/api/social/posts/${ids[7]}/comments`, { session: who, json: { body: 'Great' } });
    }
    await api('PUT', `/api/social/posts/${ids[4]}/like`, { session: 's-alice' });
    await api('POST', `/api/social/posts/${ids[4]}/comments`, { session: 's-alice', json: { body: 'Nice' } });
    const { ctx, page } = await open('s-alice', { width: 390, height: 844, mobile: true });
    const states = [];
    for (const f of ['foryou', 'latest', 'photos', 'reviews', 'saved']) {
      await page.click(`[data-filter="${f}"]`); await wait(page, 350);
      states.push(await page.evaluate(() => {
        const bar = document.getElementById('socialFeedbar'), tabs = document.querySelector('.social-filter-tabs');
        const sel = !document.getElementById('socialSortWrap').classList.contains('hidden');
        return { bar: bar.getBoundingClientRect().height > 0, sel, note: document.getElementById('socialSortNote').textContent, fits: tabs.scrollWidth <= tabs.clientWidth + 1 };
      }));
    }
    check('the sort row is shown on every filter (a Newest / Most popular choice, or how the feed is ordered)', states.every(s => s.bar) && !states[0].sel && /likes and comments/.test(states[0].note) && /Newest posts first/.test(states[1].note) && states[2].sel && states[3].sel && states[4].sel);
    check('on a 390 px phone the five filter tabs fit (the sort no longer squeezes them)', states.every(s => s.fits));
    await page.click('[data-filter="reviews"]'); await wait(page, 350);
    let order = await feedIds(page);
    check('Reviews · Newest: newest first, 10 a page', order.length === 10 && order[0] === ids[0] && order[9] === ids[9]);
    await page.click('#socialMore'); await wait(page, 400);
    order = await feedIds(page);
    check('Load more continues the same order without repeats', order.length === 12 && new Set(order).size === 12 && order[11] === ids[11]);
    await page.selectOption('#socialSort', 'popular'); await wait(page, 400);
    order = await feedIds(page);
    check('Most popular: the most-liked post first, then the next', order[0] === ids[7] && order[1] === ids[4]);
    await page.click('#socialMore'); await wait(page, 400);
    check('Most popular paginates: every post once', new Set(await feedIds(page)).size === 12);
    await page.click('[data-filter="photos"]'); await wait(page, 300);
    check('the chosen sort carries to Photos', await page.inputValue('#socialSort') === 'popular');
    await page.reload(); await wait(page, 700);
    await page.click('[data-filter="reviews"]'); await wait(page, 350);
    check('...and is remembered after a reload', await page.inputValue('#socialSort') === 'popular' && (await feedIds(page))[0] === ids[7]);
    await page.selectOption('#socialSort', 'new'); await wait(page, 300);
    await shot(page, 'sort-390');
    await ctx.close();
    // Clean up these fixture posts so later sections start from a known feed.
    for (const id of ids) await api('DELETE', `/api/social/posts/${id}`, { session: 's-bob' });
  }

  console.log('2. The character counter');
  {
    const { ctx, page } = await open('s-alice');
    check('the counter shows 0 / 2,000 from the start', (await page.textContent('#socialCount')).trim() === '0 / 2,000');
    await page.fill('#socialBody', 'Hello Cybercab');
    check('it updates as you type', (await page.textContent('#socialCount')).trim() === '14 / 2,000');
    await page.fill('#socialBody', 'x'.repeat(1850));
    check('near the limit it warns how many are left', /150 characters left/.test(await page.textContent('#socialCountMsg')) && await page.$eval('#socialCount', el => el.classList.contains('is-near')));
    await page.focus('#socialBody');
    await page.evaluate(() => { const ta = document.getElementById('socialBody'); ta.value = ''; });
    await page.keyboard.insertText('y'.repeat(2050));   // a paste
    check('pasting past the limit keeps every character (no silent cut)', (await page.inputValue('#socialBody')).length === 2050);
    check('over the limit: the count turns red, says how many over, and Post is off', (await page.textContent('#socialCount')).trim() === '2,050 / 2,000' && await page.$eval('#socialCount', el => el.classList.contains('is-over')) && /50 characters over the 2,000-character limit/.test(await page.textContent('#socialCountMsg')) && await page.isDisabled('#socialPublish'));
    await page.fill('#socialBody', 'z'.repeat(2000));
    check('exactly at the limit: "reached", and Post is allowed', /reached the 2,000-character limit/.test(await page.textContent('#socialCountMsg')) && !(await page.isDisabled('#socialPublish')));
    const tooLong = await api('POST', '/api/social/posts', { session: 's-alice', form: { body: 'q'.repeat(2001) } });
    check('the server still refuses 2,001 characters', tooLong.status === 400 && tooLong.json.error === 'text_too_long');
    await page.fill('#socialBody', '');
    await shot(page, 'counter-1440', { clip: { x: 0, y: 500, width: 1440, height: 400 } });
    await ctx.close();
  }

  console.log('3. Posting: text, photos, ride review');
  let textPost, photoPost, reviewPost;
  {
    const { ctx, page } = await open('s-alice');
    await publish(page, 'First Cybercab of the day on South Congress');
    textPost = await newestId();
    check('a text post appears at the top of the feed at once and is stored', (await feedIds(page))[0] === textPost && /South Congress/.test(await page.textContent(postEl(textPost))) && count(`SELECT COUNT(*) AS n FROM social_posts WHERE id = ?`, textPost) === 1);
    check('ordinary posts need no plate, VIN or vehicle', count(`SELECT COUNT(*) AS n FROM social_posts WHERE id = ? AND robotaxi_vehicle_id IS NULL`, textPost) === 1);
    await page.setInputFiles('#socialPhotos', [tmpJpg, tmpJpg]);
    await wait(page, 900);
    check('two photos: two previews, each removable', (await page.$$('#socialPhotoPreviews .social-preview')).length === 2);
    await page.click('#socialPhotoPreviews [data-remove]'); await wait(page, 150);
    check('removing one leaves one', (await page.$$('#socialPhotoPreviews .social-preview')).length === 1);
    await publish(page, 'Photo from the lot');
    photoPost = await newestId();
    const img = await page.$(`${postEl(photoPost)} .social-photos img`);
    await page.waitForFunction(el => el.complete && el.naturalWidth > 0, img, { timeout: 5000 }).catch(() => {});
    check('the photo post shows its photo, served back and decoded', !!img && await img.evaluate(el => el.naturalWidth > 0) && count(`SELECT COUNT(*) AS n FROM social_post_photos WHERE post_id = ?`, photoPost) === 1);
    const key = app.d1.query(`SELECT r2_key FROM social_post_photos WHERE post_id = ?`, photoPost)[0].r2_key;
    const stored = Buffer.from((await app.env.EVIDENCE_BUCKET.get(key)).body);
    check('the stored file has no camera metadata (EXIF/GPS)', !stored.includes(Buffer.from('GPS')) && !stored.includes(Buffer.from('Exif')));
    await page.click(`${postEl(photoPost)} [data-photo]`); await wait(page, 300);
    check('a photo opens in the viewer', await page.$eval('#socialLightbox', d => d.open));
    await page.keyboard.press('Escape'); await wait(page, 150);
    // Ride review with the star picker.
    await page.click('[data-attach="review"]');
    await page.hover('#socialStars [data-value="2"]');
    check('the star picker previews on hover', (await page.$$('#socialStars .is-on')).length === 2);
    await page.click('#socialStars [data-value="4"]');
    check('clicking the 4th star sets 4', await page.$eval('#socialStars', g => [...g.querySelectorAll('[role="radio"]')].filter(b => b.getAttribute('aria-checked') === 'true').map(b => b.dataset.value).join()) === '4');
    check('the post type switches to Review', await page.inputValue('#socialCategory') === 'review');
    await page.selectOption('#socialReviewVehicleType', 'cybercab');
    await page.fill('#socialReviewFare', '14.20');
    await page.fill('#socialReviewWait', '6');
    await page.fill('#socialReviewDate', '2026-10-05');
    await publish(page, 'Smooth ride to the Domain');
    reviewPost = await newestId();
    const rv = await page.textContent(`${postEl(reviewPost)} .social-review`);
    check('the published review shows 4 stars, vehicle, fare, wait and date', await page.getAttribute(`${postEl(reviewPost)} .social-review-stars`, 'aria-label') === '4 out of 5 stars' && /Cybercab/.test(rv) && /\$14\.20 fare/.test(rv) && /6 min pickup wait/.test(rv) && /Oct 5, 2026/.test(rv));
    check('...stored once, with its fields', count(`SELECT COUNT(*) AS n FROM social_post_reviews WHERE post_id = ? AND rating = 4 AND quoted_fare_cents = 1420 AND pickup_wait_minutes = 6 AND ride_date = '2026-10-05'`, reviewPost) === 1);
    check('ranks and levels show on each post', /Gold Spotter/.test(await page.textContent(`${postEl(reviewPost)} .social-rank`)) && /Lv \d+/.test(await page.textContent(`${postEl(reviewPost)} .social-level`)));
    await ctx.close();
  }

  console.log('4. Cybercab attachments');
  let carPost;
  {
    const { ctx, page } = await open('s-alice');
    await page.click('[data-attach="vehicle"]');
    await page.fill('#socialVehicleSearch', 'xvf35'); await wait(page, 600);
    check('search by plate (partial, any case) finds XVF-3582', (await page.$$('#socialVehicleResults [data-vi]')).length === 1 && /XVF-3582/.test(await page.textContent('#socialVehicleResults')));
    await page.fill('#socialVehicleSearch', '7saygdef5ta'); await wait(page, 600);
    check('search by VIN finds the same car, showing VIN and city', /7SAYGDEF5TA000123/.test(await page.textContent('#socialVehicleResults')) && /Austin/.test(await page.textContent('#socialVehicleResults')));
    await page.click('#socialVehicleResults [data-vi="0"]');
    check('selecting shows a preview card with Change and Remove', /XVF-3582/.test(await page.textContent('#socialVehiclePreview')) && await page.isVisible('#socialVehiclePreview [data-vchange]'));
    await publish(page, 'Parked by the Domain');
    carPost = await newestId();
    const card = `${postEl(carPost)} .social-vcard`;
    check('the published post shows the Cybercab card: plate, VIN, city', /XVF-3582/.test(await page.textContent(card)) && /7SAYGDEF5TA000123/.test(await page.textContent(card)) && /Austin/.test(await page.textContent(card)));
    check('attaching is stored as the registry link only (no sighting submitted, no XP)', count(`SELECT COUNT(*) AS n FROM social_posts WHERE id = ? AND robotaxi_vehicle_id = ?`, carPost, V1) === 1 && xpRows() === 0);
    await Promise.all([page.waitForURL(`**/vehicle/${V1}`), page.click(card)]);
    await page.waitForFunction(() => document.getElementById('vLicensePlate') && document.getElementById('vLicensePlate').textContent.includes('XVF'), null, { timeout: 5000 }).catch(() => {});
    check('clicking the card opens that vehicle\'s registry page', page.url().endsWith(`/vehicle/${V1}`) && /XVF-3582/.test(await page.textContent('#vLicensePlate')));
    await page.goBack(); await wait(page, 800);
    // Change the vehicle by editing.
    await page.click(`${postEl(carPost)} [data-menu]`);
    await page.click(`${postEl(carPost)} [data-act="edit"]`); await wait(page, 300);
    check('Edit loads the attached car into the composer', /XVF-3582/.test(await page.textContent('#socialVehiclePreview')));
    await page.click('#socialVehiclePreview [data-vchange]');
    await page.fill('#socialVehicleSearch', 'xvf3210'); await wait(page, 600);
    await page.keyboard.press('Enter');
    await page.click('#socialPublish'); await wait(page, 700);
    check('changing the attached car', /XVF3210/.test(await page.textContent(`${postEl(carPost)} .social-vcard`)) && count(`SELECT COUNT(*) AS n FROM social_posts WHERE id = ? AND robotaxi_vehicle_id = ?`, carPost, V2) === 1);
    await page.click(`${postEl(carPost)} [data-menu]`);
    await page.click(`${postEl(carPost)} [data-act="edit"]`); await wait(page, 300);
    await page.click('#socialVehiclePreview [data-vremove]');
    await page.click('[data-close-attach="vehicle"]');
    await page.click('#socialPublish'); await wait(page, 700);
    check('removing the attachment: the card goes, the post stays', !(await page.$(`${postEl(carPost)} .social-vcard`)) && /Parked by the Domain/.test(await page.textContent(postEl(carPost))) && count(`SELECT COUNT(*) AS n FROM social_posts WHERE id = ? AND robotaxi_vehicle_id IS NULL`, carPost) === 1);
    await ctx.close();
  }

  console.log('5. Two accounts: likes, comments, replies, edits, deletes, notifications');
  {
    const B = await open('s-bob');
    const bob = B.page;
    const like = `${postEl(textPost)} [data-like]`;
    await bob.click(like); await wait(bob, 700);
    check('Bob likes Alice\'s post: the count goes up at once and is saved', (await bob.textContent(`${like} [data-like-count]`)).trim() === '1' && count(`SELECT COUNT(*) AS n FROM social_likes WHERE post_id = ? AND user_id = 'bob'`, textPost) === 1);
    await bob.click(like); await wait(bob, 700);
    check('unlike: back to 0, removed from the database', (await bob.textContent(`${like} [data-like-count]`)).trim() === '0' && count(`SELECT COUNT(*) AS n FROM social_likes WHERE post_id = ?`, textPost) === 0);
    await bob.click(like); await wait(bob, 700);
    await bob.reload(); await wait(bob, 800);
    check('a like persists across reloads (shown as liked)', await bob.getAttribute(like, 'aria-pressed') === 'true');
    // Comment.
    await bob.click(`${postEl(textPost)} [data-comments]`); await wait(bob, 400);
    await bob.fill(`${postEl(textPost)} [data-c-new] textarea`, 'Which block was it?');
    await bob.press(`${postEl(textPost)} [data-c-new] textarea`, 'Enter'); await wait(bob, 500);
    const bobComment = app.d1.query(`SELECT id FROM social_comments WHERE user_id = 'bob' ORDER BY created_at DESC LIMIT 1`)[0].id;
    check('Bob comments: shown in the thread with his rank, count 1', /Which block was it\?/.test(await bob.textContent(`${postEl(textPost)} [data-comment-list]`)) && (await bob.textContent(`${postEl(textPost)} [data-comment-count]`)).trim() === '1' && /Bronze Spotter/.test(await bob.textContent(`[data-comment="${bobComment}"] .social-rank`)));

    // Alice: the bell, then the reply.
    const A = await open('s-alice');
    const alice = A.page;
    check('Alice\'s bell shows 2 unread (Bob\'s like and comment; never her own actions)', (await alice.textContent('#socialBellCount')).trim() === '2');
    await alice.click('#socialBell'); await wait(alice, 400);
    const noteTexts = await alice.$$eval('#socialNotifList .social-note-text', els => els.map(e => e.textContent.trim()));
    check('the panel: "Bob B commented on your post", "Bob B liked your post"', noteTexts.some(x => x === 'Bob B commented on your post') && noteTexts.some(x => x === 'Bob B liked your post') && noteTexts.length === 2);
    await shot(alice, 'bell-1440', { clip: { x: 760, y: 0, width: 680, height: 620 } });
    await alice.click('#socialNotifList .social-note:has-text("commented")'); await wait(alice, 900);
    check('opening the notice shows that post with Bob\'s comment highlighted', alice.url().includes(`post=${textPost}`) && alice.url().includes(`comment=${bobComment}`) && !!(await alice.$(`#socialSinglePost [data-comment="${bobComment}"].is-highlight`)));
    await alice.click(`[data-comment="${bobComment}"] [data-c-act="reply"]`);
    await alice.fill(`[data-comment="${bobComment}"] [data-c-form] textarea`, 'Corner of Congress and 6th');
    await alice.press(`[data-comment="${bobComment}"] [data-c-form] textarea`, 'Enter'); await wait(alice, 500);
    const aliceReply = app.d1.query(`SELECT id FROM social_comments WHERE user_id = 'alice' ORDER BY created_at DESC LIMIT 1`)[0].id;
    check('Alice replies under Bob\'s comment (one level)', /Corner of Congress/.test(await alice.textContent(`[data-comment="${bobComment}"] [data-replies]`)) && count(`SELECT COUNT(*) AS n FROM social_comments WHERE id = ? AND parent_id = ?`, aliceReply, bobComment) === 1);
    await alice.reload(); await wait(alice, 800);
    check('read status persists: after reload, 1 unread (the like)', (await alice.textContent('#socialBellCount')).trim() === '1');
    // Bob: reply notice, reply to a reply, edit and delete his own.
    await bob.reload(); await wait(bob, 800);
    check('Bob\'s bell: 1 unread (Alice\'s reply)', (await bob.textContent('#socialBellCount')).trim() === '1');
    await bob.click('#socialBell'); await wait(bob, 400);
    check('"Alice A replied to your comment"', /Alice A replied to your comment/.test(await bob.textContent('#socialNotifList')));
    await bob.click('#socialNotifList .social-note'); await wait(bob, 900);
    await bob.click(`#socialSinglePost [data-comment="${bobComment}"] > .social-comment-row [data-c-act="edit"]`);
    await bob.fill(`[data-comment="${bobComment}"] [data-c-form] textarea`, 'Which block was it? (thanks!)');
    await bob.press(`[data-comment="${bobComment}"] [data-c-form] textarea`, 'Enter'); await wait(bob, 500);
    check('Bob edits his comment: new text, "edited", saved', /\(thanks!\)/.test(await bob.textContent(`[data-comment="${bobComment}"] [data-c-body]`)) && /edited/.test(await bob.textContent(`[data-comment="${bobComment}"] .social-post-who`)) && count(`SELECT COUNT(*) AS n FROM social_comments WHERE id = ? AND edited_at IS NOT NULL`, bobComment) === 1);
    check('Bob has no Edit/Delete on Alice\'s reply, only Report', !(await bob.$(`[data-comment="${aliceReply}"] [data-c-act="edit"]`)) && !(await bob.$(`[data-comment="${aliceReply}"] [data-c-act="delete"]`)) && !!(await bob.$(`[data-comment="${aliceReply}"] [data-c-act="report"]`)));
    check('...and the server refuses it anyway (403)', (await api('PATCH', `/api/social/comments/${aliceReply}`, { session: 's-bob', json: { body: 'x' } })).status === 403 && (await api('DELETE', `/api/social/comments/${aliceReply}`, { session: 's-bob' })).status === 403);
    check('Bob cannot edit or delete Alice\'s post (403), and has no menu items for it', (await api('PATCH', `/api/social/posts/${textPost}`, { session: 's-bob', form: { body: 'x' } })).status === 403 && (await api('DELETE', `/api/social/posts/${textPost}`, { session: 's-bob' })).status === 403);
    await bob.click(`[data-comment="${aliceReply}"] [data-c-act="reply"]`).catch(() => {});
    check('replies stay one level deep (no Reply on a reply)', !(await bob.$(`[data-comment="${aliceReply}"] [data-c-act="reply"]`)));
    bob.once('dialog', d => d.accept());
    await bob.click(`[data-comment="${bobComment}"] > .social-comment-row [data-c-act="delete"]`); await wait(bob, 600);
    check('Bob deletes his comment: it and its reply go, count 0', !(await bob.$(`[data-comment="${bobComment}"]`)) && count(`SELECT COUNT(*) AS n FROM social_comments WHERE post_id = ?`, textPost) === 0 && (await bob.textContent(`#socialSinglePost [data-comment-count]`)).trim() === '0');
    check('...and the notifications about them are gone', count(`SELECT COUNT(*) AS n FROM social_notifications WHERE comment_id IN (?, ?)`, bobComment, aliceReply) === 0);
    // Notifications: privacy and duplicates.
    const aliceNotes = (await api('GET', '/api/social/notifications', { session: 's-alice' })).json.notifications;
    await api('POST', '/api/social/notifications/read', { session: 's-bob', json: { ids: aliceNotes.map(n => n.id) } });
    check('Bob cannot mark Alice\'s notifications read, or list them', (await api('GET', '/api/social/notifications?count_only=1', { session: 's-alice' })).json.unread === 1 && !(await api('GET', '/api/social/notifications', { session: 's-bob' })).json.notifications.some(n => aliceNotes.some(a => a.id === n.id)));
    await bob.goto(origin + '/community'); await wait(bob, 800);
    for (let i = 0; i < 3; i++) { await bob.click(like); await wait(bob, 650); }
    check('toggling a like repeatedly never duplicates the notice', count(`SELECT COUNT(*) AS n FROM social_notifications WHERE type = 'like' AND post_id = ?`, textPost) <= 1);
    await alice.goto(origin + '/community'); await wait(alice, 800);
    await alice.click(`${postEl(textPost)} [data-like]`); await wait(alice, 650);
    check('Alice liking her own post notifies nobody', count(`SELECT COUNT(*) AS n FROM social_notifications WHERE actor_user_id = 'alice' AND type = 'like'`) === 0);
    // Save / unsave.
    await bob.click(`${postEl(reviewPost)} [data-save]`); await wait(bob, 500);
    check('Bob saves a post (bookmark filled, stored)', await bob.getAttribute(`${postEl(reviewPost)} [data-save]`, 'aria-pressed') === 'true' && count(`SELECT COUNT(*) AS n FROM social_saves WHERE user_id = 'bob' AND post_id = ?`, reviewPost) === 1);
    await bob.click('[data-filter="saved"]'); await wait(bob, 500);
    check('Saved lists it', (await feedIds(bob)).join() === reviewPost);
    await bob.click(`${postEl(reviewPost)} [data-save]`); await wait(bob, 500);
    check('unsaving empties Saved with the message', (await feedIds(bob)).length === 0 && /You haven't saved any posts yet/.test(await bob.textContent('#socialEmptyText')));
    check('saving notified nobody', count(`SELECT COUNT(*) AS n FROM social_notifications WHERE post_id = ? AND actor_user_id = 'bob'`, reviewPost) === 0);
    await A.ctx.close(); await B.ctx.close();
  }

  console.log('6. Share links, pins, reports, moderator removal, deleting');
  {
    const A = await open('s-alice');
    await A.page.click(`${postEl(reviewPost)} [data-act="share"]`); await wait(A.page, 400);
    const copied = await A.page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
    check('Share copies the post\'s link (desktop: no share sheet)', copied.endsWith(`/community?post=${reviewPost}`));
    await A.ctx.close();
    const V = await open(null, { path: `/community?post=${reviewPost}` });
    check('the link opened fresh, signed out: Social tab, that post, its review', await V.page.getAttribute('#communityTabSocial', 'aria-selected') === 'true' && await V.page.isVisible(`#socialSinglePost [data-post="${reviewPost}"]`) && /Smooth ride/.test(await V.page.textContent('#socialSinglePost')));
    await V.page.click('#socialBack'); await wait(V.page, 700);
    check('Back to Social returns to the full feed', await V.page.isVisible('#socialFeed') && (await feedIds(V.page)).length >= 3 && !V.page.url().includes('post='));
    await V.ctx.close();
    // Pin.
    const M = await open('s-mod');
    const mod = M.page;
    await mod.click(`${postEl(photoPost)} [data-menu]`);
    check('a moderator\'s menu has Pin, Remove and Review reports', await mod.isVisible(`${postEl(photoPost)} [data-act="pin"]`) && await mod.isVisible(`${postEl(photoPost)} [data-act="remove"]`) && /Review reports/.test(await mod.textContent(`${postEl(photoPost)} .social-menu`)));
    await mod.click(`${postEl(photoPost)} [data-act="pin"]`); await wait(mod, 700);
    check('pinned: first in the feed with a Pinned label', (await feedIds(mod))[0] === photoPost && /Pinned/.test(await mod.textContent(`${postEl(photoPost)} .social-pinned`)));
    const B = await open('s-bob');
    check('riders see the pin too, and no Pin in their menu', (await feedIds(B.page))[0] === photoPost && !(await B.page.$(`${postEl(photoPost)} [data-act="pin"]`)));
    await mod.click(`${postEl(photoPost)} [data-menu]`);
    await mod.click(`${postEl(photoPost)} [data-act="unpin"]`); await wait(mod, 700);
    check('unpinned', !(await mod.$(`${postEl(photoPost)} .social-pinned`)) && count(`SELECT pinned AS n FROM social_posts WHERE id = ?`, photoPost) === 0);
    // Report.
    await B.page.click(`${postEl(carPost)} [data-menu]`);
    check('Bob\'s menu on Alice\'s post: Copy link and Report only', (await B.page.$$eval(`${postEl(carPost)} .social-menu > *`, els => els.map(e => e.textContent).join('|'))) === 'Copy link|Report post');
    await B.page.click(`${postEl(carPost)} [data-act="report"]`);
    await B.page.check('#socialReport input[value="misleading"]');
    await B.page.fill('#socialReportDetails', 'Not the same car');
    await B.page.click('#socialReport button[type="submit"]'); await wait(B.page, 500);
    check('the report is sent and stored', !(await B.page.$eval('#socialReport', d => d.open)) && count(`SELECT COUNT(*) AS n FROM social_reports WHERE target_id = ? AND reason = 'misleading' AND status = 'open'`, carPost) === 1);
    await B.ctx.close();
    await mod.goto(origin + '/moderation.html#social-reports'); await wait(mod, 1200);
    check('the moderation queue shows it with the reason and note', /Misleading/.test(await mod.textContent('#modSocialList')) && /Not the same car/.test(await mod.textContent('#modSocialList')));
    mod.once('dialog', d => d.accept('Wrong vehicle'));
    await mod.click('#modSocialList button:has-text("Remove")'); await wait(mod, 600);
    check('Remove: hidden for everyone, report closed, audit row kept', count(`SELECT COUNT(*) AS n FROM social_posts WHERE id = ? AND status = 'removed'`, carPost) === 1 && count(`SELECT COUNT(*) AS n FROM social_reports WHERE target_id = ? AND status = 'actioned'`, carPost) === 1 && count(`SELECT COUNT(*) AS n FROM social_mod_actions WHERE target_id = ? AND action = 'remove_post'`, carPost) === 1);
    // Moderator removal from the feed menu.
    await mod.goto(origin + '/community'); await wait(mod, 800);
    check('the removed post is out of the feed', !(await feedIds(mod)).includes(carPost));
    mod.once('dialog', d => d.accept(''));
    await mod.click(`${postEl(photoPost)} [data-menu]`);
    await mod.click(`${postEl(photoPost)} [data-act="remove"]`); await wait(mod, 700);
    check('a moderator removes a post from its menu', !(await feedIds(mod)).includes(photoPost) && count(`SELECT COUNT(*) AS n FROM social_posts WHERE id = ? AND status = 'removed'`, photoPost) === 1);
    await M.ctx.close();
    // The author deletes a post.
    const A2 = await open('s-alice');
    A2.page.once('dialog', d => d.accept());
    await A2.page.click(`${postEl(textPost)} [data-menu]`);
    await A2.page.click(`${postEl(textPost)} [data-act="delete"]`); await wait(A2.page, 700);
    check('Alice deletes her post: gone with its likes, comments and notices', !(await feedIds(A2.page)).includes(textPost) && ['social_posts WHERE id', 'social_likes WHERE post_id', 'social_comments WHERE post_id', 'social_notifications WHERE post_id'].every(q => count(`SELECT COUNT(*) AS n FROM ${q} = ?`, textPost) === 0));
    await A2.page.goto(origin + `/community?post=${textPost}`); await wait(A2.page, 800);
    check('its shared link now says the post isn\'t available', /This post isn't available/.test(await A2.page.textContent('#socialSinglePost')));
    await A2.ctx.close();
    check('none of it awarded XP', xpRows() === 0);
  }

  console.log('7. Migrated reviews (migration 0044\'s copy, after 0045)');
  {
    const rid = 'abcdefabcdefabcdefabcdefabcdef01';
    app.d1.exec(`INSERT INTO cybercab_reviews (id, user_id, robotaxi_vehicle_id, rating, body, created_at, updated_at) VALUES ('${rid}', 'bob', '${V1}', 5, 'Old review: quiet and quick.', '2026-09-03 15:00:00', '2026-09-03 15:00:00')`);
    app.d1.exec(`INSERT INTO cybercab_review_photos (id, review_id, position, r2_key, content_type) VALUES ('abcdefabcdefabcdefabcdefabcdef02', '${rid}', 0, 'reviews/bob/${rid}/p', 'image/jpeg')`);
    await app.env.EVIDENCE_BUCKET.put(`reviews/bob/${rid}/p`, fs.readFileSync(tmpJpg));
    app.d1.exec(`INSERT INTO cybercab_review_likes (review_id, user_id) VALUES ('${rid}', 'alice')`);
    app.d1.exec(`INSERT INTO cybercab_review_comments (id, review_id, user_id, body, created_at) VALUES ('abcdefabcdefabcdefabcdefabcdef03', '${rid}', 'alice', 'Agreed!', '2026-09-04 10:00:00')`);
    const mig = fs.readFileSync(new URL('../../migrations/0044_social.sql', import.meta.url), 'utf8');
    const copy = mig.slice(mig.indexOf('-- ---- Existing reviews -> posts'));
    app.d1.exec(copy); app.d1.exec(copy);   // as on the live database, and repeatable
    check('the copy runs on a database with 0045 applied, once per review', count(`SELECT COUNT(*) AS n FROM social_posts WHERE legacy_review_id = ?`, rid) === 1 && count(`SELECT COUNT(*) AS n FROM cybercab_reviews WHERE id = ?`, rid) === 1);
    // The sidebar's figures are stored and refreshed within a read budget
    // (worker/summary-cache.js): expire them, as their lifetime would.
    app.d1.exec(`UPDATE community_summary SET computed_at = '2000-01-01T00:00:00.000Z'`);
    const { ctx, page } = await open(null);
    await page.click('[data-filter="reviews"]'); await wait(page, 500);
    const el = postEl(rid);
    check('it shows under Reviews: author, text, 5 stars, its date', /Bob B/.test(await page.textContent(`${el} .social-post-who`)) && /Old review: quiet and quick\./.test(await page.textContent(`${el} [data-body]`)) && await page.getAttribute(`${el} .social-review-stars`, 'aria-label') === '5 out of 5 stars' && /2026-09-03/.test(await page.getAttribute(`${el} time`, 'datetime')));
    const img = await page.$(`${el} .social-photos img`);
    await page.waitForFunction(e => e.complete && e.naturalWidth > 0, img, { timeout: 5000 }).catch(() => {});
    check('its photo (the same stored file) loads', !!img && await img.evaluate(e => e.naturalWidth > 0));
    check('its like and comment carried over', (await page.textContent(`${el} [data-like-count]`)).trim() === '1' && (await page.textContent(`${el} [data-comment-count]`)).trim() === '1');
    await page.click(`${el} [data-comments]`); await wait(page, 400);
    check('...and the comment reads back', /Agreed!/.test(await page.textContent(`${el} [data-comment-list]`)));
    const tile = (await page.textContent('#statSocialRating')).trim();
    check('the Ride reviews tile counts it (average of the 2 shown reviews: 4.5)', tile === '4.5');
    await ctx.close();
  }

  console.log('8. Top Contributors privacy');
  {
    // An opted-in rider with no display name or username, and a private one.
    app.d1.exec(`INSERT INTO users (id, leaderboard_opt_in) VALUES ('nameless', 1), ('hidden', 0)`);
    app.d1.exec(`UPDATE users SET display_name = 'Secret Person', handle = 'secret_person' WHERE id = 'hidden'`);
    app.d1.exec(`INSERT INTO user_xp (user_id, xp) VALUES ('nameless', 300), ('hidden', 99999)`);
    approveVehicle(app.d1, seedVehicle(app.d1, { id: 'c3d4e5f6-0000-4000-8000-000000000003', plate: 'NAM0001' }), { withRide: true, userId: 'nameless' });
    approveVehicle(app.d1, seedVehicle(app.d1, { id: 'd4e5f6a7-0000-4000-8000-000000000004', plate: 'HID0001' }), { withRide: true, userId: 'hidden' });
    app.d1.exec(`UPDATE community_summary SET computed_at = '2000-01-01T00:00:00.000Z'`);   // as the stored figures' lifetime would
    const { ctx, page } = await open(null);
    const top = await page.textContent('#socialTop');
    const nameless = await page.evaluateHandle(() => [...document.querySelectorAll('#socialTop li')].find(li => li.querySelector('.social-name') && li.querySelector('.social-name').textContent.trim() === 'Spotter') || null);
    check('a public rider without a name shows as "Spotter" (initial S) with no profile link', !!(await nameless.asElement()) && !(await nameless.asElement().$('a')) && (await nameless.asElement().$eval('[data-avatar-name]', e => e.textContent.trim())) === 'S');
    check('a rider with the public profile switch off is not listed at all (their 99,999 XP would top it)', !/Secret Person|secret_person/.test(top) && !/Secret Person|secret_person/.test(await page.content()));
    await ctx.close();
  }

  console.log('9. Layout at 1440, 768, 390 and 375 px; dark and light');
  {
    // Fresh content for the layout pass: a post with everything.
    const f = await api('POST', '/api/social/posts', { session: 's-alice', form: { body: 'Layout check post with a long link https://example.com/a/very/long/path/that/keeps/going/and/going/without/spaces', vehicle_id: V1, review: '1', rating: '5' } });
    await api('POST', `/api/social/posts/${f.json.post.id}/comments`, { session: 's-bob', json: { body: 'Nice one @alice_a' } });
    const sizes = [[1440, 900, false], [768, 1024, false], [390, 844, true], [375, 667, true]];
    for (const theme of ['dark', 'light']) {
      for (const [w, h, mobile] of sizes) {
        if (theme === 'light' && w !== 1440 && w !== 390) continue;
        const { ctx, page } = await open('s-alice', { width: w, height: h, mobile, theme });
        const tag = `${theme}-${w}`;
        const overflow = async () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        const inView = async sel => page.$eval(sel, el => { const r = el.getBoundingClientRect(); return r.left >= -1 && r.right <= window.innerWidth + 1; });
        const issues = [];
        if (await overflow() > 0) issues.push('page');
        await page.click('[data-attach="review"]'); await page.click('[data-attach="vehicle"]'); await page.click('[data-attach="link"]');
        await page.setInputFiles('#socialPhotos', [tmpJpg, tmpJpg, tmpJpg, tmpJpg]); await wait(page, 900);
        await page.fill('#socialVehicleSearch', 'xvf'); await wait(page, 600);
        if (await overflow() > 0) issues.push('composer');
        if (!(await inView('#socialVehicleResults'))) issues.push('vehicle results');
        await shot(page, `composer-${tag}`, { fullPage: false });
        await page.keyboard.press('Escape');
        await page.fill('#socialBody', 'Layout check'); await page.click('#socialPublish').catch(() => {});
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.click('#socialBell'); await wait(page, 400);
        if (!(await inView('#socialNotifPanel'))) issues.push('bell panel');
        await shot(page, `bell-${tag}`, { fullPage: false });
        await page.click('#socialBell');
        const pid = f.json.post.id;
        await page.click(`${postEl(pid)} [data-menu]`); await wait(page, 150);
        if (!(await inView(`${postEl(pid)} .social-menu`))) issues.push('post menu');
        await page.keyboard.press('Escape');
        await page.click(`${postEl(pid)} [data-comments]`); await wait(page, 400);
        if (await overflow() > 0) issues.push('comments');
        for (const fl of ['foryou', 'latest', 'photos', 'reviews', 'saved']) {
          await page.click(`[data-filter="${fl}"]`); await wait(page, 200);
          if (!(await page.isVisible(`[data-filter="${fl}"]`)) || await overflow() > 0) issues.push(`filter ${fl}`);
        }
        await page.click('[data-filter="foryou"]'); await wait(page, 400);
        await page.click(`${postEl(pid)} [data-comments]`); await wait(page, 400);
        if (await overflow() > 0) issues.push('feed');
        await shot(page, `page-${tag}`, { fullPage: true });
        check(`${tag}: no sideways overflow or clipped menus/panels (composer, photo previews, Cybercab search, bell, post menu, comments, filters, sidebar)`, issues.length === 0 || (console.log('    issues:', issues.join(', ')), false));
        await ctx.close();
      }
    }
  }

  console.log('10. The other Community sections still work');
  {
    const { ctx, page } = await open('s-alice');
    for (const v of ['Streaks', 'Leaderboard', 'Progress', 'Social']) {
      await page.click(`#communityTab${v}`); await wait(page, 500);
      check(`${v} opens`, await page.getAttribute(`#communityTab${v}`, 'aria-selected') === 'true' && await page.isVisible(`#communityPanel${v}`));
    }
    check('the leaderboard rendered rows', (await page.$$('#boardList li, #boardEmpty:not(.hidden)')).length > 0);
    await ctx.close();
  }

  check('no JavaScript errors on any page', pageErrors.length === 0 || (console.log('    errors:', pageErrors.slice(0, 5).join(' | ')), false));
} finally {
  await browser.close();
  server.close();
  try { fs.unlinkSync(tmpJpg); } catch (e) { /* gone */ }
}
t.finish();

