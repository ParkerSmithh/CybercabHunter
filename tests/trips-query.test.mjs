// Focused tests for GET /api/trips (worker/trips.js + db.getTripsByUser).
// No live D1 needed — a fake binding captures the exact SQL/bound
// parameters db.js sends, which is what actually proves the security
// properties here: the query is scoped by a single bound user-id
// parameter (never anything client-supplied) and the SELECT list never
// names a forbidden column. Run: node tests/trips-query.test.mjs

import { db } from '../worker/db.js';
import { apiListTrips } from '../worker/trips.js';

let pass = 0, fail = 0;
function check(label, condition) {
  if (condition) { pass++; console.log(`  ok — ${label}`); }
  else { fail++; console.log(`  FAIL — ${label}`); }
}

function fakeSql(rows) {
  const state = {};
  return {
    prepare(sqlText) {
      state.sql = sqlText;
      return {
        bind(...args) { state.args = args; return this; },
        all: async () => ({ results: rows })
      };
    },
    _state: state
  };
}

async function run() {
  console.log('1. getTripsByUser builds a query scoped to exactly one bound user id');
  {
    const sql = fakeSql([{ id: 't1', ride_date: '2026-06-09', submission_status: 'needs_review' }]);
    const rows = await db.getTripsByUser(sql, 'user-123');
    const selectClause = sql._state.sql.match(/SELECT([\s\S]*?)FROM/i)[1];

    check('exactly one bound parameter', sql._state.args.length === 1);
    check('bound parameter is the caller-supplied user id, unmodified', sql._state.args[0] === 'user-123');
    check('WHERE clause filters by t.user_id = ?', /WHERE\s+t\.user_id\s*=\s*\?/i.test(sql._state.sql));
    check('joins submissions on submission_id', /JOIN\s+submissions\s+s\s+ON\s+s\.id\s*=\s*t\.submission_id/i.test(sql._state.sql));
    check('submission_status aliased from submissions.status', /s\.status\s+AS\s+submission_status/i.test(selectClause));

    check('SELECT list does not include user_id', !/\buser_id\b/i.test(selectClause));
    check('SELECT list does not include source_message_id', !/source_message_id/i.test(selectClause));
    check('SELECT list does not include receipt_hash', !/receipt_hash/i.test(selectClause));
    check('SELECT list does not include evidence_ref', !/evidence_ref/i.test(selectClause));

    check('rows pass through unchanged', rows.length === 1 && rows[0].id === 't1');
  }

  console.log('2. No trips for this user returns an empty array, not an error or null');
  {
    const sql = fakeSql([]);
    const rows = await db.getTripsByUser(sql, 'user-with-no-trips');
    check('returns an array', Array.isArray(rows));
    check('array is empty', rows.length === 0);
  }

  console.log('3. apiListTrips wraps the query in { trips: [...] } with no forbidden fields');
  {
    const sql = fakeSql([
      { id: 't1', ride_date: '2026-06-09', fare_amount_cents: 692, submission_status: 'needs_review' }
    ]);
    const resp = await apiListTrips({}, { cybercabhunter_db: sql }, 'user-123');
    const body = await resp.json();
    check('response has a trips array', Array.isArray(body.trips));
    check('response body has no user_id on any trip', !body.trips.some(t => Object.prototype.hasOwnProperty.call(t, 'user_id')));
    check('response body has no source_message_id on any trip', !body.trips.some(t => Object.prototype.hasOwnProperty.call(t, 'source_message_id')));
    check('response body has no receipt_hash on any trip', !body.trips.some(t => Object.prototype.hasOwnProperty.call(t, 'receipt_hash')));
    check('response body has no evidence_ref on any trip', !body.trips.some(t => Object.prototype.hasOwnProperty.call(t, 'evidence_ref')));
  }

  console.log('4. apiListTrips for a user with no trips returns { trips: [] }, still a 200');
  {
    const sql = fakeSql([]);
    const resp = await apiListTrips({}, { cybercabhunter_db: sql }, 'user-with-no-trips');
    const body = await resp.json();
    check('status is 200 (default Response.json status)', resp.status === 200);
    check('trips is an empty array', Array.isArray(body.trips) && body.trips.length === 0);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

run();
