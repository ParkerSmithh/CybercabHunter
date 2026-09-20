// Phase 2 hardening — receipt revision ORDERING (C1) and ride IDENTITY (C2).
// Real SQL (node:sqlite + the project's migrations), real ingestion pipeline,
// synthetic receipts only. Run: node tests/phase2-revisions.test.mjs
//
// C1: an older or unorderable receipt must never overwrite a value that a
//     newer receipt set, in EITHER arrival order and whatever its formatting.
// C2: a receipt without a usable ride identity (readable date + pickup time)
//     must never become a ride, so it can never be counted twice.

import { makeEnv, makeCheck } from './helpers/env.mjs';
import { receiptBody, eml, inboundMessage, sentAt } from './helpers/receipts.mjs';
import { handleIncomingEmail, apiGetSyncStatus } from '../worker/receipt-ingestion.js';
import { apiImportReceipts } from '../worker/receipt-import.js';
import { receiptSentAt, isConfidentlyNewer } from '../worker/receipt-ordering.js';
import { normalizeRide } from '../worker/ride-canonical.js';
import { ingestRide } from '../worker/ride-ingest.js';
import { db } from '../worker/db.js';

const t = makeCheck();
const { check } = t;

const send = async (ctx, uid, opts) => {
  const to = ctx.addressFor(uid);
  await handleIncomingEmail(inboundMessage(eml({ ...opts, to }), to), ctx.env);
};
const importText = async (ctx, uid, contents) => {
  const req = new Request('https://x/api/rides/import', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ items: contents.map(content => ({ kind: 'text', content })) })
  });
  return (await apiImportReceipts(req, ctx.env, uid)).json();
};
const live = (ctx, uid = 'u1') => ctx.d1.query('SELECT * FROM trips WHERE user_id = ? AND superseded_by IS NULL ORDER BY created_at', uid);
const revisions = ctx => ctx.d1.query('SELECT * FROM trip_revisions ORDER BY revision');
const counted = async (ctx, uid = 'u1') => (await db.getUserProfile(ctx.d1, uid)).rideSummary.trip_count;
const lastIngestion = ctx => ctx.d1.query('SELECT status, outcome, error_code FROM receipt_ingestions ORDER BY rowid DESC LIMIT 1')[0];

const ORIGINAL = () => receiptBody();                                  // $6.92
const CORRECTED = () => receiptBody({ fare: '$8.50' });                // same ride, $8.50
const REFORMATTED_ORIGINAL = () => receiptBody({ pickup: '4301 Hanover Street, Dallas, TX 75225' }); // $6.92, different hash

