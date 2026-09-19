// The authenticated user's own rider profile — read-only. Every figure is
// computed live from trips/robotaxi_vehicles/submissions by db.getUserProfile;
// nothing here is a stored counter, and no user_id or private trip field
// from a DIFFERENT user is ever touched.

import { db } from './db.js';

export async function apiGetProfile(request, env, userId) {
  const user = await db.getUserById(env.cybercabhunter_db, userId);
  if (!user) return Response.json({ authenticated: false }, { status: 401 });

  const profile = await db.getUserProfile(env.cybercabhunter_db, userId);

  return Response.json({
    user: {
      display_name: user.display_name,
      handle: user.handle,
      bio: user.bio,
      profile_visibility: user.profile_visibility,
      avatar_url: user.avatar_url,
      joined_at: user.created_at
    },
    contributions: profile.contributionCount,
    rideSummary: profile.rideSummary,
    cities: profile.cities,
    providers: profile.providers,
    discoveredVehicles: profile.discoveredVehicles
  });
}

const HANDLE_RE = /^[a-z0-9_]{3,20}$/;
const MAX_DISPLAY_NAME = 60;
const MAX_BIO = 280;

// Settings are always written as a full set (never a partial patch) so a
// deliberate "clear this field" can't be lost — the frontend always submits
// its whole form. handle is optional (null clears it); display_name/bio are
// trimmed and length-capped rather than rejected outright.
export async function apiUpdateProfile(request, env, userId) {
  const user = await db.getUserById(env.cybercabhunter_db, userId);
  if (!user) return Response.json({ authenticated: false }, { status: 401 });

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return Response.json({ success: false, error: 'invalid_body' }, { status: 400 });
  }

  const displayName = typeof body.display_name === 'string' ? (body.display_name.trim().slice(0, MAX_DISPLAY_NAME) || null) : null;
  const bio = typeof body.bio === 'string' ? (body.bio.trim().slice(0, MAX_BIO) || null) : null;
  const profileVisibility = body.profile_visibility === 'public' ? 'public' : 'private';

  let handle = null;
  if (typeof body.handle === 'string' && body.handle.trim() !== '') {
    handle = body.handle.trim().toLowerCase();
    if (!HANDLE_RE.test(handle)) {
      return Response.json({ success: false, error: 'invalid_handle' }, { status: 400 });
    }
  }

  try {
    await db.updateUserSettings(env.cybercabhunter_db, userId, { displayName, handle, bio, profileVisibility });
  } catch (err) {
    const message = String((err && err.message) || '');
    if (message.includes('UNIQUE') && message.includes('handle')) {
      return Response.json({ success: false, error: 'handle_taken' }, { status: 409 });
    }
    throw err;
  }

  return Response.json({
    success: true,
    user: { display_name: displayName, handle, bio, profile_visibility: profileVisibility }
  });
}
