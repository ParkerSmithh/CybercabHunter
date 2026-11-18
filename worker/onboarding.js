// First-time Tesla Sync onboarding: one invitation per ACCOUNT, shared by the
// website and the app (migrations/0054_tesla_sync_onboarding.sql).
//
// "New" has one meaning: the account was created by this Google sign-in
// (db.findOrCreateUserByGoogleIdentity, the only place sign-in creates an
// account), which marks it 'pending'. Nothing on a device decides it, and
// accounts that existed before stay NULL ("not applicable") for good.
//
//   pending ──presented──▶ presented ──skip──▶ skipped
//      │                       └──complete──▶ completed
//      └──────────skip / complete (shown, but "presented" never arrived)
//
// The state only moves forward, with a conditional UPDATE, so every call is
// idempotent and two devices signing in at once can't disagree. The account is
// always the session's; nothing in a request names it. Reads and writes never
// fail a sign-in: before the migration is applied they quietly report null.

export const TESLA_SYNC_STATES = ['pending', 'presented', 'skipped', 'completed'];
const ACTIONS = {
  presented: { to: 'presented', from: ['pending'] },
  skip: { to: 'skipped', from: ['pending', 'presented'] },
  complete: { to: 'completed', from: ['pending', 'presented'] }
};

export async function getTeslaSyncOnboarding(sql, userId) {
  try {
    const row = await sql.prepare(`SELECT tesla_sync_onboarding AS s FROM users WHERE id = ?`).bind(userId).first();
    return row && TESLA_SYNC_STATES.includes(row.s) ? row.s : null;
  } catch (err) {
    return null;   // not migrated yet: nobody is offered anything
  }
}

// Called once, right after sign-in creates the account. Only a NULL state can
// become pending (an account is never sent back to the start).
export async function markNewAccountForTeslaSync(sql, userId) {
  try {
    await sql.prepare(`UPDATE users SET tesla_sync_onboarding = 'pending' WHERE id = ? AND tesla_sync_onboarding IS NULL`).bind(userId).run();
  } catch (err) { /* sign-in never fails over this */ }
}

// POST /api/onboarding/tesla-sync { action: 'presented' | 'skip' | 'complete' }
// (signed in). Moves the session's own account forward if it can; otherwise
// leaves it as it is. Answers with the state either way: { tesla_sync }.
export async function apiUpdateTeslaSyncOnboarding(request, env, userId) {
  let body = null;
  try { body = await request.json(); } catch (e) { body = null; }
  const action = body && typeof body.action === 'string' ? ACTIONS[body.action] : null;
  if (!action) return Response.json({ success: false, error: 'invalid_action' }, { status: 400 });
  const sql = env.cybercabhunter_db;
  try {
    await sql.prepare(`UPDATE users SET tesla_sync_onboarding = ? WHERE id = ? AND tesla_sync_onboarding IN (${action.from.map(() => '?').join(', ')})`)
      .bind(action.to, userId, ...action.from).run();
  } catch (err) {
    return Response.json({ success: false, error: 'unavailable' }, { status: 503 });
  }
  return Response.json({ success: true, tesla_sync: await getTeslaSyncOnboarding(sql, userId) }, { headers: { 'Cache-Control': 'no-store' } });
}