async function run() {
  console.log('C1a. Send-time extraction: only Tesla\'s own Date header is a trustworthy ordering signal');
  {
    const msg = (o = {}) => ({ from: 'robotaxi@tesla.com', date: '2026-06-09T18:25:00.000Z', ...o });
    check('a Tesla message with a valid Date is stamped', receiptSentAt(msg()) === '2026-06-09T18:25:00.000Z');
    check('a manually forwarded message (From is the rider) is NOT stamped — its Date is the forwarder\'s', receiptSentAt(msg({ from: 'rider@gmail.com' })) === null);
    check('a pasted receipt (no headers) is not stamped', receiptSentAt({ from: '', date: null }) === null);
    check('an invalid Date is not stamped', receiptSentAt(msg({ date: 'not a date' })) === null);
    check('a missing Date is not stamped', receiptSentAt(msg({ date: undefined })) === null);
    check('a Date far in the future is not trusted', receiptSentAt(msg({ date: '2099-01-01T00:00:00.000Z' })) === null);
    check('an implausibly old Date is not trusted', receiptSentAt(msg({ date: '2001-01-01T00:00:00.000Z' })) === null);
    check('a look-alike domain is not Tesla', receiptSentAt(msg({ from: 'a@nottesla.com' })) === null);
    check('confidently newer needs BOTH stamps and a strictly later one',
      isConfidentlyNewer('2026-06-09T19:00:00.000Z', '2026-06-09T18:00:00.000Z') === true &&
      isConfidentlyNewer('2026-06-09T18:00:00.000Z', '2026-06-09T18:00:00.000Z') === false &&
      isConfidentlyNewer('2026-06-09T17:00:00.000Z', '2026-06-09T18:00:00.000Z') === false &&
      isConfidentlyNewer(null, '2026-06-09T18:00:00.000Z') === false &&
      isConfidentlyNewer('2026-06-09T18:00:00.000Z', null) === false);
  }

  console.log('C1-schema. Migration 0010 is additive and applies on top of the full history');
  {
    const ctx = await makeEnv();
    const col = ctx.d1.query("SELECT name, type, \"notnull\" AS nn FROM pragma_table_info('trips') WHERE name = 'receipt_sent_at'")[0];
    check('trips.receipt_sent_at exists as a nullable TEXT column', !!col && col.type === 'TEXT' && col.nn === 0);
    check('a ride created without a send time stores NULL, never a made-up value', await (async () => {
      await send(ctx, 'u1', { body: ORIGINAL(), from: 'rider@example.com', subject: 'r' });
      return live(ctx)[0].receipt_sent_at === null;
    })());
  }

  console.log('C1b. Same receipt twice / original → updated');
  {
    const ctx = await makeEnv();
    await send(ctx, 'u1', { body: ORIGINAL(), date: sentAt(0) });
    await send(ctx, 'u1', { body: ORIGINAL(), date: sentAt(0) });
    check('same receipt twice: one ride, revision 1, no snapshot', live(ctx).length === 1 && live(ctx)[0].revision === 1 && revisions(ctx).length === 0);
    check('the ride records the receipt\'s send time', live(ctx)[0].receipt_sent_at === '2026-06-09T18:25:00.000Z');

    await send(ctx, 'u1', { body: CORRECTED(), date: sentAt(30) });
    const r = live(ctx)[0];
    check('original → updated: same ride, corrected fare, revision 2', live(ctx).length === 1 && r.fare_amount_cents === 850 && r.revision === 2);
    check('the ride now carries the NEWER send time', r.receipt_sent_at === '2026-06-09T18:55:00.000Z');
    check('the replaced fare is kept as a revision snapshot', revisions(ctx).length === 1 && revisions(ctx)[0].fare_amount_cents === 692);
    check('still counted once, at the corrected fare', await counted(ctx) === 1 && (await db.getUserProfile(ctx.d1, 'u1')).spending[0].totalCents === 850);
  }

  console.log('C1c. UPDATED arrives BEFORE the original (both carry send times)');
  {
    const ctx = await makeEnv();
    await send(ctx, 'u1', { body: CORRECTED(), date: sentAt(30) });
    await send(ctx, 'u1', { body: ORIGINAL(), date: sentAt(0) });
    const r = live(ctx)[0];
    check('the corrected fare survives the late original', live(ctx).length === 1 && r.fare_amount_cents === 850 && r.revision === 1);
    check('no revision snapshot was written (nothing was replaced)', revisions(ctx).length === 0);
    check('the ingestion is recorded as a duplicate that kept the stored values', lastIngestion(ctx).outcome === 'duplicate' && lastIngestion(ctx).error_code === 'kept_existing_values');
    await send(ctx, 'u1', { body: CORRECTED(), date: sentAt(30) });
    check('re-sending the corrected receipt changes nothing', live(ctx)[0].fare_amount_cents === 850 && live(ctx)[0].revision === 1);
    check('counted once', await counted(ctx) === 1);
  }

  console.log('C1d. original → updated → older original again (identical, and reformatted)');
  {
    const ctx = await makeEnv();
    await send(ctx, 'u1', { body: ORIGINAL(), date: sentAt(0) });
    await send(ctx, 'u1', { body: CORRECTED(), date: sentAt(30) });
    await send(ctx, 'u1', { body: ORIGINAL(), date: sentAt(0) });
    check('identical old original: corrected fare kept', live(ctx)[0].fare_amount_cents === 850 && live(ctx)[0].revision === 2);

    await send(ctx, 'u1', { body: REFORMATTED_ORIGINAL(), date: sentAt(0) });
    let r = live(ctx)[0];
    check('REFORMATTED old original (different hash, older send time): corrected fare kept', r.fare_amount_cents === 850 && r.revision === 2);
    check('history was not extended by the stale copy', revisions(ctx).length === 1);

    await send(ctx, 'u1', { body: REFORMATTED_ORIGINAL(), date: sentAt(5), from: 'robotaxi@tesla.com' });
    check('a reformatted copy sent between the two is also older than the correction', live(ctx)[0].fare_amount_cents === 850);

    await send(ctx, 'u1', { body: REFORMATTED_ORIGINAL(), from: 'rider@gmail.com', forwardedFrom: 'robotaxi@tesla.com', date: sentAt(500) });
    r = live(ctx)[0];
    check('a MANUAL forward of the old original, with a much later outer Date, cannot revert it either', r.fare_amount_cents === 850 && r.revision === 2);
    check('and it is still one ride, counted once', live(ctx).length === 1 && await counted(ctx) === 1);
  }

  console.log('C1e. A later, confidently newer correction still wins after all of that');
  {
    const ctx = await makeEnv();
    await send(ctx, 'u1', { body: ORIGINAL(), date: sentAt(0) });
    await send(ctx, 'u1', { body: CORRECTED(), date: sentAt(30) });
    await send(ctx, 'u1', { body: receiptBody({ fare: '$9.25' }), date: sentAt(60) });
    check('a third, later receipt updates again (revision 3)', live(ctx)[0].fare_amount_cents === 925 && live(ctx)[0].revision === 3);
    check('revision history keeps BOTH replaced values, nothing deleted', revisions(ctx).map(r => r.fare_amount_cents).join(',') === '692,850');
  }

  console.log('C1f. Two different receipts with the same ride identity: the newer send time wins in either arrival order');
  {
    const a = await makeEnv();
    await send(a, 'u1', { body: receiptBody({ fare: '$7.00' }), date: sentAt(10) });
    await send(a, 'u1', { body: receiptBody({ fare: '$8.00' }), date: sentAt(20) });
    const b = await makeEnv();
    await send(b, 'u1', { body: receiptBody({ fare: '$8.00' }), date: sentAt(20) });
    await send(b, 'u1', { body: receiptBody({ fare: '$7.00' }), date: sentAt(10) });
    check('older→newer ends at the newer value', live(a)[0].fare_amount_cents === 800);
    check('newer→older ends at the SAME value', live(b)[0].fare_amount_cents === 800);
    check('one ride each', live(a).length === 1 && live(b).length === 1);

    const c = await makeEnv();
    await send(c, 'u1', { body: receiptBody({ fare: '$7.00' }), date: sentAt(10) });
    await send(c, 'u1', { body: receiptBody({ fare: '$8.00' }), date: sentAt(10) });
    check('equal send times cannot be ordered: the stored fare is kept', live(c)[0].fare_amount_cents === 700 && live(c).length === 1);
  }

  console.log('C1g. Receipts that cannot be ordered never overwrite a stored value');
  {
    const ctx = await makeEnv();
    await send(ctx, 'u1', { body: ORIGINAL(), date: sentAt(0) });
    const res = await importText(ctx, 'u1', [CORRECTED()]);
    check('a pasted correction of a stamped ride is kept out', live(ctx)[0].fare_amount_cents === 692 && live(ctx)[0].revision === 1);
    check('the import result says the stored values were kept', res.results[0].outcome === 'duplicate' && res.results[0].reason === 'kept_existing_values');

    const two = await makeEnv();
    await importText(two, 'u1', [ORIGINAL()]);
    const res2 = await importText(two, 'u1', [CORRECTED()]);
    check('pasted → pasted: neither has a send time, so the first value stands', live(two)[0].fare_amount_cents === 692 && res2.results[0].reason === 'kept_existing_values');

    const three = await makeEnv();
    await importText(three, 'u1', [ORIGINAL()]);
    await send(three, 'u1', { body: CORRECTED(), date: sentAt(30) });
    check('a stamped email cannot be shown newer than an unstamped stored ride: value kept', live(three)[0].fare_amount_cents === 692 && live(three)[0].revision === 1);

    const four = await makeEnv();
    await send(four, 'u1', { body: CORRECTED(), date: sentAt(30) });
    await send(four, 'u1', { body: ORIGINAL(), from: 'rider@gmail.com', forwardedFrom: 'robotaxi@tesla.com', date: sentAt(999) });
    check('a manually forwarded copy is unstamped, so it cannot override a stamped ride', live(four)[0].fare_amount_cents === 850);
    check('none of these created a second ride', [ctx, two, three, four].every(c => live(c).length === 1));
  }

  console.log('C1h. A receipt that cannot be ordered still FILLS gaps (nothing is overwritten)');
  {
    const ctx = await makeEnv();
    await send(ctx, 'u1', { body: receiptBody({ summary: null }), date: sentAt(0) });   // no distance, no plate
    check('first copy has no distance and no plate', live(ctx)[0].distance === null && !live(ctx)[0].robotaxi_vehicle_id);
    await importText(ctx, 'u1', [receiptBody({ fare: '$8.50' })]);                        // unordered, ALSO disagrees on fare
    const r = live(ctx)[0];
    check('distance and vehicle were filled in', r.distance === 2.8 && !!r.robotaxi_vehicle_id);
    check('but the disagreeing fare was NOT replaced', r.fare_amount_cents === 692);
    check('the ride\'s send time is unchanged by a gap-fill', r.receipt_sent_at === '2026-06-09T18:25:00.000Z');
    check('the ride still holds the hash of the receipt its fare came from', r.receipt_hash !== null && ctx.d1.query('SELECT COUNT(*) n FROM trips')[0].n === 1);
  }

  console.log('C1i. A fare-less receipt after a fare-bearing one never wipes the fare');
  {
    const ctx = await makeEnv();
    await send(ctx, 'u1', { body: ORIGINAL(), date: sentAt(0) });
    await send(ctx, 'u1', { body: receiptBody({ fare: null }), date: sentAt(30) });
    check('newer receipt without a fare: fare kept', live(ctx)[0].fare_amount_cents === 692);
    await send(ctx, 'u1', { body: receiptBody({ fare: null }), date: sentAt(-30) });
    check('older receipt without a fare: fare kept', live(ctx)[0].fare_amount_cents === 692 && live(ctx).length === 1);
    check('$0.00 is a real fare, distinct from no fare: a newer $0.00 replaces', await (async () => {
      await send(ctx, 'u1', { body: receiptBody({ fare: '$0.00' }), date: sentAt(60) });
      return live(ctx)[0].fare_amount_cents === 0;
    })());
  }

  console.log('C1j. Rider isolation: identical rides belonging to two riders');
  {
    const ctx = await makeEnv({ users: ['u1', 'u2'] });
    await send(ctx, 'u1', { body: ORIGINAL(), date: sentAt(0) });
    await send(ctx, 'u2', { body: ORIGINAL(), date: sentAt(0) });
    await send(ctx, 'u1', { body: CORRECTED(), date: sentAt(30) });
    check('u1\'s correction applies to u1', live(ctx, 'u1')[0].fare_amount_cents === 850 && live(ctx, 'u1')[0].revision === 2);
    check('u2\'s identical ride is untouched', live(ctx, 'u2')[0].fare_amount_cents === 692 && live(ctx, 'u2')[0].revision === 1);
    await send(ctx, 'u2', { body: CORRECTED(), date: sentAt(10) });
    check('u2 is ordered against u2\'s own history only', live(ctx, 'u2')[0].fare_amount_cents === 850 && live(ctx, 'u1')[0].revision === 2);
    check('each rider counts one ride', await counted(ctx, 'u1') === 1 && await counted(ctx, 'u2') === 1);
  }

  // ------------------------------------------------------------------ C2
  const UNREADABLE_DATE = receiptBody({ date: '9 June 2026' });
  const NO_DATE = receiptBody().replace('Trip Summary for June 9, 2026', 'Trip Summary');
  const IMPOSSIBLE_DATE = receiptBody({ date: 'Feb 30, 2026' });   // the extractor reads it; normalization rejects it
const NO_PICKUP_TIME = receiptBody({ pickupTime: '', dropoffTime: '' });
  const noRides = ctx => live(ctx).length === 0 && ctx.d1.query('SELECT COUNT(*) n FROM submissions')[0].n === 0;

  console.log('C2a. A receipt without a usable ride identity never becomes a ride');
  for (const [label, body, code] of [
    ['unrecognized date format ("9 June 2026")', UNREADABLE_DATE, 'ride_date_missing'],
    ['impossible date ("Feb 30, 2026")', IMPOSSIBLE_DATE, 'ride_date_unreadable'],
    ['missing date', NO_DATE, 'ride_date_missing'],
    ['missing pickup time', NO_PICKUP_TIME, 'pickup_time_missing']
  ]) {
    const ctx = await makeEnv();
    await send(ctx, 'u1', { body, date: sentAt(0) });
    const ing = lastIngestion(ctx);
    check(`${label}: no ride and no submission are created`, noRides(ctx));
    check(`${label}: not counted`, await counted(ctx) === 0);
    check(`${label}: not shown as an under-review ride either (nothing stored to review)`, (await db.getUserProfile(ctx.d1, 'u1')).underReview === 0 && (await db.getTripsPage(ctx.d1, 'u1', { limit: 10, offset: 0 })).total === 0);
    check(`${label}: the audit log records WHY (${code})`, ing.status === 'needs_review' && ing.outcome === 'unidentified' && ing.error_code === code);
    const run = ctx.d1.query('SELECT status, seen_count, created_count, review_count, error_count FROM ride_sync_runs')[0];
    check(`${label}: the sync run counts it as seen and needing review, created nothing`, run.seen_count === 1 && run.review_count === 1 && run.created_count === 0 && run.error_count === 0 && run.status === 'completed');
    check(`${label}: nothing was invented (no trips row at all)`, ctx.d1.query('SELECT COUNT(*) n FROM trips')[0].n === 0);
  }

  console.log('C2b. Malformed copies cannot inflate the count; the corrected receipt creates exactly one ride');
  {
    const ctx = await makeEnv();
    for (let i = 0; i < 3; i++) await send(ctx, 'u1', { body: UNREADABLE_DATE, date: sentAt(i) });
    check('three malformed copies: still zero rides, zero counted', live(ctx).length === 0 && await counted(ctx) === 0);
    await send(ctx, 'u1', { body: ORIGINAL(), date: sentAt(5) });
    check('the corrected receipt creates the ride', live(ctx).length === 1 && await counted(ctx) === 1);
    await send(ctx, 'u1', { body: UNREADABLE_DATE, date: sentAt(6) });
    await send(ctx, 'u1', { body: NO_DATE, date: sentAt(7) });
    check('malformed copies arriving AFTER the corrected one change nothing', live(ctx).length === 1 && await counted(ctx) === 1 && live(ctx)[0].revision === 1);
    check('no unnecessary duplicate: exactly one trips row and one submission', ctx.d1.query('SELECT COUNT(*) n FROM trips')[0].n === 1 && ctx.d1.query('SELECT COUNT(*) n FROM submissions')[0].n === 1);
  }

  console.log('C2c. The same holds for historical import, and the rider is told');
  {
    const ctx = await makeEnv();
    const res = await importText(ctx, 'u1', [UNREADABLE_DATE, ORIGINAL()]);
    check('import: the unreadable receipt is reported as unidentified, the good one as created', res.results[0].outcome === 'unidentified' && res.results[1].outcome === 'created');
    check('import: the reason is explicit and no date is echoed for the unreadable one', res.results[0].reason === 'missing_ride_identity' && res.results[0].ride_date === null);
    check('import: the run counts one added and one needing review', res.run.added === 1 && res.run.needs_review === 1 && res.run.errors === 0);
    check('import: one ride, counted once', live(ctx).length === 1 && await counted(ctx) === 1);
    const status = await (await apiGetSyncStatus(null, ctx.env, 'u1')).json();
    check('sync status reports one receipt that could not be added, without counting it as a ride', status.receipt_sync.not_added_unreadable === 1 && status.receipt_sync.under_review === 0);
    await importText(ctx, 'u1', [UNREADABLE_DATE]);
    check('the same unreadable receipt sent again is still ONE receipt not added', (await (await apiGetSyncStatus(null, ctx.env, 'u1')).json()).receipt_sync.not_added_unreadable === 1);
  }

  console.log('C2d. An unidentified receipt arriving by email still proves forwarding works');
  {
    const ctx = await makeEnv();
    await send(ctx, 'u1', { body: UNREADABLE_DATE, date: sentAt(0) });
    const status = await (await apiGetSyncStatus(null, ctx.env, 'u1')).json();
    check('forwarding is reported as receiving', status.forwarding.receiving === true);
  }

  console.log('C2e. Partial receipts that DO have an identity are still kept for review and can be resolved by a clearer copy');
  {
    const ctx = await makeEnv();
    await send(ctx, 'u1', { from: 'rider@example.com', subject: 'r', body: receiptBody({ fare: null, summary: null }), date: sentAt(0) });
    check('stored, not counted', live(ctx).length === 1 && await counted(ctx) === 0 && (await db.getUserProfile(ctx.d1, 'u1')).underReview === 1);
    await send(ctx, 'u1', { from: 'rider@example.com', subject: 'r', body: ORIGINAL() });
    check('the clearer copy resolves it into the SAME ride, now counted', live(ctx).length === 1 && await counted(ctx) === 1);
  }

  // ---------------------------------------------------------------- verification pass
  console.log('C1k. Production shape: a MANUAL Gmail-style forward creates a counted ride but claims no ordering timestamp');
  {
    const ctx = await makeEnv();
    // From = the rider (they pressed Forward); the outer Date is a perfectly valid, plausible time — the FORWARDER's.
    await send(ctx, 'u1', { from: 'rider@gmail.com', forwardedFrom: 'robotaxi@tesla.com', body: ORIGINAL(), date: sentAt(0) });
    check('created and counted: the forwarded block identifies Tesla', live(ctx).length === 1 && await counted(ctx) === 1 &&
      ctx.d1.query('SELECT status FROM submissions')[0].status === 'pending');
    check('receipt_sent_at is NULL — the outer Date is not Tesla\'s', live(ctx)[0].receipt_sent_at === null);
    await send(ctx, 'u1', { body: CORRECTED(), date: sentAt(30) });
    check('a later Tesla-stamped correction cannot replace an UNSTAMPED ride\'s values (kept, and logged as such)',
      live(ctx)[0].fare_amount_cents === 692 && live(ctx)[0].revision === 1 && lastIngestion(ctx).error_code === 'kept_existing_values');
    check('and it does not retroactively stamp the ride', live(ctx)[0].receipt_sent_at === null);
  }

  console.log('C1l. Automatic forward (Tesla is the message\'s own From): the send time is taken from the Date header, in UTC, whatever zone it is written in');
  for (const [zone, header] of [
    ['-0500', 'Tue, 9 Jun 2026 13:25:00 -0500'], ['+0000', 'Tue, 9 Jun 2026 18:25:00 +0000'],
    ['GMT', 'Tue, 9 Jun 2026 18:25:00 GMT'], ['+0900', 'Wed, 10 Jun 2026 03:25:00 +0900']
  ]) {
    const ctx = await makeEnv();
    await send(ctx, 'u1', { body: ORIGINAL(), date: header });
    check(`Date written as ${zone} is stored as the same UTC instant`, live(ctx)[0].receipt_sent_at === '2026-06-09T18:25:00.000Z');
  }

  console.log('C1m. Scenario D end-to-end: every source that cannot prove Tesla\'s send time stores NULL and still makes a normal ride');
  for (const [label, opts, viaImport] of [
    ['a Date header that is not a date', { date: 'not a date at all' }],
    ['an empty Date header', { date: '' }],
    ['a Date years in the future', { date: 'Fri, 1 Jan 2100 00:00:00 +0000' }],
    ['a Date before Tesla Robotaxi existed', { date: 'Mon, 1 Jan 2001 00:00:00 +0000' }],
    ['a non-Tesla sender with a valid Date', { from: 'rider@example.com', date: sentAt(0) }],
    ['a look-alike Tesla domain with a valid Date', { from: 'billing@nottesla.com', date: sentAt(0) }],
    ['pasted text (no headers at all)', null, true]
  ]) {
    const ctx = await makeEnv();
    if (viaImport) await importText(ctx, 'u1', [ORIGINAL()]); else await send(ctx, 'u1', { body: ORIGINAL(), ...opts });
    check(`${label}: a ride is created and counted, but receipt_sent_at is NULL (no timestamp is invented)`,
      live(ctx).length === 1 && await counted(ctx) === 1 && live(ctx)[0].receipt_sent_at === null);
  }

  console.log('C2f. Identity gate, exhaustive: no malformed identity field can produce a stored ride, so nothing can later be counted twice');
  {
    const BASE = {
      ride_date: '2026-06-09', pickup_time: '13:04', dropoff_time: '13:18', pickup_description: '4301 Hanover St, Dallas, TX 75225',
      dropoff_description: 'NorthPark Center, Dallas, TX 75225', fare_amount_cents: 692, distance: 2.8, duration_minutes: 14,
      license_plate: 'XJR2195', service_area: 'Dallas'
    };
    const ride = (over, hash) => normalizeRide({
      extraction: { fields: { ...BASE, ...over }, fieldSources: {}, parserVersion: 'test' },
      receiptHash: hash, review: { status: 'accepted', reason: 'test' }, messageId: null, sentAt: null
    }, 'receipt_email');
    const ingest = (ctx, r) => ingestRide(ctx.env, r, { userId: 'u1', evidenceType: 'email_receipt' });
    const MALFORMED = [
      ['impossible calendar date', { ride_date: '2026-13-40' }, 'ride_date_unreadable'],
      ['31st of a 30-day month', { ride_date: 'June 31, 2026' }, 'ride_date_unreadable'],
      ['non-padded ISO date', { ride_date: '2026-6-9' }, 'ride_date_unreadable'],
      ['a word, not a date', { ride_date: 'yesterday' }, 'ride_date_unreadable'],
      ['empty date', { ride_date: '' }, 'ride_date_missing'],
      ['null date', { ride_date: null }, 'ride_date_missing'],
      ['hour out of range', { pickup_time: '25:99' }, 'pickup_time_unreadable'],
      ['12-hour text instead of HH:MM', { pickup_time: '1pm' }, 'pickup_time_unreadable'],
      ['minutes not two digits', { pickup_time: '13:4' }, 'pickup_time_unreadable'],
      ['null pickup time', { pickup_time: null }, 'pickup_time_missing'],
      ['both missing', { ride_date: null, pickup_time: null }, 'ride_date_missing']
    ];
    const ctx = await makeEnv();
    let allUnidentified = true, reasonsRight = true;
    for (const [label, over, expected] of MALFORMED) {
      const r = ride(over, `malformed-${label}`);
      const res = await ingest(ctx, r);
      allUnidentified &&= res.outcome === 'unidentified' && res.reviewStatus === 'needs_review';
      reasonsRight &&= r.identityIssue === expected && r.rideKey === null;
    }
    check('all 11 malformed variants are classified unidentified / needs_review', allUnidentified);
    check('each carries the right, specific reason and NO ride_key', reasonsRight);
    check('none created a trip or a submission, and nothing is counted', ctx.d1.query('SELECT COUNT(*) n FROM trips')[0].n === 0 &&
      ctx.d1.query('SELECT COUNT(*) n FROM submissions')[0].n === 0 && await counted(ctx) === 0);
    check('every attempt is in the audit log for review (11 rows, all needs_review / unidentified)',
      ctx.d1.query("SELECT COUNT(*) n FROM receipt_ingestions WHERE status = 'needs_review' AND outcome = 'unidentified'")[0].n === MALFORMED.length);

    const good = await ingest(ctx, ride({}, 'good-1'));
    check('the corrected (parseable) receipt then creates exactly one ride', good.outcome === 'created' && live(ctx).length === 1 && await counted(ctx) === 1);
    for (const [label, over] of MALFORMED) await ingest(ctx, ride(over, `malformed-again-${label}`));
    const good2 = await ingest(ctx, ride({ fare_amount_cents: 692 }, 'good-2-different-hash'));
    check('malformed copies arriving after it, and a differently-hashed good copy, still leave exactly one ride',
      live(ctx).length === 1 && await counted(ctx) === 1 && good2.outcome !== 'created');
    check('INVARIANT: no ride with a NULL ride_key or NULL ride_date exists anywhere',
      ctx.d1.query('SELECT COUNT(*) n FROM trips WHERE ride_key IS NULL OR ride_date IS NULL OR pickup_time IS NULL')[0].n === 0);

    // The plate is deliberately NOT part of the gate: garbage there must not block a ride, and must not invent a plate.
    const ctx2 = await makeEnv();
    const plateless = ride({ license_plate: '!!' }, 'garbled-plate');
    const res = await ingest(ctx2, plateless);
    check('a garbled plate does not block the ride (identity is date + pickup time) and no plate is invented',
      res.outcome === 'created' && live(ctx2)[0].ride_key === 'v1|2026-06-09|13:04|' && live(ctx2)[0].robotaxi_vehicle_id === null);
    const withPlate = await ingest(ctx2, ride({}, 'proper-plate'));
    check('a later copy with a readable plate completes the same ride instead of duplicating it',
      withPlate.outcome === 'updated' && live(ctx2).length === 1 && live(ctx2)[0].ride_key === 'v1|2026-06-09|13:04|XJR2195' && live(ctx2)[0].robotaxi_vehicle_id !== null);
  }

  t.finish();
}

run().catch(err => { console.error(err); process.exit(1); });
