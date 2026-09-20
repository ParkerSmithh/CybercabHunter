// Phase 2 — the pure pieces: date/plate/time normalization, timezone and DST,
// ride identity, the trust decision, and the migration on legacy-shaped data.
// Run: node tests/phase2-canonical.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeCheck } from './helpers/env.mjs';
import { createTestD1, seedUser } from './helpers/d1-sqlite.mjs';
import {
  normalizeRide, normalizeRideDate, normalizePlate, computeRideKey, parseRideKey, rideKeysCompatible, RIDE_SOURCES
} from '../worker/ride-canonical.js';
import { localToUtcIso } from '../worker/ride-time.js';
import { resolveTimezone, parseStateFromAddress } from '../worker/city-reference.js';
import { findTeslaSender, isTeslaAddress, detectGmailForwardingConfirmation } from '../worker/receipt-forwarding.js';
import { classifyReceipt } from '../worker/receipt-validation.js';

const t = makeCheck();
const { check } = t;
const __dirname = dirname(fileURLToPath(import.meta.url));

async function run() {
  console.log('1. Ride dates normalize to ISO, or to null — never to a guess');
  {
    check('ISO passes through', normalizeRideDate('2026-06-09') === '2026-06-09');
    check('"June 9, 2026"', normalizeRideDate('June 9, 2026') === '2026-06-09');
    check('"Sep 17, 2026" (the older v1 parser format)', normalizeRideDate('Sep 17, 2026') === '2026-09-17');
    check('"6/9/2026"', normalizeRideDate('6/9/2026') === '2026-06-09');
    check('two-digit year', normalizeRideDate('6/9/26') === '2026-06-09');
    check('an impossible date is null (Feb 30)', normalizeRideDate('February 30, 2026') === null);
    check('garbage is null', normalizeRideDate('sometime last week') === null && normalizeRideDate('') === null && normalizeRideDate(null) === null);
  }

  console.log('2. Plates normalize (case, spaces, hyphens) or become null');
  {
    check('uppercases and strips separators', normalizePlate('xjr-2195') === 'XJR2195' && normalizePlate('XJR 2195') === 'XJR2195');
    check('too short/long or empty is null', normalizePlate('A') === null && normalizePlate('ABCDEFGHIJKLMN') === null && normalizePlate(null) === null);
  }

  console.log('3. Timezone inference and daylight saving');
  {
    check('Dallas -> America/Chicago, from the service area', resolveTimezone({ serviceArea: 'Dallas', state: 'TX' }).timezone === 'America/Chicago' && resolveTimezone({ serviceArea: 'dallas' }).source === 'inferred_from_service_area');
    check('an unlisted Texas suburb falls back to the STATE, labelled as such', (() => { const z = resolveTimezone({ serviceArea: 'Plano', state: 'TX' }); return z.timezone === 'America/Chicago' && z.source === 'inferred_from_state'; })());
    check('unknown city and state -> no timezone is claimed', resolveTimezone({ serviceArea: 'Nowhere', state: null }) === null && resolveTimezone({}) === null);
    check('state parsed from an address tail', parseStateFromAddress('4301 Hanover St, Dallas, TX 75225') === 'TX' && parseStateFromAddress('no state here') === null);
    check('summer (CDT, UTC-5): 13:04 -> 18:04Z', localToUtcIso('2026-06-09', '13:04', 'America/Chicago') === '2026-06-09T18:04:00Z');
    check('winter (CST, UTC-6): 13:04 -> 19:04Z', localToUtcIso('2026-01-15', '13:04', 'America/Chicago') === '2026-01-15T19:04:00Z');
    check('Phoenix has no DST: 13:04 in July -> 20:04Z', localToUtcIso('2026-07-15', '13:04', 'America/Phoenix') === '2026-07-15T20:04:00Z');
    check('crossing into the next UTC day: 9:30 pm CDT -> next day 02:30Z', localToUtcIso('2026-06-09', '21:30', 'America/Chicago') === '2026-06-10T02:30:00Z');
    check('missing pieces or bad zone -> null, not a guess', localToUtcIso(null, '13:04', 'America/Chicago') === null && localToUtcIso('2026-06-09', '13:04', 'Not/AZone') === null && localToUtcIso('2026-06-09', '13:04', null) === null);
  }

  console.log('4. Ride identity (ride_key) is separate from the receipt hash');
  {
    check('built from date, pickup time and plate', computeRideKey({ rideDate: '2026-06-09', pickupTime: '13:04', licensePlate: 'XJR2195' }) === 'v1|2026-06-09|13:04|XJR2195');
    check('plate is optional', computeRideKey({ rideDate: '2026-06-09', pickupTime: '13:04', licensePlate: null }) === 'v1|2026-06-09|13:04|');
    check('no date or no pickup time -> no identity (null), never a partial key', computeRideKey({ rideDate: null, pickupTime: '13:04' }) === null && computeRideKey({ rideDate: '2026-06-09', pickupTime: null }) === null);
    check('parse round-trips', JSON.stringify(parseRideKey('v1|2026-06-09|13:04|XJR2195')) === JSON.stringify({ rideDate: '2026-06-09', pickupTime: '13:04', licensePlate: 'XJR2195' }));
    check('same time, plate missing on one side -> the same ride', rideKeysCompatible('v1|2026-06-09|13:04|', 'v1|2026-06-09|13:04|XJR2195'));
    check('same time, different plates -> different rides', !rideKeysCompatible('v1|2026-06-09|13:04|AAA1111', 'v1|2026-06-09|13:04|BBB2222'));
    check('different pickup time -> different rides', !rideKeysCompatible('v1|2026-06-09|13:04|X', 'v1|2026-06-09|17:30|X'));
    check('garbage keys never match', !rideKeysCompatible(null, 'v1|2026-06-09|13:04|X') && !rideKeysCompatible('nope', 'nope'));
  }

  console.log('5. normalizeRide: the canonical shape, null-preserving, with provenance');
  {
    const base = { extraction: { parserVersion: 'x', fields: {}, fieldSources: {} }, receiptHash: 'h', review: { status: 'accepted', reason: 'r' }, messageId: null };
    const empty = normalizeRide(base, 'receipt_import');
    check('an empty receipt yields all-null fields, never zeros', empty.distance === null && empty.fareAmountCents === null && empty.durationMinutes === null && empty.rideDate === null && empty.rideKey === null);
    check('no fare -> no currency claim', empty.currency === null && empty.currencySource === null);
    const withFare = normalizeRide({ ...base, extraction: { ...base.extraction, fields: { fare_amount_cents: 0, distance: 0 } } }, 'receipt_import');
    check('a real zero fare stays 0 (free ride), a real zero distance stays 0', withFare.fareAmountCents === 0 && withFare.distance === 0);
    check('a fare with only a "$" is USD, flagged ASSUMED', withFare.currency === 'USD' && withFare.currencySource === 'assumed');
    const explicit = normalizeRide({ ...base, extraction: { ...base.extraction, fields: { fare_amount_cents: 500, currency: 'eur' }, fieldSources: { currency: 'extracted' } } }, 'receipt_import');
    check('a currency the receipt actually states is EXTRACTED', explicit.currency === 'EUR' && explicit.currencySource === 'extracted');
    check('junk numbers are rejected to null (negative distance, NaN fare)', normalizeRide({ ...base, extraction: { ...base.extraction, fields: { distance: -3, fare_amount_cents: NaN } } }, 'receipt_import').distance === null);
    let threw = false; try { normalizeRide(base, 'tesla_mobile_api'); } catch (e) { threw = true; }
    check('an unknown source is refused — the undocumented Tesla API is NOT a registered source', threw && !Object.keys(RIDE_SOURCES).some(k => /api|mobile|fleet/i.test(k)));
    check('the two receipt sources are the only ones registered', Object.keys(RIDE_SOURCES).sort().join() === 'receipt_email,receipt_import');
  }

  console.log('6. Trust: authorization is the token; validity is the message itself');
  {
    check('tesla.com and subdomains are Tesla', isTeslaAddress('robotaxi@tesla.com') && isTeslaAddress('a@mail.tesla.com'));
    check('look-alike domains are NOT Tesla', !isTeslaAddress('a@tesla.com.evil.com') && !isTeslaAddress('a@nottesla.com') && !isTeslaAddress('a@tesla.co') && !isTeslaAddress(''));
    check('direct From: tesla.com is found', findTeslaSender({ from: 'robotaxi@tesla.com', text: '' })?.via === 'from_header');
    const gmail = { from: 'me@gmail.com', text: '---------- Forwarded message ---------\nFrom: Tesla <robotaxi@tesla.com>\nDate: x\n' };
    const apple = { from: 'me@icloud.com', text: 'Begin forwarded message:\n\nFrom: Tesla <robotaxi@tesla.com>\nSubject: r\n' };
    const outlook = { from: 'me@outlook.com', text: '-----Original Message-----\nFrom: robotaxi@tesla.com\nSent: Tuesday\n' };
    check('Gmail forwarded block', findTeslaSender(gmail)?.via === 'forwarded_block');
    check('Apple Mail forwarded block', findTeslaSender(apple)?.via === 'forwarded_block');
    check('Outlook original-message block', findTeslaSender(outlook)?.via === 'forwarded_block');
    check('a forwarded block from someone else is not Tesla', findTeslaSender({ from: 'me@gmail.com', text: '---------- Forwarded message ---------\nFrom: Bob <bob@example.com>\n' }) === null);
    check('"tesla.com" merely mentioned in the body proves nothing', findTeslaSender({ from: 'me@gmail.com', text: 'my friend at robotaxi@tesla.com sent this' }) === null);
    check('a From: line far below the marker is not read', findTeslaSender({ from: 'me@gmail.com', text: '---------- Forwarded message ---------\n' + 'x\n'.repeat(30) + 'From: robotaxi@tesla.com' }) === null);

    const sig = signals => ({ signals: { mentionsRobotaxi: false, hasFare: false, hasDistance: false, hasRideId: false, hasPickupDropoff: false, hasTripDate: false, fareMismatch: false, ...signals } });
    const tesla = { from: 'robotaxi@tesla.com', text: '' };
    const stranger = { from: 'me@x.com', text: '' };
    check('Tesla sender + 3 signals -> accepted', classifyReceipt(tesla, sig({ hasFare: true, hasDistance: true, hasTripDate: true })).status === 'accepted');
    check('Tesla sender + 2 signals -> needs_review', classifyReceipt(tesla, sig({ hasFare: true, hasDistance: true })).status === 'needs_review');
    check('no sender evidence + the COMPLETE real format -> accepted', classifyReceipt(stranger, sig({ hasFare: true, hasDistance: true, hasTripDate: true, hasPickupDropoff: true })).status === 'accepted');
    check('no sender evidence + an incomplete format -> needs_review, not accepted', classifyReceipt(stranger, sig({ hasFare: true, hasDistance: true, hasTripDate: true })).status === 'needs_review');
    check('no sender evidence, no structure -> rejected', classifyReceipt(stranger, sig({})).status === 'rejected');
    check('a fare mismatch is never auto-accepted, even from Tesla with full structure', classifyReceipt(tesla, sig({ hasFare: true, hasDistance: true, hasTripDate: true, hasPickupDropoff: true, fareMismatch: true })).status === 'needs_review');
    check('Tesla sender alone with zero structure is still only review', classifyReceipt(tesla, sig({})).status === 'needs_review');
  }

  console.log('7. Gmail forwarding confirmation detection');
  {
    const ok = { from: 'forwarding-noreply@google.com', subject: 'Gmail Forwarding Confirmation - Receive Mail from a@b.com', text: 'Confirmation code: 123456789' };
    check('extracts the code from a real-looking Google message', detectGmailForwardingConfirmation(ok)?.code === '123456789');
    check('ignores the same text from any non-Google sender', detectGmailForwardingConfirmation({ ...ok, from: 'evil@example.com' }) === null);
    check('ignores a Google message that is not the confirmation', detectGmailForwardingConfirmation({ ...ok, subject: 'Security alert' }) === null);
    check('no code in the body -> null', detectGmailForwardingConfirmation({ ...ok, text: 'click the link' }) === null);
  }

  console.log('8. Migration 0009 on legacy-shaped data: preserves every row, collapses duplicates without deleting, re-evaluates status');
  {
    // Build the schema as it was BEFORE Phase 2, load legacy rows shaped exactly
    // like the production data found during Phase 2 prep, then apply 0009.
    const d1 = createTestD1({ migrateThrough: '0008_user_bio.sql' });
    seedUser(d1, 'u1'); seedUser(d1, 'u2');
    d1.exec(`INSERT INTO robotaxi_vehicles (id, license_plate) VALUES ('v1', 'XJR2195')`);
    const sub = (id, user, status) => d1.exec(`INSERT INTO submissions (id, user_id, submission_type, status) VALUES ('${id}', '${user}', 'ride_receipt', '${status}')`);
    const trip = (id, user, s, cols) => d1.exec(`INSERT INTO trips (id, submission_id, user_id, ${Object.keys(cols).join(',')}, created_at) VALUES ('${id}', '${s}', '${user}', ${Object.values(cols).map(v => v === null ? 'NULL' : typeof v === 'number' ? v : `'${v}'`).join(',')}, '2026-09-17 0${id.length}:00:00')`);
    const complete = { ride_date: '2026-06-09', pickup_time: '13:04', dropoff_time: '13:18', service_area: 'Dallas', distance: 2.8, fare_amount_cents: 692, pickup_description: 'A St', dropoff_description: 'B St', robotaxi_vehicle_id: 'v1', receipt_hash: null };
    sub('s1', 'u1', 'needs_review'); trip('a', 'u1', 's1', { ...complete, receipt_hash: 'h1' });
    sub('s2', 'u1', 'needs_review'); trip('bb', 'u1', 's2', { ...complete, receipt_hash: 'h2' });
    sub('s3', 'u1', 'needs_review'); trip('ccc', 'u1', 's3', { ...complete, receipt_hash: 'h3' });
    sub('s4', 'u1', 'needs_review'); trip('dddd', 'u1', 's4', { service_area: 'Dallas', fare_amount_cents: 692, receipt_hash: 'h4' }); // fare + city only, no date
    sub('s5', 'u2', 'needs_review'); trip('eeeee', 'u2', 's5', { ...complete, receipt_hash: 'h5' }); // same ride, DIFFERENT user
    sub('s6', 'u1', 'rejected');     trip('ffffff', 'u1', 's6', { ...complete, pickup_time: '18:00', receipt_hash: 'h6' });

    const before = d1.query('SELECT COUNT(*) n FROM trips')[0].n;
    d1.exec(readFileSync(join(__dirname, '..', 'migrations', '0009_phase2_rides.sql'), 'utf8'));

    check('no trip was deleted', d1.query('SELECT COUNT(*) n FROM trips')[0].n === before);
    check('foreign keys and integrity hold', d1.query('PRAGMA foreign_key_check').length === 0 && d1.query('PRAGMA integrity_check')[0].integrity_check === 'ok');
    const byId = Object.fromEntries(d1.query('SELECT * FROM trips').map(r => [r.id, r]));
    check('ride_key backfilled from stored date, time and linked plate', byId.a.ride_key === 'v1|2026-06-09|13:04|XJR2195');
    check('a trip with no date has no ride_key (nothing invented)', byId.dddd.ride_key === null);
    check('the earliest of three identical rides stays canonical', byId.a.superseded_by === null);
    check('the two later copies are marked superseded_by the canonical one', byId.bb.superseded_by === 'a' && byId.ccc.superseded_by === 'a');
    check('the same ride for a DIFFERENT user is a separate ride, not a duplicate', byId.eeeee.superseded_by === null);
    check('currency provenance backfilled as assumed where a fare exists', byId.a.currency_source === 'assumed');
    check('timezone inferred for Texas rides', byId.a.timezone === 'America/Chicago' && byId.a.timezone_source === 'inferred_from_service_area');
    const status = Object.fromEntries(d1.query('SELECT id, status FROM submissions').map(r => [r.id, r.status]));
    check('a complete canonical receipt moves out of review (accepted)', status.s1 === 'pending' && status.s5 === 'pending');
    check('a partial receipt (fare + city only) stays in review', status.s4 === 'needs_review');
    check('a rejected submission is never resurrected', status.s6 === 'rejected');
    check('superseded duplicates are not promoted', status.s2 === 'needs_review' && status.s3 === 'needs_review');
    check('the unique ride identity index is now in force', (() => { try { d1.exec(`INSERT INTO submissions (id, user_id, submission_type) VALUES ('sx','u1','ride_receipt'); INSERT INTO trips (id, submission_id, user_id, ride_key) VALUES ('tx','sx','u1','v1|2026-06-09|13:04|XJR2195')`); return false; } catch (e) { return /UNIQUE/.test(String(e.message)); } })());
    check('receipt_hash uniqueness is now per user (two users may hold the same content)', (() => { try { d1.exec(`INSERT INTO submissions (id, user_id, submission_type) VALUES ('sy','u2','ride_receipt'); INSERT INTO trips (id, submission_id, user_id, receipt_hash) VALUES ('ty','sy','u2','h1')`); return true; } catch (e) { return false; } })());
  }

  console.log('9. Migration 0009 is safe on an empty database and applies cleanly on top of everything');
  {
    const d1 = createTestD1();
    check('all migrations apply from scratch', d1.query("SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('trip_revisions','ride_sync_runs')")[0].n === 2);
  }

  t.finish();
}

run().catch(err => { console.error(err); process.exit(1); });
