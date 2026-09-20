// Phase 2 — receipt -> canonical ride -> database. Real SQL (node:sqlite with
// the project's actual migrations), real ingestion pipeline. Covers: normal,
// duplicate, updated receipts, missing distance/fare, free rides, rejected,
// review status, historical import vs email, user isolation, privacy.
// Run: node tests/phase2-ingest.test.mjs

import { makeEnv, makeCheck } from './helpers/env.mjs';
import { receiptBody, eml, inboundMessage, sentAt, PASSENGER_NAME, PAYMENT_LAST4 } from './helpers/receipts.mjs';
import { handleIncomingEmail } from '../worker/receipt-ingestion.js';
import { apiImportReceipts } from '../worker/receipt-import.js';
import { db } from '../worker/db.js';

const t = makeCheck();
const { check } = t;

async function send(ctx, userId, opts) {
  const to = ctx.addressFor(userId);
  const msg = inboundMessage(eml({ ...opts, to }), to);
  await handleIncomingEmail(msg, ctx.env);
  return msg;
}
const trips = (ctx, userId = 'u1') => ctx.d1.query('SELECT * FROM trips WHERE user_id = ? AND superseded_by IS NULL ORDER BY created_at', userId);
const profile = (ctx, userId = 'u1') => db.getUserProfile(ctx.d1, userId);

