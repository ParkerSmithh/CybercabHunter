// /news (worker/news.js, migrations/0029): the feed ingest against stubbed
// RSS / Atom, the public API and the moderator tools.
//   - parsing: Google News (" - Publisher" stripped, the source tag), RSS with
//     an enclosure, Atom; canonical URLs without tracking params
//   - the allowlist (cybercab, or robotaxi + tesla) and the blocklist (stock
//     stories), both read from news_config
//   - reruns insert nothing twice; a 304 is "nothing new"
//   - the same story at three outlets is one cluster, importance 2
//   - GET /api/news: shape, newest first, cursor pages, hidden never served,
//     major-only, search
//   - moderation: 401 / 403 for others; hide / unhide / feature; config edit
//   - the scheduled run only works at 6 AM Chicago
// Run: node tests/news.test.mjs

import worker from '../worker/index.js';
import { makeEnv, makeCheck } from './helpers/env.mjs';
import { runNewsIngest, runScheduledNews, parseFeed, canonicalUrl, clusterAndScore, NEWS_CRON, FEEDS } from '../worker/news.js';
import fs from 'node:fs';

const t = makeCheck();
const { check } = t;
const NOW = Date.parse('2026-10-09T11:00:00Z');   // 6 AM CDT
const iso = h => new Date(NOW - h * 3600e3).toUTCString();

const gItem = (title, src, srcUrl, hoursAgo, id) => `<item><title>${title} - ${src}</title><link>https://news.google.com/rss/articles/${id}?oc=5</link><guid isPermaLink="false">${id}</guid><pubDate>${iso(hoursAgo)}</pubDate><description>&lt;a href="https://news.google.com/rss/articles/${id}?oc=5"&gt;${title}&lt;/a&gt;&amp;nbsp;&amp;nbsp;&lt;font color="#6f6f6f"&gt;${src}&lt;/font&gt;</description><source url="${srcUrl}">${src}</source></item>`;
const GOOGLE = `<?xml version="1.0"?><rss><channel><title>Google News</title>
${gItem('Tesla Cybercab launches in Phoenix, its third city', 'Reuters', 'https://www.reuters.com', 5, 'AAA1')}
${gItem('Tesla launches Cybercab in Phoenix as third city', 'The Verge', 'https://www.theverge.com', 7, 'AAA2')}
${gItem('Cybercab launches in Phoenix: Tesla third city', 'CNBC', 'https://www.cnbc.com', 9, 'AAA3')}
${gItem('Tesla stock jumps as Cybercab hype builds', 'MarketWatch', 'https://www.marketwatch.com', 3, 'AAA4')}
${gItem('Ford unveils a new electric pickup', 'Autoblog', 'https://www.autoblog.com', 2, 'AAA5')}
${gItem('Tesla robotaxi app adds airport pickups in Austin', 'Teslarati', 'https://www.teslarati.com', 30, 'AAA6')}
${gItem('Tesla posts video of the Cybercab interior', 'Tesla', 'https://www.tesla.com', 50, 'AAA7')}
</channel></rss>`;
const ELECTREK = `<?xml version="1.0"?><rss xmlns:media="http://search.yahoo.com/mrss/"><channel>
<item><title><![CDATA[Tesla Cybercab spotted testing in snow]]></title><link>https://electrek.co/2026/10/08/cybercab-snow/?utm_source=rss&amp;utm_medium=feed</link><pubDate>${iso(20)}</pubDate>
<description><![CDATA[<p>A Tesla Cybercab prototype was seen <b>testing</b> on snowy roads near the Gigafactory, a first for the two-seat robotaxi.</p>]]></description>
<enclosure url="https://electrek.co/wp-content/uploads/cybercab-snow.jpg" type="image/jpeg" length="48000"/></item>
<item><title>Rivian R2 deliveries begin</title><link>https://electrek.co/2026/10/08/r2/</link><pubDate>${iso(21)}</pubDate><description>Not about robotaxis.</description></item>
</channel></rss>`;
const VERGE_ATOM = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
<entry><title type="html"><![CDATA[Tesla’s robotaxi service expands to Dallas suburbs]]></title><link rel="alternate" type="text/html" href="https://www.theverge.com/transportation/1/tesla-robotaxi-dallas" /><published>2026-10-08T09:00:00-04:00</published><summary type="html"><![CDATA[Tesla’s robotaxi now covers Plano and Frisco.]]></summary></entry>
</feed>`;

function stubFetch({ notModified = false } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const u = String(url);
    if (init.method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': '40000' } });
    if (notModified && !u.includes('news.google.com')) return new Response(null, { status: 304 });
    if (u.includes('news.google.com')) return new Response(u.includes('after%3A') ? '<rss><channel></channel></rss>' : GOOGLE, { headers: { 'content-type': 'application/xml' } });
    if (u.includes('electrek')) return new Response(ELECTREK, { headers: { etag: '"e1"', 'last-modified': 'Fri, 09 Oct 2026 10:00:00 GMT' } });
    if (u.includes('theverge')) return new Response(VERGE_ATOM, { headers: { etag: '"v1"' } });
    return new Response('<rss><channel></channel></rss>');
  };
  fn.calls = calls;
  return fn;
}

async function makeApp() {
  const ctx = await makeEnv({ users: ['rider', 'mod'] });
  ctx.d1.exec(`UPDATE users SET role = 'moderator' WHERE id = 'mod'`);
  for (const u of ['rider', 'mod']) await ctx.env.TESLA_SESSIONS.put(`session:session-${u}`, JSON.stringify({ user_id: u }));
  ctx.env.ASSETS = { fetch: async () => new Response('asset') };
  return ctx;
}
const call = async (ctx, method, path, { session, body } = {}) => {
  const headers = { Origin: 'https://cybercabhunter.com' };
  if (session) headers.Authorization = `Bearer session-${session}`;
  if (body) headers['Content-Type'] = 'application/json';
  const r = await worker.fetch(new Request(`https://x${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }), ctx.env, { waitUntil() {} });
  let json = null; try { json = await r.clone().json(); } catch (e) { json = null; }
  return { status: r.status, json };
};
const rows = ctx => ctx.d1.query(`SELECT * FROM news_articles ORDER BY published_at DESC`);

