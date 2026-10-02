// Community page: leaderboards and public rider profiles.
//
//   GET /api/community/leaderboard?board=discovered   public, edge-cached
//     -> { board, label, boards: [{ id, label }], entries: [{ rank, count, name, handle, avatar_url, profile }],
//          totals: { spotters, vehicles } }   (every ranked rider, not just the top N: counts only)
//   GET /api/rider-search?q=bo                        public, rate limited, never cached
//     -> { q, results: [{ name, handle, avatar_url }] }   (at most 8; see apiSearchRiders)
//   GET /api/riders/:handle                           public, edge-cached
//     -> { rider: { name, handle, avatar_url, bio, joined }, discovered: { count, vehicles: [...] },
//          rides: { count, vehicles, cities: [{ name, rides }] },
//          reviews: { count, average, recent: [...] } }
//
// Boards are a server-side map (BOARDS): a future board (most sightings,
// longest streak) is one new entry — its ranking SQL and label — and the page
// shows tab buttons only once there is more than one.
//
// PRIVACY (hard rules):
//   - A rider is shown only while users.leaderboard_opt_in = 1: on by default
//     (new accounts, and existing ones via migrations/0021, as the privacy
//     page states), off with the Profile page's switch. profile_visibility is
//     not read.
//   - A rider who has turned it off is a "Private spotter": rank and count only —
//     no name, handle, photo, id or link ever leaves the server for them.
//   - A public profile needs the opt-in AND a handle; anything else is a 404,
//     identical to an unknown handle (existence isn't revealed).
//   - A public profile's ride figures are COUNTS ONLY (counted rides, distinct
//     vehicles ridden, and rides per city name — the same "which rides count"
//     rule as Rider Data); the privacy page says so, and the same switch hides
//     them. Never selected here: email (google_connections), fares/spending,
//     ride dates/times/routes/addresses, receipts, plates of vehicles ridden,
//     review status, internal user ids.
//   - Only publicly eligible vehicles (publicVehicleEligibleSql) ever count or
//     appear, so a private vehicle never leaks through a count or a list.

import { COUNTED_RIDES_WHERE, RIDES_FROM, publicVehicleEligibleSql } from './ride-status.js';
import { tesla } from './tesla.js';
import { sha256Hex } from './account.js';

const CACHE_SECONDS = 60;
const TOP_N = 6;
const HANDLE_RE = /^[a-z0-9_]{3,20}$/;
const PRIVATE_NAME = 'Private spotter';
const PROFILE_REVIEWS = 10;   // most recent reviews shown on a public profile
const SEARCH_MIN = 2;
const SEARCH_MAX = 40;
const SEARCH_LIMIT = 8;

// ---- Discovery credit (THE rule, shared by the leaderboard and profiles) ----
// For each publicly eligible vehicle, the discoverer is whoever has the
// EARLIEST of:
//   - its first counted ride (earliest by created_at, then rowid; pending and
//     approved count; superseded duplicates excluded — the Rider Data rule), or
//   - the approved human sighting that CREATED it (origin 'sighting'): its
//     earliest linked sighting, since the sighting that creates a vehicle is
//     always the first one linked to it.
// Both times are arrival times in this database (trips.created_at,
// submissions.submitted_at); on an exact tie the ride wins. The Muse
// connector's system account (MUSE_CONNECTOR_USER_ID) never earns credit: its
// rides are skipped, and a vehicle its sighting created has no sighting credit.
// Computed live — rejecting, deleting or superseding the winning ride or
// sighting, or making the vehicle private or deleting it, moves or drops the
// credit on the next read.
// `?` placeholders: the system account id, twice.
function discoveryCreditCte() {
  return `
    ride_first AS (
      SELECT t.robotaxi_vehicle_id AS vid, t.user_id AS uid, t.created_at AS at,
             ROW_NUMBER() OVER (PARTITION BY t.robotaxi_vehicle_id ORDER BY t.created_at ASC, t.rowid ASC) AS rn
      FROM ${RIDES_FROM}
      WHERE t.robotaxi_vehicle_id IS NOT NULL AND ${COUNTED_RIDES_WHERE} AND t.user_id <> ?
    ),
    sighting_creator AS (
      SELECT o.robotaxi_vehicle_id AS vid, o.user_id AS uid, s.submitted_at AS at, s.status AS status,
             ROW_NUMBER() OVER (PARTITION BY o.robotaxi_vehicle_id ORDER BY s.submitted_at ASC, s.rowid ASC) AS rn
      FROM vehicle_observations o JOIN submissions s ON s.id = o.submission_id
      WHERE o.robotaxi_vehicle_id IS NOT NULL AND s.submission_type = 'vehicle_sighting'
    ),
    candidates AS (
      SELECT vid, uid, at, 0 AS kind FROM ride_first WHERE rn = 1
      UNION ALL
      SELECT sc.vid, sc.uid, sc.at, 1 AS kind
      FROM sighting_creator sc JOIN robotaxi_vehicles cv ON cv.id = sc.vid
      WHERE sc.rn = 1 AND cv.origin = 'sighting' AND sc.status = 'approved' AND sc.uid <> ?
    ),
    credit AS (
      SELECT c.vid, c.uid, c.at,
             ROW_NUMBER() OVER (PARTITION BY c.vid ORDER BY c.at ASC, c.kind ASC) AS rn
      FROM candidates c JOIN robotaxi_vehicles v ON v.id = c.vid
      WHERE ${publicVehicleEligibleSql('v')}
    )`;
}

