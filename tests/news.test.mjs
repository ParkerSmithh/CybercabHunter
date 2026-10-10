// /news (worker/news.js; migrations 0029-0031): the publisher-feed ingest,
// the 10-minute step, thumbnails, 30-day retention, the public API and the
// moderator tools — all against stubbed feeds, pages and images.
//   - parsing: RSS (CDATA, enclosure, <source>), Atom; canonical URLs; excerpts
//   - the allowlist / blocklist / publisher blocklist; dedupe; 304s; 30-day cap
//   - clustering (no chaining) and scoring
//   - the 10-minute step: one feed per run, in rotation; prune daily, sweep monthly
//   - thumbnails: og:image -> twitter:image -> <img> > 200 px; robots.txt;
//     thumb_blocklist; 400 px WebP via Image Transformations, never the original;
//     failures leave the story intact
//   - retention: 30-day prune of rows AND R2 objects (hidden / featured too);
//     orphan sweep; keyset pages survive rows vanishing
//   - GET /api/news (thumb_url before image_url), /news-img/<id>.webp, moderation
//   - Major scoring (migration 0032): keywords (editable), the numeric fleet
//     signal, the Workers AI check on rules-score-1 new stories (mocked), the
//     daily rules-only rescore
// Run: node tests/news.test.mjs

import worker from '../worker/index.js';
import { makeEnv, makeCheck } from './helpers/env.mjs';
import { fakeR2 } from './helpers/d1-sqlite.mjs';
import { DEFAULT_MAJOR_KEYWORDS, aiVerdict, parseVerdict, runNewsIngest, runNewsTick, parseFeed, canonicalUrl, clusterAndScore, extractImage, parseRobots, robotsAllows, makeThumb, processThumbs, pruneOld, sweepOrphans, thumbKey, NEWS_CRON, FEEDS } from '../worker/news.js';
import fs from 'node:fs';

const t = makeCheck();
const { check } = t;
const NOW = Date.parse('2026-10-09T16:00:00Z');
const iso = h => new Date(NOW - h * 3600e3).toUTCString();
const feedOf = id => FEEDS.find(f => f.id === id);

const rssItem = (title, link, hoursAgo, desc = '', extra = '') => `<item><title><![CDATA[${title}]]></title><link>${link}</link><pubDate>${iso(hoursAgo)}</pubDate><description><![CDATA[${desc}]]></description>${extra}</item>`;
const RSS = items => `<?xml version="1.0"?><rss xmlns:media="http://search.yahoo.com/mrss/"><channel>${items.join('')}</channel></rss>`;
const FEED_BODIES = {
  electrek: RSS([
    rssItem('Tesla Cybercab launches in Phoenix, its third city', 'https://electrek.co/phoenix/?utm_source=rss', 5, '<p>Tesla <b>launched</b> Cybercab rides in Phoenix today.</p>'),
    rssItem('Tesla Cybercab spotted testing in snow', 'https://electrek.co/snow/', 20, 'A prototype was seen on snowy roads.', '<enclosure url="https://electrek.co/snow.jpg" type="image/jpeg" length="48000"/>'),
    rssItem('Rivian R2 deliveries begin', 'https://electrek.co/r2/', 21, 'Not about robotaxis.'),
    rssItem('Tesla stock jumps on Cybercab hype', 'https://electrek.co/stock/', 3, '')
  ]),
  teslarati: RSS([rssItem('Tesla launches Cybercab in Phoenix as third city', 'https://www.teslarati.com/phoenix/', 7, 'Phoenix is next.')]),
  notateslaapp: RSS([rssItem('Cybercab launches in Phoenix: Tesla third city', 'https://www.notateslaapp.com/phoenix', 9, 'More cities.'), rssItem('Old Cybercab story from spring', 'https://www.notateslaapp.com/old', 24 * 60, 'old')]),
  theverge: `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><title type="html"><![CDATA[Tesla’s robotaxi service expands to Dallas suburbs]]></title><link rel="alternate" type="text/html" href="https://www.theverge.com/tesla/1/dallas" /><published>2026-10-08T09:00:00-04:00</published><summary type="html"><![CDATA[Tesla’s robotaxi now covers Plano and Frisco.]]></summary></entry></feed>`
};
const PAGE = (og, tw, imgs = '') => `<!doctype html><html><head><title>x</title>${og ? `<meta property="og:image" content="${og}">` : ''}${tw ? `<meta name="twitter:image" content="${tw}">` : ''}</head><body>${imgs}<p>article</p></body></html>`;
// A WebP header ("RIFF....WEBPVP8 ") with a given pixel width.
const webpOf = width => { const b = new Uint8Array(40); b.set([82, 73, 70, 70, 32, 0, 0, 0, 87, 69, 66, 80, 86, 80, 56, 32]); b[23] = 0x9d; b[24] = 0x01; b[25] = 0x2a; b[26] = width & 0xff; b[27] = (width >> 8) & 0x3f; b[28] = 0x10; b[29] = 0x01; return b; };
const WEBP = webpOf(400);

