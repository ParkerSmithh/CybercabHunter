# Registry preflight (Phase 3E) — read-only

Before Phase 3E, every registry vehicle a receipt created was `public` by
default, and receipts are **not authenticated** (forwarded email is not
SPF/DKIM/ARC-verified; a pasted receipt has no sender at all). A syntactically
valid receipt is therefore not proof of a Tesla-originated email, and an
existing `public` row is not evidence that anyone vetted it.

Phase 3E changes behavior going forward only:

- New vehicles start `private`; a moderator makes one `public`.
- A vehicle is publicly retrievable only when it is `public` **and** has at
  least one counted, non-superseded ride.
- Existing rows are **not** modified. Existing `public` rows with a counted
  ride stay publicly visible until a moderator makes them private.

## Run the reports

Every query is a plain `SELECT` (see `worker/registry-preflight.js`, which is
also covered by `tests/registry-trust.test.mjs`). Print them:

```sh
node --input-type=module -e "import { REGISTRY_PREFLIGHT as q } from './worker/registry-preflight.js'; for (const x of q) console.log('-- ' + x.id + ': ' + x.title + '\n-- ' + x.why + '\n' + x.sql.trim() + ';\n')"
```

Run one at a time against the database (read-only; never `--file` a script
that contains anything but these SELECTs):

```sh
npx wrangler d1 execute cybercabhunter_db --remote --command "<one query>"
```

| Report | Question it answers |
|---|---|
| `duplicate_plates` | Which normalized plates belong to 2+ registry vehicles? |
| `non_normalized_plates` | Which stored plates are not alphanumeric-uppercase (or are blank)? |
| `public_vehicles` | Everything currently public, with counted/live/all ride counts. **Review before rollout.** |
| `public_zero_counted_rides` | Public vehicles that will start returning 404. |
| `public_review_or_rejected_only` | Public vehicles backed only by needs-review/rejected receipts. |
| `public_orphaned` | Public vehicles with no trips at all (trip deleted). |
| `ambiguous_sighting_matches` | Approved unlinked sightings the fallback will refuse. |
| `unlinked_sightings_matching_one_vehicle` | Approved unlinked sightings that would show on a single vehicle if it is eligible. |

Duplicates are **never merged automatically**. Resolving them is a separate,
human-reviewed piece of work.

---

# Legacy Public Registry Cleanup Runbook (Phase 3G)

**Status: written and tested locally. Nothing here has been run against production.**

## Why this exists

Every `robotaxi_vehicles` row created before Phase 3E was set `public` by the
column default. Before 3E nothing in the code could write that column, and no
moderator vehicle tool existed, so **every legacy `public` row is unreviewed**.
The database cannot tell those rows apart from a deliberately approved one, so
they are all treated as unreviewed: the cleanup makes them private, and
moderators re-approve the genuine ones from the moderator page.

The cleanup changes **only** `visibility` and `updated_at` on the rows recorded
in a saved inventory. It never deletes a row and never touches trips,
submissions, sightings, observations, plates, or any other vehicle column.

> **Provenance is not proof.** The moderator page shows how a vehicle's counted
> rides entered Cybercab Hunter (forwarded email, import, other). That
> describes the path the data took. It does not prove a receipt was genuinely
> issued by Tesla: a forwarded receipt is not cryptographically checked, and a
> pasted or imported one has no sender at all. Approval is a human judgment.

