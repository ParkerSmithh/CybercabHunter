// Cybercab news: an automatic headline aggregator for /news (public/news.html).
//
// SOURCES: publisher RSS / Atom feeds, kept in news_config 'feeds' (a JSON
// array of {id, name, url, tier}; seeded from DEFAULT_FEEDS, each verified
// Oct 10, 2026: a parseable feed that robots.txt allows). Moderators add and
// remove feeds from /moderation (modNewsFeeds): a new URL is checked on the
// spot (robots.txt, parses as RSS / Atom); a bare domain is auto-discovered
// (/feed, /rss, /rss.xml, /atom.xml, then the homepage's <link rel=alternate>).
// (Google News was dropped: from Cloudflare it answers 503.)
//
// SCHEDULE (runNewsTick, on NEWS_CRON = every 10 minutes at :05, :15, ...):
// each tick, so it stays inside the Workers free plan's per-run limits:
//   1. checks ONE feed (pickFeed): the most overdue against its tier's
//      interval (tier 1, the dedicated EV / Tesla outlets: ~2 h; tier 2,
//      general tech, business and local press: ~6 h; a feed never checked
//      goes first, so a new feed backfills its last 30 days on the next
//      step), politely: robots.txt honored, a descriptive User-Agent and
//      If-None-Match / If-Modified-Since (a 304 is "nothing new");
//   2. parses title, link, publisher, date and description; keeps an item
//      that matches the allowlist (default "cybercab", or "robotaxi" AND
//      "tesla"), has no blocklisted headline word or /pattern/ (stock and
//      investor stories, viral-clip framing, app-version posts), is not
//      from a blocklisted publisher, and is at most 30 days old (all lists in
//      news_config, edited from /moderation);
//   3. stores it once (the canonical URL is UNIQUE; the same outlet's same
//      headline under another URL is the same story), then re-clusters the
//      recent stories by headline similarity and scores them, +1 per signal:
//      3+ outlets ran it within 24 h; a Major keyword in a headline or
//      excerpt (news_config 'major_keywords': launch, crash, NHTSA, fleet,
//      registry, new market, ...); a number in a headline with a fleet word
//      ("Tesla Adds 150 Cybercabs"); a Major keyword OR a substantive press /
//      official story (tagged Regulatory, Data, Expansion or Business) — one
//      +1 between them; and, for a NEW story whose rules score
//      is exactly 1, a Workers AI significance verdict (aiVerdict; at most
//      AI_PER_TICK a step; an error keeps the rules score). 2+ = major,
//      1 = notable; FEATURED by a moderator = 2. Once a day every stored
//      story is rescored by the rules (the stored AI verdicts count, the
//      model is never asked again);
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
// Excerpts are the feed's own description, tags stripped, at most ~300
// characters cut at a sentence end — never invented, never the article body;
// none when it only repeats the headline.

const UA = 'CybercabHunter-NewsBot/1.0 (+https://cybercabhunter.com/news; RSS check)';
export const NEWS_CRON = '5-59/10 * * * *';
const TZ = 'America/Chicago';
const EXCERPT_MAX = 300;
const RECLUSTER_DAYS = 5;              // re-cluster this many days back (a story's cluster window is 72 h)
const MAX_AGE_DAYS = 30;               // older items are not stored, and stored ones are deleted
const THUMBS_PER_TICK = 3;
const THUMB_PAGE_MAX_BYTES = 2 * 1024 * 1024;
const THUMB_MAX_BYTES = 200 * 1024;    // a 400 px WebP is ~30-60 KB; anything bigger is refused
const FETCH_TIMEOUT_MS = 10000;
const ROBOTS_TTL_SECONDS = 7 * 86400;
const CACHE_SECONDS = 900;
const KV_RUN = 'news:last_run';
const KV_FEED_CHECKS = 'news:feed_checks';   // {feed id: last check, ms}
const TIER_MINUTES = { 1: 120, 2: 360 };
const FEED_PAGE_MAX_BYTES = 2 * 1024 * 1024;
const KV_PRUNE = 'news:last_prune';
const KV_SWEEP = 'news:last_sweep';
const KV_RESCORE = 'news:last_rescore';
export const AI_MODEL = '@cf/meta/llama-3.1-8b-instruct';
const AI_PER_TICK = 4;
const AI_TIMEOUT_MS = 8000;
const kvFeed = id => `news:feed:${id}`;
const kvRobots = host => `news:robots:${host}`;
const storyKey = it => `${String(it.source).toLowerCase()}|${[...titleTokens(it.title)].sort().join(' ')}`;
export const thumbKey = id => `thumbs/${id}.webp`;
export const thumbUrl = id => `/news-img/${id}.webp`;

