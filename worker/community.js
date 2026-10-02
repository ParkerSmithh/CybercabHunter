// Community page: leaderboards and public rider profiles.
//
//   GET /api/community/leaderboard?board=discovered   public, edge-cached
//     -> { board, label, boards: [{ id, label }], entries: [{ rank, count, name, handle, avatar_url, profile }] }
//   GET /api/riders/:handle                           public, edge-cached
//     -> { rider: { name, handle, avatar_url, bio, joined }, discovered: { count, vehicles: [...] } }
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
//   - Never selected here: email (google_connections), fares/spending, ride
//     dates/times/routes, receipts, review status, internal user ids.
//   - Only publicly eligible vehicles (publicVehicleEligibleSql) ever count or
//     appear, so a private vehicle never leaks through a count or a list.

import { COUNTED_RIDES_WHERE, RIDES_FROM, publicVehicleEligibleSql } from './ride-status.js';

const CACHE_SECONDS = 60;
const TOP_N = 6;
const HANDLE_RE = /^[a-z0-9_]{3,20}$/;
const PRIVATE_NAME = 'Private spotter';

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
      entries: rankEntries(rows)
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
    return Response.json({
      rider: {
        name: (user.display_name && String(user.display_name).trim()) || `@${user.handle}`,
        handle: user.handle,
        avatar_url: safeAvatar(user.avatar_url),
        bio: user.bio || null,
        joined: String(user.created_at || '').slice(0, 7) || null   // month only
      },
      discovered: { count: vehicles.length, vehicles }
    }, { headers: { 'Cache-Control': `public, max-age=${CACHE_SECONDS}` } });
  });
}
