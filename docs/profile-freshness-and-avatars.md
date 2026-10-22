# Profile freshness and profile pictures

How a rider's name, photo and privacy reach every surface, and how the
Google picture is kept apart from an uploaded one. Built Oct 21, 2026
(Phase 5.1 backend fixes). **Deployed October 21, 2026.** Migration 0046 was
applied before Worker version `e8d46c9d-b23b-4fd3-a087-35bcb54b8901`.
The approved production verification completed successfully; see
[the verification report](verification/phase-5-1-production.md).

## Root causes (before)

| Surface | Before | Effect |
| --- | --- | --- |
| Main leaderboard (`/api/community/leaderboard`) | Stored figures patched at once (`leaderboardRiderChanged`), but each response was edge-cached 5 min under its URL and sent with `max-age=300` | Old name, photo or a just-hidden rider for up to 5 min at the edge, plus 5 min in the browser |
| Streak boards (`/api/streaks/leaderboard`) | Names, photos and privacy copied into the daily snapshot (`community_summary`) and never updated | Old name/photo, or a rider who turned privacy off, for up to ~24 h |
| Rider profiles (`/api/riders/:handle`) | Edge-cached 60 s, `max-age=60` | A profile turned private stayed visible up to 60 s (+ browser) |
| Signed-out Social feed, page 1 | Edge-cached 60 s | Old author name/photo up to 60 s |
| All of the above on `cybercabhunter.com` | A cached Response returned as-is picks up the zone's Browser Cache TTL: the response says `max-age=14400` | Browsers and the app could keep an old copy for 4 h |
| `cache.delete()` | Only clears the copy in the data centre that ran it | No way to clear other locations |

Already live (never cached): signed-in Social feed, posts, comments,
notifications, Find riders, moderation, `/api/me`, `/api/profile`.

Avatar: `users.avatar_url` was the only picture field. Google sign-in set it
once (at account creation); an upload replaced it; Remove set it to NULL, so
the Google picture was lost for good.

## Fix 1: streak boards use current profile data

`worker/community-summary.js`. The daily row now stores each board's
**order only** (`board_order`: rider id + streak numbers, top 50 per board,
whatever their privacy setting; never a name or photo). Each response reads
those riders' `display_name, handle, avatar_url, leaderboard_opt_in` from
`users` by primary key (one query, ≤ 50 rows, once per edge-cache period) and
keeps the opted-in ones, top 10, ranks counted among them (no gaps).

- A rename or new photo shows on the next request; streak numbers and order
  stay the daily run's (no recomputation, no extra writes).
- Privacy off: gone at once. Back on: listed again at once, same numbers.
- A deleted account (its `users` row is gone) disappears at once.
- A row stored by the old code (no `board_order`) is recomputed once.

## Fix 2: cache freshness (`worker/profile-cache.js`)

- **Profile epoch.** A counter in KV (`profile_epoch`), bumped by
  `leaderboardRiderChanged`, which already runs on every profile save,
  photo upload/removal, account deletion, and now on a Google sign-in that
  changes the shown picture.
- **Versioned edge keys.** The leaderboards, streak boards, rider profiles
  and signed-out feed are cached under `/__edge/<name>?<params>&pe=<epoch>`.
  A new epoch makes every old copy unreachable in every location: the editor's
  location at once, everywhere else within about a minute (KV propagation).
  Between changes, caching works as before (5 min boards, 60 s profiles and
  feed). Unknown query parameters are no longer part of the key.
- **Browsers keep nothing.** These responses leave with `private, no-store`
  (as the signed-out feed already did), so neither a browser nor the app can
  hold an old copy, and the zone's 4-hour Browser Cache TTL no longer applies.
- **Cost.** One KV read per request to these endpoints (to build the key);
  one KV write per public profile change. D1 load is unchanged between
  changes; after a change, each board/profile is rebuilt once per location.
  A browser revisiting within 5 min now reaches the Worker (an edge hit, no D1).
- **Failure modes.** KV can't be read: these endpoints serve straight from
  the database and store nothing, so a KV problem never surfaces an old copy.
  A bump refused by KV (one write per second per key) is retried once; if it
  still fails it is logged (`profile_epoch_bump_failed`) and the copies expire
  on their TTL (5 min boards, 60 s profiles and feed), the previous version's
  freshness, with the database already correct. Values are time + 48 random
  bits, so concurrent bumps never repeat an earlier value.
- **Expected delay.** The editor's location: next request. Other locations:
  up to about 60 s (KV propagation). Worst case (KV write refused twice):
  the TTL above.
- **Already-open pages and apps** are not pushed anything: they show the new
  data when they next fetch (reload, revisit, pull to refresh). The native
  app also refreshes Community after the rider's own profile change.

## Fix 3: Google picture fallback (migration 0046)

`users.google_avatar_url` (new) keeps the Google picture. `users.avatar_url`
keeps its meaning (the picture shown), so every existing reader is unchanged.

| Event | avatar_url (shown) | google_avatar_url |
| --- | --- | --- |
| New Google account | Google picture | Google picture |
| Google sign-in, no upload | Google's current picture | Google's current picture |
| Google sign-in, with an upload | upload (never replaced) | Google's current picture |
| Upload | upload | kept (recorded first if missing) |
| Remove (an upload) | Google picture, else NULL | kept |
| Remove (a Google picture shown) | unchanged (only uploads are removed) | kept |
| Name / username / bio / privacy save | unchanged | unchanged |