Keep the working files **outside the repository** (they contain your rider
data's vehicle inventory) and delete them when the rollout is settled:

```sh
export CLEANUP_DIR="$HOME/cybercab-cleanup-$(date +%Y%m%d)"
mkdir -p "$CLEANUP_DIR"
```

## Prerequisites (do these first; they are not part of the cleanup)

**Nothing in this section has been run against production.** These are owner /
operator actions, performed by hand, in this order. The registry tooling below
cannot work without them: the moderator page and its endpoints authorize
against a `users.role` column, and no account has the moderator role until you
give it one. Do not start Section A until the verification in P3 passes.

### P1. Apply migration `0011_user_roles.sql`

**What it does.** It adds one column, `users.role`, defaulting to `'user'` and
restricted to the two values `'user'` and `'moderator'`. Every existing account
becomes `'user'`. It is additive, and **it does not make anyone a moderator**:
that is P2, done by hand. Until it is applied, the moderator endpoints cannot
authorize anybody.

**How.** Follow `docs/deployment-and-migrations.md` exactly; nothing here is a
new convention. **Migrate first, then deploy** (the deploy is Section C below,
not part of P1).

1. List what wrangler thinks is pending, and read it:

   ```sh
   npx wrangler d1 migrations list cybercabhunter_db --remote
   ```

   The list must contain **only migrations you intend to run**. It should
   include `0011_user_roles.sql`. Two cautions from the deployment doc:

   - `migrations apply` applies **every** pending file, in order; there is no
     documented way to apply just one. The deployment doc records `0006` and
     `0010` as genuinely pending when it was written. If either still appears,
     `apply` will run it too, so open each listed file and decide deliberately
     that you want it applied now. If you do not, stop and sort that out first
     rather than applying.
   - If the list shows a file you know was already applied, stop: the tracker
     is out of sync, and the deployment doc explains how to reconcile by schema
     comparison before doing anything else.

2. Take a backup first, using the project's convention (the file contains rider
   data: keep it outside the repository and delete it when no longer needed):

   ```sh
   npx wrangler d1 export cybercabhunter_db --remote --output="$CLEANUP_DIR/backup-before-0011.sql"
   ```

   (Section B takes a second backup right before the cleanup itself.)

3. Apply. **Never** apply a migration with `d1 execute --file`; that runs the
   SQL without recording it in `d1_migrations`, which is exactly how the
   tracker got out of sync once before:

   ```sh
   npx wrangler d1 migrations apply cybercabhunter_db --remote
   ```

After the Section C deploy, re-run the `migrations list` command from step 1 and
confirm nothing is pending (deployment doc, step 6).

### P2. Designate the first moderator (by hand)

**Only after P1.** This is deliberately not a feature: nothing in the app, and
no public API, can grant or change a role, and even `/api/me` does not reveal
it. You, the owner, set it directly in the database, **once, for the one
account that should moderate**. Every other account stays `role = 'user'`
(the column default, enforced by its `CHECK`).

**Identify the exact user id without listing other people's accounts.** Sign in
to Cybercab Hunter normally as the account that will moderate. The site keeps
that account's session id in your browser's local storage under the key
`teslaSessionId` (browser dev tools, Application / Storage). **That value is a
bearer credential: treat it like a password**, do not paste it into chat, tickets
or a shared terminal log. Read it without echoing it, then ask the existing
`/api/me` endpoint who it belongs to:

```sh
API=https://cybercabhunter.contactjoeclos.workers.dev
read -rs SESSION      # paste the teslaSessionId value; nothing is echoed
curl -s -H "Authorization: Bearer $SESSION" "$API/api/me"
```

The response contains `"user":{"id":"…","display_name":…}`. That `id` is the
value to use below. As a cross-check, look up **only that one row** (never
`SELECT` the whole `users` table); it should return exactly one row, currently
with `role` = `user`:

```sh
npx wrangler d1 execute cybercabhunter_db --remote --command "SELECT id, display_name, handle, role FROM users WHERE id = '<that id>'"
```

**Designate.** This is a production data edit made by you, on purpose; it is a
plain data change, not a migration, so `--command` is appropriate here. Check
the id twice, and use `WHERE id =` with the exact id, never a pattern or a
name:

```sh
npx wrangler d1 execute cybercabhunter_db --remote --command "UPDATE users SET role = 'moderator' WHERE id = '<that id>'"
```

Do not rely on the command's own output as confirmation; use P3. To remove
moderator access later, set that account's role back to `'user'` the same way.

### P3. Verify the prerequisites (read-only)

None of these change anything. Do not continue to Section A until all pass.

1. **Migration 0011 is applied and recorded.**

   ```sh
   npx wrangler d1 execute cybercabhunter_db --remote --command "SELECT name, applied_at FROM d1_migrations WHERE name = '0011_user_roles.sql'"
   npx wrangler d1 execute cybercabhunter_db --remote --command "SELECT name, type, dflt_value FROM pragma_table_info('users') WHERE name = 'role'"
   ```

   The first returns exactly one row. The second returns one row: `role`, type
   `TEXT`, default `'user'`. `migrations list` (P1 step 1) must no longer list
   `0011_user_roles.sql` as pending.