// A value no user id can equal, when the system account isn't configured.
const systemUserId = env => env.MUSE_CONNECTOR_USER_ID || '\u0000';

// Riders ranked by discovered vehicles: count, and when they reached it (the
// time of their latest credited discovery) for ordering within a tie.
async function rankDiscovered(sql, env) {
  const sys = systemUserId(env);
  const { results } = await sql.prepare(`
    WITH ${discoveryCreditCte()}
    SELECT u.leaderboard_opt_in AS opt_in, u.display_name, u.handle, u.avatar_url,
           COUNT(*) AS count, MAX(credit.at) AS reached_at, credit.uid AS uid
    FROM credit JOIN users u ON u.id = credit.uid
    WHERE credit.rn = 1
    GROUP BY credit.uid
    ORDER BY count DESC, reached_at ASC, credit.uid ASC
  `).bind(sys, sys).all();
  return results || [];
}

const BOARDS = {
  discovered: { label: 'Most Vehicles Discovered', rank: rankDiscovered }
};
const DEFAULT_BOARD = 'discovered';

// The public shape of one ranked rider. Only opted-in riders carry anything
// that identifies them; `profile` is true only when a public page exists.
function publicEntry(row, rank) {
  const optedIn = Number(row.opt_in) === 1;
  if (!optedIn) return { rank, count: Number(row.count), name: PRIVATE_NAME, handle: null, avatar_url: null, profile: false };
  const handle = row.handle || null;
  return {
    rank,
    count: Number(row.count),
    name: (row.display_name && String(row.display_name).trim()) || (handle ? `@${handle}` : 'Spotter'),
    handle,
    avatar_url: safeAvatar(row.avatar_url),
    profile: !!handle
  };
}

// Only an https image URL (a Google photo) or one of our own profile pictures
// (/api/avatars/<key>, worker/avatars.js) is ever passed on.
function safeAvatar(url) {
  if (typeof url !== 'string') return null;
  return /^https:\/\/[^\s"'<>]+$/.test(url) || /^\/api\/avatars\/[a-f0-9]{32}$/.test(url) ? url : null;
}

// Competition ranking (1, 1, 3): tied counts share a rank; the rows are
// already ordered, so within a tie whoever reached the count first is first.
export function rankEntries(rows, limit = TOP_N) {
  const out = [];
  rows.slice(0, limit).forEach((row, i) => {
    const prev = out[i - 1];
    const rank = prev && Number(rows[i - 1].count) === Number(row.count) ? prev.rank : i + 1;
    out.push(publicEntry(row, rank));
  });
  return out;
}

async function cached(request, ctx, build) {
  const cache = typeof caches !== 'undefined' && caches.default ? caches.default : null;
  const cacheKey = new Request(new URL(request.url).toString(), { method: 'GET' });
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }
  const response = await build();
  if (cache && response.status === 200) {
    const stored = cache.put(cacheKey, response.clone()).catch(() => {});
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(stored);
  }
  return response;
}

