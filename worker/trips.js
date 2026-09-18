// The authenticated user's own ride history — read-only. Every column
// returned is explicitly whitelisted in db.getTripsByUser itself, not here,
// so there's a single place that decides what this API can ever expose.

import { db } from './db.js';

export async function apiListTrips(request, env, userId) {
  const trips = await db.getTripsByUser(env.cybercabhunter_db, userId);
  return Response.json({ trips });
}