// The seeded feed list (migrations/0034 stores the same in news_config).
// Tier 1: the dedicated EV / Tesla outlets; tier 2: general tech, business
// and local press. Left out on Oct 10, 2026: Reuters, AP, Axios (robots.txt
// disallows), CleanTechnica (403 to bots), Green Car Reports (feed stale
// since 2025), Austin American-Statesman and Dallas Morning News (no feed),
// Austin Business Journal (403).
export const DEFAULT_FEEDS = [
  { id: 'electrek', tier: 1, name: 'Electrek', url: 'https://electrek.co/feed/' },
  { id: 'teslarati', tier: 1, name: 'Teslarati', url: 'https://www.teslarati.com/feed/' },
  { id: 'insideevs', tier: 1, name: 'InsideEVs', url: 'https://insideevs.com/rss/articles/all/' },
  { id: 'notateslaapp', tier: 1, name: 'Not a Tesla App', url: 'https://www.notateslaapp.com/rss' },
  { id: 'teslanorth', tier: 1, name: 'Teslanorth', url: 'https://teslanorth.com/feed/' },
  { id: 'driveteslacanada', tier: 1, name: 'Drive Tesla Canada', url: 'https://driveteslacanada.ca/feed/' },
  { id: 'teslaoracle', tier: 2, name: 'Tesla Oracle', url: 'https://www.teslaoracle.com/feed/' },
  { id: 'techcrunch', tier: 2, name: 'TechCrunch', url: 'https://techcrunch.com/category/transportation/feed/' },
  { id: 'theverge', tier: 2, name: 'The Verge', url: 'https://www.theverge.com/rss/tesla/index.xml' },
  { id: 'arstechnica', tier: 2, name: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/cars' },
  { id: 'electrive', tier: 2, name: 'Electrive', url: 'https://www.electrive.com/feed/' },
  { id: 'cnbc-autos', tier: 2, name: 'CNBC', url: 'https://www.cnbc.com/id/10000101/device/rss/rss.html' },
  { id: 'cnbc-tech', tier: 2, name: 'CNBC', url: 'https://www.cnbc.com/id/19854910/device/rss/rss.html' },
  { id: 'bloomberg-tech', tier: 2, name: 'Bloomberg', url: 'https://www.bloomberg.com/feeds/technology/news.rss' },
  { id: 'businessinsider', tier: 2, name: 'Business Insider', url: 'https://feeds.businessinsider.com/custom/all' },
  { id: 'fortune', tier: 2, name: 'Fortune', url: 'https://fortune.com/feed/fortune-feeds/?id=3230629' },
  { id: 'nytimes-tech', tier: 2, name: 'The New York Times', url: 'https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml' },
  { id: 'thedriven', tier: 2, name: 'The Driven', url: 'https://thedriven.io/feed/' },
  { id: 'therobotreport', tier: 2, name: 'The Robot Report', url: 'https://www.therobotreport.com/feed/' },
  { id: 'carscoops', tier: 2, name: 'Carscoops', url: 'https://www.carscoops.com/feed/' },
  { id: 'jalopnik', tier: 2, name: 'Jalopnik', url: 'https://www.jalopnik.com/feed/' },
  { id: 'kxan', tier: 2, name: 'KXAN', url: 'https://www.kxan.com/feed/' },
  { id: 'kvue', tier: 2, name: 'KVUE', url: 'https://www.kvue.com/feeds/syndication/rss/news' },
  { id: 'communityimpact', tier: 2, name: 'Community Impact', url: 'https://communityimpact.com/rss/' },
  { id: 'lvrj', tier: 2, name: 'Las Vegas Review-Journal', url: 'https://www.reviewjournal.com/feed/' }
];
export const FEEDS = DEFAULT_FEEDS;
// A stored feed list -> the valid entries, or null.
export function parseFeedList(value) {
  let v; try { v = JSON.parse(value); } catch (e) { return null; }
  if (!Array.isArray(v)) return null;
  const out = v.filter(f => f && typeof f.id === 'string' && /^[a-z0-9-]{1,60}$/.test(f.id) && typeof f.url === 'string' && /^https:\/\//i.test(f.url))
    .map(f => ({ id: f.id, name: String(f.name || '').trim().slice(0, 80) || hostOf(f.url), url: f.url, tier: f.tier === 1 ? 1 : 2 }));
  return out;
}
// The feed to check this step: never checked first (in list order), then the
// most overdue against its tier's interval.
export function pickFeed(feeds, checks, nowMs) {
  let best = null, bestScore = -1;
  for (const f of feeds) {
    const last = checks[f.id];
    const score = last ? (nowMs - last) / (TIER_MINUTES[f.tier === 1 ? 1 : 2] * 60e3) : Infinity;
    if (score > bestScore) { best = f; bestScore = score; }
  }
  return best;
}

// Defaults for news_config (migrations/0029 seeds the same). One rule per line;
// "a + b" means both words. Matching is case-insensitive, on whole words.
export const DEFAULT_ALLOW = 'cybercab\nrobotaxi + tesla';
export const DEFAULT_BLOCK = 'stock\nstocks\nshares\nprice target\nTSLA\nwall street\nanalyst\nanalysts\ninvestors\nvaluation\nstocktwits\nvideo shows\nwatch:\nshocking\nyou won\'t believe\ngoes viral\ncaught on camera\nleaked video\n/app\\s+\\d+\\.\\d+/';
// Publishers whose stories are never kept (news_config 'publisher_blocklist',
// a JSON array; migrations/0030 seeds it, 0033 adds Stocktwits). Matched case-insensitively against
// a story's source, before scoring and storage.
export const DEFAULT_PUBLISHER_BLOCKLIST = ['BASENOR', 'Stocktwits'];
const publisherKey = name => String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
export function parsePublisherList(value) {
  try { const v = JSON.parse(value); return Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim().replace(/\s+/g, ' ')) : null; } catch (e) { return null; }
}

// The Major keywords (news_config 'major_keywords', a JSON array; migrations/0032
// seeds the same). Each matches case-insensitively at the start of a word
// ("launch" also matches "launches", "sues" never matches "issues"), in a
// headline or its excerpt.
export const DEFAULT_MAJOR_KEYWORDS = ['launch', 'expansion', 'expands', 'expanded', 'expanding', 'crash', 'recall', 'nhtsa', 'investigation', 'investigates', 'investigated', 'lawsuit', 'sues', 'sued', 'new city', 'new cities', 'safety', 'price', 'pricing',
  'fleet', 'deploys', 'deployment', 'rolls out', 'rollout', 'adds', 'dozens', 'hundreds',
  'dmv', 'registry', 'registered', 'registration', 'certification', 'self-certification',
  'new market', 'service area', 'service zone', 'expands to', 'launch in', 'arrives in'];
export function parseKeywordList(value) {
  try { const v = JSON.parse(value); return Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim().replace(/\s+/g, ' ').toLowerCase()) : null; } catch (e) { return null; }
}
const reEscape = w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function keywordMatcher(keywords) {
  const list = (keywords || []).map(k => String(k).trim().toLowerCase()).filter(Boolean);
  if (!list.length) return () => false;
  const re = new RegExp(`(^|[^a-z0-9])(${list.map(k => reEscape(k).replace(/ /g, '\\s+')).join('|')})`, 'i');
  return text => re.test(String(text || ''));
}
// The numeric fleet signal: a headline with a number (digits, or "dozens" /
// "hundreds" / "thousands") and a fleet word.
const FLEET_WORD = /\b(cybercabs?|robotaxis?|fleet|vehicles)\b/i;
const NUMBER = /\d|\b(dozens|hundreds|thousands)\b/i;
export const fleetNumber = title => NUMBER.test(String(title || '')) && FLEET_WORD.test(String(title || ''));
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