2. **Only the intended account is a moderator, and everyone else is `user`.**

   ```sh
   npx wrangler d1 execute cybercabhunter_db --remote --command "SELECT id, display_name, handle, role FROM users WHERE role = 'moderator'"
   npx wrangler d1 execute cybercabhunter_db --remote --command "SELECT role, COUNT(*) AS accounts FROM users GROUP BY role"
   ```

   The first returns only the account you meant to designate. In the second,
   the `moderator` count is exactly the number of people you designated and
   every other account is counted under `user`.

3. **The moderator endpoints enforce it.** These are `GET` requests that only
   read; do **not** use `PATCH` for a check. Use an ordinary account's session
   for the middle case (any account that is not the moderator), collected the
   same way as in P2:

   ```sh
   API=https://cybercabhunter.contactjoeclos.workers.dev
   read -rs MOD_SESSION; read -rs USER_SESSION
   for path in /api/moderation/robotaxi-vehicles /api/moderation/vehicle-sightings; do
     echo "== $path"
     echo -n "no session:      "; curl -s -o /dev/null -w '%{http_code}\n' "$API$path"
     echo -n "ordinary user:   "; curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $USER_SESSION" "$API$path"
     echo -n "the moderator:   "; curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $MOD_SESSION" "$API$path"
   done
   ```

   Expected for both paths: **401** with no session, **403** for the ordinary
   user, **200** for the moderator. The role is read from the database on every
   request, so the moderator does not need to sign in again after P2. If the
   moderator gets 403, re-check P3.2; if an ordinary user gets 200, stop and
   undo P2 for that account.

## A. Preflight (read-only reports)

Run **every** report above, one at a time, and read each result before going on.
Look hardest at:

- `duplicate_plates`: plates shared by 2+ rows. Sightings for these stay private
  until a human resolves the duplicate (see "Duplicates" below). Do not
  proceed to a unique index or a merge based on this runbook.
- `non_normalized_plates`: rows the SQL plate lookup cannot match.
- `public_vehicles`: **the cleanup input.** Everything currently public.
- `ambiguous_sighting_matches`: approved sightings that will stay private.

**`wrangler d1 execute` has no read-only mode.** It will run whatever SQL it is
given. So generate the report files, *open and read each one*, and run them one
at a time. Never paste several statements together or run a file you have not
read:

```sh preflight-generate
mkdir -p "$CLEANUP_DIR/preflight" && node --input-type=module -e "import fs from 'node:fs'; import { REGISTRY_PREFLIGHT as q } from './worker/registry-preflight.js'; for (const x of q) fs.writeFileSync(process.env.CLEANUP_DIR + '/preflight/' + x.id + '.sql', x.sql.trim() + ';\n')"
```

```sh
npx wrangler d1 execute cybercabhunter_db --remote --json --file "$CLEANUP_DIR/preflight/public_vehicles.sql"
```

(Read-only `SELECT` files may be run with `--file`; the "never use `--file`"
rule in `deployment-and-migrations.md` is about *migrations*.)

Decide, before going further, what you will do about any duplicate or
non-normalized plate. Duplicates are never merged by this runbook.

## B. Back up production D1

Use the project's documented convention (`docs/deployment-and-migrations.md`,
step 3). The file contains rider data; keep it outside the repo and delete it
when it is no longer needed:

```sh
npx wrangler d1 export cybercabhunter_db --remote --output="$CLEANUP_DIR/backup-before-cleanup.sql"
```

## C. Deploy the Phase 3E gating code

```sh
npm run deploy
```

(`wrangler deploy`, per `package.json`.) Deploy **before** changing any legacy
visibility. From this moment the code creates every new registry vehicle
`private`, so no new row can slip in public. From now until the cleanup is
finished, **moderators must not approve or change any vehicle**: an approval
made in this window would be reverted by the cleanup.

## D. Save the rollback inventory