async function run() {
  console.log('1. A normal receipt creates exactly one ride, with honest provenance');
  {
    const ctx = await makeEnv();
    await send(ctx, 'u1', { body: receiptBody() });
    const rows = trips(ctx);
    check('exactly one trip', rows.length === 1);
    const r = rows[0];
    check('ride date is ISO', r.ride_date === '2026-06-09');
    check('distance/duration/fare extracted', r.distance === 2.8 && r.duration_minutes === 14 && r.fare_amount_cents === 692);
    check('duration is extracted, not derived', r.duration_minutes_derived === 0);
    check('currency is recorded as ASSUMED (receipt only shows "$")', r.currency === 'USD' && r.currency_source === 'assumed');
    check('city taken from the address', r.service_area === 'Dallas');
    check('timezone inferred from the service area and labelled as such', r.timezone === 'America/Chicago' && r.timezone_source === 'inferred_from_service_area');
    check('UTC start is DST-correct (1:04 pm CDT = 18:04Z)', r.started_at_utc === '2026-06-09T18:04:00Z');
    check('stable ride_key built from date, pickup time and plate', r.ride_key === 'v1|2026-06-09|13:04|XJR2195');
    check('linked to a robotaxi vehicle by plate', !!r.robotaxi_vehicle_id);
    check('source recorded', r.source === 'receipt_email');
    const sub = ctx.d1.query('SELECT status FROM submissions WHERE id = ?', r.submission_id)[0];
    check('forwarded-by-Tesla real receipt is ACCEPTED (pending), not parked in review', sub.status === 'pending');
    const run1 = ctx.d1.query('SELECT * FROM ride_sync_runs')[0];
    check('a sync run recorded 1 seen / 1 created', run1.seen_count === 1 && run1.created_count === 1 && run1.status === 'completed');
  }

  console.log('2. The same receipt again — new Message-ID, same content, and a retried Message-ID — never creates a second ride');
  {
    const ctx = await makeEnv();
    await send(ctx, 'u1', { body: receiptBody(), messageId: '<same@test>' });
    await send(ctx, 'u1', { body: receiptBody() });                        // different Message-ID
    await send(ctx, 'u1', { body: receiptBody(), messageId: '<same@test>' }); // retried delivery
    check('still exactly one trip after three deliveries', trips(ctx).length === 1);
    const runs = ctx.d1.query('SELECT duplicate_count, created_count FROM ride_sync_runs ORDER BY started_at, id');
    check('the two later deliveries were counted as duplicates', runs.reduce((s, r) => s + r.duplicate_count, 0) === 2);
    check('statistics count one ride', (await profile(ctx)).rideSummary.trip_count === 1);
  }

  console.log('3. A manually forwarded copy (rider is the sender, Tesla only inside the forwarded block)');
  {
    const ctx = await makeEnv();
    await send(ctx, 'u1', { body: receiptBody(), from: 'rider@example.com', forwardedFrom: 'robotaxi@tesla.com' });
    const rows = trips(ctx);
    check('one trip created', rows.length === 1);
    const sub = ctx.d1.query('SELECT status FROM submissions WHERE id = ?', rows[0].submission_id)[0];
    check('accepted: the forwarded block identifies Tesla as the original sender', sub.status === 'pending');
    await send(ctx, 'u1', { body: receiptBody() }); // the direct copy of the same ride later
    check('the direct copy of the same ride does not add a second ride', trips(ctx).length === 1);
  }

  console.log('4. An UPDATED receipt (same ride, changed fare) updates the ride in place and never double-counts');
  {
    const ctx = await makeEnv();
    await send(ctx, 'u1', { body: receiptBody(), date: sentAt(0) });
    const originalId = trips(ctx)[0].id;
    await send(ctx, 'u1', { body: receiptBody({ fare: '$56.92' }), date: sentAt(30) }); // e.g. a cleaning fee added, sent later
    const rows = trips(ctx);
    check('still exactly one ride', rows.length === 1 && rows[0].id === originalId);
    check('fare updated to the new value', rows[0].fare_amount_cents === 5692);
    check('revision bumped to 2', rows[0].revision === 2);
    const revs = ctx.d1.query('SELECT * FROM trip_revisions WHERE trip_id = ?', originalId);
    check('the replaced fare is kept in trip_revisions', revs.length === 1 && revs[0].fare_amount_cents === 692 && revs[0].revision === 1);
    const p = await profile(ctx);
    check('statistics count ONE ride at the corrected fare', p.rideSummary.trip_count === 1 && p.spending[0].totalCents === 5692);
    const updateRuns = ctx.d1.query('SELECT created_count FROM ride_sync_runs WHERE updated_count = 1');
    check('one sync run recorded an update, and that run created nothing', updateRuns.length === 1 && updateRuns[0].created_count === 0);

    await send(ctx, 'u1', { body: receiptBody(), date: sentAt(0) }); // the ORIGINAL receipt arrives again afterwards
    check('re-sending the old receipt does not revert the corrected fare', trips(ctx)[0].fare_amount_cents === 5692 && trips(ctx)[0].revision === 2);
    check('and still one ride', trips(ctx).length === 1);
  }

  console.log('5. Missing distance: the ride is valid and distance stays NULL (never 0)');
  {
    const ctx = await makeEnv();
    await send(ctx, 'u1', { body: receiptBody({ summary: null }) });
    const r = trips(ctx)[0];
    check('ride created', !!r);
    check('distance is NULL', r.distance === null);
    check('duration derived from the two times, and flagged derived', r.duration_minutes === 14 && r.duration_minutes_derived === 1);
    const p = await profile(ctx);
    check('total distance is NULL, not 0', p.rideSummary.total_distance === null);
    check('coverage says distance is recorded for 0 of 1 rides', p.coverage.withDistance === 0 && p.coverage.rides === 1);
  }

  console.log('6. Missing fare: the ride is valid, fare is NULL, and it is NOT a free ride');
  {
    const ctx = await makeEnv();
    await send(ctx, 'u1', { body: receiptBody({ fare: null }) });
    const r = trips(ctx)[0];
    check('ride created', !!r);
    check('fare is NULL', r.fare_amount_cents === null);
    check('no currency claimed without a fare', r.currency === null && r.currency_source === null);
    const p = await profile(ctx);
    check('no spending block at all (nothing to total)', p.spending.length === 0);
    check('coverage: fare recorded for 0 of 1 rides', p.coverage.withFare === 0);
  }

  console.log('7. Free ride: only a recorded $0.00 counts as free');
  {
    const ctx = await makeEnv();
    await send(ctx, 'u1', { body: receiptBody({ fare: '$0.00' }) });
    await send(ctx, 'u1', { body: receiptBody({ date: 'June 10, 2026', fare: null }) });
    const p = await profile(ctx);
    check('two rides counted', p.rideSummary.trip_count === 2);
    check('fare $0 stored as 0, not NULL', ctx.d1.query('SELECT fare_amount_cents f FROM trips WHERE ride_date = ?', '2026-06-09')[0].f === 0);
    check('exactly one free ride', p.spending[0].freeCount === 1);
    check('the ride with NO fare is not called free', p.spending[0].fareCount === 1 && p.coverage.withFare === 1 && p.coverage.rides === 2);
  }

  console.log('8. Rejected: something that is not a Tesla receipt creates nothing');
  {
    const ctx = await makeEnv();
    await send(ctx, 'u1', { from: 'newsletter@example.com', subject: 'Big sale', body: 'Buy our stuff. 50% off everything.' });
    check('no trip created', trips(ctx).length === 0);
    check('no submission created', ctx.d1.query('SELECT COUNT(*) n FROM submissions')[0].n === 0);
    const ing = ctx.d1.query('SELECT status, outcome FROM receipt_ingestions')[0];
    check('the attempt is logged as rejected', ing.status === 'rejected' && ing.outcome === 'rejected');
    check('the run counts one rejection', ctx.d1.query('SELECT rejected_count n FROM ride_sync_runs')[0].n === 1);
  }

  console.log('9. Every message to the address is NOT automatically a ride (authorization != validity)');
  {
    const ctx = await makeEnv();
    await send(ctx, 'u1', { from: 'rider@example.com', subject: 'lunch?', body: 'Want to grab lunch tomorrow?' });
    check('a personal email sent to the forwarding address creates no ride', trips(ctx).length === 0);
    await send(ctx, 'u1', { from: 'rider@example.com', body: receiptBody(), subject: 'my receipt' });
    check('a pasted-style receipt with a COMPLETE real format but no sender evidence is accepted', trips(ctx).length === 1 &&
      ctx.d1.query('SELECT s.status st FROM submissions s JOIN trips t ON t.submission_id = s.id')[0].st === 'pending');
  }

  console.log('10. Review status: partial receipts are kept but not counted, and a clearer copy lifts them out of review');
  {
    const ctx = await makeEnv();
    // Date + stops + times but no fare or distance, and no Tesla sender: enough
    // to identify the ride, not enough structure to vouch for it.
    await send(ctx, 'u1', { from: 'rider@example.com', subject: 'receipt', body: receiptBody({ fare: null, summary: null }) });
    let rows = trips(ctx);
    check('a ride row exists', rows.length === 1);
    let sub = ctx.d1.query('SELECT status FROM submissions WHERE id = ?', rows[0].submission_id)[0];
    check('it is in needs_review', sub.status === 'needs_review');
    let p = await profile(ctx);
    check('a needs_review ride is NOT counted in statistics', p.rideSummary.trip_count === 0);
    check('but the rider is told one ride is under review', p.underReview === 1);
    const hist = await db.getTripsPage(ctx.d1, 'u1', { limit: 10, offset: 0 });
    check('and it still appears in ride history, labelled under_review', hist.total === 1 && hist.trips[0].status === 'under_review');
    await send(ctx, 'u1', { from: 'rider@example.com', subject: 'receipt', body: receiptBody() });
    rows = trips(ctx);
    check('a clearer copy of the same ride updates it (still one ride)', rows.length === 1 && rows[0].fare_amount_cents === 692);
    check('and lifts it out of review, so it now counts', (await profile(ctx)).rideSummary.trip_count === 1);
  }

  console.log('11. Two different rides on the same day with the same route and fare stay two rides');
  {
    const ctx = await makeEnv();
    await send(ctx, 'u1', { body: receiptBody({ pickupTime: '9:00 am', dropoffTime: '9:14 am' }) });
    await send(ctx, 'u1', { body: receiptBody({ pickupTime: '5:30 pm', dropoffTime: '5:44 pm' }) });
    check('different pickup times are different rides', trips(ctx).length === 2);
    check('same plate across two rides is ONE unique vehicle', (await profile(ctx)).rideSummary.unique_vehicles === 1);
  }

  console.log('12. Ride identity survives a plate appearing later (compatible keys)');
  {
    const ctx = await makeEnv();
    await send(ctx, 'u1', { body: receiptBody({ summary: null }) });           // no plate
    const id = trips(ctx)[0].id;
    check('first copy has no plate in its key', trips(ctx)[0].ride_key === 'v1|2026-06-09|13:04|');
    await send(ctx, 'u1', { body: receiptBody() });                             // same ride, plate present
    check('the clearer copy updates the same ride, no second ride', trips(ctx).length === 1 && trips(ctx)[0].id === id);
    check('the ride now has its plate in the key and a linked vehicle', trips(ctx)[0].ride_key === 'v1|2026-06-09|13:04|XJR2195' && !!trips(ctx)[0].robotaxi_vehicle_id);
    check('distance was filled in by the clearer copy', trips(ctx)[0].distance === 2.8);
  }

  console.log('13. Historical import and email share one pipeline: neither order creates a duplicate');
  {
    const ctx = await makeEnv();
    const importReq = items => new Request('https://x/api/rides/import', { method: 'POST', body: JSON.stringify({ items }) });
    // import first, then the same receipt arrives by email
    let resp = await apiImportReceipts(importReq([{ kind: 'text', content: receiptBody() }]), ctx.env, 'u1');
    let body = await resp.json();
    check('import created one ride', body.success && body.run.added === 1 && trips(ctx).length === 1);
    check('imported ride recorded with the import source', trips(ctx)[0].source === 'receipt_import');
    await send(ctx, 'u1', { body: receiptBody() });
    check('the same receipt arriving by email adds nothing', trips(ctx).length === 1);

    // and the other way around, with an .eml upload
    const ctx2 = await makeEnv();
    await send(ctx2, 'u1', { body: receiptBody() });
    resp = await apiImportReceipts(importReq([{ kind: 'eml', content: eml({ body: receiptBody() }) }]), ctx2.env, 'u1');
    body = await resp.json();
    check('importing an .eml of a ride already received by email is a duplicate', body.run.duplicates === 1 && body.run.added === 0 && trips(ctx2).length === 1);

    // a batch mixing a new receipt, a duplicate and junk
    const ctx3 = await makeEnv();
    resp = await apiImportReceipts(importReq([
      { kind: 'text', content: receiptBody() },
      { kind: 'text', content: receiptBody() },
      { kind: 'text', content: receiptBody({ date: 'June 12, 2026' }) },
      { kind: 'text', content: 'not a receipt at all' }
    ]), ctx3.env, 'u1');
    body = await resp.json();
    check('batch: 4 processed, 2 added, 1 duplicate, 1 rejected', body.run.processed === 4 && body.run.added === 2 && body.run.duplicates === 1 && body.run.rejected === 1);
    check('the response echoes no addresses, names, or payment details', !JSON.stringify(body).match(/Hanover|NorthPark|Alex|8111/));
  }

  console.log('14. User isolation: two riders with an identical receipt each get their own ride');
  {
    const ctx = await makeEnv({ users: ['u1', 'u2'] });
    await send(ctx, 'u1', { body: receiptBody() });
    await send(ctx, 'u2', { body: receiptBody() });
    check('each rider has exactly one ride', trips(ctx, 'u1').length === 1 && trips(ctx, 'u2').length === 1);
    check('the rides are different rows', trips(ctx, 'u1')[0].id !== trips(ctx, 'u2')[0].id);
    check("u2's receipt was not treated as a duplicate of u1's", ctx.d1.query("SELECT COUNT(*) n FROM receipt_ingestions WHERE status = 'duplicate'")[0].n === 0);
    check("each rider's stats count only their own ride", (await profile(ctx, 'u1')).rideSummary.trip_count === 1 && (await profile(ctx, 'u2')).rideSummary.trip_count === 1);
    check('both riders share ONE public vehicle row (crowdsourced, ownerless)', ctx.d1.query('SELECT COUNT(*) n FROM robotaxi_vehicles')[0].n === 1);
  }

  console.log('15. Privacy: passenger name, payment last-four and raw receipt text are never persisted');
  {
    const ctx = await makeEnv();
    await send(ctx, 'u1', { body: receiptBody() });
    const tables = ctx.d1.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").map(r => r.name);
    let leaked = [];
    for (const table of tables) {
      for (const row of ctx.d1.query(`SELECT * FROM ${table}`)) {
        const blob = JSON.stringify(row);
        if (blob.includes(PASSENGER_NAME) || blob.includes(PAYMENT_LAST4) || /Thanks for the ride|Payment Method/i.test(blob)) leaked.push(table);
      }
    }
    check('no table holds the passenger name, payment digits, or receipt boilerplate', leaked.length === 0);
  }

  console.log('16. Gmail forwarding confirmation: the code is surfaced to the rider, and cleared once a real receipt arrives');
  {
    const ctx = await makeEnv();
    await send(ctx, 'u1', {
      from: 'forwarding-noreply@google.com', subject: 'Gmail Forwarding Confirmation - Receive Mail from rider@example.com',
      body: 'rider@example.com has requested to automatically forward mail to your email address.\n\nConfirmation code: 123456789\n\nTo allow, click the link below.'
    });
    check('no ride and no submission created from the confirmation mail', trips(ctx).length === 0 && ctx.d1.query('SELECT COUNT(*) n FROM submissions')[0].n === 0);
    let addr = ctx.d1.query('SELECT forwarding_code FROM receipt_ingestion_addresses')[0];
    check('the confirmation code is stored for the rider', addr.forwarding_code === '123456789');
    await send(ctx, 'u1', { from: 'attacker@example.com', subject: 'Gmail Forwarding Confirmation', body: 'Confirmation code: 999999' });
    addr = ctx.d1.query('SELECT forwarding_code FROM receipt_ingestion_addresses')[0];
    check('a look-alike message not from Google cannot overwrite the code', addr.forwarding_code === '123456789');
    await send(ctx, 'u1', { body: receiptBody() });
    addr = ctx.d1.query('SELECT forwarding_code, last_received_at FROM receipt_ingestion_addresses')[0];
    check('once a real receipt arrives the code is cleared and last_received_at set', addr.forwarding_code === null && !!addr.last_received_at);
  }

  console.log('17. An unknown recipient is bounced with no database writes');
  {
    const ctx = await makeEnv();
    const msg = inboundMessage(eml({ body: receiptBody(), to: 'u_doesnotexist@receipts.example.com' }), 'u_doesnotexist@receipts.example.com');
    await handleIncomingEmail(msg, ctx.env);
    check('rejected at the SMTP level', msg.rejections.length === 1);
    check('nothing written', ctx.d1.query('SELECT COUNT(*) n FROM ride_sync_runs')[0].n === 0 && ctx.d1.query('SELECT COUNT(*) n FROM receipt_ingestions')[0].n === 0);
  }

  t.finish();
}

run().catch(err => { console.error(err); process.exit(1); });