async function run() {
  console.log('1. Parsing and URLs');
  {
    const g = parseFeed(GOOGLE, FEEDS.find(f => f.kind === 'google'));
    check('Google News: the " - Publisher" suffix is stripped and the outlet comes from <source>', g[0].title === 'Tesla Cybercab launches in Phoenix, its third city' && g[0].source === 'Reuters');
    check('...its description (just the headline again) gives no excerpt', g[0].excerpt === null);
    check('...a tesla.com story is "official", a Reuters one "press"', g.find(i => i.source === 'Tesla').source_type === 'official' && g[0].source_type === 'press');
    const e = parseFeed(ELECTREK, FEEDS.find(f => f.id === 'electrek'));
    check('RSS: CDATA title, tags stripped from the excerpt, the enclosure as a thumbnail candidate', e[0].title === 'Tesla Cybercab spotted testing in snow' && /^A Tesla Cybercab prototype was seen testing on snowy roads/.test(e[0].excerpt) && !/<|>/.test(e[0].excerpt) && e[0].media[0].url.endsWith('cybercab-snow.jpg'));
    check('canonical URL: tracking params removed', e[0].url === 'https://electrek.co/2026/10/08/cybercab-snow/' && canonicalUrl('https://x.com/a?utm_source=b&fbclid=c&gclid=d&id=7') === 'https://x.com/a?id=7');
    const a = parseFeed(VERGE_ATOM, FEEDS.find(f => f.id === 'theverge'));
    check('Atom: the alternate link, published date, summary', a.length === 1 && a[0].url === 'https://www.theverge.com/transportation/1/tesla-robotaxi-dallas' && a[0].published_at === '2026-10-08T13:00:00.000Z' && /Plano and Frisco/.test(a[0].excerpt));
    const long = parseFeed(`<rss><item><title>Cybercab</title><link>https://a.com/1</link><pubDate>${iso(1)}</pubDate><description>${'word '.repeat(200)}</description></item></rss>`, { id: 'x', kind: 'rss', name: 'A' });
    check('an excerpt is at most ~280 characters, never the full text', long[0].excerpt.length <= 280 && long[0].excerpt.endsWith('…'));
  }

  console.log('2. The ingest');
  const ctx = await makeApp();
  {
    const f = stubFetch();
    const log = await runNewsIngest(ctx.env, { fetchImpl: f, nowMs: NOW });
    const r = rows(ctx);
    const titles = r.map(x => x.title);
    check('kept: the Cybercab and "Tesla robotaxi" stories', titles.includes('Tesla Cybercab spotted testing in snow') && titles.includes('Tesla robotaxi app adds airport pickups in Austin') && titles.includes('Tesla’s robotaxi service expands to Dallas suburbs'));
    check('dropped: the stock story (blocklist) and the generic EV stories (no match)', !titles.some(x => /stock|Ford|Rivian/.test(x)) && log.dropped >= 3);
    check('every feed was fetched with a descriptive User-Agent', f.calls.filter(c => c.init.method !== 'HEAD').every(c => /CybercabHunter-NewsBot/.test(c.init.headers['User-Agent'])) && FEEDS.every(fd => f.calls.some(c => c.url === fd.url)));
    check('the first run backfills 30 days from Google News date windows', log.backfill === true && f.calls.filter(c => /after%3A/.test(c.url)).length >= 14);
    check('the thumbnail came only from the feed (its declared size checked), not a HEAD of anything else', r.find(x => /snow/.test(x.title)).image_url === 'https://electrek.co/wp-content/uploads/cybercab-snow.jpg');
    const phx = r.filter(x => /Phoenix/.test(x.title));
    check('the same story at three outlets: one cluster, the earliest item primary, 3 outlets, importance 2 (3+ outlets in 24 h and "launch")', phx.length === 3 && new Set(phx.map(x => x.cluster_id)).size === 1 && phx[0].cluster_id === phx.find(x => x.source === 'CNBC').id && phx.every(x => x.source_count === 3 && x.importance === 2));
    check('a one-outlet story with an "expands" headline is notable (1); a plain one normal (0)', r.find(x => /Dallas suburbs/.test(x.title)).importance === 1 && r.find(x => /snow/.test(x.title)).importance === 0);
    check('the run is logged', JSON.parse(await ctx.env.TESLA_SESSIONS.get('news:last_run')).new === r.length);
    const before = r.length;
    const f2 = stubFetch();
    const again = await runNewsIngest(ctx.env, { fetchImpl: f2, nowMs: NOW + 3600e3 });
    check('a rerun inserts nothing twice (URL is UNIQUE), and does not backfill again', rows(ctx).length === before && again.new === 0 && again.backfill === false);
    check('...and sends the saved validators (If-None-Match / If-Modified-Since)', f2.calls.some(c => c.url.includes('electrek') && c.init.headers['If-None-Match'] === '"e1"' && c.init.headers['If-Modified-Since']));
    const f3 = stubFetch({ notModified: true });
    const nm = await runNewsIngest(ctx.env, { fetchImpl: f3, nowMs: NOW + 7200e3 });
    check('a 304 is "nothing new"', nm.not_modified >= 5 && nm.new === 0);
    const dup = await makeApp();
    const twice = async (url, body) => { const ok = { headers: {} }; return new Response(body, ok); };
    const fx = async (url, init = {}) => {
      const u = String(url);
      if (init.method === 'HEAD') return new Response(null, { status: 404 });
      if (u.includes('electrek')) return new Response(`<rss><item><title>Cybercab loses a door in Philadelphia</title><link>https://electrek.co/door/</link><pubDate>${iso(4)}</pubDate><description>The door came off.</description></item></rss>`);
      if (u.includes('news.google.com') && !u.includes('after%3A')) return new Response(`<rss>${gItem('Cybercab loses a door in Philadelphia', 'Electrek', 'https://electrek.co', 4, 'DUP1')}${gItem('Old Cybercab story from spring', 'Reuters', 'https://www.reuters.com', 24 * 60, 'OLD1')}</rss>`);
      return new Response('<rss></rss>');
    };
    await runNewsIngest(dup.env, { fetchImpl: fx, nowMs: NOW });
    const dr = rows(dup);
    check('the same outlet\'s same headline via Google News is one story (the publisher\'s own item, with its excerpt, kept)', dr.filter(x => /door/.test(x.title)).length === 1 && dr.find(x => /door/.test(x.title)).url === 'https://electrek.co/door/' && /door came off/.test(dr.find(x => /door/.test(x.title)).excerpt));
    check('stories older than 30 days are not stored', !dr.some(x => /spring/.test(x.title)));
  }

  console.log('3. GET /api/news');
  {
    const a = await call(ctx, 'GET', '/api/news');
    const s = a.json.stories;
    check('newest first, one entry per story (the Phoenix cluster once, its other outlets as "also")', a.status === 200 && s.filter(x => /Phoenix/.test(x.title)).length === 1 && s.find(x => /Phoenix/.test(x.title)).also.length === 2 && s.every((x, i) => !i || s[i - 1].published_at >= x.published_at));
    const p = s.find(x => /Phoenix/.test(x.title));
    check('the shape: id, title, url, source, source_type, published_at, excerpt, image_url, importance, source_count, tags, also', ['id', 'title', 'url', 'source', 'source_type', 'published_at', 'excerpt', 'image_url', 'importance', 'source_count', 'tags', 'also'].every(k => k in p) && p.tags.includes('Expansion') && p.also.every(o => o.url && o.source));
    check('the disclosure travels with the data', /picked and summarized automatically/.test(a.json.disclosure));
    const p1 = await call(ctx, 'GET', '/api/news?limit=2');
    const p2 = await call(ctx, 'GET', `/api/news?limit=2&cursor=${p1.json.next_cursor}`);
    check('cursor pages: no overlap, still newest first', p1.json.stories.length === 2 && p2.json.stories.length >= 1 && !p2.json.stories.some(x => p1.json.stories.some(y => y.id === x.id)) && p2.json.stories[0].published_at <= p1.json.stories[1].published_at);
    const major = await call(ctx, 'GET', '/api/news?importance=2');
    check('importance=2: the major stories only', major.json.stories.length >= 1 && major.json.stories.every(x => x.importance === 2));
    const q = await call(ctx, 'GET', '/api/news?q=snow');
    check('search over title and excerpt', q.json.stories.length === 1 && /snow/.test(q.json.stories[0].title));
  }

  console.log('4. Moderation');
  {
    check('signed out: 401; an ordinary rider: 403', (await call(ctx, 'GET', '/api/moderation/news')).status === 401 && (await call(ctx, 'GET', '/api/moderation/news', { session: 'rider' })).status === 403);
    const list = await call(ctx, 'GET', '/api/moderation/news', { session: 'mod' });
    check('a moderator sees every story, the last run and the config', list.status === 200 && list.json.stories.length === rows(ctx).length && list.json.last_run && /cybercab/.test(list.json.config.allow));
    const snow = rows(ctx).find(x => /snow/.test(x.title));
    const hide = await call(ctx, 'POST', `/api/moderation/news/${snow.id}`, { session: 'mod', body: { action: 'hide' } });
    const pub = await call(ctx, 'GET', '/api/news?limit=50');
    check('hide: kept in D1, never served', hide.json.story.hidden === true && rows(ctx).some(x => x.id === snow.id) && !pub.json.stories.some(x => x.id === snow.id));
    await call(ctx, 'POST', `/api/moderation/news/${snow.id}`, { session: 'mod', body: { action: 'unhide' } });
    const feat = await call(ctx, 'POST', `/api/moderation/news/${snow.id}`, { session: 'mod', body: { action: 'feature' } });
    check('unhide, then feature: importance 2', feat.json.story.featured === true && feat.json.story.importance === 2);
    await runNewsIngest(ctx.env, { fetchImpl: stubFetch(), nowMs: NOW + 9000e3 });
    check('...and a rerun keeps a featured story at 2', rows(ctx).find(x => x.id === snow.id).importance === 2);
    await call(ctx, 'POST', `/api/moderation/news/${snow.id}`, { session: 'mod', body: { action: 'unfeature' } });
    check('unfeature: back to its scored importance', rows(ctx).find(x => x.id === snow.id).importance === 0);
    check('an unknown action is refused', (await call(ctx, 'POST', `/api/moderation/news/${snow.id}`, { session: 'mod', body: { action: 'delete' } })).status === 400);
    const cfg = await call(ctx, 'PUT', '/api/moderation/news-config', { session: 'mod', body: { allow: 'cybercab\nrobotaxi + tesla', block: 'stock\nsnow' } });
    check('the lists are edited without a redeploy...', cfg.status === 200 && ctx.d1.query(`SELECT value FROM news_config WHERE key = 'block'`)[0].value === 'stock\nsnow');
    const fresh = await makeApp();
    fresh.d1.exec(`UPDATE news_config SET value = 'stock\nsnow' WHERE key = 'block'`);
    await runNewsIngest(fresh.env, { fetchImpl: stubFetch(), nowMs: NOW });
    check('...and the next run uses them', !rows(fresh).some(x => /snow/.test(x.title)));
    check('an empty allowlist is refused', (await call(ctx, 'PUT', '/api/moderation/news-config', { session: 'mod', body: { allow: '  ', block: '' } })).status === 400);
  }

  console.log('5. The schedule');
  {
    const wr = fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
    check('the cron fires at 11:00 and 12:00 UTC (6 AM Chicago in CDT and CST)', NEWS_CRON === '0 11,12 * * *' && wr.includes('"0 11,12 * * *"'));
    const e = await makeApp();
    check('only the run that is 6 AM in Chicago does the work', (await runScheduledNews(e.env, Date.parse('2026-10-09T12:00:00Z'))).skipped === 'not_the_local_hour' && (await runScheduledNews(e.env, Date.parse('2026-12-09T11:00:00Z'))).skipped === 'not_the_local_hour');
    const chain = clusterAndScore([
      { id: 'c1', title: 'Cybercab launches rides in Austin today for public', source: 'A', published_at: '2026-10-01T00:00:00Z' },
      { id: 'c2', title: 'Cybercab launches public rides in Austin today, feds watch', source: 'B', published_at: '2026-10-01T02:00:00Z' },
      { id: 'c3', title: 'Feds watch Cybercab rides today in Austin, probe', source: 'C', published_at: '2026-10-01T04:00:00Z' }]);
    check('no chaining: a story joins a cluster only by matching its first story', chain.c1.cluster_id === chain.c2.cluster_id && chain.c3.cluster_id !== chain.c1.cluster_id);
    const groups = clusterAndScore([
      { id: 'a', title: 'Cybercab enters Miami market with ten cars', source: 'A', published_at: '2026-10-01T00:00:00Z' },
      { id: 'b', title: 'Cybercab enters Miami market with ten cars today', source: 'B', published_at: '2026-10-05T00:00:00Z' }]);
    check('stories days apart are not merged (72 h window)', groups.a.cluster_id !== groups.b.cluster_id);
  }

  t.finish();
}

run().catch(e => { console.error(e); process.exit(1); });
