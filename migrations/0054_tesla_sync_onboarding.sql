-- First-time Tesla Sync (Gmail receipt forwarding) onboarding: offered once
-- per ACCOUNT, on whichever platform (website or app) the rider first signs in
-- after creating it. Additive and nullable.
--
--   NULL        not applicable: every account that existed before this
--               migration (never offered retroactively), and any account the
--               Worker creates without marking it
--   'pending'   created by Google sign-in (worker/db.js
--               findOrCreateUserByGoogleIdentity, the only place an account
--               is created at sign-in); not yet shown
--   'presented' shown by the website or the app; no longer offered
--               automatically (it can always be opened from Rider Data or
--               Receipts)
--   'skipped'   the rider chose Skip for Now
--   'completed' the rider finished the forwarding setup from the invitation
--
-- Only moves forward (worker/onboarding.js). No index: it is read by the
-- primary key with the rest of the user row.
ALTER TABLE users ADD COLUMN tesla_sync_onboarding TEXT
  CHECK (tesla_sync_onboarding IN ('pending', 'presented', 'skipped', 'completed'));
