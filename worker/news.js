// Cybercab news: an automatic headline aggregator for /news (public/news.html).
//
// SOURCES: eleven publisher RSS / Atom feeds (FEEDS), each verified Oct 9-10,
// 2026: robots.txt allows the feed path for generic bots, and the feed answers
// from Cloudflare's network. (Google News was dropped: from Cloudflare it
// answers 503, and its links are redirects, not the publishers' articles.)
//
// SCHEDULE (runNewsTick, on NEWS_CRON = every 10 minutes at :05, :15, ...):
// each tick, so it stays inside the Workers free plan's per-run limits:
//   1. checks ONE feed, in rotation (KV news:next_feed), politely: a
//      descriptive User-Agent and If-None-Match / If-Modified-Since (a 304
//      is "nothing new"). Each feed is checked about every 110 minutes;
//   2. parses title, link, publisher, date and description; keeps an item
//      that matches the allowlist (default "cybercab", or "robotaxi" AND
//      "tesla"), has no blocklisted headline word (stock stories), is not
//      from a blocklisted publisher, and is at most 30 days old (all lists in
//      news_config, edited from /moderation);
//   3. stores it once (the canonical URL is UNIQUE; the same outlet's same
//      headline under another URL is the same story), then re-clusters the
//      recent stories by headline similarity and scores them: +1 when 3+
//      outlets ran it within 24 h, +1 for a launch / expansion / crash /
//      recall / NHTSA / investigation / lawsuit / new city / safety / price
//      headline (2 = major, 1 = notable); FEATURED by a moderator = 2;
//   4. makes up to THUMBS_PER_TICK thumbnails (makeThumb): the article page
//      (robots.txt respected, 10 s, 2 MB cap) -> og:image, twitter:image, or
//      the first <img> wider than 200 px -> fetched through Cloudflare Image
//      Transformations as a 400 px WebP (quality 70) -> R2 NEWS_THUMBS at
//      thumbs/<story id>.webp, served from /news-img/<story id>.webp. No
//      transformation available -> no thumbnail (never a full-size image);
//   5. once a day: deletes stories older than 30 days and their thumbnails
//      (pruneOld); once a month: deletes thumbnails whose story is gone
//      (sweepOrphans).
// Each tick is logged (KV news:last_run; the last prune and sweep too).
//
// Excerpts are the feed's own description, tags stripped, at most 280
// characters — never invented, never the article body.

const UA = 'CybercabHunter-NewsBot/1.0 (+https://cybercabhunter.com/news; RSS check)';
export const NEWS_CRON = '5-59/10 * * * *';
const TZ = 'America/Chicago';
const EXCERPT_MAX = 280;
const RECLUSTER_DAYS = 5;              // re-cluster this many days back (a story's cluster window is 72 h)
const MAX_AGE_DAYS = 30;               // older items are not stored, and stored ones are deleted
const THUMBS_PER_TICK = 3;
const THUMB_PAGE_MAX_BYTES = 2 * 1024 * 1024;
const THUMB_MAX_BYTES = 200 * 1024;    // a 400 px WebP is ~30-60 KB; anything bigger is refused
const FETCH_TIMEOUT_MS = 10000;
const ROBOTS_TTL_SECONDS = 7 * 86400;
const CACHE_SECONDS = 900;
const KV_RUN = 'news:last_run';
const KV_NEXT_FEED = 'news:next_feed';
const KV_PRUNE = 'news:last_prune';
const KV_SWEEP = 'news:last_sweep';
const kvFeed = id => `news:feed:${id}`;
const kvRobots = host => `news:robots:${host}`;
const storyKey = it => `${String(it.source).toLowerCase()}|${[...titleTokens(it.title)].sort().join(' ')}`;
export const thumbKey = id => `thumbs/${id}.webp`;
export const thumbUrl = id => `/news-img/${id}.webp`;