export function excerptOf(description, title) {
  // WordPress feeds end with "The post … appeared first on …" and "[…]" / "Read more".
  const text = stripTags(description)
    .replace(/\s*The post\b[\s\S]*?\bappeared first on\b[\s\S]*$/i, '')
    .replace(/\s*(\[(…|\.\.\.)\]|\(…\)|Continue reading\b.*|Read more\b.*)$/i, '')
    .trim();
  if (!text) return null;
  const norm = s => String(s).toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const nt = norm(text), nh = norm(title);
  // Only the headline again (Google News style, or the headline plus the outlet): none.
  if (nt.startsWith(nh.slice(0, 40)) || nh.includes(nt)) return null;
  const tw = nt.split(' '), hw = new Set(nh.split(' '));
  if (tw.length <= hw.size + 3 && tw.filter(w => hw.has(w)).length / tw.length >= 0.8) return null;
  if (text.length <= EXCERPT_MAX) return text;
  // Cut at the last sentence end that fits; failing that, at a word, with "…".
  const cut = text.slice(0, EXCERPT_MAX);
  let end = -1;
  for (const m of cut.matchAll(/[.!?]["”’)]?(?=\s)/g)) end = m.index + m[0].length;
  if (end >= 80) return cut.slice(0, end);
  const words = cut.slice(0, EXCERPT_MAX - 1);
  return words.slice(0, Math.max(words.lastIndexOf(' '), EXCERPT_MAX - 40)).replace(/[\s,;:.—-]+$/, '') + '…';
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
// A blocklist line: words / a phrase (whole words), or /a pattern/ (always
// case-insensitive; null when it does not compile).
export function blockPattern(line) {
  const m = /^\/(.+)\/([a-z]*)$/.exec(line);
  if (!m) return word(line);
  try { return new RegExp(m[1], [...new Set((m[2] + 'i').replace(/[^imsu]/g, ''))].join('')); } catch (e) { return null; }
}
const straightQuotes = s => String(s || '').replace(/[’‘]/g, "'").replace(/[“”]/g, '"');
export function compileRules(allowText, blockText) {
  // Allowlist words also match their plural and possessive ("Cybercabs", "Cybercab's").
  const allowWord = w => new RegExp(`(^|[^a-z0-9])${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(s|['’]s)?($|[^a-z0-9])`, 'i');
  const allow = lines(allowText).map(l => l.split('+').map(t => t.trim()).filter(Boolean).map(allowWord));
  const block = lines(blockText).map(blockPattern).filter(Boolean);
  return {
    keep(item) {
      const text = `${item.title} ${item.excerpt || ''}`;
      if (!allow.some(rule => rule.every(re => re.test(text)))) return 'not_relevant';
      const title = straightQuotes(item.title);
      if (block.some(re => re.test(title))) return 'blocked';
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
// Rows: {id, title, excerpt, source, source_type, published_at, featured, ai_major}.
// Returns per-id {cluster_id, source_count, importance, rules}: rules is the
// cluster's deterministic score (outlets + keyword-or-substantive + numeric
// fleet), and
// importance adds a stored AI "major" verdict, capped at 2 (featured = 2).
export function clusterAndScore(rows, { keywords = DEFAULT_MAJOR_KEYWORDS } = {}) {
  const hasKeyword = keywordMatcher(keywords);
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
    // A Major keyword and the substance signal share one +1: they mostly fire
    // on the same words, and counting both made opinion pieces Major.
    const rules = (within24.size >= 3 ? 1 : 0)
      + (members.some(m => hasKeyword(m.title) || hasKeyword(m.excerpt) || substantive(m)) ? 1 : 0)
      + (members.some(m => fleetNumber(m.title)) ? 1 : 0);
    const ai = members.some(m => m.ai_major === 1) ? 1 : 0;
    for (const m of members) out[m.id] = { cluster_id: first.id, source_count: sources.size, importance: m.featured ? 2 : Math.min(2, rules + ai), rules };
  }
  return out;
}

// Topic tags for a story (computed when served; scoring reads them too).
const TOPICS = [
  ['Expansion', /\b(expan\w*|launch\w*|new cit(y|ies)|rollout|rolls? out|coming to|arriv\w*|cities)\b/i],
  ['Regulatory', /\b(nhtsa|regulat\w*|permit\w*|dmv|lawsuit\w*|sue[sd]?|investigat\w*|federal|congress|senate|legislat\w*|law|cpuc|approval)\b/i],
  ['Data', /\b(registr\w*|data|statistics?|fleet|miles)\b|\d[\d,.]*\s*(cybercabs?|robotaxis?|vehicles|units|rides|miles)\b/i],
  ['Business', /\b(funding|raises?|raised|partner\w*|ipo|acquir\w*|acquisition|merger|deal|investment)\b/i],
  ['Safety', /\b(crash\w*|safety|recall\w*|collision\w*|injur\w*|incident\w*)\b/i],
  ['Production', /\b(production|factory|gigafactory|giga|manufactur\w*|assembly)\b/i],
  ['Pricing', /\b(price\w*|pricing|fares?|cost\w*)\b/i],
  ['Rides', /\b(ride\w*|riders?|passengers?|app)\b/i]
];
export const topicsOf = s => { const text = `${s.title} ${s.excerpt || ''}`; return TOPICS.filter(([, re]) => re.test(text)).map(([n]) => n); };
// The substance signal: a press or official story (not social) tagged
// Regulatory, Data, Expansion or Business.
const SUBSTANTIVE = new Set(['Regulatory', 'Data', 'Expansion', 'Business']);
export const substantive = s => (s.source_type || 'press') !== 'social' && topicsOf(s).some(t => SUBSTANTIVE.has(t));
export function tagsOf(s) {
  const t = topicsOf(s);
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
  if (!(await robotsOk(env, feed.url, fetchImpl))) throw new Error(`${feed.id}: robots.txt disallows the feed (or could not be read)`);
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
  const { results } = await sql.prepare(`SELECT key, value FROM news_config WHERE key IN ('allow', 'block', 'publisher_blocklist', 'thumb_blocklist', 'major_keywords', 'feeds')`).all();
  const map = Object.fromEntries((results || []).map(r => [r.key, r.value]));
  const publishers = map.publisher_blocklist != null ? parsePublisherList(map.publisher_blocklist) : null;
  return {
    allow: map.allow != null ? map.allow : DEFAULT_ALLOW,
    block: map.block != null ? map.block : DEFAULT_BLOCK,
    publisher_blocklist: publishers || DEFAULT_PUBLISHER_BLOCKLIST,
    thumb_blocklist: (map.thumb_blocklist != null && domainList(map.thumb_blocklist)) || [],
    major_keywords: (map.major_keywords != null && parseKeywordList(map.major_keywords)) || DEFAULT_MAJOR_KEYWORDS,
    feeds: (map.feeds != null && parseFeedList(map.feeds)) || DEFAULT_FEEDS
  };
}

const newLog = (nowMs, extra = {}) => ({ at: new Date(nowMs).toISOString(), feeds: [], fetched: 0, kept: 0, dropped: 0, blocked_publisher: 0, duplicates: 0, new: 0, not_modified: 0, errors: [], ...extra });

// Checks the given feeds and stores their new stories.
async function ingestFeeds(env, feeds, { fetchImpl, nowMs, log, cfg }) {
  const sql = env.cybercabhunter_db;
  if (!cfg) cfg = await config(sql);
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
  fresh.forEach(it => { it.id = crypto.randomUUID(); });
  const inserts = fresh.map(it => sql.prepare(`INSERT OR IGNORE INTO news_articles (id, title, url, source, source_type, published_at, excerpt, image_url, thumb_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`)
    .bind(it.id, it.title.slice(0, 300), it.url, it.source.slice(0, 80), it.source_type, it.published_at, it.excerpt, null));
  for (let i = 0; i < inserts.length; i += 50) {
    const res = await sql.batch(inserts.slice(i, i + 50));
    log.new += res.reduce((n, r) => n + ((r.meta && r.meta.changes) || 0), 0);
  }
  if (!log.new) return;
  const scored = await recluster(sql, nowMs, RECLUSTER_DAYS, cfg.major_keywords);
  if (await aiPass(env, fresh.map(it => it.id), scored, log)) await recluster(sql, nowMs, RECLUSTER_DAYS, cfg.major_keywords);
}

// ---------- Workers AI significance (new stories only) ----------
const AI_SYSTEM = `You judge whether a Tesla Cybercab / robotaxi news story is MAJOR for people tracking the Cybercab rollout.
MAJOR (substantive news): fleet data (registrations, fleet counts, growth numbers), regulatory action with official status (NHTSA, certifications, permits, investigations), expansion (new cities or markets, service-hour changes, from official announcements or reputable press), business moves (funding, partnerships, IPOs of robotaxi operators), safety data with real numbers, new vehicle variants entering service, a serious crash with injuries or an official investigation.
NOT MAJOR: viral clips of single incidents, app version updates, opinion or analysis with no news, stock chatter, rumors, gossip.
Examples:
"Tesla registers a record 150 Cybercabs in Texas in one day" -> major: fleet data
"NHTSA gives Tesla until Oct. 30 to answer, under oath, how it certified the Cybercab" -> major: regulatory
"Tesla extends Austin Robotaxi service hours to 11 p.m." -> major: expansion
"Video Shows Man Stuck in Tesla Cybercab That Goes in Circles Around Parking Lot" -> not-major: viral clip
"Tesla Robotaxi App 26.8.3 Now Live on iOS" -> not-major: routine update
Answer with exactly one line: "major: <short reason>" or "not-major: <short reason>".`;
// The model's answer -> {major, reason}, or null when it isn't one of the two.
export function parseVerdict(text) {
  const line = String(text || '').split(/\r?\n/).map(l => l.trim().replace(/^[*"'`>\s-]+/, '')).find(Boolean) || '';
  const m = /^(not[\s-]?major|major)\b\s*[:\-–—]?\s*(.*)$/i.exec(line);
  if (!m) return null;
  return { major: !/^not/i.test(m[1]), reason: m[2].replace(/^[*"`:\s\-–—]+/, '').replace(/["*`]+$/g, '').trim().slice(0, 200) };
}
export async function aiVerdict(env, story, { timeoutMs = AI_TIMEOUT_MS } = {}) {
  if (!env.AI || typeof env.AI.run !== 'function') throw new Error('ai_unavailable');
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('ai_timeout')), timeoutMs); });
  try {
    const res = await Promise.race([env.AI.run(AI_MODEL, {
      messages: [{ role: 'system', content: AI_SYSTEM }, { role: 'user', content: `Headline: ${story.title}\nExcerpt: ${story.excerpt || '(none)'}` }],
      max_tokens: 60, temperature: 0
    }), timeout]);
    const v = parseVerdict(res && typeof res === 'object' ? res.response : res);
    if (!v) throw new Error('ai_unparseable');
    return v;
  } finally { clearTimeout(timer); }
}
// Asks the model about the new stories whose rules score is exactly 1 (not
// featured, and no verdict yet in their cluster); stores each verdict. A
// failure is logged and the rules score stands. Returns whether any promoted.
async function aiPass(env, ids, scored, log) {
  const sql = env.cybercabhunter_db;
  const rows = scored.rows.filter(r => ids.includes(r.id) && !r.featured && r.ai_major == null && scored.next[r.id] && scored.next[r.id].rules === 1);
  const judged = new Set(scored.rows.filter(r => r.ai_major != null).map(r => scored.next[r.id] && scored.next[r.id].cluster_id));
  const ask = [];
  for (const r of rows) { const c = scored.next[r.id].cluster_id; if (!judged.has(c)) { judged.add(c); ask.push(r); } }
  if (!ask.length) return false;
  log.ai = { checked: 0, promoted: 0, failed: 0, skipped: Math.max(0, ask.length - AI_PER_TICK), verdicts: [] };
  let promoted = false;
  for (const r of ask.slice(0, AI_PER_TICK)) {
    const title = String(r.title).slice(0, 100);
    try {
      const v = await aiVerdict(env, r);
      log.ai.checked++;
      await sql.prepare(`UPDATE news_articles SET ai_major = ?, ai_reason = ? WHERE id = ?`).bind(v.major ? 1 : 0, v.reason, r.id).run();
      if (v.major) { log.ai.promoted++; promoted = true; }
      log.ai.verdicts.push({ title, verdict: v.major ? 'major' : 'not-major', reason: v.reason });
    } catch (e) {
      log.ai.failed++;
      log.ai.verdicts.push({ title, error: String(e && e.message || e).slice(0, 120) });
      console.log('news ai failed', title, String(e && e.message || e));
    }
  }
  return promoted;
}

// Every feed in one go (tests and one-off backfills; the schedule uses runNewsTick).
export async function runNewsIngest(env, { fetchImpl = fetch, nowMs = Date.now(), thumbs = false } = {}) {
  const log = newLog(nowMs);
  const cfg = await config(env.cybercabhunter_db);
  await ingestFeeds(env, cfg.feeds, { fetchImpl, nowMs, log, cfg });
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
  const cfg = await config(env.cybercabhunter_db);
  let checks = {}; try { checks = JSON.parse((await kv.get(KV_FEED_CHECKS)) || '{}') || {}; } catch (e) { checks = {}; }
  const feed = pickFeed(cfg.feeds, checks, nowMs);
  const log = newLog(nowMs);
  if (feed) {
    // Only the feeds still listed are remembered.
    const next = Object.fromEntries(cfg.feeds.filter(f => checks[f.id]).map(f => [f.id, checks[f.id]]));
    next[feed.id] = nowMs;
    await kv.put(KV_FEED_CHECKS, JSON.stringify(next));
    await ingestFeeds(env, [feed], { fetchImpl, nowMs, log, cfg });
  }
  log.thumbs = await processThumbs(env, { fetchImpl, limit: THUMBS_PER_TICK });
  const today = chicagoDay(nowMs);
  let prune = null; try { prune = JSON.parse((await kv.get(KV_PRUNE)) || 'null'); } catch (e) { prune = null; }
  if (!prune || prune.day !== today) {
    const p = await pruneOld(env, nowMs);
    Object.assign(log, p);
    await kv.put(KV_PRUNE, JSON.stringify({ day: today, at: log.at, ...p }));
  } else {
    // Once a day (and on the step after the Major keywords are saved), on a
    // step without the prune: every stored story rescored by the rules.
    let rs = null; try { rs = JSON.parse((await kv.get(KV_RESCORE)) || 'null'); } catch (e) { rs = null; }
    if (!rs || rs.day !== today) {
      const cfg = await config(env.cybercabhunter_db);
      const { changed } = await recluster(env.cybercabhunter_db, nowMs, MAX_AGE_DAYS + 1, cfg.major_keywords);
      log.rescored = changed;
      await kv.put(KV_RESCORE, JSON.stringify({ day: today, at: log.at, changed }));
    }
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

// Re-clusters and rescores (rules + stored AI verdicts) the stories of the
// last `days`. Only cluster_id, source_count and importance change (hidden
// stays as it is). Returns {changed, rows, next}.
async function recluster(sql, nowMs, days, keywords) {
  if (!keywords) keywords = (await config(sql)).major_keywords;
  const since = new Date(nowMs - days * 864e5).toISOString();
  const { results } = await sql.prepare(`SELECT id, title, excerpt, source, source_type, published_at, featured, ai_major, cluster_id, source_count, importance FROM news_articles WHERE published_at >= ?`).bind(since).all();
  const rows = results || [];
  const next = clusterAndScore(rows, { keywords });
  const updates = rows.filter(r => { const n = next[r.id]; return n && (n.cluster_id !== r.cluster_id || n.source_count !== r.source_count || n.importance !== r.importance); })
    .map(r => sql.prepare(`UPDATE news_articles SET cluster_id = ?, source_count = ?, importance = ? WHERE id = ?`).bind(next[r.id].cluster_id, next[r.id].source_count, next[r.id].importance, r.id));
  for (let i = 0; i < updates.length; i += 50) await sql.batch(updates.slice(i, i + 50));
  return { changed: updates.length, rows, next };
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
  const { results } = await env.cybercabhunter_db.prepare(`SELECT id, title, url, source, source_type, published_at, importance, source_count, cluster_id, hidden, featured, thumb_key, thumb_status, ai_major, ai_reason
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
  let majorKeywords;
  if (body.major_keywords !== undefined) {
    if (!Array.isArray(body.major_keywords) || body.major_keywords.some(x => typeof x !== 'string')) return Response.json({ success: false, error: 'bad_major_keywords' }, { status: 400 });
    majorKeywords = [...new Set(body.major_keywords.map(x => x.trim().replace(/\s+/g, ' ').toLowerCase().slice(0, 60)).filter(Boolean))].slice(0, 200);
  }
  if (allow === undefined && block === undefined && publishers === undefined && thumbDomains === undefined && majorKeywords === undefined) return Response.json({ success: false, error: 'bad_config' }, { status: 400 });
  if (allow !== undefined && !lines(allow).length) return Response.json({ success: false, error: 'empty_allowlist' }, { status: 400 });
  const badPattern = block !== undefined && lines(block).find(l => !blockPattern(l));
  if (badPattern) return Response.json({ success: false, error: 'bad_pattern', line: badPattern }, { status: 400 });
  const sql = env.cybercabhunter_db;
  const put = (k, v) => sql.prepare(`INSERT INTO news_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(k, v);
  const writes = [];
  if (allow !== undefined) writes.push(put('allow', allow));
  if (block !== undefined) writes.push(put('block', block));
  if (publishers !== undefined) writes.push(put('publisher_blocklist', JSON.stringify(publishers)));
  if (thumbDomains !== undefined) writes.push(put('thumb_blocklist', JSON.stringify(thumbDomains)));
  if (majorKeywords !== undefined) writes.push(put('major_keywords', JSON.stringify(majorKeywords)));
  await sql.batch(writes);
  // New Major keywords: the next step rescores every stored story.
  if (majorKeywords !== undefined) await env.TESLA_SESSIONS.delete(KV_RESCORE);
  return Response.json({ success: true, config: await config(sql) });
}

// ---------- feed discovery and validation (moderation) ----------
const looksLikeFeed = text => /<(rss|feed|rdf:RDF)\b/i.test(String(text).slice(0, 4000));
const feedTitle = xml => { const head = String(xml).split(/<(item|entry)\b/i)[0]; return stripTags(tag(head, 'title')).slice(0, 80); };
// One candidate URL -> {url, title} when it is a feed robots.txt allows, else {error}.
async function tryFeed(env, url, fetchImpl) {
  if (!(await robotsOk(env, url, fetchImpl))) return { error: 'robots_disallowed' };
  let r;
  try { r = await fetchWithTimeout(fetchImpl, url, { headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/html;q=0.5' }, redirect: 'follow' }); } catch (e) { return { error: 'unreachable' }; }
  if (!r.ok) return { error: `http_${r.status}` };
  const text = new TextDecoder().decode(await readCapped(r, FEED_PAGE_MAX_BYTES));
  if (!looksLikeFeed(text)) return { error: 'not_a_feed', html: text };
  const finalUrl = r.url && /^https:\/\//i.test(r.url) ? r.url : url;
  if (finalUrl !== url && !(await robotsOk(env, finalUrl, fetchImpl))) return { error: 'robots_disallowed' };
  return { url: finalUrl, title: feedTitle(text), items: parseFeed(text, { id: 'check', name: 'check' }).length };
}
// The first <link rel="alternate" type="application/rss+xml|atom+xml"> of a page.
export function alternateFeed(html, pageUrl) {
  for (const t of String(html).match(/<link\b[^>]*>/gi) || []) {
    if (!/\brel\s*=\s*["']?alternate/i.test(t) || !/\btype\s*=\s*["']application\/(rss|atom)\+xml/i.test(t)) continue;
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(t);
    if (href) { try { const u = new URL(decode(href[1]), pageUrl); if (u.protocol === 'https:') return u.toString(); } catch (e) { /* skip */ } }
  }
  return null;
}
// A URL or bare domain -> {url, title} of a feed we may fetch, or {error}:
// robots_disallowed, no_feed_found, not_a_feed.
export async function discoverFeed(env, input, { fetchImpl = fetch } = {}) {
  let raw = String(input || '').trim();
  if (!raw) return { error: 'no_feed_found' };
  if (!/^[a-z]+:\/\//i.test(raw)) raw = 'https://' + raw;
  let u;
  try { u = new URL(raw); } catch (e) { return { error: 'bad_url' }; }
  if (u.protocol !== 'https:') return { error: 'https_only' };
  const bare = (u.pathname === '/' || u.pathname === '') && !u.search;
  let disallowed = false;
  const candidates = bare ? ['/feed', '/rss', '/rss.xml', '/atom.xml'].map(p => u.origin + p) : [u.toString()];
  let page = null;
  for (const c of candidates) {
    const res = await tryFeed(env, c, fetchImpl);
    if (res.url) return res;
    if (res.error === 'robots_disallowed') disallowed = true;
    if (!bare && res.html) page = res.html;
  }
  // The homepage (or the given page) may name its feed.
  if (bare) {
    if (!(await robotsOk(env, u.origin + '/', fetchImpl))) disallowed = true;
    else {
      try { const r = await fetchWithTimeout(fetchImpl, u.origin + '/', { headers: { 'User-Agent': UA, Accept: 'text/html' }, redirect: 'follow' }); if (r.ok) page = new TextDecoder().decode(await readCapped(r, FEED_PAGE_MAX_BYTES)); } catch (e) { page = null; }
    }
  }
  const alt = page && alternateFeed(page, bare ? u.origin + '/' : u.toString());
  if (alt) {
    const res = await tryFeed(env, alt, fetchImpl);
    if (res.url) return res;
    if (res.error === 'robots_disallowed') disallowed = true;
  }
  return { error: disallowed ? 'robots_disallowed' : bare ? 'no_feed_found' : 'not_a_feed' };
}
const FEED_ERRORS = {
  robots_disallowed: 'That site\'s robots.txt does not allow fetching its feed.',
  no_feed_found: 'No feed found (tried /feed, /rss, /rss.xml, /atom.xml and the homepage).',
  not_a_feed: 'That URL is not an RSS or Atom feed, and the page names none.',
  bad_url: 'That is not a valid URL or domain.',
  https_only: 'Only https feeds can be added.',
  duplicate: 'That feed is already on the list.',
  not_found: 'No feed with that id.'
};
const feedError = (error, status = 400) => Response.json({ success: false, error, message: FEED_ERRORS[error] || error }, { status });
// POST /api/moderation/news-feeds {action: add, url, name?, tier} | {action: remove, id} | {action: tier, id, tier}
// Adds are checked now (robots.txt, parses as RSS / Atom; a bare domain is
// auto-discovered); every change applies from the next step.
export async function modNewsFeeds(request, env, { fetchImpl = fetch } = {}) {
  let body = {};
  try { body = await request.json(); } catch (e) { body = {}; }
  const sql = env.cybercabhunter_db;
  const feeds = (await config(sql)).feeds.slice();
  const tier = body.tier === 1 || body.tier === '1' ? 1 : 2;
  if (body.action === 'add') {
    const found = await discoverFeed(env, body.url, { fetchImpl });
    if (found.error) return feedError(found.error);
    if (feeds.some(f => f.url.replace(/\/+$/, '').toLowerCase() === found.url.replace(/\/+$/, '').toLowerCase())) return feedError('duplicate', 409);
    if (feeds.length >= 60) return feedError('too_many_feeds');
    const base = hostOf(found.url).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'feed';
    let id = base, n = 2;
    while (feeds.some(f => f.id === id)) id = `${base}-${n++}`;
    feeds.push({ id, name: String(body.name || '').trim().replace(/\s+/g, ' ').slice(0, 80) || found.title || hostOf(found.url), url: found.url, tier });
  } else if (body.action === 'remove' || body.action === 'tier') {
    const i = feeds.findIndex(f => f.id === body.id);
    if (i < 0) return feedError('not_found', 404);
    if (body.action === 'remove') feeds.splice(i, 1); else feeds[i] = { ...feeds[i], tier };
  } else {
    return feedError('bad_action');
  }
  await sql.prepare(`INSERT INTO news_config (key, value) VALUES ('feeds', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(JSON.stringify(feeds)).run();
  return Response.json({ success: true, feeds });
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
