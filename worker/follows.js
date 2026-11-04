// Followers & Following (migrations/0051_follows.sql; the rider page, the
// Community feed and the Profile page on the website, the same screens in the app).
//
//   GET    /api/follows/:handle                 relationship, counts and what the viewer may see
//   PUT    /api/follows/:handle                 signed in; follow, or request a private account (idempotent)
//   DELETE /api/follows/:handle                 signed in; unfollow or cancel a request (idempotent)
//   GET    /api/follows/:handle/followers?cursor=   the accounts following them
//   GET    /api/follows/:handle/following?cursor=   the accounts they follow
//   GET    /api/follow-requests?cursor=         signed in; requests to follow me
//   POST   /api/follow-requests/:id/accept      signed in; only my own requests (idempotent)
//   POST   /api/follow-requests/:id/decline     signed in; only my own requests (idempotent)
//   DELETE /api/followers/:id                   signed in; remove my follower (idempotent)
//   GET    /api/social/feed?filter=following    worker/social.js
//
// RULES (all enforced here; the pages only mirror them):
//   - A PRIVATE account is the existing setting: users.leaderboard_opt_in = 0
//     (the Profile page's public-profile switch). Everything that setting
//     already hides stays hidden from everyone but its approved followers.
//   - Pending requests grant nothing and are never counted.
//   - Who can see what:
//       public account: counts and lists are public.
//       private account, signed out: the same 404 as an unknown handle.
//       private account, signed in: only "@handle is private" and Request;
//         no name, photo, bio, counts or lists until approved.
//       approved follower or the owner: name, photo, bio, counts and lists,
//         and that account's posts carry its name in every feed.
//   - Lists never name a private account to a third party: it is left out and
//     counted in hidden_count. Its owner sees everyone who follows them, because
//     following or requesting someone shows them who you are.
//   - Going public accepts pending requests (anyone may follow a public account
//     anyway). Going private keeps existing followers and requires approval
//     for new ones. Removing a follower revokes access at once: nothing is
//     cached per viewer (every answer here is private, no-store).
//   - No user id or email leaves the server. Actions name an opaque row id.
//   - Rate limits: LIMITS per rider and per pair, counted in follow_actions;
//     unfollowing and cancelling are never limited. One notification per pair
//     and type, so following and unfollowing can't spam anyone.
//   - No XP from any of it. There is no blocking or account-suspension system
//     on this site to honor; removing a follower is the owner's control.

import { tesla } from './tesla.js';
import { sha256Hex } from './account.js';
import { authorJson } from './social.js';

export const FOLLOW_LIMITS = { perHour: 60, perDay: 300, perPairPerDay: 6 };
const PAGE = 30;
const PAGE_MAX = 50;
const HANDLE_RE = /^[a-z0-9_]{3,20}$/;
const ID_RE = /^[a-f0-9]{32}$/;
const NO_STORE = { 'Cache-Control': 'private, no-store' };