Right after the deploy, save exactly which rows are public and their prior
`updated_at`. **This file is the rollback source of truth.** Also save the full
vehicle table and the before-counts so step F can prove nothing else changed:

```sql inventory
SELECT id, license_plate, visibility, updated_at FROM robotaxi_vehicles WHERE visibility = 'public' ORDER BY id
```

```sh
npx wrangler d1 execute cybercabhunter_db --remote --json --command "SELECT id, license_plate, visibility, updated_at FROM robotaxi_vehicles WHERE visibility = 'public' ORDER BY id" > "$CLEANUP_DIR/inventory.json"
npx wrangler d1 execute cybercabhunter_db --remote --json --command "SELECT * FROM robotaxi_vehicles ORDER BY id" > "$CLEANUP_DIR/snapshot-before.json"
```

Open both files. `inventory.json` must be valid JSON containing the public
vehicles you saw in `public_vehicles`. If a file starts with anything other
than `[`, wrangler printed a banner into it: stop and fix that first. Then save
the before-counts:

```sql verify-counts
SELECT (SELECT COUNT(*) FROM robotaxi_vehicles) AS vehicles,
       (SELECT COUNT(*) FROM robotaxi_vehicles WHERE visibility = 'public') AS public_vehicles,
       (SELECT COUNT(*) FROM trips) AS trips,
       (SELECT COUNT(*) FROM trips WHERE robotaxi_vehicle_id IS NOT NULL) AS trips_with_vehicle,
       (SELECT COUNT(*) FROM vehicle_observations) AS observations,
       (SELECT COUNT(*) FROM vehicle_observations WHERE robotaxi_vehicle_id IS NOT NULL) AS observations_linked,
       (SELECT COUNT(*) FROM submissions WHERE submission_type = 'vehicle_sighting' AND status = 'approved') AS approved_sightings
```

```sh
npx wrangler d1 execute cybercabhunter_db --remote --json --command "SELECT (SELECT COUNT(*) FROM robotaxi_vehicles) AS vehicles, (SELECT COUNT(*) FROM robotaxi_vehicles WHERE visibility = 'public') AS public_vehicles, (SELECT COUNT(*) FROM trips) AS trips, (SELECT COUNT(*) FROM trips WHERE robotaxi_vehicle_id IS NOT NULL) AS trips_with_vehicle, (SELECT COUNT(*) FROM vehicle_observations) AS observations, (SELECT COUNT(*) FROM vehicle_observations WHERE robotaxi_vehicle_id IS NOT NULL) AS observations_linked, (SELECT COUNT(*) FROM submissions WHERE submission_type = 'vehicle_sighting' AND status = 'approved') AS approved_sightings" > "$CLEANUP_DIR/counts-before.json"
```

## E. Set the legacy public rows private

Do not write this SQL by hand. Generate it from the saved inventory, then
**read the generated files**:

```sh generate-cleanup
node --input-type=module -e "import fs from 'node:fs'; import { buildCleanupStatements } from './worker/registry-cleanup-sql.js'; const d = process.env.CLEANUP_DIR; const s = buildCleanupStatements(JSON.parse(fs.readFileSync(d + '/inventory.json', 'utf8'))); fs.writeFileSync(d + '/cleanup.sql', s.cleanup); fs.writeFileSync(d + '/rollback.sql', s.rollback); console.log('inventory rows:', s.count)"
```

The generator refuses an inventory with a non-UUID id, a prior visibility that
is not `public`, a malformed timestamp, or a duplicate id, so nothing
unexpected can reach the SQL. `cleanup.sql` contains statements of exactly this
shape (ids in batches of 50):

```sql
UPDATE robotaxi_vehicles SET visibility = 'private', updated_at = datetime('now')
WHERE visibility = 'public' AND id IN ('<inventory ids>');
```

It changes `visibility` and `updated_at` only, only for inventory ids that are
still public. A vehicle that was already private is not touched.

**Run `cleanup.sql` exactly once, before any moderator re-approves anything.**
If you ran it again after a moderator had approved a vehicle, that vehicle
would be set private again (it is still in the inventory and would be public).
Run it:

```sh
npx wrangler d1 execute cybercabhunter_db --remote --file "$CLEANUP_DIR/cleanup.sql"
```

## F. Verify

1. **Rows intact, only visibility changed.** Save the table again and check it
   against the before-snapshot. This prints `OK` or lists every problem (a
   removed or added row, or any column other than `visibility`/`updated_at`
   that changed):

   ```sh
   npx wrangler d1 execute cybercabhunter_db --remote --json --command "SELECT * FROM robotaxi_vehicles ORDER BY id" > "$CLEANUP_DIR/snapshot-after.json"
   ```

   ```sh verify-snapshots
   node --input-type=module -e "import fs from 'node:fs'; import { verifyCleanupSnapshots } from './worker/registry-cleanup-sql.js'; const d = process.env.CLEANUP_DIR; const r = (f) => JSON.parse(fs.readFileSync(d + '/' + f, 'utf8')); const v = verifyCleanupSnapshots({ before: r('snapshot-before.json'), after: r('snapshot-after.json'), inventory: r('inventory.json') }); console.log(v.ok ? 'OK: only visibility/updated_at changed on ' + v.changedRows + ' inventory row(s)' : 'PROBLEMS:\n' + v.problems.join('\n')); process.exit(v.ok ? 0 : 1)"
   ```

2. **Trips, sightings, and links intact.** Re-run the counts query from step D
   and compare with `counts-before.json`. Every number must be identical
   **except `public_vehicles`, which must now be `0`**: `vehicles`, `trips`,
   `trips_with_vehicle`, `observations`, `observations_linked`, and
   `approved_sightings` are unchanged, so rider history is intact and approved
   sightings are still linked (they are hidden with their vehicle, not
   unlinked).

3. **Public endpoints no longer show legacy vehicles.** For several ids from
   the inventory, and for one id that does not exist, the status and body must
   be **identical** (a hidden vehicle is indistinguishable from a missing one):

   ```sh
   API=https://cybercabhunter.contactjoeclos.workers.dev
   for id in <an inventory id> <another> 00000000-0000-4000-8000-000000000000; do
     echo "$id"; curl -s -w '  -> HTTP %{http_code}\n' "$API/api/robotaxi-vehicles/$id"; curl -s -w '  -> HTTP %{http_code}\n' "$API/api/robotaxi-vehicles/$id/sightings"
   done
   ```

   Every line must be `{"success":false,"error":"not_found"}` with HTTP 404.

4. **No accidental new public vehicles.** Nothing may be public until a
   moderator approves it. Any row created after the deploy that is not private
   is a problem (replace `:deploy_time` with the UTC time you ran step C, as
   `YYYY-MM-DD HH:MM:SS`):

   ```sql verify-new-vehicles
   SELECT id, license_plate, visibility, created_at FROM robotaxi_vehicles
   WHERE created_at >= ':deploy_time' AND visibility <> 'private'
   ```

   It must return no rows. While no moderator has acted yet, the counts query's
   `public_vehicles` must also still be `0`.

Stop and use section H if any check fails.

## G. Moderator re-approval

**Phase 3H requires migration `0012_robotaxi_vehicle_reviews.sql` to be applied
to production BEFORE the Phase 3H code is deployed** (migrate first, then deploy,
per `docs/deployment-and-migrations.md`). The approval action writes to that
table, so deploying first would make every approval fail with a server error.
It is additive: one new table and two indexes.

> **Historical UI note.** The rest of this section describes the moderator
> page's UI **as it was at Phase 3H**. The eligibility rules, audit history,
> and the public-eligibility gate described below are still accurate; the
> specific controls have since changed:
> - The scope dropdown now offers only **Private** (the default) and
>   **Public** — the third option described below, "Private — has counted
>   rides", no longer exists.
> - **Approve** and **Return to Private** are now instant, single-click
>   actions with no confirmation step and no note field (described below as
>   opening a confirmation first — that step was removed).
> - A **Delete Vehicle** action now exists (not covered by this runbook,
>   added later). It keeps a two-step confirmation for safety, and also
>   purges the ride(s)/receipt(s) logged against that vehicle — intentional,
>   disclosed behavior, not something this runbook's cleanup ever does.