export const FEEDS = [
  { id: 'electrek', kind: 'rss', name: 'Electrek', url: 'https://electrek.co/feed/' },
  { id: 'teslarati', kind: 'rss', name: 'Teslarati', url: 'https://www.teslarati.com/feed/' },
  { id: 'notateslaapp', kind: 'rss', name: 'Not a Tesla App', url: 'https://www.notateslaapp.com/rss' },
  { id: 'teslaoracle', kind: 'rss', name: 'Tesla Oracle', url: 'https://www.teslaoracle.com/feed/' },
  { id: 'teslanorth', kind: 'rss', name: 'Teslanorth', url: 'https://teslanorth.com/feed/' },
  { id: 'driveteslacanada', kind: 'rss', name: 'Drive Tesla Canada', url: 'https://driveteslacanada.ca/feed/' },
  { id: 'techcrunch', kind: 'rss', name: 'TechCrunch', url: 'https://techcrunch.com/category/transportation/feed/' },
  { id: 'theverge', kind: 'rss', name: 'The Verge', url: 'https://www.theverge.com/rss/tesla/index.xml' },
  { id: 'arstechnica', kind: 'rss', name: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/cars' },
  { id: 'electrive', kind: 'rss', name: 'Electrive', url: 'https://www.electrive.com/feed/' },
  { id: 'insideevs', kind: 'rss', name: 'InsideEVs', url: 'https://insideevs.com/rss/articles/all/' }
];

// Defaults for news_config (migrations/0029 seeds the same). One rule per line;
// "a + b" means both words. Matching is case-insensitive, on whole words.
export const DEFAULT_ALLOW = 'cybercab\nrobotaxi + tesla';
export const DEFAULT_BLOCK = 'stock\nstocks\nshares\nprice target\nTSLA\nwall street\nanalyst\nanalysts';
// Publishers whose stories are never kept (news_config 'publisher_blocklist',
// a JSON array; migrations/0030 seeds it). Matched case-insensitively against
// a story's source, before scoring and storage.
export const DEFAULT_PUBLISHER_BLOCKLIST = ['BASENOR'];
const publisherKey = name => String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
export function parsePublisherList(value) {
  try { const v = JSON.parse(value); return Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim().replace(/\s+/g, ' ')) : null; } catch (e) { return null; }
}

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
    // RSS 2.0 <source>: the outlet an aggregated item came from.
    const src = /<source\b([^>]*)>([\s\S]*?)<\/source>/i.exec(b);
    if (src && stripTags(src[2])) { source = stripTags(src[2]); publisherUrl = attr(src[1], 'url') || link; }
    // Aggregators append " - Publisher" to headlines.
    if (src && source && title.endsWith(' - ' + source)) title = title.slice(0, -(source.length + 3)).trim();
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
async function fetchWithTimeout(fetchImpl, url, init = {}, ms = FETCH_TIMEOUT_MS) {
  const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ac ? setTimeout(() => ac.abort(), ms) : null;
  try { return await fetchImpl(url, ac ? { ...init, signal: ac.signal } : init); }
  finally { if (timer) clearTimeout(timer); }
}
// The body, at most maxBytes (a bigger one is cut off, never read whole).
async function readCapped(r, maxBytes) {
  if (!r.body || !r.body.getReader) { const t = await r.arrayBuffer(); return new Uint8Array(t).slice(0, maxBytes); }
  const reader = r.body.getReader(), parts = [];
  let size = 0;
  while (size < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); size += value.length;
  }
  try { reader.cancel(); } catch (e) { /* already done */ }
  const out = new Uint8Array(Math.min(size, maxBytes));
  let o = 0;
  for (const p of parts) { const take = Math.min(p.length, out.length - o); out.set(p.subarray(0, take), o); o += take; if (o >= out.length) break; }
  return out;
}

async function fetchFeed(env, feed, fetchImpl) {
  let state = {};
  try { state = JSON.parse((await env.TESLA_SESSIONS.get(kvFeed(feed.id))) || '{}'); } catch (e) { state = {}; }
  const headers = { 'User-Agent': UA, Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.5' };
  if (state.etag) headers['If-None-Match'] = state.etag;
  if (state.lastModified) headers['If-Modified-Since'] = state.lastModified;
  const r = await fetchWithTimeout(fetchImpl, feed.url, { headers, redirect: 'follow' });
  if (r.status === 304) return { status: 304, items: [] };
  if (!r.ok) throw new Error(`${feed.id}: HTTP ${r.status}`);
  const xml = await r.text();
  const next = { etag: r.headers.get('etag') || undefined, lastModified: r.headers.get('last-modified') || undefined };
  if (next.etag || next.lastModified) await env.TESLA_SESSIONS.put(kvFeed(feed.id), JSON.stringify(next));
  return { status: r.status, items: parseFeed(xml, feed) };
}

const domainList = value => { try { const v = JSON.parse(value); return Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '')) : null; } catch (e) { return null; } };
async function config(sql) {
  const { results } = await sql.prepare(`SELECT key, value FROM news_config WHERE key IN ('allow', 'block', 'publisher_blocklist', 'thumb_blocklist')`).all();
  const map = Object.fromEntries((results || []).map(r => [r.key, r.value]));
  const publishers = map.publisher_blocklist != null ? parsePublisherList(map.publisher_blocklist) : null;
  return {
    allow: map.allow != null ? map.allow : DEFAULT_ALLOW,
    block: map.block != null ? map.block : DEFAULT_BLOCK,
    publisher_blocklist: publishers || DEFAULT_PUBLISHER_BLOCKLIST,
    thumb_blocklist: (map.thumb_blocklist != null && domainList(map.thumb_blocklist)) || []
  };
}