const newId = () => [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
const sqlNow = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const ok = (body, status = 200) => Response.json(body, { status, headers: NO_STORE });
const fail = (error, status = 400) => ok({ success: false, error }, status);
const unauthenticated = () => Response.json({ authenticated: false }, { status: 401, headers: NO_STORE });
const notFound = () => fail('not_found', 404);
const encodeCursor = o => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function decodeCursor(raw) {
  if (!raw) return null;
  try {
    const c = JSON.parse(atob(String(raw).replace(/-/g, '+').replace(/_/g, '/')));
    return typeof c.t === 'string' && typeof c.id === 'string' ? c : null;
  } catch (e) { return null; }
}

const myId = (request, env) => tesla.requireUserId(request, env);

async function userByHandle(sql, raw) {
  let handle = '';
  try { handle = decodeURIComponent(raw).trim().toLowerCase(); } catch (e) { return null; }
  if (!HANDLE_RE.test(handle)) return null;
  return sql.prepare(`SELECT u.id, u.handle, u.display_name, u.avatar_url, u.bio, u.created_at, u.leaderboard_opt_in AS opt_in, x.xp
    FROM users u LEFT JOIN user_xp x ON x.user_id = u.id WHERE u.handle = ?`).bind(handle).first();
}

// Someone the viewer may see by name: their public fields, rank and level.
const person = row => {
  const { name, handle, avatar_url, rank, level } = authorJson({ ...row, opt_in: 1 });
  return { name, handle, avatar_url, rank, level };
};

// Between the viewer and someone else: follow | following | requested | follow_back | self.
function stateOf(outgoing, incoming) {
  if (outgoing === 'accepted') return 'following';
  if (outgoing === 'pending') return 'requested';
  return incoming === 'accepted' ? 'follow_back' : 'follow';
}

async function relation(sql, meId, otherId) {
  if (!meId) return { state: 'signed_out', follows_you: false, requested_you: false };
  if (meId === otherId) return { state: 'self', follows_you: false, requested_you: false };
  const row = await sql.prepare(`SELECT
      (SELECT status FROM user_follows WHERE follower_id = ?1 AND followed_id = ?2) AS outgoing,
      (SELECT status FROM user_follows WHERE follower_id = ?2 AND followed_id = ?1) AS incoming`).bind(meId, otherId).first();
  return { state: stateOf(row && row.outgoing, row && row.incoming), follows_you: !!row && row.incoming === 'accepted', requested_you: !!row && row.incoming === 'pending' };
}

async function counts(sql, userId) {
  const row = await sql.prepare(`SELECT
      (SELECT COUNT(*) FROM user_follows WHERE followed_id = ?1 AND status = 'accepted') AS followers,
      (SELECT COUNT(*) FROM user_follows WHERE follower_id = ?1 AND status = 'accepted') AS following`).bind(userId).first();
  return { followers: Number(row.followers) || 0, following: Number(row.following) || 0 };
}

// The owner, an approved follower, or anyone for a public account.
function canSee(target, meId, rel) {
  return Number(target.opt_in) === 1 || meId === target.id || rel.state === 'following';
}

async function summary(sql, target, meId) {
  const rel = await relation(sql, meId, target.id);
  const isPrivate = Number(target.opt_in) !== 1;
  const visible = canSee(target, meId, rel);
  return {
    handle: target.handle,
    private: isPrivate,
    can_view: visible,
    relationship: rel.state,
    follows_you: rel.follows_you,
    requested_you: rel.requested_you,
    counts: visible ? await counts(sql, target.id) : null,
    // A private account's identity, only for those who may see it.
    profile: isPrivate && visible ? {
      ...person(target),
      bio: target.bio || null,
      joined: String(target.created_at || '').slice(0, 7) || null
    } : null
  };
}

export async function apiFollowStatus(request, env, rawHandle) {
  const sql = env.cybercabhunter_db;
  const target = await userByHandle(sql, rawHandle);
  if (!target) return notFound();
  const meId = await myId(request, env);
  // Signed out, a private account looks like an unknown handle.
  if (Number(target.opt_in) !== 1 && !meId) return notFound();
  return ok(await summary(sql, target, meId));
}

// ---- Rate limits ----

async function isRateLimited(env, meId, targetId) {
  const sql = env.cybercabhunter_db;
  if (env.REVIEWS_LIMITER) {
    try { if ((await env.REVIEWS_LIMITER.limit({ key: `follow:${await sha256Hex(meId)}` })).success === false) return true; } catch (e) { /* fail open */ }
  }
  const { perHour, perDay, perPairPerDay } = FOLLOW_LIMITS;
  const row = await sql.prepare(`SELECT
      (SELECT COUNT(*) FROM (SELECT 1 FROM follow_actions WHERE user_id = ?1 AND created_at >= ?3 LIMIT ${perHour})) AS hour,
      (SELECT COUNT(*) FROM (SELECT 1 FROM follow_actions WHERE user_id = ?1 AND created_at >= ?4 LIMIT ${perDay})) AS day,
      (SELECT COUNT(*) FROM (SELECT 1 FROM follow_actions WHERE user_id = ?1 AND target_user_id = ?2 AND created_at >= ?4 LIMIT ${perPairPerDay})) AS pair`)
    .bind(meId, targetId, sqlNow(Date.now() - 3600e3), sqlNow(Date.now() - 86400e3)).first();
  return Number(row.hour) >= perHour || Number(row.day) >= perDay || Number(row.pair) >= perPairPerDay;
}

const rateLimited = () => Response.json({ success: false, error: 'rate_limited' }, { status: 429, headers: { ...NO_STORE, 'Retry-After': '600' } });

// ---- Follow, unfollow, request, cancel ----

const notify = (sql, userId, type, actorId) => sql.prepare(`INSERT OR IGNORE INTO follow_notifications (id, user_id, type, actor_user_id, dedupe_key)
    VALUES (?, ?, ?, ?, ?)`).bind(newId(), userId, type, actorId, `${type}:${actorId}:${userId}`);
const clearRequestNotice = (sql, ownerId, requesterId) => sql.prepare(`DELETE FROM follow_notifications WHERE dedupe_key = ?`)
  .bind(`follow_request:${requesterId}:${ownerId}`);

export async function apiFollow(request, env, rawHandle) {
  const meId = await myId(request, env);
  if (!meId) return unauthenticated();
  const sql = env.cybercabhunter_db;
  const target = await userByHandle(sql, rawHandle);
  if (!target) return notFound();
  if (target.id === meId) return fail('cannot_follow_self');
  const existing = await sql.prepare(`SELECT status FROM user_follows WHERE follower_id = ? AND followed_id = ?`).bind(meId, target.id).first();
  // Already following or requested: nothing to do, and no limit spent.
  if (!existing) {
    if (await isRateLimited(env, meId, target.id)) return rateLimited();
    const status = Number(target.opt_in) === 1 ? 'accepted' : 'pending';
    await sql.batch([
      // The UNIQUE pair makes a double tap or a race one row, and one count.
      sql.prepare(`INSERT OR IGNORE INTO user_follows (id, follower_id, followed_id, status) VALUES (?, ?, ?, ?)`).bind(newId(), meId, target.id, status),
      sql.prepare(`INSERT INTO follow_actions (user_id, target_user_id) VALUES (?, ?)`).bind(meId, target.id),
      sql.prepare(`DELETE FROM follow_actions WHERE user_id = ? AND created_at < ?`).bind(meId, sqlNow(Date.now() - 2 * 86400e3)),
      notify(sql, target.id, status === 'accepted' ? 'follower' : 'follow_request', meId)
    ]);
  }
  return ok({ success: true, ...(await summary(sql, target, meId)) });
}

export async function apiUnfollow(request, env, rawHandle) {
  const meId = await myId(request, env);
  if (!meId) return unauthenticated();
  const sql = env.cybercabhunter_db;
  const target = await userByHandle(sql, rawHandle);
  if (!target) return notFound();
  if (target.id === meId) return fail('cannot_follow_self');
  await sql.batch([
    sql.prepare(`DELETE FROM user_follows WHERE follower_id = ? AND followed_id = ?`).bind(meId, target.id),
    clearRequestNotice(sql, target.id, meId)
  ]);
  return ok({ success: true, ...(await summary(sql, target, meId)) });
}

// ---- Lists ----

async function listPage(request, env, rawHandle, direction) {
  const sql = env.cybercabhunter_db;
  const target = await userByHandle(sql, rawHandle);
  if (!target) return notFound();
  const meId = await myId(request, env);
  if (Number(target.opt_in) !== 1 && !meId) return notFound();
  const rel = await relation(sql, meId, target.id);
  if (!canSee(target, meId, rel)) return fail('private_account', 403);
  const owner = meId === target.id;
  const params = new URL(request.url).searchParams;
  const limit = Math.min(Math.max(Number(params.get('limit')) || PAGE, 1), PAGE_MAX);
  const cursor = decodeCursor(params.get('cursor'));
  const [mine, theirs] = direction === 'followers' ? ['followed_id', 'follower_id'] : ['follower_id', 'followed_id'];
  // Only the owner sees private accounts and riders with no public name in their own lists.
  const shown = owner ? '' : `AND u.leaderboard_opt_in = 1 AND u.handle IS NOT NULL`;
  const rows = (await sql.prepare(`SELECT f.id AS follow_id, f.updated_at, u.id AS uid, u.handle, u.display_name, u.avatar_url, x.xp
      FROM user_follows f JOIN users u ON u.id = f.${theirs} LEFT JOIN user_xp x ON x.user_id = u.id
      WHERE f.${mine} = ? AND f.status = 'accepted' ${shown}
      ${cursor ? 'AND (f.updated_at < ? OR (f.updated_at = ? AND f.id < ?))' : ''}
      ORDER BY f.updated_at DESC, f.id DESC LIMIT ?`)
    .bind(target.id, ...(cursor ? [cursor.t, cursor.t, cursor.id] : []), limit + 1).all()).results || [];
  const page = rows.slice(0, limit);
  // The viewer's own relationship with everyone on this page, in one read.
  const relations = new Map();
  const ids = page.map(r => r.uid).filter(id => id !== meId);
  if (meId && ids.length) {
    const marks = ids.map(() => '?').join(',');
    const edges = (await sql.prepare(`SELECT follower_id, followed_id, status FROM user_follows
        WHERE (follower_id = ? AND followed_id IN (${marks})) OR (followed_id = ? AND follower_id IN (${marks}))`).bind(meId, ...ids, meId, ...ids).all()).results || [];
    for (const id of ids) {
      const out = edges.find(e => e.follower_id === meId && e.followed_id === id);
      const inc = edges.find(e => e.followed_id === meId && e.follower_id === id);
      relations.set(id, stateOf(out && out.status, inc && inc.status));
    }
  }
  const body = {
    users: page.map(r => ({
      ...person(r),
      relationship: !meId ? 'signed_out' : r.uid === meId ? 'self' : relations.get(r.uid),
      // What the owner's "Remove" names (their followers only).
      follow_id: owner && direction === 'followers' ? r.follow_id : null
    })),
    next_cursor: rows.length > limit ? encodeCursor({ t: page[page.length - 1].updated_at, id: page[page.length - 1].follow_id }) : null
  };
  // The first page says how many accounts this viewer isn't shown.
  if (!cursor) {
    const c = await counts(sql, target.id);
    const total = direction === 'followers' ? c.followers : c.following;
    let visible = total;
    if (!owner) {
      const row = await sql.prepare(`SELECT COUNT(*) AS n FROM user_follows f JOIN users u ON u.id = f.${theirs}
          WHERE f.${mine} = ? AND f.status = 'accepted' AND u.leaderboard_opt_in = 1 AND u.handle IS NOT NULL`).bind(target.id).first();
      visible = Number(row.n) || 0;
    }
    body.total = total;
    body.hidden_count = Math.max(0, total - visible);
  }
  return ok(body);
}

export const apiFollowers = (request, env, rawHandle) => listPage(request, env, rawHandle, 'followers');
export const apiFollowing = (request, env, rawHandle) => listPage(request, env, rawHandle, 'following');

// ---- Requests to follow me, and my followers ----

export async function apiFollowRequests(request, env) {
  const meId = await myId(request, env);
  if (!meId) return unauthenticated();
  const sql = env.cybercabhunter_db;
  const params = new URL(request.url).searchParams;
  const limit = Math.min(Math.max(Number(params.get('limit')) || PAGE, 1), PAGE_MAX);
  const cursor = decodeCursor(params.get('cursor'));
  const rows = (await sql.prepare(`SELECT f.id AS follow_id, f.updated_at, f.created_at, u.handle, u.display_name, u.avatar_url, x.xp
      FROM user_follows f JOIN users u ON u.id = f.follower_id LEFT JOIN user_xp x ON x.user_id = u.id
      WHERE f.followed_id = ? AND f.status = 'pending'
      ${cursor ? 'AND (f.updated_at < ? OR (f.updated_at = ? AND f.id < ?))' : ''}
      ORDER BY f.updated_at DESC, f.id DESC LIMIT ?`)
    .bind(meId, ...(cursor ? [cursor.t, cursor.t, cursor.id] : []), limit + 1).all()).results || [];
  const page = rows.slice(0, limit);
  const count = await sql.prepare(`SELECT COUNT(*) AS n FROM user_follows WHERE followed_id = ? AND status = 'pending'`).bind(meId).first();
  return ok({
    count: Number(count.n) || 0,
    requests: page.map(r => ({ id: r.follow_id, created_at: r.created_at, user: person(r) })),
    next_cursor: rows.length > limit ? encodeCursor({ t: page[page.length - 1].updated_at, id: page[page.length - 1].follow_id }) : null
  });
}

// The owner's row, whatever its state: another rider's id finds nothing.
const ownRow = (sql, id, meId) => sql.prepare(`SELECT id, follower_id, status FROM user_follows WHERE id = ? AND followed_id = ?`).bind(id, meId).first();

export async function apiResolveFollowRequest(request, env, id, accept) {
  const meId = await myId(request, env);
  if (!meId) return unauthenticated();
  if (!ID_RE.test(id)) return notFound();
  const sql = env.cybercabhunter_db;
  const row = await ownRow(sql, id, meId);
  if (!row) return accept ? notFound() : ok({ success: true });   // declined twice: already gone
  if (row.status !== 'pending') {
    // Accepting twice is fine; a follower isn't removed by "decline" (that's Remove).
    return accept ? ok({ success: true }) : fail('not_pending', 409);
  }
  await sql.batch(accept ? [
    sql.prepare(`UPDATE user_follows SET status = 'accepted', updated_at = datetime('now') WHERE id = ? AND followed_id = ? AND status = 'pending'`).bind(id, meId),
    clearRequestNotice(sql, meId, row.follower_id),
    notify(sql, row.follower_id, 'follow_accepted', meId)
  ] : [
    sql.prepare(`DELETE FROM user_follows WHERE id = ? AND followed_id = ? AND status = 'pending'`).bind(id, meId),
    clearRequestNotice(sql, meId, row.follower_id)
  ]);
  return ok({ success: true });
}

export async function apiRemoveFollower(request, env, id) {
  const meId = await myId(request, env);
  if (!meId) return unauthenticated();
  if (!ID_RE.test(id)) return notFound();
  await env.cybercabhunter_db.prepare(`DELETE FROM user_follows WHERE id = ? AND followed_id = ? AND status = 'accepted'`).bind(id, meId).run();
  return ok({ success: true });
}

// An account turning public: anyone may follow it now, so its pending requests
// become followers. (Turning private changes nothing here: followers stay.)
export async function acceptPendingOnGoingPublic(sql, userId) {
  const pending = (await sql.prepare(`SELECT follower_id FROM user_follows WHERE followed_id = ? AND status = 'pending'`).bind(userId).all()).results || [];
  if (!pending.length) return;
  await sql.batch([
    sql.prepare(`UPDATE user_follows SET status = 'accepted', updated_at = datetime('now') WHERE followed_id = ? AND status = 'pending'`).bind(userId),
    ...pending.flatMap(p => [clearRequestNotice(sql, userId, p.follower_id), notify(sql, p.follower_id, 'follow_accepted', userId)])
  ]);
}

// ---- For worker/social.js ----

// Of these authors, the ones this rider may see by name (approved followers).
export async function approvedAuthors(sql, meId, authorIds) {
  if (!meId || !authorIds.length) return new Set();
  const rows = (await sql.prepare(`SELECT followed_id FROM user_follows WHERE follower_id = ? AND status = 'accepted'
      AND followed_id IN (${authorIds.map(() => '?').join(',')})`).bind(meId, ...authorIds).all()).results || [];
  return new Set(rows.map(r => r.followed_id));
}

const NOTICE_TEXT = {
  follower: 'started following you',
  follow_request: 'asked to follow you',
  follow_accepted: 'accepted your follow request'
};

export async function followUnread(sql, meId) {
  const row = await sql.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM follow_notifications WHERE user_id = ? AND read_at IS NULL LIMIT 100)`).bind(meId).first();
  return Number(row ? row.n : 0);
}

// The notification list's follow items. The actor chose to reach this rider, so
// they are named here even if their account is private. No private content is
// in a notice: only who, and what they did.
export async function followNotices(sql, meId, limit) {
  const rows = (await sql.prepare(`SELECT n.id, n.type, n.read_at, n.created_at, u.handle, u.display_name, u.avatar_url, x.xp
      FROM follow_notifications n JOIN users u ON u.id = n.actor_user_id LEFT JOIN user_xp x ON x.user_id = u.id
      WHERE n.user_id = ? ORDER BY n.created_at DESC, n.id DESC LIMIT ?`).bind(meId, limit).all()).results || [];
  return rows.map(r => {
    const who = person(r);
    return {
      id: r.id,
      type: r.type,
      actor: { name: who.name, handle: who.handle, avatar_url: who.avatar_url, anonymous: false },
      text: NOTICE_TEXT[r.type],
      excerpt: '',
      url: r.type === 'follow_request' ? '/profile?section=follow-requests' : (r.handle ? `/rider/${r.handle}` : '/community'),
      created_at: r.created_at,
      read: !!r.read_at
    };
  });
}

export const markFollowNoticesRead = (sql, meId, ids) => (ids === 'all'
  ? sql.prepare(`UPDATE follow_notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL`).bind(meId)
  : sql.prepare(`UPDATE follow_notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`).bind(meId, ...ids));
