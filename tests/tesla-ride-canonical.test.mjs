// The Tesla ride-history adapter (worker/ride-canonical.js, source 'tesla-api'):
// a realistic API ride -> the canonical ride shape, including every "missing
// stays missing" case. Run: node tests/tesla-ride-canonical.test.mjs

import { normalizeRide, TESLA_API_SOURCE, computeRideKey } from '../worker/ride-canonical.js';
import { makeCheck } from './helpers/env.mjs';

const t = makeCheck();
const { check } = t;

// One ride as GET /mobile-app/ride/history returns it (field names from the
// reference exporter's CSV columns), including fields that must NOT be read.
const SAMPLE = {
  rideIntegerId: 48213,
  rideId: '3f6c1a9e-58b2-4d0e-9a51-2c7d8e0f4b11',
  state: 'COMPLETED',
  status: 'COMPLETED',
  rideRequestedAt: '2026-09-14T22:01:02Z',
  rideStartedAt: '2026-09-14T22:05:10Z',
  rideCompletedAt: '2026-09-14T22:21:40Z',
  pickupLocationName: '1100 S Congress Ave, Austin, TX 78704',
  pickupLocationLatitude: 30.2533,
  pickupLocationLongitude: -97.7489,
  pickupLocationTimezone: 'America/Chicago',
  dropoffLocationName: 'Domain Northside, Austin, TX 78758',
  dropoffLocationLatitude: 30.4027,
  dropoffLocationLongitude: -97.7253,
  dropoffLocationTimezone: 'America/Chicago',
  totalDistanceMiles: 11.4,
  driveDistanceMiles: 11.1,
  totalDurationSeconds: 990,
  totalDue: 18.96,
  totalDueTaxExcl: 17.52,
  currencyCode: 'USD',
  vin: '7SAYGDEE5TF000123',
  licensePlate: 'xvf-251',
  vehicleModel: 'Cybercab',
  isValid: true,
  billingUserId: 'billing-secret-1',
  billingUserUuid: 'billing-secret-2',
  riderSsoId: 'sso-secret',
  route: 'encoded-route-polyline',
  txid: 'payment-tx-secret'
};

const norm = (overrides = {}) => normalizeRide({ ...SAMPLE, ...overrides }, TESLA_API_SOURCE);

console.log('1. A complete ride');
{
  const r = norm();
  check('source tag "tesla-api", provider tesla', r.source === 'tesla-api' && r.provider === 'tesla');
  check('Tesla\'s rideId is the external ride id', r.externalRideId === SAMPLE.rideId);
  check('local date and pickup/dropoff minute in the ride\'s own timezone (CDT)', r.rideDate === '2026-09-14' && r.pickupTime === '17:05' && r.dropoffTime === '17:21');
  check('UTC instants kept as ISO', r.startedAtUtc === '2026-09-14T22:05:10.000Z' && r.completedAtUtc === '2026-09-14T22:21:40.000Z');
  check('timezone from the API, provenance "extracted"', r.timezone === 'America/Chicago' && r.timezoneSource === 'extracted');
  check('pickup/dropoff names', r.pickupDescription === SAMPLE.pickupLocationName && r.dropoffDescription === SAMPLE.dropoffLocationName);
  check('pickup/dropoff coordinates', r.pickupLatitude === 30.2533 && r.pickupLongitude === -97.7489 && r.dropoffLatitude === 30.4027 && r.dropoffLongitude === -97.7253);
  check('service area from the pickup point (Austin box)', r.serviceArea === 'Austin');
  check('distance in miles from totalDistanceMiles', r.distance === 11.4 && r.distanceUnit === 'mi');
  check('duration: seconds kept, minutes rounded, not derived', r.durationSeconds === 990 && r.durationMinutes === 17 && r.durationDerived === false);
  check('fare: totalDue dollars -> cents, currency extracted', r.fareAmountCents === 1896 && r.currency === 'USD' && r.currencySource === 'extracted');
  check('plate normalized through plate.js (XVF251)', r.licensePlate === 'XVF251');
  check('VIN stored as-is, as the reported VIN', r.reportedVin === SAMPLE.vin && !('vin' in r));
  check('ride key = local date | pickup minute | plate (same as a receipt)', r.rideKey === computeRideKey({ rideDate: '2026-09-14', pickupTime: '17:05', licensePlate: 'XVF251' }));
  check('stable per-ride hash for dedupe: tesla-api:<rideId>', r.receiptHash === `tesla-api:${SAMPLE.rideId}`);
  check('accepted (Tesla\'s own record), no identity issue', r.review.status === 'accepted' && r.identityIssue === null);
  check('no send time (the ordering rule then never lets it overwrite stored values)', r.receiptSentAt === null && r.messageId === null);
  const dump = JSON.stringify(r);
  check('billing ids, rider ids, payment tx and route are never read', !/billing-secret|sso-secret|payment-tx-secret|encoded-route/.test(dump));
}