On the moderator page, **Registry Vehicles**, choose a list: **Private — has
counted rides** (the default), **All private vehicles** (including ones with no
counted rides, so nothing hides from review), or **Currently public**. Each card
shows the plate, its state, the counted rides and **how they entered the
system**, the first/latest counted ride dates, any needs-review or rejected rides
attached, first-seen / created / last-activity times, the record's existing
`verification_status` field, a duplicate-plate warning, and who last reviewed it.

The state is one of **Private — Needs Review** with either **Eligible for
Approval** or **Not Eligible**, **Public**, or **Approved — Not Visible** (flagged
public but currently hidden). "Not Eligible" always comes with plain reasons
(**No counted rides**, **Duplicate plate**, **No plate recorded**) and facts such
as **Needs review ride present**, **Rejected-only history**, or **No rides on
record (orphaned)**. These are facts, never a score.

A vehicle can be approved only if it is private, has at least one counted,
non-superseded ride, and its normalized plate belongs to exactly one registry
row. Only an eligible vehicle shows **Approve for Public Registry**; it opens a
confirmation (with an optional note for the history) and nothing changes until
you confirm. **Return to Private** takes a public vehicle out of public view.
**The review action is the only way to make a vehicle public.** The older
`PATCH /api/moderation/robotaxi-vehicles/:id` endpoint can now only take a
vehicle to `private` (an administrative takedown, also recorded); asking it for
`public` is refused with `409 review_required`.

Every approval or return is recorded, permanently and append-only: who did it,
when, the note, and the facts it was made on. The operator cleanup in this
runbook is *not* a moderator review and has no history row.

> **Moderator approval means** a Cybercab Hunter moderator reviewed this registry
> record and intentionally approved it for public visibility. It does not prove a
> receipt was genuinely issued by Tesla.

A vehicle needs *both* `visibility = 'public'` **and** a counted ride to appear
publicly. If an approved vehicle later loses its last counted ride it is hidden
again automatically; if a counted ride returns, the earlier approval still stands,
so use **Return to Private** to withdraw an approval. A duplicated plate should
be resolved (separately, by hand) before it can be approved.

## H. Rollback

Only if the rollout must be reversed. It restores exactly the vehicles recorded
in `inventory.json`, back to `public` with their saved `updated_at`, and nothing
else: it cannot touch a row that is not in the inventory, cannot change any
other column, and each statement is guarded by `visibility = 'private'`, so it
is safe to run twice or after a partial run. A vehicle edited after the
cleanup keeps its edit. `rollback.sql` was generated together with `cleanup.sql`
in step E; read it, then:

```sh
npx wrangler d1 execute cybercabhunter_db --remote --file "$CLEANUP_DIR/rollback.sql"
```

**Phase 3H caveat: read this before running it.** The rollback restores every
inventory vehicle that is *currently private*. It cannot tell "still private
since the cleanup" from "a moderator deliberately took it down with **Return to
Private**", so run as generated it would **re-publish a vehicle a moderator
withdrew** (the review history would still say it was taken down). Before running
it, list the vehicles a moderator returned to private, and delete each one's
statement from `rollback.sql` (one `UPDATE` line per vehicle, containing its id):

```sql taken-down-by-moderator
SELECT DISTINCT robotaxi_vehicle_id, license_plate FROM robotaxi_vehicle_reviews WHERE action = 'returned_private' ORDER BY robotaxi_vehicle_id
```

(That table exists only after migration `0012`. If it does not exist yet, no
moderator could have taken anything down and this caveat does not apply.)

Then repeat verification F.2 (the counts must match `counts-before.json`,
including `public_vehicles`). **Rolling back re-exposes vehicles nobody has
reviewed**: do it only to undo a failed rollout, not as a way to skip review.
If you need the pre-cleanup database itself, the export from step B is the
recovery point.

## Not part of this runbook

Merging duplicate vehicles, a unique plate index, receipt authentication, and
rate limiting are separate, later work. Nothing here changes them.

(The public `/vehicles` page and a moderator Delete Vehicle action were also
listed here as later work when this runbook was written — both have since
shipped. See `features.md` for the current Cars registry and moderation
behavior.)