const newLog = (nowMs, extra = {}) => ({ at: new Date(nowMs).toISOString(), feeds: [], fetched: 0, kept: 0, dropped: 0, blocked_publisher: 0, duplicates: 0, new: 0, not_modified: 0, errors: [], ...extra });

// Checks the given feeds and stores their new stories.
async function ingestFeeds(env, feeds, { fetchImpl, nowMs, log }) {
  const sql = env.cybercabhunter_db;
  const cfg = await config(sql);
  const rules = compileRules(cfg.allow, cfg.block);
  const blockedPublishers = new Set(cfg.publisher_blocklist.map(publisherKey));
  const candidates = new Map(), seenStory = new Set();
  const oldest = new Date(nowMs - MAX_AGE_DAYS * 864e5).toISOString();
  for (const feed of feeds) {
    log.feeds.push(feed.id);
    try {
      const res = await fetchFeed(env, feed, fetchImpl);
      if (res.status === 304) { log.not_modified++; continue; }
      log.fetched += res.items.length;
      for (const item of res.items) {
        // A blocklisted publisher: dropped before anything else (counted on its own).
        if (blockedPublishers.has(publisherKey(item.source))) { log.blocked_publisher++; log.dropped++; continue; }
        if (rules.keep(item) || item.published_at < oldest) { log.dropped++; continue; }
        if (candidates.has(item.url) || seenStory.has(storyKey(item))) { log.duplicates++; continue; }
        seenStory.add(storyKey(item));
        candidates.set(item.url, item);
      }
    } catch (e) {
      log.errors.push(String(e && e.message || e).slice(0, 160));
    }
  }
  log.kept += candidates.size;
  const urls = [...candidates.keys()];
  const known = new Set();
  for (let i = 0; i < urls.length; i += 50) {
    const chunk = urls.slice(i, i + 50);
    const { results } = await sql.prepare(`SELECT url FROM news_articles WHERE url IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all();
    (results || []).forEach(r => known.add(r.url));
  }
  // The same outlet's same headline already stored (under another URL) is the same story.
  const storedKeys = new Set();
  if (urls.length) {
    const recent = await sql.prepare(`SELECT source, title FROM news_articles WHERE published_at >= ?`).bind(new Date(nowMs - 10 * 864e5).toISOString()).all();
    (recent.results || []).forEach(r => storedKeys.add(storyKey(r)));
  }
  const fresh = urls.filter(u => !known.has(u)).map(u => candidates.get(u)).filter(it => !storedKeys.has(storyKey(it)));
  log.duplicates += urls.length - fresh.length;
  const inserts = fresh.map(it => sql.prepare(`INSERT OR IGNORE INTO news_articles (id, title, url, source, source_type, published_at, excerpt, image_url, thumb_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`)
    .bind(crypto.randomUUID(), it.title.slice(0, 300), it.url, it.source.slice(0, 80), it.source_type, it.published_at, it.excerpt, null));
  for (let i = 0; i < inserts.length; i += 50) {
    const res = await sql.batch(inserts.slice(i, i + 50));
    log.new += res.reduce((n, r) => n + ((r.meta && r.meta.changes) || 0), 0);
  }
  if (log.new) await recluster(sql, nowMs, RECLUSTER_DAYS);
}

// Every feed in one go (tests and one-off backfills; the schedule uses runNewsTick).
export async function runNewsIngest(env, { fetchImpl = fetch, nowMs = Date.now(), thumbs = false } = {}) {
  const log = newLog(nowMs);
  await ingestFeeds(env, FEEDS, { fetchImpl, nowMs, log });
  if (thumbs) log.thumbs = await processThumbs(env, { fetchImpl, limit: thumbs === true ? THUMBS_PER_TICK : thumbs });
  await env.TESLA_SESSIONS.put(KV_RUN, JSON.stringify(log));
  console.log('news ingest', JSON.stringify(log));
  return log;
}

const chicagoDay = ms => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));

// One scheduled step (every 10 minutes; also the moderator's "Run the next
// ingest step now"): the next feed in rotation, a few thumbnails, and the
// daily prune / monthly orphan sweep when they are due.
export async function runNewsTick(env, { fetchImpl = fetch, nowMs = Date.now() } = {}) {
  const kv = env.TESLA_SESSIONS;
  const i = (Number(await kv.get(KV_NEXT_FEED)) || 0) % FEEDS.length;
  await kv.put(KV_NEXT_FEED, String((i + 1) % FEEDS.length));
  const log = newLog(nowMs);
  await ingestFeeds(env, [FEEDS[i]], { fetchImpl, nowMs, log });
  log.thumbs = await processThumbs(env, { fetchImpl, limit: THUMBS_PER_TICK });
  const today = chicagoDay(nowMs);
  let prune = null; try { prune = JSON.parse((await kv.get(KV_PRUNE)) || 'null'); } catch (e) { prune = null; }
  if (!prune || prune.day !== today) {
    const p = await pruneOld(env, nowMs);
    Object.assign(log, p);
    await kv.put(KV_PRUNE, JSON.stringify({ day: today, at: log.at, ...p }));
  }
  const month = today.slice(0, 7);
  let sweep = null; try { sweep = JSON.parse((await kv.get(KV_SWEEP)) || 'null'); } catch (e) { sweep = null; }
  if (!sweep || sweep.month !== month) {
    const o = await sweepOrphans(env);
    log.orphans_deleted = o.orphans_deleted;
    await kv.put(KV_SWEEP, JSON.stringify({ month, at: log.at, ...o }));
  }
  await kv.put(KV_RUN, JSON.stringify(log));
  console.log('news tick', JSON.stringify(log));
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

// ---------- robots.txt (for article pages and their images) ----------
// The rules for our User-Agent (or, failing that, "*"): longest match wins,
// Allow beats Disallow on a tie; "*" and "$" wildcards. Cached a week per host.
export function parseRobots(text) {
  const groups = [];
  let cur = null, lastWasAgent = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const field = m[1].toLowerCase(), value = m[2].trim();
    if (field === 'user-agent') {
      if (!lastWasAgent || !cur) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(value.toLowerCase()); lastWasAgent = true;
    } else if (cur && (field === 'allow' || field === 'disallow')) {
      lastWasAgent = false;
      if (value || field === 'allow') cur.rules.push({ allow: field === 'allow', path: value });
    } else { lastWasAgent = false; }
  }
  const mine = groups.filter(g => g.agents.some(a => a !== '*' && 'cybercabhunter-newsbot'.includes(a)));
  const pick = mine.length ? mine : groups.filter(g => g.agents.includes('*'));
  return pick.flatMap(g => g.rules);
}
export function robotsAllows(rules, url) {
  let path;
  try { const u = new URL(url); path = u.pathname + u.search; } catch (e) { return false; }
  let best = null;
  for (const r of rules) {
    if (!r.path) continue;
    const re = new RegExp('^' + r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
    if (re.test(path) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r;
  }
  return !best || best.allow;
}
async function robotsOk(env, url, fetchImpl) {
  let host;
  try { host = new URL(url).host; } catch (e) { return false; }
  let rules = null;
  try { rules = JSON.parse((await env.TESLA_SESSIONS.get(kvRobots(host))) || 'null'); } catch (e) { rules = null; }
  if (!rules) {
    try {
      const r = await fetchWithTimeout(fetchImpl, `https://${host}/robots.txt`, { headers: { 'User-Agent': UA } }, 8000);
      if (r.status >= 500) return false;                 // unknown: do not fetch
      rules = r.ok ? parseRobots(await r.text()) : [];   // 4xx: no robots.txt, no restrictions
    } catch (e) { return false; }
    await env.TESLA_SESSIONS.put(kvRobots(host), JSON.stringify(rules), { expirationTtl: ROBOTS_TTL_SECONDS });
  }
  return robotsAllows(rules, url);
}

// ---------- thumbnails ----------
// The page's own picture, in this order: og:image, twitter:image, then the
// first <img> declared wider than 200 px. No SVG, data: URI or tracking pixel.
const metaContent = (html, key) => {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const t of tags) {
    const name = /\b(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(t);
    if (name && name[1].toLowerCase() === key) { const c = /\bcontent\s*=\s*["']([^"']+)["']/i.exec(t); if (c) return decode(c[1]).trim(); }
  }
  return null;
};
const badImage = u => !u || /^data:/i.test(u) || /\.svg(\?|#|$)/i.test(u) || /(pixel|tracking|beacon|spacer|1x1|blank\.gif)/i.test(u);
export function extractImage(html, pageUrl) {
  const abs = u => { try { const x = new URL(u, pageUrl); return /^https?:$/.test(x.protocol) ? x.toString() : null; } catch (e) { return null; } };
  for (const key of ['og:image', 'og:image:secure_url', 'twitter:image', 'twitter:image:src']) {
    const v = metaContent(html, key);
    const u = v && abs(v);
    if (u && !badImage(u)) return { url: u, from: key.startsWith('og') ? 'og:image' : 'twitter:image' };
  }
  for (const tag of html.match(/<img\b[^>]*>/gi) || []) {
    const src = /\b(?:src|data-src)\s*=\s*["']([^"']+)["']/i.exec(tag);
    const w = Number((/\bwidth\s*=\s*["']?(\d+)/i.exec(tag) || [])[1]) || 0;
    const h = Number((/\bheight\s*=\s*["']?(\d+)/i.exec(tag) || [])[1]) || 0;
    const u = src && abs(decode(src[1]));
    if (u && !badImage(u) && w > 200 && !(h && h <= 2)) return { url: u, from: 'img' };
  }
  return null;
}

// A WebP's pixel width, from its header (VP8, VP8L or VP8X); null if unreadable.
export function webpWidth(b) {
  if (!b || b.length < 30 || String.fromCharCode(...b.subarray(0, 4)) !== 'RIFF' || String.fromCharCode(...b.subarray(8, 12)) !== 'WEBP') return null;
  const chunk = String.fromCharCode(...b.subarray(12, 16));
  if (chunk === 'VP8 ') return (b[26] | (b[27] << 8)) & 0x3fff;
  if (chunk === 'VP8L') return 1 + ((b[21] | (b[22] << 8)) & 0x3fff);
  if (chunk === 'VP8X') return 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
  return null;
}

// One story's thumbnail. Returns { status: 'done', key } or { status: 'failed' |
// 'skipped', reason }. A failure never touches the story itself.
export async function makeThumb(env, story, { fetchImpl = fetch, cfg } = {}) {
  let host;
  try { host = new URL(story.url).hostname.replace(/^www\./, '').toLowerCase(); } catch (e) { return { status: 'skipped', reason: 'bad_url' }; }
  if (host === 'news.google.com') return { status: 'skipped', reason: 'no_article_url' };
  if ((cfg.thumb_blocklist || []).some(d => host === d || host.endsWith('.' + d))) return { status: 'skipped', reason: 'thumb_blocklist' };
  if (!(await robotsOk(env, story.url, fetchImpl))) return { status: 'skipped', reason: 'robots' };
  let html;
  try {
    const r = await fetchWithTimeout(fetchImpl, story.url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, redirect: 'follow' });
    if (!r.ok) return { status: 'failed', reason: `page_http_${r.status}` };
    if (!/html/i.test(r.headers.get('content-type') || 'text/html')) return { status: 'failed', reason: 'page_not_html' };
    html = new TextDecoder().decode(await readCapped(r, THUMB_PAGE_MAX_BYTES));
  } catch (e) { return { status: 'failed', reason: 'page_fetch' }; }
  const img = extractImage(html, story.url);
  if (!img) return { status: 'failed', reason: 'no_image' };
  if (!(await robotsOk(env, img.url, fetchImpl))) return { status: 'skipped', reason: 'robots_image' };
  let bytes;
  try {
    // Cloudflare Image Transformations: 400 px wide (aspect kept), WebP, quality 70.
    const r = await fetchWithTimeout(fetchImpl, img.url, { headers: { 'User-Agent': UA, Accept: 'image/webp,image/*' }, cf: { image: { width: 400, fit: 'scale-down', format: 'webp', quality: 70 } } });
    if (!r.ok) return { status: 'failed', reason: `image_http_${r.status}` };
    // Not WebP means the transformation did not run (not enabled, or not on the
    // zone): never store the original, full-size image.
    if (!/^image\/webp/i.test(r.headers.get('content-type') || '')) return { status: 'failed', reason: 'no_transform' };
    bytes = await readCapped(r, THUMB_MAX_BYTES + 1);
    if (bytes.length > THUMB_MAX_BYTES) return { status: 'failed', reason: 'too_big' };
    // A WebP the publisher served itself (not resized by us) is refused too:
    // only a real thumbnail, at most 400 px wide, is ever stored.
    const w = webpWidth(bytes);
    if (!w || w > 400) return { status: 'failed', reason: 'not_resized' };
  } catch (e) { return { status: 'failed', reason: 'image_fetch' }; }
  const key = thumbKey(story.id);
  await env.NEWS_THUMBS.put(key, bytes, { httpMetadata: { contentType: 'image/webp', cacheControl: 'public, max-age=2592000' } });
  return { status: 'done', key, from: img.from };
}

export async function processThumbs(env, { fetchImpl = fetch, limit = THUMBS_PER_TICK } = {}) {
  const out = { done: 0, failed: 0, skipped: 0 };
  if (!env.NEWS_THUMBS) return { ...out, unavailable: true };
  const sql = env.cybercabhunter_db;
  const cfg = await config(sql);
  const { results } = await sql.prepare(`SELECT id, url FROM news_articles WHERE thumb_status = 'pending' ORDER BY published_at DESC LIMIT ?`).bind(limit).all();
  for (const story of results || []) {
    let res;
    try { res = await makeThumb(env, story, { fetchImpl, cfg }); } catch (e) { res = { status: 'failed', reason: 'error' }; }
    out[res.status]++;
    await sql.prepare(`UPDATE news_articles SET thumb_status = ?, thumb_key = ? WHERE id = ?`)
      .bind(res.status === 'done' ? 'done' : `${res.status}:${res.reason}`, res.status === 'done' ? res.key : null, story.id).run();
  }
  return out;
}

// ---------- retention ----------
// Stories older than 30 days go, with their thumbnails (hidden or featured
// alike: no story is exempt).
export async function pruneOld(env, nowMs = Date.now()) {
  const sql = env.cybercabhunter_db;
  const cutoff = new Date(nowMs - MAX_AGE_DAYS * 864e5).toISOString();
  const { results } = await sql.prepare(`SELECT id, thumb_key FROM news_articles WHERE published_at < ?`).bind(cutoff).all();
  const rows = results || [];
  const keys = rows.map(r => r.thumb_key).filter(Boolean);
  let thumbs = 0;
  for (let i = 0; i < keys.length; i += 1000) {
    if (env.NEWS_THUMBS) { await env.NEWS_THUMBS.delete(keys.slice(i, i + 1000)); thumbs += Math.min(1000, keys.length - i); }
  }
  for (let i = 0; i < rows.length; i += 50) {
    const ids = rows.slice(i, i + 50).map(r => r.id);
    await sql.prepare(`DELETE FROM news_articles WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).run();
  }
  return { stories_pruned: rows.length, thumbs_deleted: thumbs };
}

// Thumbnails whose story no longer exists (monthly).
export async function sweepOrphans(env) {
  if (!env.NEWS_THUMBS) return { orphans_deleted: 0 };
  const sql = env.cybercabhunter_db;
  let cursor, deleted = 0, checked = 0;
  do {
    const page = await env.NEWS_THUMBS.list({ prefix: 'thumbs/', cursor, limit: 1000 });
    const keys = (page.objects || []).map(o => o.key);
    checked += keys.length;
    const ids = keys.map(k => (/^thumbs\/([0-9a-f-]{36})\.webp$/i.exec(k) || [])[1]);
    const alive = new Set();
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50).filter(Boolean);
      if (!chunk.length) continue;
      const { results } = await sql.prepare(`SELECT id FROM news_articles WHERE id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all();
      (results || []).forEach(r => alive.add(r.id));
    }
    const orphans = keys.filter((k, j) => !ids[j] || !alive.has(ids[j]));
    if (orphans.length) { await env.NEWS_THUMBS.delete(orphans); deleted += orphans.length; }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return { orphans_deleted: deleted, thumbs_checked: checked };
}

// GET /news-img/<story id>.webp — a story's thumbnail from R2.
export async function apiNewsImage(request, env, id) {
  if (!env.NEWS_THUMBS || !/^[0-9a-f-]{36}$/i.test(id)) return new Response('Not found', { status: 404 });
  const obj = await env.NEWS_THUMBS.get(thumbKey(id));
  if (!obj) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'public, max-age=300' } });
  return new Response(obj.body, { headers: { 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=2592000', 'X-Content-Type-Options': 'nosniff' } });
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
    const { results } = await sql.prepare(`SELECT n.id, n.title, n.url, n.source, n.source_type, n.published_at, n.excerpt, n.image_url, n.thumb_key, n.importance, n.source_count, n.cluster_id
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
      // The page shows thumb_url first (our own WebP), then image_url (a feed
      // enclosure), then the outlet's initial.
      excerpt: r.excerpt, thumb_url: r.thumb_key ? thumbUrl(r.id) : null, image_url: r.image_url, importance: r.importance, source_count: r.source_count, tags: tagsOf(r),
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
  const { results } = await env.cybercabhunter_db.prepare(`SELECT id, title, url, source, source_type, published_at, importance, source_count, cluster_id, hidden, featured, thumb_key, thumb_status
    FROM news_articles ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY published_at DESC, id DESC LIMIT ?`).bind(...binds, limit + 1).all();
  const rows = (results || []).slice(0, limit);
  let last = null;
  try { last = JSON.parse((await env.TESLA_SESSIONS.get(KV_RUN)) || 'null'); } catch (e) { last = null; }
  let prune = null; try { prune = JSON.parse((await env.TESLA_SESSIONS.get(KV_PRUNE)) || 'null'); } catch (e) { prune = null; }
  return Response.json({ success: true, last_prune: prune, stories: rows.map(r => ({ ...r, hidden: !!r.hidden, featured: !!r.featured, thumb_url: r.thumb_key ? thumbUrl(r.id) : null })), next_cursor: (results || []).length > limit ? encodeCursor(rows[rows.length - 1]) : null, last_run: last, config: await config(env.cybercabhunter_db) });
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
  // Each part is optional (only the ones sent are saved); at least one is needed.
  const clean = v => (typeof v === 'string' ? lines(v).map(l => l.slice(0, 80)).slice(0, 100).join('\n') : undefined);
  const allow = clean(body.allow), block = clean(body.block);
  let publishers;
  if (body.publisher_blocklist !== undefined) {
    if (!Array.isArray(body.publisher_blocklist) || body.publisher_blocklist.some(x => typeof x !== 'string')) return Response.json({ success: false, error: 'bad_publisher_blocklist' }, { status: 400 });
    const seen = new Set();
    publishers = body.publisher_blocklist.map(x => x.trim().replace(/\s+/g, ' ').slice(0, 80)).filter(x => x && !seen.has(publisherKey(x)) && seen.add(publisherKey(x))).slice(0, 200);
  }
  let thumbDomains;
  if (body.thumb_blocklist !== undefined) {
    if (!Array.isArray(body.thumb_blocklist) || body.thumb_blocklist.some(x => typeof x !== 'string')) return Response.json({ success: false, error: 'bad_thumb_blocklist' }, { status: 400 });
    thumbDomains = [...new Set(domainList(JSON.stringify(body.thumb_blocklist)).filter(d => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)))].slice(0, 200);
  }
  if (allow === undefined && block === undefined && publishers === undefined && thumbDomains === undefined) return Response.json({ success: false, error: 'bad_config' }, { status: 400 });
  if (allow !== undefined && !lines(allow).length) return Response.json({ success: false, error: 'empty_allowlist' }, { status: 400 });
  const sql = env.cybercabhunter_db;
  const put = (k, v) => sql.prepare(`INSERT INTO news_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(k, v);
  const writes = [];
  if (allow !== undefined) writes.push(put('allow', allow));
  if (block !== undefined) writes.push(put('block', block));
  if (publishers !== undefined) writes.push(put('publisher_blocklist', JSON.stringify(publishers)));
  if (thumbDomains !== undefined) writes.push(put('thumb_blocklist', JSON.stringify(thumbDomains)));
  await sql.batch(writes);
  return Response.json({ success: true, config: await config(sql) });
}

// POST /api/moderation/news/run — the next scheduled step, now (one feed, a
// few thumbnails, and the prune / sweep if due), same as the 10-minute cron.
export async function modRunNews(request, env) {
  const log = await runNewsTick(env);
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