// A stub web: the feeds, robots.txt, article pages and images. Image requests
// with cf.image come back as WebP (Image Transformations on) unless transform:false.
function stubWeb({ notModified = false, transform = true, robots = {}, pages = {}, failPages = [], nativeWebp = false } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, init });
    const host = new URL(u).host;
    if (u.endsWith('/robots.txt')) return robots[host] != null ? new Response(robots[host]) : new Response('not found', { status: 404 });
    const feed = FEEDS.find(f => f.url === u);
    if (feed) {
      if (notModified) return new Response(null, { status: 304 });
      return new Response(FEED_BODIES[feed.id] || RSS([]), { headers: { etag: `"${feed.id}-1"`, 'last-modified': 'Fri, 09 Oct 2026 10:00:00 GMT' } });
    }
    if (failPages.some(p => u.startsWith(p))) return new Response('err', { status: 500 });
    if (pages[u] != null) return new Response(pages[u], { headers: { 'content-type': 'text/html; charset=utf-8' } });
    if (/\.(jpe?g|png|webp)(\?|$)/i.test(u)) {
      if (nativeWebp) return new Response(webpOf(1600), { headers: { 'content-type': 'image/webp' } });   // the site's own full-size WebP
      if (init.cf && init.cf.image && transform) return new Response(WEBP, { headers: { 'content-type': 'image/webp' } });
      return new Response(new Uint8Array(500000), { headers: { 'content-type': 'image/jpeg' } });
    }
    return new Response(PAGE('/img/hero.jpg', null), { headers: { 'content-type': 'text/html' } });
  };
  fn.calls = calls;
  return fn;
}