export async function apiCommunityLeaderboard(request, env, ctx) {
  const boardId = new URL(request.url).searchParams.get('board') || DEFAULT_BOARD;
  const board = Object.prototype.hasOwnProperty.call(BOARDS, boardId) ? BOARDS[boardId] : null;
  if (!board) return Response.json({ success: false, error: 'invalid_board' }, { status: 400 });
  return cached(request, ctx, async () => {
    const rows = await board.rank(env.cybercabhunter_db, env);
    return Response.json({
      board: boardId,
      label: board.label,
      boards: Object.entries(BOARDS).map(([id, b]) => ({ id, label: b.label })),
      entries: rankEntries(rows),
      totals: { spotters: rows.length, vehicles: rows.reduce((n, r) => n + Number(r.count), 0) }
    }, { headers: { 'Cache-Control': `public, max-age=${CACHE_SECONDS}` } });
  });
}

export async function apiGetRiderProfile(request, env, ctx, rawHandle) {
  const notFound = () => Response.json({ success: false, error: 'not_found' }, { status: 404, headers: { 'Cache-Control': `public, max-age=${CACHE_SECONDS}` } });
  let handle = '';
  try { handle = decodeURIComponent(rawHandle).trim().toLowerCase(); } catch (e) { return notFound(); }
  if (!HANDLE_RE.test(handle)) return notFound();
  return cached(request, ctx, async () => {
    const sql = env.cybercabhunter_db;
    const user = await sql.prepare(`
      SELECT id, display_name, handle, avatar_url, bio, created_at FROM users
      WHERE handle = ? AND leaderboard_opt_in = 1
    `).bind(handle).first();
    if (!user) return notFound();
    const sys = systemUserId(env);
    const { results } = await sql.prepare(`
      WITH ${discoveryCreditCte()}
      SELECT v.id, v.license_plate, v.model, v.color, v.service_area
      FROM credit JOIN robotaxi_vehicles v ON v.id = credit.vid
      WHERE credit.rn = 1 AND credit.uid = ?
      ORDER BY credit.at ASC
    `).bind(sys, sys, user.id).all();
    const vehicles = (results || []).map(v => ({ id: v.id, license_plate: v.license_plate, model: v.model, color: v.color, service_area: v.service_area }));
    const counted = `FROM ${RIDES_FROM} WHERE t.user_id = ? AND ${COUNTED_RIDES_WHERE}`;
    const [rideTotals, cityRows, reviewTotals, reviewRows] = await sql.batch([
      sql.prepare(`SELECT COUNT(*) AS rides, COUNT(DISTINCT t.robotaxi_vehicle_id) AS vehicles ${counted}`).bind(user.id),
      sql.prepare(`SELECT t.service_area AS name, COUNT(*) AS rides ${counted} AND t.service_area IS NOT NULL GROUP BY t.service_area ORDER BY rides DESC, t.service_area`).bind(user.id),
      sql.prepare(`
        SELECT COUNT(*) AS n, AVG(r.rating) AS avg FROM cybercab_reviews r JOIN robotaxi_vehicles v ON v.id = r.robotaxi_vehicle_id
        WHERE r.user_id = ? AND ${publicVehicleEligibleSql('v')}`).bind(user.id),
      sql.prepare(`
        SELECT r.id, r.rating, r.body, r.created_at, v.id AS vehicle_id, v.license_plate,
               (SELECT COUNT(*) FROM cybercab_review_likes l WHERE l.review_id = r.id) AS like_count,
               (SELECT COUNT(*) FROM cybercab_review_comments c WHERE c.review_id = r.id) AS comment_count
        FROM cybercab_reviews r JOIN robotaxi_vehicles v ON v.id = r.robotaxi_vehicle_id
        WHERE r.user_id = ? AND ${publicVehicleEligibleSql('v')}
        ORDER BY r.created_at DESC, r.id DESC LIMIT ${PROFILE_REVIEWS}`).bind(user.id)
    ]);
    const rt = (rideTotals.results || [])[0] || {};
    const rv = (reviewTotals.results || [])[0] || {};
    const reviewCount = Number(rv.n) || 0;
    return Response.json({
      rider: {
        name: (user.display_name && String(user.display_name).trim()) || `@${user.handle}`,
        handle: user.handle,
        avatar_url: safeAvatar(user.avatar_url),
        bio: user.bio || null,
        joined: String(user.created_at || '').slice(0, 7) || null   // month only
      },
      discovered: { count: vehicles.length, vehicles },
      rides: {
        count: Number(rt.rides) || 0,
        vehicles: Number(rt.vehicles) || 0,
        cities: (cityRows.results || []).map(c => ({ name: c.name, rides: Number(c.rides) }))
      },
      reviews: {
        count: reviewCount,
        average: reviewCount ? Math.round(Number(rv.avg) * 10) / 10 : null,
        recent: (reviewRows.results || []).map(r => ({
          id: r.id, rating: Number(r.rating), body: r.body, created_at: r.created_at,
          vehicle: { id: r.vehicle_id, license_plate: r.license_plate || null },
          like_count: Number(r.like_count), comment_count: Number(r.comment_count)
        }))
      }
    }, { headers: { 'Cache-Control': `public, max-age=${CACHE_SECONDS}` } });
  });
}

