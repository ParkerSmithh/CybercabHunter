// Cybercab news: an automatic headline aggregator for /news (public/news.html).
//
// INGEST (scheduled, runNewsIngest): once a day at 6 AM America/Chicago
// (NEWS_CRON fires at 11:00 and 12:00 UTC; NEWS_LOCAL_HOURS keeps the one that
// is 6 AM in Chicago, so daylight saving needs no change — to run more often,
// widen both). Each run:
//   1. fetches the RSS / Atom feeds below, politely: a descriptive
//      User-Agent, If-None-Match / If-Modified-Since from the last run, and a
//      304 is "nothing new" (Google News sends no validators, so it is simply
//      fetched once a day). The five publisher feeds' robots.txt allow their
//      feed paths (checked Oct 9, 2026). Google News's robots.txt disallows
//      /rss/ for generic bots; the owner chose to fetch its four RSS searches
//      anyway, once a day, as the syndication endpoints they are.
//   2. parses title, link, publisher, date, description and an RSS media
//      thumbnail (enclosure / media:content / media:thumbnail only — never a
//      page's og:image);
//   3. keeps an item when it matches the allowlist (default: "cybercab", or
//      "robotaxi" AND "tesla") and its title hits nothing on the blocklist
//      (stock-price stories); both lists live in news_config and are edited
//      from /moderation without a redeploy;
//   4. stores it once: the canonical URL (tracking params removed) is UNIQUE,
//      so reruns insert nothing twice; then re-clusters the recent stories by
//      normalized-title similarity (same story, other outlets -> one
//      cluster_id, the earliest item primary, source_count = outlets);
//   5. scores each cluster: +1 when 3+ outlets ran it within 24 h, +1 for a
//      launch / expansion / crash / recall / NHTSA / investigation / lawsuit /
//      new city / safety / price headline (2 = major, 1 = notable, 0 =
//      normal); a story a moderator FEATURED is always 2;
//   6. classifies the publisher: official (tesla.com, nhtsa.gov, waymo.com),
//      social (x.com, youtube.com) or press.
// The first run backfills 30 days from Google News date windows; later runs
// are incremental. Each run is logged (KV news:last_run, and console).
//
// Excerpts are the feed's own description, tags stripped, at most 280
// characters — never invented, never the article body. A Google News
// description is only the headline again, so those stories carry none.

const UA = 'CybercabHunter-NewsBot/1.0 (+https://cybercabhunter.com/news; daily RSS check)';
export const NEWS_CRON = '0 11,12 * * *';
const NEWS_LOCAL_HOURS = [6];          // America/Chicago hours a cron run counts
const TZ = 'America/Chicago';
const EXCERPT_MAX = 280;
const RECLUSTER_DAYS = 14;             // normal run: re-cluster this many days back
const BACKFILL_DAYS = 30;
const BACKFILL_WINDOW_DAYS = 4;        // Google News returns at most 100 per search
const THUMB_MAX_BYTES = 350 * 1024;    // a thumbnail, never a full-size photo
const THUMB_CHECKS_PER_RUN = 20;
const CACHE_SECONDS = 900;
const KV_RUN = 'news:last_run';
const KV_BACKFILLED = 'news:backfilled';
const kvFeed = id => `news:feed:${id}`;
const MAX_AGE_DAYS = 30;               // older items are not stored
const storyKey = it => `${String(it.source).toLowerCase()}|${[...titleTokens(it.title)].sort().join(' ')}`;

const googleSearch = q => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
// Publisher feeds first: when Google News carries the same outlet's same
// headline, the publisher's own item (with its excerpt and thumbnail) wins.
export const FEEDS = [
  { id: 'electrek', kind: 'rss', name: 'Electrek', url: 'https://electrek.co/feed/' },
  { id: 'teslarati', kind: 'rss', name: 'Teslarati', url: 'https://www.teslarati.com/feed/' },
  { id: 'insideevs', kind: 'rss', name: 'InsideEVs', url: 'https://insideevs.com/rss/articles/all/' },
  { id: 'theverge', kind: 'rss', name: 'The Verge', url: 'https://www.theverge.com/rss/index.xml' },
  { id: 'techcrunch', kind: 'rss', name: 'TechCrunch', url: 'https://techcrunch.com/feed/' },
  { id: 'gn-cybercab', kind: 'google', url: googleSearch('Tesla Cybercab') },
  { id: 'gn-robotaxi', kind: 'google', url: googleSearch('Tesla robotaxi') },
  { id: 'gn-robotaxi-austin', kind: 'google', url: googleSearch('Tesla robotaxi Austin') },
  { id: 'gn-robotaxi-dallas', kind: 'google', url: googleSearch('Tesla robotaxi Dallas') }
];
const BACKFILL_QUERIES = ['Tesla Cybercab', 'Tesla robotaxi'];

