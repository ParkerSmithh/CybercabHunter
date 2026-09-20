# Deploying and migrating — the procedure

Everything here is about **production** (`cybercabhunter_db`, remote). Local tests build their own in-memory database from `migrations/` and need none of this.

## The tooling, and what it expects

The project uses **wrangler's D1 migrations**: numbered `migrations/NNNN_name.sql` files, applied with `wrangler d1 migrations apply <db> --remote`. Wrangler records each applied file **by name** in a table it creates in the database itself, `d1_migrations(id, name UNIQUE, applied_at)`, and on every `apply`/`list` it treats any file in `migrations/` whose name is *not* in that table as pending and runs it. There is no checksum; the name is the whole record. (No `migrations_dir` / `migrations_table` override is set in `wrangler.jsonc`, so the defaults apply.)

## What went wrong once (so it does not recur)

Migrations 0001–0009 were originally applied by hand with `wrangler d1 execute --file`. That runs the SQL but **writes nothing to `d1_migrations`**, so the table stayed empty and wrangler believed *nothing* had ever been applied: `migrations list --remote` offered all of 0001–0009, and a plain `migrations apply --remote` would have tried to re-run them (failing on the first `CREATE TABLE`/`ALTER TABLE ADD COLUMN`, or worse, partly succeeding).

Reconciliation was done by comparing production's actual schema (every table, column, type and index) with a database built from the migration files. They matched exactly for 0001–0005 and 0007–0009, and **0006 (`tesla_ride_sync_connections`) had never been applied**. So only the eight verified migrations were recorded in `d1_migrations` (name only, no rider data touched), leaving 0006 and 0010 as genuinely pending.

## The procedure from now on

1. **Never** run a migration with `d1 execute --file`. Always `wrangler d1 migrations apply cybercabhunter_db --remote`, which applies and records in one step.
2. Before applying: `wrangler d1 migrations list cybercabhunter_db --remote` and read the list. It must contain **only** the migrations you intend to run. If it lists something already applied, stop — the tracker is out of sync; reconcile by schema comparison as above before doing anything else.
3. Take a backup first: `wrangler d1 export cybercabhunter_db --remote --output=<somewhere outside the repo>.sql` (it contains rider data; delete it when no longer needed).
4. Migrations must be **additive** (new tables/columns/indexes). A destructive change needs explicit sign-off and a rehearsal on a restored copy of the backup.
5. **Order: migrate first, then deploy.** New code may rely on a new column; old code tolerates an extra column. Deploying first breaks ingestion until the column exists.
6. After deploying, re-run `migrations list` (should say nothing pending) and probe an authenticated endpoint.

## Checking for drift at any time

`wrangler d1 migrations list cybercabhunter_db --remote` shows what wrangler thinks is pending. Anything unexpected means either a migration was applied outside wrangler again or a file was added but not yet applied.
