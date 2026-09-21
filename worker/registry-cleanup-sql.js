// Statement builder for the one-time LEGACY PUBLIC REGISTRY CLEANUP
// (docs/registry-preflight.md, "Legacy Public Registry Cleanup Runbook").
//
// This file only PRODUCES SQL TEXT. It executes nothing, holds no database
// handle, has no route, is not imported by the router, and lives under
// worker/ (excluded from the static assets by .assetsignore). The operator
// runs the generated files by hand, after reading them.
//
// Why it exists: every registry row created before Phase 3E was made
// 'public' by the column default and no moderator ever reviewed it, so the
// cleanup sets those rows private and moderators re-approve the genuine ones.
// A hand-edited ID list is exactly how a rollback restores the wrong rows, so
// both the cleanup and its rollback are generated from ONE saved inventory of
// (id, prior visibility, prior updated_at).
//
//  - cleanup  touches only inventory ids that are STILL public, and changes
//             only visibility and updated_at.
//  - rollback restores only inventory ids that are currently private, back to
//             public with their exact saved updated_at. It cannot touch a row
//             that is not in the inventory, and it is safe to run twice.
// Neither statement writes any other column, deletes a row, or touches
// trips, submissions, or observations.

export const LEGACY_INVENTORY_SQL =
  `SELECT id, license_plate, visibility, updated_at FROM robotaxi_vehicles WHERE visibility = 'public' ORDER BY id`;

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const CHUNK = 50;   // ids per UPDATE, keeping each statement comfortably small

// Accepts what `wrangler d1 execute --json` prints ([{ results: [...] }, ...]),
// a { results: [...] } object, or a plain array of rows. Everything is
// validated before any of it is allowed near SQL text.
export function parseCleanupInventory(input) {
  let rows;
  if (Array.isArray(input)) {
    rows = input.some(x => x && Array.isArray(x.results)) ? input.flatMap(x => x.results || []) : input;
  } else if (input && Array.isArray(input.results)) {
    rows = input.results;
  } else {
    throw new Error('inventory: expected the JSON saved from the inventory query');
  }

  const seen = new Set();
  return rows.map((row, i) => {
    const where = `inventory row ${i + 1}`;
    if (!row || typeof row.id !== 'string' || !ID_RE.test(row.id)) throw new Error(`${where}: id is not a UUID`);
    if (row.visibility !== 'public') throw new Error(`${where}: prior visibility must be 'public' (the inventory is the legacy PUBLIC rows)`);
    if (typeof row.updated_at !== 'string' || !TIMESTAMP_RE.test(row.updated_at)) throw new Error(`${where}: updated_at must be 'YYYY-MM-DD HH:MM:SS'`);
    const id = row.id.toLowerCase();
    if (seen.has(id)) throw new Error(`${where}: duplicate id ${id}`);
    seen.add(id);
    return { id, license_plate: row.license_plate ?? null, visibility: 'public', updated_at: row.updated_at };
  });
}

export function buildCleanupStatements(input) {
  const inventory = parseCleanupInventory(input);
  const header = kind => `-- Legacy registry cleanup ${kind}: ${inventory.length} vehicle(s). Generated from the saved inventory; read before running.\n`;

  if (inventory.length === 0) {
    const none = header('(nothing to do)') + '-- The inventory is empty: no public vehicles were recorded, so there is nothing to change.\n';
    return { count: 0, cleanup: none, rollback: none };
  }

  const list = ids => ids.map(id => `'${id}'`).join(', ');
  const chunks = [];
  for (let i = 0; i < inventory.length; i += CHUNK) chunks.push(inventory.slice(i, i + CHUNK).map(v => v.id));

  const cleanup = header('') + chunks.map(ids =>
    `UPDATE robotaxi_vehicles SET visibility = 'private', updated_at = datetime('now')\n` +
    `WHERE visibility = 'public' AND id IN (${list(ids)});\n`
  ).join('');

  const rollback = header('ROLLBACK') + inventory.map(v =>
    `UPDATE robotaxi_vehicles SET visibility = 'public', updated_at = '${v.updated_at}' ` +
    `WHERE id = '${v.id}' AND visibility = 'private';\n`
  ).join('');

  return { count: inventory.length, cleanup, rollback };
}

// Snapshot verifier for runbook step F. `before` and `after` are saved
// results of `SELECT * FROM robotaxi_vehicles ORDER BY id` taken immediately
// before and after the cleanup (same shapes parseCleanupInventory accepts).
// It proves the cleanup changed exactly what it claims to: for every
// inventory row, ONLY visibility (public -> private) and updated_at differ;
// every other row, and every other column, is identical; and no row was added
// or removed. Returns { ok, problems[], changedRows } — it never throws on a
// mismatch, so the operator sees every problem at once.
export function verifyCleanupSnapshots({ before, after, inventory }) {
  const flatten = input => (Array.isArray(input)
    ? (input.some(x => x && Array.isArray(x.results)) ? input.flatMap(x => x.results || []) : input)
    : (input && Array.isArray(input.results) ? input.results : []));
  const byId = rows => new Map(flatten(rows).map(r => [String(r.id).toLowerCase(), r]));
  const b = byId(before), a = byId(after);
  const inv = new Set(parseCleanupInventory(inventory).map(v => v.id));
  const problems = [];
  let changedRows = 0;

  for (const id of b.keys()) if (!a.has(id)) problems.push(`row ${id} was REMOVED`);
  for (const id of a.keys()) if (!b.has(id)) problems.push(`row ${id} was ADDED`);

  for (const [id, was] of b) {
    const now = a.get(id);
    if (!now) continue;
    const columns = [...new Set([...Object.keys(was), ...Object.keys(now)])];
    const changed = columns.filter(c => JSON.stringify(was[c]) !== JSON.stringify(now[c]));
    if (changed.length) changedRows += 1;
    if (inv.has(id)) {
      const unexpected = changed.filter(c => c !== 'visibility' && c !== 'updated_at');
      if (unexpected.length) problems.push(`row ${id}: unexpected column(s) changed: ${unexpected.join(', ')}`);
      if (now.visibility !== 'private') problems.push(`row ${id}: expected visibility 'private' after cleanup, found '${now.visibility}'`);
    } else if (changed.length) {
      problems.push(`row ${id} is NOT in the inventory but changed: ${changed.join(', ')}`);
    }
  }
  return { ok: problems.length === 0, problems, changedRows };
}