// Defaults for news_config (migrations/0029 seeds the same). One rule per line;
// "a + b" means both words. Matching is case-insensitive, on whole words.
export const DEFAULT_ALLOW = 'cybercab\nrobotaxi + tesla';
export const DEFAULT_BLOCK = 'stock\nstocks\nshares\nprice target\nTSLA\nwall street\nanalyst\nanalysts';

const IMPORTANT = /\b(launch(es|ed|ing)?|expan(sion|ds|d|ding)|crash(es|ed)?|recall(s|ed)?|nhtsa|investigat(ion|ions|es|ed|ing)|lawsuit(s)?|sue(s|d)?|new cit(y|ies)|safety|price(s|d)?|pricing)\b/i;
const OFFICIAL = ['tesla.com', 'nhtsa.gov', 'waymo.com'];
const SOCIAL = ['x.com', 'twitter.com', 'youtube.com', 'youtu.be'];

// ---------- small helpers ----------
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
function decode(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => (ENTITIES[n.toLowerCase()] != null ? ENTITIES[n.toLowerCase()] : m));
}
const stripTags = s => decode(decode(s)).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const tag = (xml, name) => { const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(xml); return m ? m[1] : ''; };
const attr = (el, name) => { const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(el); return m ? decode(m[1]) : ''; };
const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch (e) { return ''; } };
const onHost = (host, list) => list.some(d => host === d || host.endsWith('.' + d));

export function sourceType(publisherUrl) {
  const h = hostOf(publisherUrl);
  if (onHost(h, OFFICIAL)) return 'official';
  if (onHost(h, SOCIAL)) return 'social';
  return 'press';
}

// The canonical URL: https, no fragment, no tracking params (utm_*, fbclid,
// gclid, …). A Google News article link keeps its path only (its "oc" param
// is tracking too).
export function canonicalUrl(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch (e) { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  u.protocol = 'https:';
  u.hash = '';
  if (u.hostname === 'news.google.com') { u.search = ''; return u.toString(); }
  for (const k of [...u.searchParams.keys()]) {
    if (/^utm_/i.test(k) || /^(fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|ref|ref_src|cmpid|ocid|taid|guccounter)$/i.test(k)) u.searchParams.delete(k);
  }
  u.search = u.searchParams.toString() ? '?' + u.searchParams.toString() : '';
  return u.toString();
}

function excerptOf(description, title) {
  const text = stripTags(description);
  if (!text) return null;
  const norm = s => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  // Google News: the description is just the headline and the outlet again.
  if (norm(text).startsWith(norm(title).slice(0, 40))) return null;
  if (text.length <= EXCERPT_MAX) return text;
  const cut = text.slice(0, EXCERPT_MAX - 1);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), EXCERPT_MAX - 40)).replace(/[\s,;:.—-]+$/, '') + '…';
}

