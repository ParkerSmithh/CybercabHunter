// THE definition of what a license plate is, everywhere in the Worker.
//
// A normalized plate is the input uppercased with every character outside
// A-Z / 0-9 removed. That is deliberately all it is: no O/0 or I/1 merging
// and no locale-specific rules, because merging visually similar characters
// would change which physical vehicles count as "the same plate". This file
// exists so every path (receipt ingestion, sighting submission, registry
// lookup/creation) agrees — one physical car must never become two vehicles
// because two call sites normalized differently.
//
// Notes on behavior that is inherited from the previous per-file copies and
// intentionally unchanged:
//  - String.prototype.toUpperCase is locale-independent, but it is Unicode
//    aware: 'ß' -> 'SS', 'ı' -> 'I', 'ſ' -> 'S', 'ﬁ' -> 'FI' fold into ASCII
//    letters, while fullwidth letters/digits and other non-ASCII characters
//    are simply removed.
//  - Nothing here validates length; callers that need a length rule apply it
//    to the result (see ride-canonical.js).

export function normalizePlate(raw) {
  if (raw === null || raw === undefined) return '';
  return String(raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// The SQL-side counterpart, used to compare a STORED plate to a normalized
// one. It only strips hyphens and spaces (the shapes plates were ever stored
// in), so it agrees with normalizePlate() exactly for every value the
// application itself has written — those are already alphanumeric. A row
// seeded or imported by hand with other punctuation (e.g. "ABC.123") would
// NOT match here; the production preflight (registry-preflight.js) lists
// such rows.
export function sqlNormalizedPlate(column) {
  return `UPPER(REPLACE(REPLACE(${column}, '-', ''), ' ', ''))`;
}