async function makeApp() {
  const ctx = await makeEnv({ users: ['rider', 'mod'] });
  ctx.d1.exec(`UPDATE users SET role = 'moderator' WHERE id = 'mod'`);
  for (const u of ['rider', 'mod']) await ctx.env.TESLA_SESSIONS.put(`session:session-${u}`, JSON.stringify({ user_id: u }));
  ctx.env.ASSETS = { fetch: async () => new Response('asset') };
  ctx.env.NEWS_THUMBS = fakeR2();
  return ctx;
}
const call = async (ctx, method, path, { session, body } = {}) => {
  const headers = { Origin: 'https://cybercabhunter.com' };
  if (session) headers.Authorization = `Bearer session-${session}`;
  if (body) headers['Content-Type'] = 'application/json';
  const r = await worker.fetch(new Request(`https://x${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }), ctx.env, { waitUntil() {} });
  let json = null; try { json = await r.clone().json(); } catch (e) { json = null; }
  return { status: r.status, json, r };
};
const rows = ctx => ctx.d1.query(`SELECT * FROM news_articles ORDER BY published_at DESC`);
const insertStory = (ctx, o) => ctx.d1.prepare(`INSERT INTO news_articles (id, title, url, source, published_at, cluster_id, thumb_key, thumb_status, hidden, featured, importance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  .bind(o.id, o.title || 'Cybercab story', o.url || `https://example.com/${o.id}`, o.source || 'Example', o.published_at, o.id, o.thumb_key || null, o.thumb_status || 'done', o.hidden || 0, o.featured || 0, o.importance || 0)._exec();
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function run() {
  console.log('1. Sources and parsing');
  {
    check('eleven publisher feeds, no Google News', FEEDS.length === 11 && FEEDS.every(f => f.kind === 'rss' && /^https:\/\//.test(f.url) && !/news\.google\.com/.test(f.url)));
    const e = parseFeed(FEED_BODIES.electrek, feedOf('electrek'));
    check('RSS: CDATA title, the outlet from the feed, tags stripped from the excerpt', e[0].title === 'Tesla Cybercab launches in Phoenix, its third city' && e[0].source === 'Electrek' && e[0].excerpt === 'Tesla launched Cybercab rides in Phoenix today.');
    check('canonical URL: tracking params removed', e[0].url === 'https://electrek.co/phoenix/' && canonicalUrl('https://x.com/a?utm_source=b&fbclid=c&gclid=d&id=7') === 'https://x.com/a?id=7');
    const a = parseFeed(FEED_BODIES.theverge, feedOf('theverge'));
    check('Atom: the alternate link, published date, summary', a.length === 1 && a[0].url === 'https://www.theverge.com/tesla/1/dallas' && a[0].published_at === '2026-10-08T13:00:00.000Z' && /Plano and Frisco/.test(a[0].excerpt));
    const agg = parseFeed(RSS([rssItem('Cybercab news - Some Outlet', 'https://agg.example/1', 1, '', '<source url="https://some.example">Some Outlet</source>')]), { id: 'x', kind: 'rss', name: 'Agg' });
    check('an RSS <source> names the outlet (and its " - Outlet" suffix is dropped)', agg[0].source === 'Some Outlet' && agg[0].title === 'Cybercab news');
    const long = parseFeed(RSS([rssItem('Cybercab', 'https://a.com/1', 1, 'word '.repeat(200))]), { id: 'x', kind: 'rss', name: 'A' });
    check('an excerpt is at most ~280 characters, never the full text', long[0].excerpt.length <= 280 && long[0].excerpt.endsWith('…'));
  }

  console.log('2. Ingest (all feeds)');
  const ctx = await makeApp();
  {
    const web = stubWeb();
    const log = await runNewsIngest(ctx.env, { fetchImpl: web, nowMs: NOW });
    const r = rows(ctx), titles = r.map(x => x.title);
    check('kept: Cybercab and Tesla-robotaxi stories from several outlets', titles.includes('Tesla Cybercab spotted testing in snow') && titles.includes('Tesla’s robotaxi service expands to Dallas suburbs') && r.filter(x => /Phoenix/.test(x.title)).length === 3);
    check('dropped: the stock story (blocklist), the off-topic one, and one older than 30 days', !titles.some(x => /stock|Rivian|spring/.test(x)) && log.dropped >= 3);
    check('every feed fetched with a descriptive User-Agent; no Google request', FEEDS.every(f => web.calls.some(c => c.url === f.url && /CybercabHunter-NewsBot/.test(c.init.headers['User-Agent']))) && !web.calls.some(c => /google/.test(c.url)));
    const phx = r.filter(x => /Phoenix/.test(x.title));
    check('the same story at three outlets: one cluster, earliest primary, importance 2', new Set(phx.map(x => x.cluster_id)).size === 1 && phx.every(x => x.source_count === 3 && x.importance === 2) && phx[0].cluster_id === phx.find(x => x.source === 'Not a Tesla App').id);
    check('new stories are queued for a thumbnail', r.every(x => x.thumb_status === 'pending' && x.thumb_key === null));
    const before = r.length;
    const again = await runNewsIngest(ctx.env, { fetchImpl: stubWeb(), nowMs: NOW + 3600e3 });
    check('a rerun inserts nothing twice', rows(ctx).length === before && again.new === 0);
    const web3 = stubWeb({ notModified: true });
    const nm = await runNewsIngest(ctx.env, { fetchImpl: web3, nowMs: NOW + 7200e3 });
    check('...it sends the saved validators, and a 304 is "nothing new"', web3.calls.some(c => c.url === FEEDS[0].url && c.init.headers['If-None-Match'] === '"electrek-1"') && nm.not_modified === FEEDS.length && nm.new === 0);
    const chain = clusterAndScore([
      { id: 'c1', title: 'Cybercab launches rides in Austin today for public', source: 'A', published_at: '2026-10-01T00:00:00Z' },
      { id: 'c2', title: 'Cybercab launches public rides in Austin today, feds watch', source: 'B', published_at: '2026-10-01T02:00:00Z' },
      { id: 'c3', title: 'Feds watch Cybercab rides today in Austin, probe', source: 'C', published_at: '2026-10-01T04:00:00Z' }]);
    check('clustering never chains: a story joins only by matching a cluster\'s first story', chain.c1.cluster_id === chain.c2.cluster_id && chain.c3.cluster_id !== chain.c1.cluster_id);
  }

  console.log('3. The 10-minute step');
  {
    const wr = fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
    check('the news cron runs every 10 minutes (offset from */10), and the old daily one is gone', NEWS_CRON === '5-59/10 * * * *' && wr.includes('"5-59/10 * * * *"') && !wr.includes('"0 11,12 * * *"'));
    check('the R2 bucket is bound as NEWS_THUMBS', /"binding":\s*"NEWS_THUMBS",\s*"bucket_name":\s*"cybercabhunter-news-thumbs"/.test(wr));
    const e = await makeApp();
    const w1 = stubWeb();
    const t1 = await runNewsTick(e.env, { fetchImpl: w1, nowMs: NOW });
    const t2 = await runNewsTick(e.env, { fetchImpl: stubWeb(), nowMs: NOW + 600e3 });
    check('one feed per step, in rotation', t1.feeds.length === 1 && t2.feeds.length === 1 && t1.feeds[0] === FEEDS[0].id && t2.feeds[0] === FEEDS[1].id && w1.calls.filter(c => FEEDS.some(f => f.url === c.url)).length === 1);
    let last;
    for (let k = 2; k <= FEEDS.length; k++) last = await runNewsTick(e.env, { fetchImpl: stubWeb(), nowMs: NOW + k * 600e3 });
    check('...wrapping around after the eleventh', last.feeds[0] === FEEDS[0].id);
    check('the prune runs once per Austin day (first step only), the orphan sweep once a month', 'stories_pruned' in t1 && !('stories_pruned' in t2) && 'orphans_deleted' in t1 && !('orphans_deleted' in t2));
  }

  console.log('4. Thumbnails');
  {
    const html = PAGE('https://cdn.a.com/og.jpg', 'https://cdn.a.com/tw.jpg', '<img src="https://cdn.a.com/body.jpg" width="800">');
    check('extraction order: og:image first', extractImage(html, 'https://a.com/p').url === 'https://cdn.a.com/og.jpg');
    check('...then twitter:image', extractImage(PAGE(null, '/tw.jpg', '<img src="/body.jpg" width="800">'), 'https://a.com/p').url === 'https://a.com/tw.jpg');
    check('...then the first <img> wider than 200 px (a 1 px pixel and a narrow icon skipped)', extractImage(PAGE(null, null, '<img src="/pixel.gif" width="1" height="1"><img src="/icon.png" width="64"><img src="/body.jpg" width="640">'), 'https://a.com/p').url === 'https://a.com/body.jpg');
    check('no SVG or data: URI ever', extractImage(PAGE('/logo.svg', 'data:image/png;base64,AAA', ''), 'https://a.com/p') === null);
    const rules = parseRobots('User-agent: *\nDisallow: /private/\nAllow: /private/ok\n\nUser-agent: OtherBot\nDisallow: /');
    check('robots.txt: longest match wins, Allow beats a shorter Disallow; another bot\'s group ignored', robotsAllows(rules, 'https://a.com/news/1') && !robotsAllows(rules, 'https://a.com/private/x') && robotsAllows(rules, 'https://a.com/private/ok'));

    const e = await makeApp();
    const sid = uuid(1), story = { id: sid, url: 'https://good.example/article' };
    insertStory(e, { id: sid, url: story.url, published_at: new Date(NOW - 3600e3).toISOString(), thumb_status: 'pending' });
    const web = stubWeb({ pages: { 'https://good.example/article': PAGE('https://img.good.example/photo.jpg?w=1600', null) } });
    const res = await processThumbs(e.env, { fetchImpl: web, limit: 3 });
    const obj = await e.env.NEWS_THUMBS.get(thumbKey(sid));
    const imgCall = web.calls.find(c => c.url.startsWith('https://img.good.example/photo.jpg'));
    check('the image is fetched through Image Transformations: 400 px wide, WebP, quality 70', imgCall && imgCall.init.cf.image.width === 400 && imgCall.init.cf.image.format === 'webp' && imgCall.init.cf.image.quality === 70);
    check('...stored in R2 at thumbs/<id>.webp as image/webp, cached 30 days, and the row points at it', res.done === 1 && obj && obj.httpMetadata.contentType === 'image/webp' && obj.httpMetadata.cacheControl === 'public, max-age=2592000' && rows(e)[0].thumb_key === `thumbs/${sid}.webp` && rows(e)[0].thumb_status === 'done');
    const served = await call(e, 'GET', `/news-img/${sid}.webp`);
    check('/news-img/<id>.webp serves it (WebP, long cache); an unknown id is a 404', served.status === 200 && served.r.headers.get('content-type') === 'image/webp' && /max-age=2592000/.test(served.r.headers.get('cache-control')) && (await call(e, 'GET', `/news-img/${uuid(99)}.webp`)).status === 404);
    const api = await call(e, 'GET', '/api/news');
    check('the API gives our thumbnail URL', api.json.stories[0].thumb_url === `/news-img/${sid}.webp`);

    // No transformation (e.g. not enabled for the zone): never store the original.
    const e2 = await makeApp();
    insertStory(e2, { id: uuid(2), url: 'https://good.example/article', published_at: new Date(NOW).toISOString(), thumb_status: 'pending' });
    await processThumbs(e2.env, { fetchImpl: stubWeb({ transform: false, pages: { 'https://good.example/article': PAGE('https://img.good.example/photo.jpg', null) } }) });
    check('no transformation -> no thumbnail and nothing stored (never a full-size image)', e2.env.NEWS_THUMBS._objects.size === 0 && rows(e2)[0].thumb_status === 'failed:no_transform' && rows(e2)[0].thumb_key === null);
    // A publisher that serves its own full-size WebP (no transformation ran): refused.
    const e2b = await makeApp();
    insertStory(e2b, { id: uuid(22), url: 'https://good.example/article', published_at: new Date(NOW).toISOString(), thumb_status: 'pending' });
    await processThumbs(e2b.env, { fetchImpl: stubWeb({ nativeWebp: true, pages: { 'https://good.example/article': PAGE('https://img.good.example/photo.webp', null) } }) });
    check('a WebP wider than 400 px (the publisher\'s own file, not our resize) is refused, nothing stored', e2b.env.NEWS_THUMBS._objects.size === 0 && rows(e2b)[0].thumb_status === 'failed:not_resized');
    // robots.txt disallows the article -> the page is never fetched.
    const e3 = await makeApp();
    insertStory(e3, { id: uuid(3), url: 'https://strict.example/news/1', published_at: new Date(NOW).toISOString(), thumb_status: 'pending' });
    const w3 = stubWeb({ robots: { 'strict.example': 'User-agent: *\nDisallow: /news/' } });
    await processThumbs(e3.env, { fetchImpl: w3 });
    check('robots.txt disallowing the article: skipped, the page never fetched', rows(e3)[0].thumb_status === 'skipped:robots' && !w3.calls.some(c => c.url === 'https://strict.example/news/1'));
    // A publisher on thumb_blocklist: listed, never fetched.
    const e4 = await makeApp();
    e4.d1.exec(`UPDATE news_config SET value = '["optout.example"]' WHERE key = 'thumb_blocklist'`);
    insertStory(e4, { id: uuid(4), url: 'https://www.optout.example/a', published_at: new Date(NOW).toISOString(), thumb_status: 'pending' });
    const w4 = stubWeb();
    await processThumbs(e4.env, { fetchImpl: w4 });
    check('thumb_blocklist honored: no request to that publisher at all, the story still listed', rows(e4)[0].thumb_status === 'skipped:thumb_blocklist' && !w4.calls.some(c => /optout\.example/.test(c.url)) && (await call(e4, 'GET', '/api/news')).json.stories.length === 1);
    // A page that fails: the story stays, without a thumbnail, and is not retried.
    const e5 = await makeApp();
    insertStory(e5, { id: uuid(5), url: 'https://down.example/a', published_at: new Date(NOW).toISOString(), thumb_status: 'pending' });
    await processThumbs(e5.env, { fetchImpl: stubWeb({ failPages: ['https://down.example/a'] }) });
    const w5 = stubWeb();
    await processThumbs(e5.env, { fetchImpl: w5 });
    check('a failed page: the story intact with no thumbnail, and no retry', rows(e5).length === 1 && rows(e5)[0].thumb_status === 'failed:page_http_500' && !w5.calls.some(c => /down\.example/.test(c.url)));
    // A Google redirect link (stories stored before the switch): nothing to fetch.
    const g = await makeThumb(e5.env, { id: uuid(6), url: 'https://news.google.com/rss/articles/ABC' }, { fetchImpl: stubWeb(), cfg: { thumb_blocklist: [] } });
    check('a Google News redirect link is skipped (no article page)', g.status === 'skipped' && g.reason === 'no_article_url');
    // The page prefers thumb_url, then image_url, then the badge.
    const js = fs.readFileSync(new URL('../public/js/news.js', import.meta.url), 'utf8');
    check('/news shows thumb_url first, then the feed\'s image_url, then the initial; in a fixed box (no layout shift)', /const thumbSrc = s => \(\/\^\\\/news-img\\\/[^?]+\? s\.thumb_url : safeUrl\(s\.image_url\)\)/.test(js) && /\.news-thumb\{flex-shrink:0; width:72px; height:72px;/.test(fs.readFileSync(new URL('../public/css/style.css', import.meta.url), 'utf8')));
  }

  console.log('5. Retention');
  {
    const e = await makeApp();
    const old = uuid(10), oldHidden = uuid(11), oldFeatured = uuid(12), fresh = uuid(13);
    const day31 = new Date(NOW - 31 * 864e5).toISOString();
    for (const [id, extra] of [[old, {}], [oldHidden, { hidden: 1 }], [oldFeatured, { featured: 1, importance: 2 }]]) {
      insertStory(e, { id, published_at: day31, thumb_key: thumbKey(id), ...extra });
      await e.env.NEWS_THUMBS.put(thumbKey(id), WEBP, { httpMetadata: { contentType: 'image/webp' } });
    }
    insertStory(e, { id: fresh, published_at: new Date(NOW - 2 * 864e5).toISOString(), thumb_key: thumbKey(fresh) });
    await e.env.NEWS_THUMBS.put(thumbKey(fresh), WEBP);
    const p = await pruneOld(e.env, NOW);
    check('a 31-day-old story: its row AND its R2 thumbnail are deleted', !rows(e).some(r => r.id === old) && !(await e.env.NEWS_THUMBS.get(thumbKey(old))));
    check('...hidden and featured stories are pruned the same (no exemptions)', !rows(e).some(r => r.id === oldHidden || r.id === oldFeatured) && !(await e.env.NEWS_THUMBS.get(thumbKey(oldFeatured))));
    check('...a newer story and its thumbnail stay; the counts are reported', rows(e).some(r => r.id === fresh) && !!(await e.env.NEWS_THUMBS.get(thumbKey(fresh))) && p.stories_pruned === 3 && p.thumbs_deleted === 3);
    await e.env.NEWS_THUMBS.put(thumbKey(uuid(77)), WEBP);
    await e.env.NEWS_THUMBS.put('thumbs/not-a-story.webp', WEBP);
    const o = await sweepOrphans(e.env);
    check('the orphan sweep deletes thumbnails with no story, keeps the rest', o.orphans_deleted === 2 && !(await e.env.NEWS_THUMBS.get(thumbKey(uuid(77)))) && !!(await e.env.NEWS_THUMBS.get(thumbKey(fresh))));
    // Keyset pages survive rows vanishing mid-pagination.
    const k = await makeApp();
    for (let i = 0; i < 6; i++) insertStory(k, { id: uuid(100 + i), title: `Cybercab story number ${i} unique words ${i}`, published_at: new Date(NOW - i * 3600e3).toISOString() });
    const p1 = await call(k, 'GET', '/api/news?limit=2');
    k.d1.exec(`DELETE FROM news_articles WHERE id IN ('${uuid(101)}', '${uuid(102)}')`);   // page 1's last row and the next one vanish
    const p2 = await call(k, 'GET', `/api/news?limit=2&cursor=${p1.json.next_cursor}`);
    check('a cursor still works after rows vanish mid-pagination (keyset on published_at, id): no error, no repeats, still newest first', p2.status === 200 && p2.json.stories.map(s => s.id).join() === [uuid(103), uuid(104)].join() && !p2.json.stories.some(s => p1.json.stories.some(x => x.id === s.id)));
  }

  console.log('6. GET /api/news and moderation');
  {
    const a = await call(ctx, 'GET', '/api/news');
    const s = a.json.stories;
    check('newest first, one entry per story (the Phoenix cluster once, other outlets as "also")', a.status === 200 && s.filter(x => /Phoenix/.test(x.title)).length === 1 && s.find(x => /Phoenix/.test(x.title)).also.length === 2);
    check('each story has thumb_url and image_url (null until a thumbnail exists)', s.every(x => 'thumb_url' in x && 'image_url' in x));
    const major = await call(ctx, 'GET', '/api/news?importance=2');
    check('importance=2: the major stories only; search over title and excerpt', major.json.stories.every(x => x.importance === 2) && (await call(ctx, 'GET', '/api/news?q=snow')).json.stories.length === 1);
    check('moderation: 401 signed out, 403 for a rider', (await call(ctx, 'GET', '/api/moderation/news')).status === 401 && (await call(ctx, 'GET', '/api/moderation/news', { session: 'rider' })).status === 403);
    const snow = rows(ctx).find(x => /snow/.test(x.title));
    await call(ctx, 'POST', `/api/moderation/news/${snow.id}`, { session: 'mod', body: { action: 'hide' } });
    check('hide: kept in D1, never served', rows(ctx).some(x => x.id === snow.id) && !(await call(ctx, 'GET', '/api/news?limit=50')).json.stories.some(x => x.id === snow.id));
    await call(ctx, 'POST', `/api/moderation/news/${snow.id}`, { session: 'mod', body: { action: 'unhide' } });
    const feat = await call(ctx, 'POST', `/api/moderation/news/${snow.id}`, { session: 'mod', body: { action: 'feature' } });
    check('feature: importance 2', feat.json.story.importance === 2 && feat.json.story.featured === true);
    const put = await call(ctx, 'PUT', '/api/moderation/news-config', { session: 'mod', body: { thumb_blocklist: ['https://www.OptOut.example/path', 'bad domain', 'other.example'] } });
    check('thumb_blocklist is saved from moderation (normalized domains; junk dropped); other lists untouched', put.status === 200 && JSON.stringify(put.json.config.thumb_blocklist) === '["optout.example","other.example"]' && /cybercab/.test(put.json.config.allow));
    const pub = await call(ctx, 'PUT', '/api/moderation/news-config', { session: 'mod', body: { publisher_blocklist: ['electrek'] } });
    const e = await makeApp();
    e.d1.exec(`UPDATE news_config SET value = '["electrek"]' WHERE key = 'publisher_blocklist'`);
    const lg = await runNewsIngest(e.env, { fetchImpl: stubWeb(), nowMs: NOW });
    check('the publisher blocklist (any capitalization) drops that outlet\'s stories, counted; others unaffected', pub.status === 200 && !rows(e).some(x => x.source === 'Electrek') && lg.blocked_publisher === 4 && rows(e).some(x => x.source === 'Teslarati'));
    check('migration seeds: publisher_blocklist ["BASENOR"], thumb_blocklist []', e.d1.query(`SELECT value FROM news_config WHERE key = 'thumb_blocklist'`)[0].value === '[]' && (await makeApp()).d1.query(`SELECT value FROM news_config WHERE key = 'publisher_blocklist'`)[0].value === '["BASENOR"]');
    const realFetch = globalThis.fetch;
    globalThis.fetch = stubWeb();
    let r;
    try { r = await call(ctx, 'POST', '/api/moderation/news/run', { session: 'mod' }); } finally { globalThis.fetch = realFetch; }
    check('"Run the next ingest step now" runs one step (one feed, thumbnails, prune)', r.status === 200 && r.json.run.feeds.length === 1 && r.json.run.thumbs && 'done' in r.json.run.thumbs);
  }

  console.log('6. Major scoring');
  {
    const one = (title, extra = {}) => clusterAndScore([{ id: 'x', title, excerpt: '', source: 'Solo', published_at: '2026-10-09T00:00:00Z', ...extra }]).x;
    const reg = one('Tesla Adds 150 Cybercabs to Its Texas Robotaxi Registry');
    check('"Tesla Adds 150 Cybercabs to Its Texas Robotaxi Registry", one outlet: Major (number + fleet word, registry keyword)', reg.importance === 2 && reg.rules === 2);
    check('"Dozens of Tesla Cybercabs Just Took Over the Dallas Robotaxi Lot", one outlet: Major ("dozens" counts as a number)', one('Dozens of Tesla Cybercabs Just Took Over the Dallas Robotaxi Lot').importance === 2);
    check('a number without a fleet word, or a fleet word without a number: no numeric signal', one('Tesla Q3 2026 earnings call date set').rules === 0 && one('Robotaxi riders praise smooth trip').rules === 0);
    check('a single-outlet crash story with no other signal stays at 1', one('Tesla Cybercab crash on Lamar Blvd').importance === 1);
    const three = clusterAndScore(['A', 'B', 'C'].map((src, i) => ({ id: 'p' + i, title: 'Cybercab picks up riders near Zilker Park on Sunday', excerpt: 'Riders shared videos.', source: src, published_at: `2026-10-09T0${i}:00:00Z` })));
    check('a 3-outlet story with no keywords: 1, not Major', ['p0', 'p1', 'p2'].every(id => three[id].importance === 1 && three[id].source_count === 3));
    check('keywords are case-insensitive, start-of-word, and read the excerpt too', one('TESLA CYBERCAB RECALL').importance === 1 && one('Cybercab LAUNCHES rides').importance === 1 && one('Cybercab owner issues statement').importance === 0 && one('Cybercab story', { excerpt: 'The NHTSA asked questions.' }).importance === 1);
    check('a stored AI "major" verdict adds +1; featured is always 2; capped at 2', one('Tesla Cybercab crash on Lamar Blvd', { ai_major: 1 }).importance === 2 && one('Cybercab spotted', { featured: 1 }).importance === 2 && one('Tesla Adds 150 Cybercabs to fleet registry', { ai_major: 1 }).importance === 2);
    const seeded = (await makeApp()).d1.query(`SELECT value FROM news_config WHERE key = 'major_keywords'`)[0].value;
    check('migration 0032 seeds major_keywords with the full list (old + fleet + DMV + new-market terms)', JSON.stringify(JSON.parse(seeded)) === JSON.stringify(DEFAULT_MAJOR_KEYWORDS) && ['launch', 'nhtsa', 'fleet', 'rolls out', 'dmv', 'self-certification', 'arrives in'].every(k => DEFAULT_MAJOR_KEYWORDS.includes(k)));
    check('the AI binding is configured (Workers AI)', /"ai":\s*\{\s*"binding":\s*"AI"/.test(fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8')));

    // A new-story ingest with a mocked Workers AI.
    const AI_FEED = RSS([
      rssItem('Tesla Adds 150 Cybercabs to Its Texas Robotaxi Registry', 'https://electrek.co/registry/', 2, 'The registry grew again.'),
      rssItem('Tesla Cybercab crash on Lamar Blvd', 'https://electrek.co/lamar/', 3, 'A minor fender bender.'),
      rssItem('Cybercab spotted downtown near the Capitol', 'https://electrek.co/capitol/', 4, 'A white Cybercab was seen.')
    ]);
    const aiWeb = () => async url => { const f = FEEDS.find(x => x.url === String(url)); return new Response(f && f.id === 'electrek' ? AI_FEED : RSS([])); };
    const mockAI = answer => { const calls = []; return { calls, run: async (model, input) => { calls.push({ model, text: input.messages[1].content }); return answer(input); } }; };
    const imp = (e, re) => rows(e).find(x => re.test(x.title));
    for (const [label, answer, expect] of [['major', () => ({ response: 'major: a crash is a safety event' }), 2], ['not-major', () => ({ response: 'not-major: minor incident' }), 1]]) {
      const e = await makeApp();
      e.env.AI = mockAI(answer);
      const lg = await runNewsIngest(e.env, { fetchImpl: aiWeb(), nowMs: NOW });
      check(`AI "${label}" on the rules-score-1 story -> importance ${expect}; reason stored and logged`, imp(e, /Lamar/).importance === expect && imp(e, /Lamar/).ai_major === (expect === 2 ? 1 : 0) && imp(e, /Lamar/).ai_reason && lg.ai.checked === 1 && lg.ai.verdicts[0].reason === imp(e, /Lamar/).ai_reason);
      check(`...only that story was sent to the model (scores 0 and 2 skip it): ${label}`, e.env.AI.calls.length === 1 && /Lamar/.test(e.env.AI.calls[0].text) && /llama/.test(e.env.AI.calls[0].model) && imp(e, /Registry/).importance === 2 && imp(e, /Registry/).ai_major === null && imp(e, /Capitol/).importance === 0 && imp(e, /Capitol/).ai_major === null);
    }
    {
      const e = await makeApp();
      e.env.AI = mockAI(() => { throw new Error('upstream 500'); });
      const lg = await runNewsIngest(e.env, { fetchImpl: aiWeb(), nowMs: NOW });
      check('AI error: the rules score stands (1), nothing invented, the ingest completes, the failure logged', imp(e, /Lamar/).importance === 1 && imp(e, /Lamar/).ai_major === null && lg.new === 3 && lg.ai.failed === 1 && /upstream 500/.test(lg.ai.verdicts[0].error));
      const g = await makeApp();
      g.env.AI = mockAI(() => ({ response: 'Sure! Here is my analysis of the story.' }));
      const lg2 = await runNewsIngest(g.env, { fetchImpl: aiWeb(), nowMs: NOW });
      check('AI garbage: the rules score stands, logged as unparseable', imp(g, /Lamar/).importance === 1 && lg2.ai.failed === 1 && lg2.ai.verdicts[0].error === 'ai_unparseable');
      const h = await makeApp();
      const lg3 = await runNewsIngest(h.env, { fetchImpl: aiWeb(), nowMs: NOW });
      check('no AI binding: the rules score stands, logged', imp(h, /Lamar/).importance === 1 && lg3.ai.verdicts[0].error === 'ai_unavailable');
      let hang = false;
      try { await aiVerdict({ AI: { run: () => new Promise(() => {}) } }, { title: 'x' }, { timeoutMs: 30 }); } catch (err) { hang = err.message === 'ai_timeout'; }
      check('AI timeout: the call gives up (ai_timeout) instead of hanging the ingest', hang);
      check('the verdict parser: "major: …" / "not-major: …", markdown tolerated, anything else rejected', parseVerdict('**Major**: fleet growth').major === true && parseVerdict('**Major**: fleet growth').reason === 'fleet growth' && parseVerdict('Not major - app update').major === false && parseVerdict('maybe?') === null);
    }

    // The daily rescore: rules only, the moderator's keywords from the next run, hidden stays hidden.
    {
      const e = await makeApp();
      e.env.AI = mockAI(() => ({ response: 'major: should never be asked' }));
      const at = h => new Date(NOW - h * 3600e3).toISOString();
      insertStory(e, { id: uuid(1), title: 'Tesla Adds 150 Cybercabs to Its Texas Robotaxi Registry', published_at: at(24 * 9) });   // stored at 0 under the old rules
      insertStory(e, { id: uuid(2), title: 'Cybercab parade in Round Rock', published_at: at(24 * 3), hidden: 1 });
      insertStory(e, { id: uuid(3), title: 'Cybercab parade in Round Rock again', published_at: at(24 * 12) });
      const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(NOW));
      await e.env.TESLA_SESSIONS.put('news:last_prune', JSON.stringify({ day }));
      await e.env.TESLA_SESSIONS.put('news:last_sweep', JSON.stringify({ month: day.slice(0, 7) }));
      const t1 = await runNewsTick(e.env, { fetchImpl: stubWeb({ notModified: true }), nowMs: NOW });
      const get = id => e.d1.query(`SELECT importance, hidden, ai_major FROM news_articles WHERE id = '${id}'`)[0];
      check('the daily rescore: a stored 9-day-old story that newly qualifies becomes Major, with no AI call', t1.rescored >= 1 && get(uuid(1)).importance === 2 && get(uuid(1)).ai_major === null && e.env.AI.calls.length === 0);
      const t2 = await runNewsTick(e.env, { fetchImpl: stubWeb({ notModified: true }), nowMs: NOW + 600e3 });
      check('...once a day (the next step does not rescore again)', t2.rescored === undefined);
      const put = await call(e, 'PUT', '/api/moderation/news-config', { session: 'mod', body: { major_keywords: ['  Parade ', 'parade', 'Round   Rock'] } });
      check('major_keywords saved from moderation (trimmed, lowercased, deduped); other lists untouched', put.status === 200 && JSON.stringify(put.json.config.major_keywords) === '["parade","round rock"]' && /cybercab/.test(put.json.config.allow));
      check('...an invalid major_keywords is refused', (await call(e, 'PUT', '/api/moderation/news-config', { session: 'mod', body: { major_keywords: 'parade' } })).status === 400);
      const t3 = await runNewsTick(e.env, { fetchImpl: stubWeb({ notModified: true }), nowMs: NOW + 1200e3 });
      check('...and apply on the next run: matching stored stories rescored (12-day-old one included)', t3.rescored >= 1 && get(uuid(3)).importance === 1 && get(uuid(1)).importance === 1);
      check('hidden stays hidden through the rescore (it is scored, never shown)', get(uuid(2)).hidden === 1 && get(uuid(2)).importance === 1 && !(await call(e, 'GET', '/api/news')).json.stories.some(x => x.id === uuid(2)));
      const list = await call(e, 'GET', '/api/moderation/news', { session: 'mod' });
      check('moderation lists the Major keywords and each story\'s AI verdict fields', Array.isArray(list.json.config.major_keywords) && 'ai_major' in list.json.stories[0]);
    }
  }

  t.finish();
}

run().catch(e => { console.error(e); process.exit(1); });