// ---------- feed parsing (RSS 2.0 and Atom) ----------
export function parseFeed(xml, feed) {
  const items = [];
  const blocks = String(xml).match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];
  for (const b of blocks) {
    let title = stripTags(tag(b, 'title'));
    let link = stripTags(tag(b, 'link'));
    if (!link) {
      const alt = (b.match(/<link\b[^>]*>/gi) || []).find(l => !/rel\s*=\s*"(?!alternate)/i.test(l));
      link = alt ? attr(alt, 'href') : '';
    }
    const date = stripTags(tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date'));
    const published = new Date(date);
    if (!title || !link || isNaN(published)) continue;
    let source = feed.name || '', publisherUrl = link;
    if (feed.kind === 'google') {
      const src = /<source\b([^>]*)>([\s\S]*?)<\/source>/i.exec(b);
      if (src) { source = stripTags(src[2]); publisherUrl = attr(src[1], 'url') || link; }
      // Google appends " - Publisher" to every headline.
      if (source && title.endsWith(' - ' + source)) title = title.slice(0, -(source.length + 3)).trim();
    }
    if (!source) source = hostOf(link) || 'Unknown';
    // A thumbnail only from the feed's own media tags.
    const media = [];
    for (const m of b.match(/<(media:content|media:thumbnail|enclosure)\b[^>]*>/gi) || []) {
      const url = attr(m, 'url'), type = attr(m, 'type'), medium = attr(m, 'medium');
      const isImage = /^image\//i.test(type) || medium === 'image' || /^<media:thumbnail/i.test(m) || /\.(jpe?g|png|webp)(\?|$)/i.test(url);
      if (url && isImage) media.push({ url, length: Number(attr(m, 'length')) || 0, thumb: /^<media:thumbnail/i.test(m) });
    }
    media.sort((a, z) => (z.thumb - a.thumb) || ((a.length || 1e9) - (z.length || 1e9)));
    items.push({
      title,
      url: canonicalUrl(link),
      source,
      source_type: sourceType(publisherUrl),
      published_at: published.toISOString(),
      excerpt: excerptOf(tag(b, 'description') || tag(b, 'summary') || tag(b, 'content'), title),
      media: media.slice(0, 2)
    });
  }
  return items.filter(i => i.url);
}

// ---------- allow / block ----------
const lines = s => String(s || '').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
const word = w => new RegExp(`(^|[^a-z0-9])${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`, 'i');
export function compileRules(allowText, blockText) {
  const allow = lines(allowText).map(l => l.split('+').map(t => t.trim()).filter(Boolean).map(word));
  const block = lines(blockText).map(word);
  return {
    keep(item) {
      const text = `${item.title} ${item.excerpt || ''}`;
      if (!allow.some(rule => rule.every(re => re.test(text)))) return 'not_relevant';
      if (block.some(re => re.test(item.title))) return 'blocked';
      return null;
    }
  };
}

// ---------- clustering + scoring ----------
const STOP = new Set('a an the to of in on for and or is are was be with as at by from after before into its it it s this that new says said will could may about over up out more than tesla teslas tesla s robotaxi robotaxis cybercab cybercabs elon musk musk s'.split(' '));
export function titleTokens(title) {
  return new Set(String(title).toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').split(' ').filter(w => w.length > 1 && !STOP.has(w)));
}
export function similar(a, b) {
  if (!a.size || !b.size) return false;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  const union = a.size + b.size - inter;
  return inter >= 3 && inter / union >= 0.5;
}
// Rows: {id, title, source, published_at, featured}. Returns per-id {cluster_id, source_count, importance}.
export function clusterAndScore(rows) {
  const sorted = [...rows].sort((a, b) => (a.published_at < b.published_at ? -1 : a.published_at > b.published_at ? 1 : a.id < b.id ? -1 : 1));
  const ms = r => Date.parse(r.published_at);
  // Each story joins the first cluster whose FIRST story it matches (within
  // 72 h of it); never through a chain of near-matches, which would glue
  // different stories together.
  const clusters = [];   // { first, tokens, members }
  for (const r of sorted) {
    const tk = titleTokens(r.title);
    const home = clusters.find(c => ms(r) - ms(c.first) <= 72 * 3600e3 && similar(c.tokens, tk));
    if (home) home.members.push(r); else clusters.push({ first: r, tokens: tk, members: [r] });
  }
  const groups = new Map(clusters.map((c, i) => [i, c.members]));
  const out = {};
  for (const members of groups.values()) {
    const first = members[0];
    const sources = new Set(members.map(m => m.source.toLowerCase()));
    const within24 = new Set(members.filter(m => ms(m) - ms(first) <= 24 * 3600e3).map(m => m.source.toLowerCase()));
    let score = (within24.size >= 3 ? 1 : 0) + (members.some(m => IMPORTANT.test(m.title)) ? 1 : 0);
    for (const m of members) out[m.id] = { cluster_id: first.id, source_count: sources.size, importance: m.featured ? 2 : score };
  }
  return out;
}

// Topic tags for a story (computed when served).
const TOPICS = [
  ['Expansion', /\b(expan\w*|launch\w*|new cit(y|ies)|rollout|rolls? out|coming to|arriv\w*|cities)\b/i],
  ['Regulatory', /\b(nhtsa|regulat\w*|permit\w*|dmv|lawsuit\w*|sue[sd]?|investigat\w*|federal|congress|senate|legislat\w*|law|cpuc|approval)\b/i],
  ['Safety', /\b(crash\w*|safety|recall\w*|collision\w*|injur\w*|incident\w*)\b/i],
  ['Production', /\b(production|factory|gigafactory|giga|manufactur\w*|assembly)\b/i],
  ['Pricing', /\b(price\w*|pricing|fares?|cost\w*)\b/i],
  ['Rides', /\b(ride\w*|riders?|passengers?|app)\b/i]
];
export function tagsOf(s) {
  const text = `${s.title} ${s.excerpt || ''}`;
  const t = TOPICS.filter(([, re]) => re.test(text)).map(([n]) => n);
  if (/\btesla\b/i.test(s.title)) t.unshift('Tesla');
  return t.slice(0, 4);
}

// ---------- fetching ----------
async function fetchFeed(env, feed, fetchImpl, { conditional = true } = {}) {
  let state = {};
  if (conditional) { try { state = JSON.parse((await env.TESLA_SESSIONS.get(kvFeed(feed.id))) || '{}'); } catch (e) { state = {}; } }
  const headers = { 'User-Agent': UA, Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.5' };
  if (conditional && state.etag) headers['If-None-Match'] = state.etag;
  if (conditional && state.lastModified) headers['If-Modified-Since'] = state.lastModified;
  const r = await fetchImpl(feed.url, { headers, redirect: 'follow' });
  if (r.status === 304) return { status: 304, items: [] };
  if (!r.ok) throw new Error(`${feed.id}: HTTP ${r.status}`);
  const xml = await r.text();
  if (conditional) {
    const next = { etag: r.headers.get('etag') || undefined, lastModified: r.headers.get('last-modified') || undefined };
    if (next.etag || next.lastModified) await env.TESLA_SESSIONS.put(kvFeed(feed.id), JSON.stringify(next));
  }
  return { status: r.status, items: parseFeed(xml, feed) };
}

// A thumbnail: https, an image, and small (from the feed's declared length,
// or a HEAD's content-length). Anything else -> none (the page shows the
// outlet's initial instead). Never a full-size photo.
async function validThumb(media, fetchImpl, budget) {
  for (const m of media || []) {
    if (!/^https:\/\//i.test(m.url)) continue;
    if (m.length && m.length <= THUMB_MAX_BYTES) return m.url;
    if (budget.left <= 0) return null;
    budget.left--;
    try {
      const r = await fetchImpl(m.url, { method: 'HEAD', headers: { 'User-Agent': UA } });
      const len = Number(r.headers.get('content-length')) || 0;
      if (r.ok && /^image\//i.test(r.headers.get('content-type') || '') && len > 0 && len <= THUMB_MAX_BYTES) return m.url;
    } catch (e) { /* no thumbnail */ }
  }
  return null;
}

async function config(sql) {
  const { results } = await sql.prepare(`SELECT key, value FROM news_config WHERE key IN ('allow', 'block')`).all();
  const map = Object.fromEntries((results || []).map(r => [r.key, r.value]));
  return { allow: map.allow != null ? map.allow : DEFAULT_ALLOW, block: map.block != null ? map.block : DEFAULT_BLOCK };
}

const isoDay = d => d.toISOString().slice(0, 10);
const chicagoHour = ms => Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' }).format(new Date(ms)));

// The scheduled entry: only the run that is 6 AM in Chicago does the work.
export async function runScheduledNews(env, nowMs = Date.now()) {
  if (!NEWS_LOCAL_HOURS.includes(chicagoHour(nowMs))) return { skipped: 'not_the_local_hour' };
  return runNewsIngest(env);
}

export async function runNewsIngest(env, { fetchImpl = fetch, nowMs = Date.now(), backfill } = {}) {
  const sql = env.cybercabhunter_db;
  const log = { at: new Date(nowMs).toISOString(), fetched: 0, kept: 0, dropped: 0, duplicates: 0, new: 0, not_modified: 0, errors: [], backfill: false };
  const rules = compileRules(...Object.values(await config(sql)));
  const doBackfill = backfill != null ? backfill : !(await env.TESLA_SESSIONS.get(KV_BACKFILLED));
  const jobs = FEEDS.map(f => ({ feed: f, conditional: true }));
  if (doBackfill) {
    log.backfill = true;
    for (const q of BACKFILL_QUERIES) {
      for (let back = BACKFILL_DAYS; back > 0; back -= BACKFILL_WINDOW_DAYS) {
        const from = new Date(nowMs - back * 864e5), to = new Date(nowMs - Math.max(0, back - BACKFILL_WINDOW_DAYS) * 864e5 + 864e5);
        jobs.push({ feed: { id: `gn-backfill`, kind: 'google', url: googleSearch(`${q} after:${isoDay(from)} before:${isoDay(to)}`) }, conditional: false });
      }
    }
  }
  const candidates = new Map(), seenStory = new Set();
  const oldest = new Date(nowMs - MAX_AGE_DAYS * 864e5).toISOString();
  for (const { feed, conditional } of jobs) {
    try {
      const res = await fetchFeed(env, feed, fetchImpl, { conditional });
      if (res.status === 304) { log.not_modified++; continue; }
      log.fetched += res.items.length;
      for (const item of res.items) {
        const why = rules.keep(item);
        if (why || item.published_at < oldest) { log.dropped++; continue; }
        if (candidates.has(item.url) || seenStory.has(storyKey(item))) { log.duplicates++; continue; }
        seenStory.add(storyKey(item));
        candidates.set(item.url, item);
      }
    } catch (e) {
      log.errors.push(String(e && e.message || e).slice(0, 160));
    }
  }
  log.kept = candidates.size;
  // Only the URLs not stored yet get a thumbnail check and an insert.
  const urls = [...candidates.keys()];
  const known = new Set();
  for (let i = 0; i < urls.length; i += 50) {
    const chunk = urls.slice(i, i + 50);
    const { results } = await sql.prepare(`SELECT url FROM news_articles WHERE url IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all();
    (results || []).forEach(r => known.add(r.url));
  }
  // The same outlet's same headline already stored (under another URL) is the same story.
  const storedKeys = new Set();
  const recent = await sql.prepare(`SELECT source, title FROM news_articles WHERE published_at >= ?`).bind(new Date(nowMs - 10 * 864e5).toISOString()).all();
  (recent.results || []).forEach(r => storedKeys.add(storyKey(r)));
  const fresh = urls.filter(u => !known.has(u)).map(u => candidates.get(u)).filter(it => !storedKeys.has(storyKey(it)));
  log.duplicates += urls.length - fresh.length;
  const budget = { left: THUMB_CHECKS_PER_RUN };
  const inserts = [];
  for (const it of fresh) {
    const image = await validThumb(it.media, fetchImpl, budget);
    inserts.push(sql.prepare(`INSERT OR IGNORE INTO news_articles (id, title, url, source, source_type, published_at, excerpt, image_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), it.title.slice(0, 300), it.url, it.source.slice(0, 80), it.source_type, it.published_at, it.excerpt, image));
  }
  for (let i = 0; i < inserts.length; i += 50) {
    const res = await sql.batch(inserts.slice(i, i + 50));
    log.new += res.reduce((n, r) => n + ((r.meta && r.meta.changes) || 0), 0);
  }
  await recluster(sql, nowMs, doBackfill ? BACKFILL_DAYS + 5 : RECLUSTER_DAYS);
  if (doBackfill && !log.errors.length) await env.TESLA_SESSIONS.put(KV_BACKFILLED, log.at);
  await env.TESLA_SESSIONS.put(KV_RUN, JSON.stringify(log));
  console.log('news ingest', JSON.stringify(log));
  return log;
}

async function recluster(sql, nowMs, days) {
  const since = new Date(nowMs - days * 864e5).toISOString();
  const { results } = await sql.prepare(`SELECT id, title, source, published_at, featured, cluster_id, source_count, importance FROM news_articles WHERE published_at >= ?`).bind(since).all();
  const rows = results || [];
  const next = clusterAndScore(rows);
  const updates = rows.filter(r => { const n = next[r.id]; return n && (n.cluster_id !== r.cluster_id || n.source_count !== r.source_count || n.importance !== r.importance); })
    .map(r => sql.prepare(`UPDATE news_articles SET cluster_id = ?, source_count = ?, importance = ? WHERE id = ?`).bind(next[r.id].cluster_id, next[r.id].source_count, next[r.id].importance, r.id));
  for (let i = 0; i < updates.length; i += 50) await sql.batch(updates.slice(i, i + 50));
  return updates.length;
}

// ---------- public API ----------
// GET /api/news?importance=2&limit=20&cursor=&q= — newest first, one entry per
// story (its earliest visible item), with the other outlets as "also".
// Hidden stories never appear. Edge-cached 15 minutes.
const PRIMARY = `n.hidden = 0 AND NOT EXISTS (SELECT 1 FROM news_articles o WHERE o.cluster_id = n.cluster_id AND o.hidden = 0
  AND (o.published_at < n.published_at OR (o.published_at = n.published_at AND o.id < n.id)))`;
export function encodeCursor(row) { return btoa(`${row.published_at}|${row.id}`).replace(/=+$/, ''); }
function decodeCursor(c) {
  try { const [p, id] = atob(String(c)).split('|'); return p && id && !isNaN(Date.parse(p)) ? { p, id } : null; } catch (e) { return null; }
}
export async function apiNews(request, env, ctx) {
  const cache = typeof caches !== 'undefined' && caches.default ? caches.default : null;
  const key = new Request(new URL(request.url).toString(), { method: 'GET' });
  if (cache) { const hit = await cache.match(key); if (hit) return hit; }
  const params = new URL(request.url).searchParams;
  const limit = Math.min(Math.max(Number(params.get('limit')) || 20, 1), 50);
  const majorOnly = params.get('importance') === '2';
  const cursor = params.get('cursor') ? decodeCursor(params.get('cursor')) : null;
  const q = String(params.get('q') || '').trim().slice(0, 80);
  const where = [PRIMARY], binds = [];
  if (majorOnly) where.push('n.importance = 2');
  if (cursor) { where.push('(n.published_at < ? OR (n.published_at = ? AND n.id < ?))'); binds.push(cursor.p, cursor.p, cursor.id); }
  if (q) { where.push(`(n.title LIKE ? ESCAPE '\\' OR n.excerpt LIKE ? ESCAPE '\\')`); const like = `%${q.replace(/[\\%_]/g, c => '\\' + c)}%`; binds.push(like, like); }
  const sql = env.cybercabhunter_db;
  try {
    const { results } = await sql.prepare(`SELECT n.id, n.title, n.url, n.source, n.source_type, n.published_at, n.excerpt, n.image_url, n.importance, n.source_count, n.cluster_id
      FROM news_articles n WHERE ${where.join(' AND ')} ORDER BY n.published_at DESC, n.id DESC LIMIT ?`).bind(...binds, limit + 1).all();
    const rows = (results || []).slice(0, limit);
    const more = (results || []).length > limit;
    const clusters = [...new Set(rows.map(r => r.cluster_id).filter(Boolean))];
    const siblings = {};
    if (clusters.length) {
      const sib = await sql.prepare(`SELECT id, cluster_id, title, url, source, source_type, published_at FROM news_articles WHERE hidden = 0 AND cluster_id IN (${clusters.map(() => '?').join(',')}) ORDER BY published_at`).bind(...clusters).all();
      for (const s of sib.results || []) (siblings[s.cluster_id] = siblings[s.cluster_id] || []).push(s);
    }
    const stories = rows.map(r => ({
      id: r.id, title: r.title, url: r.url, source: r.source, source_type: r.source_type, published_at: r.published_at,
      excerpt: r.excerpt, image_url: r.image_url, importance: r.importance, source_count: r.source_count, tags: tagsOf(r),
      also: (siblings[r.cluster_id] || []).filter(s => s.id !== r.id).map(s => ({ title: s.title, url: s.url, source: s.source, source_type: s.source_type, published_at: s.published_at }))
    }));
    const body = { stories, next_cursor: more && rows.length ? encodeCursor(rows[rows.length - 1]) : null, disclosure: 'Stories are picked and summarized automatically; follow each link for the original reporting.' };
    const response = Response.json(body, { headers: { 'Cache-Control': `public, max-age=${CACHE_SECONDS}` } });
    if (cache) { const stored = cache.put(key, response.clone()).catch(() => {}); if (ctx && ctx.waitUntil) ctx.waitUntil(stored); }
    return response;
  } catch (e) {
    return Response.json({ success: false, error: 'news_unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}

// ---------- moderation (each caller checks requireModerator first) ----------
// GET /api/moderation/news?limit=&cursor= — every story, hidden ones too.
export async function modListNews(request, env) {
  const params = new URL(request.url).searchParams;
  const limit = Math.min(Math.max(Number(params.get('limit')) || 50, 1), 100);
  const cursor = params.get('cursor') ? decodeCursor(params.get('cursor')) : null;
  const where = [], binds = [];
  if (cursor) { where.push('(published_at < ? OR (published_at = ? AND id < ?))'); binds.push(cursor.p, cursor.p, cursor.id); }
  const { results } = await env.cybercabhunter_db.prepare(`SELECT id, title, url, source, source_type, published_at, importance, source_count, cluster_id, hidden, featured
    FROM news_articles ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY published_at DESC, id DESC LIMIT ?`).bind(...binds, limit + 1).all();
  const rows = (results || []).slice(0, limit);
  let last = null;
  try { last = JSON.parse((await env.TESLA_SESSIONS.get(KV_RUN)) || 'null'); } catch (e) { last = null; }
  return Response.json({ success: true, stories: rows.map(r => ({ ...r, hidden: !!r.hidden, featured: !!r.featured })), next_cursor: (results || []).length > limit ? encodeCursor(rows[rows.length - 1]) : null, last_run: last, config: await config(env.cybercabhunter_db) });
}

// POST /api/moderation/news/:id {action: hide | unhide | feature | unfeature}
export async function modUpdateNews(request, env, id) {
  let body = {};
  try { body = await request.json(); } catch (e) { body = {}; }
  const sql = env.cybercabhunter_db;
  const row = await sql.prepare(`SELECT id, cluster_id FROM news_articles WHERE id = ?`).bind(id).first();
  if (!row) return Response.json({ success: false, error: 'not_found' }, { status: 404 });
  const action = body.action;
  if (action === 'hide' || action === 'unhide') {
    await sql.prepare(`UPDATE news_articles SET hidden = ? WHERE id = ?`).bind(action === 'hide' ? 1 : 0, id).run();
  } else if (action === 'feature') {
    await sql.prepare(`UPDATE news_articles SET featured = 1, importance = 2 WHERE id = ?`).bind(id).run();
  } else if (action === 'unfeature') {
    await sql.prepare(`UPDATE news_articles SET featured = 0 WHERE id = ?`).bind(id).run();
    await recluster(sql, Date.now(), RECLUSTER_DAYS + 30);   // back to its scored importance
  } else {
    return Response.json({ success: false, error: 'bad_action' }, { status: 400 });
  }
  await purgeNewsCache(request);
  const after = await sql.prepare(`SELECT id, hidden, featured, importance FROM news_articles WHERE id = ?`).bind(id).first();
  return Response.json({ success: true, story: { ...after, hidden: !!after.hidden, featured: !!after.featured } });
}

// PUT /api/moderation/news-config {allow, block} — one rule per line.
export async function modUpdateNewsConfig(request, env) {
  let body = {};
  try { body = await request.json(); } catch (e) { body = {}; }
  const clean = v => (typeof v === 'string' ? lines(v).map(l => l.slice(0, 80)).slice(0, 100).join('\n') : null);
  const allow = clean(body.allow), block = clean(body.block);
  if (allow === null || block === null) return Response.json({ success: false, error: 'bad_config' }, { status: 400 });
  if (!lines(allow).length) return Response.json({ success: false, error: 'empty_allowlist' }, { status: 400 });
  const sql = env.cybercabhunter_db;
  await sql.batch([
    sql.prepare(`INSERT INTO news_config (key, value) VALUES ('allow', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(allow),
    sql.prepare(`INSERT INTO news_config (key, value) VALUES ('block', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(block)
  ]);
  return Response.json({ success: true, config: { allow, block } });
}

// POST /api/moderation/news/run — run the ingest now (not just at 6 AM).
export async function modRunNews(request, env) {
  const log = await runNewsIngest(env);
  await purgeNewsCache(request);
  return Response.json({ success: true, run: log });
}

// The common public URLs, so a hide / feature shows up without waiting 15 min.
async function purgeNewsCache(request) {
  const cache = typeof caches !== 'undefined' && caches.default ? caches.default : null;
  if (!cache) return;
  const origin = new URL(request.url).origin;
  await Promise.all(['/api/news', '/api/news?limit=20', '/api/news?importance=2', '/api/news?importance=2&limit=6', '/api/news?limit=20&importance=2']
    .map(p => cache.delete(new Request(origin + p, { method: 'GET' })).catch(() => {})));
}