console.log('2. Missing stays missing (never 0, never invented)');
{
  const r = norm({ totalDistanceMiles: undefined, totalDurationSeconds: null, totalDue: '', currencyCode: undefined, licensePlate: null, vin: null, dropoffLocationName: '  ' });
  check('no distance -> null, not 0', r.distance === null);
  check('no duration -> null seconds and minutes', r.durationSeconds === null && r.durationMinutes === null);
  check('no fare -> null cents AND no currency claimed', r.fareAmountCents === null && r.currency === null && r.currencySource === null);
  check('no plate -> null plate; the ride key has an empty plate slot', r.licensePlate === null && r.rideKey.endsWith('|'));
  check('no VIN -> null; blank dropoff name -> null', r.reportedVin === null && r.dropoffDescription === null);
  check('a real zero fare stays 0 (a free ride), with its currency', norm({ totalDue: 0 }).fareAmountCents === 0 && norm({ totalDue: 0 }).currency === 'USD');
  check('a fare string "11.88" parses; a junk fare is null', norm({ totalDue: '11.88' }).fareAmountCents === 1188 && norm({ totalDue: 'n/a' }).fareAmountCents === null);
  check('a fare without a currency code: USD, recorded as assumed', norm({ currencyCode: null }).currency === 'USD' && norm({ currencyCode: null }).currencySource === 'assumed');
  check('a negative distance is not a distance', norm({ totalDistanceMiles: -3 }).distance === null);
}

console.log('3. Timezone fallbacks');
{
  const r = norm({ pickupLocationTimezone: null, dropoffLocationTimezone: 'America/Chicago' });
  check('pickup zone missing -> dropoff zone', r.timezone === 'America/Chicago' && r.timezoneSource === 'extracted');
  const inferred = norm({ pickupLocationTimezone: null, dropoffLocationTimezone: 'Not/AZone' });
  check('no valid API zone -> resolveTimezone from the service area', inferred.timezone === 'America/Chicago' && inferred.timezoneSource === 'inferred_from_service_area' && inferred.pickupTime === '17:05');
  const byState = norm({ pickupLocationTimezone: null, dropoffLocationTimezone: null, pickupLocationLatitude: null, pickupLocationLongitude: null, dropoffLocationLatitude: null, dropoffLocationLongitude: null, pickupLocationName: '1 Main St, Phoenix, AZ 85004' });
  check('no zone, no coordinates -> the state in the address', byState.timezone === 'America/Phoenix' && byState.timezoneSource === 'inferred_from_state' && byState.serviceArea === null);
  const none = norm({ pickupLocationTimezone: null, dropoffLocationTimezone: null, pickupLocationLatitude: null, pickupLocationLongitude: null, dropoffLocationLatitude: null, dropoffLocationLongitude: null, pickupLocationName: 'Somewhere', dropoffLocationName: 'Elsewhere' });
  check('nothing to go on -> no timezone, no local date/time, an identity issue (never stored)', none.timezone === null && none.rideDate === null && none.pickupTime === null && none.identityIssue === 'ride_timezone_unknown' && none.rideKey === null);
  check('...but the UTC start is still kept', none.startedAtUtc === '2026-09-14T22:05:10.000Z');
}

console.log('4. Rides that cannot be identified, and invalid rides');
{
  check('no rideId -> identity issue', norm({ rideId: null }).identityIssue === 'ride_id_missing' && norm({ rideId: null }).receiptHash === null);
  check('no start time (e.g. a cancelled request) -> identity issue', norm({ rideStartedAt: null }).identityIssue === 'ride_start_missing');
  check('an unreadable start time -> identity issue', norm({ rideStartedAt: 'yesterday' }).identityIssue === 'ride_start_unreadable');
  const invalid = norm({ isValid: false });
  check('Tesla marks the ride invalid -> kept for review, not counted', invalid.review.status === 'needs_review' && invalid.review.reason === 'tesla_marked_invalid');
  check('out-of-range coordinates are dropped', norm({ pickupLocationLatitude: 123 }).pickupLatitude === null);
  check('a ride outside every service area has no service area', norm({ pickupLocationLatitude: 40.7, pickupLocationLongitude: -74, dropoffLocationLatitude: 40.8, dropoffLocationLongitude: -73.9 }).serviceArea === null);
}

console.log('5. Timezone edge: a late-evening ride is dated in local time, not UTC');
{
  const r = norm({ rideStartedAt: '2026-09-15T03:30:00Z', rideCompletedAt: '2026-09-15T03:50:00Z' });
  check('03:30 UTC on the 15th is 22:30 on the 14th in Austin', r.rideDate === '2026-09-14' && r.pickupTime === '22:30');
}

t.finish();