// Rider search for the Community page's "Find riders" box.
//   - Only riders who HAVE a public profile: leaderboard_opt_in = 1 AND a
//     username (the same rule as GET /api/riders/:handle). A private account
//     is simply never matched — no row, no "private account" placeholder —
//     and neither is an account without a profile page to go to, or the
//     Muse connector's system account.
//   - Matches the name a profile shows (the display name, else the username),
//     case-insensitive: names that START with the query first, then names
//     that contain it, alphabetical within each group. At most 8 results.
//   - 2–40 characters; anything shorter returns nothing. LIKE wildcards in the
//     query are escaped, so "%" or "_" only match themselves.
//   - The response carries name, username and photo only — never a user id,
//     email or anything else — and is never cached, so turning the Profile
//     switch off takes effect at once.
//   - Rate limited per rider (signed in) or per IP (SEARCH_LIMITER; fails
//     open if the binding is missing or errors).
export async function apiSearchRiders(request, env) {
  const noStore = { 'Cache-Control': 'no-store' };
  const q = (new URL(request.url).searchParams.get('q') || '').trim().replace(/\s+/g, ' ');
  if (q.length < SEARCH_MIN || q.length > SEARCH_MAX) return Response.json({ q, results: [] }, { headers: noStore });

  if (env.SEARCH_LIMITER) {
    const userId = await tesla.requireUserId(request, env);
    const who = userId ? `u:${userId}` : `ip:${request.headers.get('CF-Connecting-IP') || 'unknown'}`;
    let allowed = true;
    try { allowed = (await env.SEARCH_LIMITER.limit({ key: `rider-search:${await sha256Hex(who)}` })).success !== false; } catch (e) { /* fail open */ }
    if (!allowed) return Response.json({ success: false, error: 'rate_limited' }, { status: 429, headers: { 'Retry-After': '60', ...noStore } });
  }

  const like = q.toLowerCase().replace(/[\\%_]/g, c => `\\${c}`);
  const name = `COALESCE(NULLIF(TRIM(u.display_name), ''), u.handle)`;
  const { results } = await env.cybercabhunter_db.prepare(`
    SELECT ${name} AS name, u.handle, u.avatar_url,
           CASE WHEN LOWER(${name}) LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END AS grp
    FROM users u
    WHERE u.leaderboard_opt_in = 1 AND u.handle IS NOT NULL AND u.id <> ?
      AND LOWER(${name}) LIKE ? ESCAPE '\\'
    ORDER BY grp, LOWER(name), u.handle
    LIMIT ${SEARCH_LIMIT}
  `).bind(`${like}%`, systemUserId(env), `%${like}%`).all();
  return Response.json({
    q,
    results: (results || []).map(r => ({ name: String(r.name), handle: r.handle, avatar_url: safeAvatar(r.avatar_url) }))
  }, { headers: noStore });
}
