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
      joined_at: user.created_at
    },
    contributions: profile.contributionCount,
    rideSummary: profile.rideSummary,
    cities: profile.cities,
    providers: profile.providers,
    discoveredVehicles: profile.discoveredVehicles
  });
}