Priority: upload, then Google picture, then initials. Only an https URL from
Google is stored. `GET /api/profile` adds `avatar_source` ('custom' |
'google' | null) and `has_google_avatar`; `GET /api/me` adds `avatar_source`;
`DELETE /api/profile/avatar` returns the picture now shown and its source.
Existing fields are unchanged. The Google URL itself is never returned by
these endpoints (it is already public wherever it is shown).

Website (`public/profile.html`) and the native app show **Remove photo** only
for an upload (an older Worker without `avatar_source`: as before) and say
what replaces it.

**Migration 0046:** adds the column; backfills it only where it is empty and
the shown picture is an https URL (only Google sign-in ever wrote one). No
shown picture is changed. Riders with an upload or no picture get their
Google picture recorded at their next Google sign-in.

## Deployment runbook (completed October 21, 2026; retained for reference)

The Worker and the website are ONE deployment: `wrangler deploy` publishes
`worker/` and the `public/` assets together (wrangler.jsonc), and a rollback
restores both. (The repo's CNAME is a GitHub Pages leftover; cybercabhunter.com
is served by the Worker.) The native app needs no deployment: it works with
both the current and the new Worker.

Procedure (`docs/deployment-and-migrations.md` rules apply; `cybercabhunter-db` is the
database name in wrangler.jsonc, wrangler also accepts the binding `cybercabhunter_db`):

1. **Pending migrations.** `npx wrangler d1 migrations list cybercabhunter-db --remote`
   must list exactly `0046_google_avatar.sql`. Anything else: stop.
2. **Note the current version** for rollback: `npx wrangler deployments list`
   (record the active version id).
3. **Backup and verify it.**
   - `npx wrangler d1 export cybercabhunter-db --remote --output=<outside the repo>/pre-0046.sql`
   - Check the file is non-empty and contains `CREATE TABLE users` and
     `INSERT INTO "users"`; load it into a local database
     (`npx wrangler d1 execute cybercabhunter-db --local --file=<file>` in a
     scratch copy, or sqlite3) and compare `SELECT COUNT(*) FROM users` with
     production's (`npx wrangler d1 execute cybercabhunter-db --remote --command "SELECT COUNT(*) FROM users"`).
   - Also note the D1 Time Travel bookmark: `npx wrangler d1 time-travel info cybercabhunter-db`.
   - The export contains rider data: keep it outside the repo, delete it when done.
4. **Apply 0046**: `npx wrangler d1 migrations apply cybercabhunter-db --remote`.
5. **Verify the migration**:
   - `migrations list --remote`: nothing pending.
   - `PRAGMA table_info(users)` includes `google_avatar_url`.
   - `SELECT COUNT(*) FROM users WHERE avatar_url LIKE '/api/avatars/%' AND google_avatar_url IS NOT NULL` is 0 (no upload was recorded as Google).
   - `SELECT COUNT(*) FROM users WHERE google_avatar_url IS NOT NULL AND (avatar_url IS NULL OR avatar_url <> google_avatar_url)` is 0.
   - The site still works on the OLD Worker (tested: the previous code passes its whole suite with 0046 applied).
6. **Deploy** the Worker + website: `npx wrangler deploy`.
7. **Smoke test** with a test account, never the owner's:
   - change the display name, then check the leaderboard, a streak board, `/rider/<handle>`, Find riders;
   - upload and remove a photo (the Google picture returns);
   - turn privacy off (gone from boards, profile 404) and back on;
   - check the response headers: `Cache-Control: private, no-store` on `/api/community/leaderboard`;
   - sign out and in.
8. **Monitor**: `npx wrangler tail` for errors (watch for `profile_epoch_bump_failed`,
   5xx on `/api/streaks/leaderboard`, `/api/profile*`, `/oauth/google/callback`),
   and the Workers dashboard error rate and KV operation counts for an hour.

**If something fails:**
- *Before step 4:* nothing changed; stop.
- *The migration fails:* wrangler records a migration only when it
  succeeds. Check `PRAGMA table_info(users)` and stop; production keeps
  running on the old Worker either way (it doesn't use the column). If the
  column was added but the backfill did not run, the one `UPDATE` can be run
  later (it only fills empty `google_avatar_url` values), with approval;
  until then Google sign-in and uploads record the Google picture anyway.
- *After step 4, before or after step 6:* **do not reverse the migration.**
  The added column is harmless to the old Worker (verified). Recover forward:
  - Worker/website problem: `npx wrangler rollback <previous version id>`.
    Everything the new code wrote stays readable by the old code: the column
    is ignored; the stored streak row also keeps the old `boards` shape
    (verified: the old streak endpoint returns 200 from a row the new code
    wrote); the KV key `profile_epoch` and the `/__edge/...` cache entries
    are ignored and expire.
  - After a rollback, the old Worker's "Remove photo" goes back to clearing
    the picture to initials; `google_avatar_url` is kept, so a later redeploy
    restores the fallback at the rider's next sign-in.
  - Data restore (Time Travel / the export) is a last resort only for actual
    data damage: it discards every write since the bookmark (posts,
    sightings, sign-ups), and needs the owner's explicit approval.
- *KV problems after deploying:* profile-bearing endpoints skip the shared
  cache while KV can't be read (correct data, more D1 reads); a failed bump is
  logged and copies expire on their TTL. No data is at risk.

## Limitations

- Already-open clients update on their next fetch, not by push.
- Other locations follow within ~1 minute (KV), not instantly.
- Streak tie order (equal numbers) is the daily run's, so a rename doesn't
  re-sort ties until the next daily run.
- Turning privacy back on (off -> on only) makes the next leaderboard view
  recompute the figures once, so the rider is listed again at once. Ordinary
  edits never recompute.
- A removed upload's files are deleted (as before); removal can't be undone.
