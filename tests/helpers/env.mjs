import { createTestD1, fakeKV, fakeR2, seedUser } from './d1-sqlite.mjs';
import { db } from '../../worker/db.js';

// A fully wired test environment: real-SQL D1, fake KV/R2, one or more users
// each with a forwarding address.
export async function makeEnv({ users = ['u1'], domain = 'receipts.example.com' } = {}) {
  const d1 = createTestD1();
  const tokens = {};
  for (const id of users) {
    seedUser(d1, id);
    tokens[id] = await db.findOrCreateReceiptIngestionAddress(d1, id);
  }
  const env = {
    cybercabhunter_db: d1,
    TESLA_SESSIONS: fakeKV(),
    EVIDENCE_BUCKET: fakeR2(),
    RECEIPT_DOMAIN: domain,
    FRONTEND_URL: 'https://cybercabhunter.com/'
  };
  const addressFor = id => `u_${tokens[id]}@${domain}`;
  return { env, d1, tokens, addressFor };
}

export function makeCheck() {
  const t = { pass: 0, fail: 0 };
  t.check = (label, condition) => {
    if (condition) { t.pass++; console.log(`  ok — ${label}`); }
    else { t.fail++; console.log(`  FAIL — ${label}`); }
  };
  t.finish = () => {
    console.log(`\n${t.pass} passed, ${t.fail} failed`);
    if (t.fail > 0) process.exit(1);
  };
  return t;
}

// Insert a ride (submission + trip) directly, bypassing ingestion — for
// statistics/history tests that need precise control over stored values.
let seedCounter = 0;
export function seedRide(d1, o = {}) {
  seedCounter += 1;
  const id = o.id || `trip-${seedCounter}`;
  const submissionId = `sub-${id}`;
  const userId = o.userId || 'u1';
  const created = o.createdAt || `2026-09-01 10:00:${String(seedCounter % 60).padStart(2, '0')}`;
  d1.prepare(`INSERT INTO submissions (id, user_id, submission_type, status, evidence_type) VALUES (?, ?, 'ride_receipt', ?, 'email_receipt')`)
    .bind(submissionId, userId, o.status || 'pending')._exec();
  d1.prepare(`
    INSERT INTO trips (id, submission_id, user_id, provider, service_area, ride_date, pickup_time, distance,
      fare_amount_cents, currency, currency_source, robotaxi_vehicle_id, source, ride_key, superseded_by,
      duration_minutes, pickup_description, dropoff_description, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id, submissionId, userId, o.provider || 'tesla', o.serviceArea === undefined ? 'Dallas' : o.serviceArea,
    o.rideDate === undefined ? '2026-06-09' : o.rideDate, o.pickupTime === undefined ? '13:04' : o.pickupTime,
    o.distance === undefined ? 2.8 : o.distance,
    o.fare === undefined ? 692 : o.fare,
    o.fare === null ? null : (o.currency || 'USD'), o.fare === null ? null : (o.currencySource || 'assumed'),
    o.vehicleId || null, o.source || 'receipt_email', o.rideKey === undefined ? null : o.rideKey,
    o.supersededBy || null, o.duration === undefined ? null : o.duration,
    o.pickupDescription === undefined ? '4301 Hanover St, Dallas, TX 75225' : o.pickupDescription,
    o.dropoffDescription === undefined ? 'NorthPark Center, Dallas, TX 75225' : o.dropoffDescription,
    created
  )._exec();
  return id;
}

export function seedVehicle(d1, { id, plate, model = null, firstSeenAt = '2026-06-01 00:00:00' }) {
  d1.prepare(`INSERT INTO robotaxi_vehicles (id, license_plate, model, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(id, plate, model, firstSeenAt, firstSeenAt)._exec();
  return id;
}
