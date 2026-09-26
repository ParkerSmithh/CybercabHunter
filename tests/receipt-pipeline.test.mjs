// Pure-function tests for the receipt-ingestion pipeline (parsing,
// extraction, classification, dedup hashing) against synthetic fixtures.
// No D1/R2/network — these modules have no Workers-only dependency besides
// Web Crypto, which Node also provides natively. Run: node tests/receipt-pipeline.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseRawEmail } from '../worker/receipt-parser.js';
import { extractTeslaReceiptFields, extractTeslaReceiptFieldsV2 } from '../worker/receipt-extraction.js';
import { classifyReceipt } from '../worker/receipt-validation.js';
import { computeReceiptHash } from '../worker/receipt-dedupe.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = name => readFileSync(join(__dirname, 'fixtures', name), 'utf8');

let pass = 0, fail = 0;
function check(label, condition) {
  if (condition) { pass++; console.log(`  ok — ${label}`); }
  else { fail++; console.log(`  FAIL — ${label}`); }
}

async function run() {
  console.log('1. Valid Tesla-style receipt');
  {
    const msg = await parseRawEmail(fixture('tesla-receipt-valid.eml'));
    const extraction = extractTeslaReceiptFields(msg);
    const classification = classifyReceipt(msg, extraction);
    const hash = await computeReceiptHash(msg, extraction);
    check('sender parsed', msg.from === 'robotaxi@tesla.com');
    check('ride_date extracted', extraction.fields.ride_date === 'Sep 17, 2026');
    check('service_area extracted', extraction.fields.service_area?.includes('Austin'));
    check('distance extracted', extraction.fields.distance === 5.2);
    check('fare extracted as cents', extraction.fields.fare_amount_cents === 1250);
    check('external_ride_id extracted', extraction.fields.external_ride_id === 'RT-998877');
    check('license_plate extracted', extraction.fields.license_plate === 'XWM7221');
    check('classified as accepted', classification.status === 'accepted');
    check('hash is 64-char hex', /^[0-9a-f]{64}$/.test(hash));
  }

  console.log('2. Duplicate of the valid receipt (same content) hashes identically');
  {
    const msgA = await parseRawEmail(fixture('tesla-receipt-valid.eml'));
    const msgB = await parseRawEmail(fixture('tesla-receipt-valid.eml'));
    const hashA = await computeReceiptHash(msgA, extractTeslaReceiptFields(msgA));
    const hashB = await computeReceiptHash(msgB, extractTeslaReceiptFields(msgB));
    check('identical fixture produces identical hash (dedup key stable)', hashA === hashB);
  }

  console.log('3. Non-Tesla email');
  {
    const msg = await parseRawEmail(fixture('non-tesla-email.eml'));
    const extraction = extractTeslaReceiptFields(msg);
    const classification = classifyReceipt(msg, extraction);
    check('classified as rejected', classification.status === 'rejected');
  }

  console.log('4. Malformed input (not valid MIME at all)');
  {
    let threw = false;
    try {
      await parseRawEmail('this is not a valid email at all \x00\x01\x02');
    } catch (err) {
      threw = true;
    }
    // postal-mime is lenient and may not throw on garbage text — either a
    // clean throw OR a parse that yields no usable Tesla signal (which the
    // ingestion pipeline's classifier then rejects) is an acceptable outcome.
    if (!threw) {
      const msg = await parseRawEmail('this is not a valid email at all');
      const extraction = extractTeslaReceiptFields(msg);
      const classification = classifyReceipt(msg, extraction);
      check('garbage input does not classify as accepted', classification.status !== 'accepted');
    } else {
      check('malformed input threw as expected', true);
    }
  }

  console.log('5/6. Missing ride ID and fare — falls back to content-hash dedup, trip still storable');
  {
    const msg = await parseRawEmail(fixture('tesla-receipt-missing-fields.eml'));
    const extraction = extractTeslaReceiptFields(msg);
    const hash = await computeReceiptHash(msg, extraction);
    check('no external_ride_id extracted', extraction.fields.external_ride_id === undefined);
    check('no fare extracted', extraction.fields.fare_amount_cents === undefined);
    check('distance still extracted (partial data is fine)', extraction.fields.distance === 3.1);
    check('hash still computed via content fallback', /^[0-9a-f]{64}$/.test(hash));
    const classification = classifyReceipt(msg, extraction);
    check('classified as needs_review (partial match, not auto-accepted)', classification.status === 'needs_review');
  }

  console.log('7. No vehicle/plate present');
  {
    const msg = await parseRawEmail(fixture('tesla-receipt-missing-fields.eml'));
    const extraction = extractTeslaReceiptFields(msg);
    check('no license_plate fabricated', extraction.fields.license_plate === undefined);
  }

  console.log('8. Real Tesla receipt format (tesla_robotaxi_v2)');
  {
    const msg = await parseRawEmail(fixture('tesla-receipt-real-format.eml'));
    const extraction = extractTeslaReceiptFieldsV2(msg);
    const classification = classifyReceipt(msg, extraction);
    const hash = await computeReceiptHash(msg, extraction);
    check('ride_date extracted as ISO date', extraction.fields.ride_date === '2026-06-09');
    check('distance extracted', extraction.fields.distance === 2.8);
    check('duration_minutes extracted', extraction.fields.duration_minutes === 14);
    check('duration source is extracted, not derived', extraction.fieldSources.duration_minutes === 'extracted');
    check('license_plate extracted from summary line', extraction.fields.license_plate === 'XJR2195');
    check('fare extracted as cents (Total and Trip Fare agree)', extraction.fields.fare_amount_cents === 692);
    const dirtyPatterns = [/</, />/, /<\/a>/i, /<a\b/i, /google\.com\/maps/i, /\[image:/i];
    const isClean = str => !dirtyPatterns.some(re => re.test(str));

    check('pickup_description is exactly the clean address', extraction.fields.pickup_description === '4301 Hanover St, Dallas, TX 75225');
    check('pickup_description has no HTML/URL/image artifacts', isClean(extraction.fields.pickup_description));
    check('pickup_time converted to 24h', extraction.fields.pickup_time === '13:04');
    check('dropoff_description is exactly the clean name+address', extraction.fields.dropoff_description === 'NorthPark Center, 8687 N Central Expy, Dallas, TX 75225');
    check('dropoff_description has no HTML/URL/image artifacts', isClean(extraction.fields.dropoff_description));
    check('dropoff_description keeps the location name', extraction.fields.dropoff_description.includes('NorthPark Center'));
    check('dropoff_description keeps the street address', extraction.fields.dropoff_description.includes('8687 N Central Expy, Dallas, TX 75225'));
    check('dropoff_time converted to 24h', extraction.fields.dropoff_time === '13:18');
    check('service_area derived from address', extraction.fields.service_area === 'Dallas');
    check('no ride ID present — external_ride_id is undefined', extraction.fields.external_ride_id === undefined);
    check('license plate is never used as external_ride_id', extraction.fields.external_ride_id !== 'XJR2195');
    check('absence of ride ID does not reject — classified accepted (real sender, strong structural match)', classification.status === 'accepted');
    check('dedup hash computed via structured-field fallback (no ride ID)', /^[0-9a-f]{64}$/.test(hash));
  }

  console.log('9. Same real receipt, Gmail-forwarded copy (different sender, forwarding wrapper in body)');
  {
    const direct = await parseRawEmail(fixture('tesla-receipt-real-format.eml'));
    const forwarded = await parseRawEmail(fixture('tesla-receipt-real-format-forwarded.eml'));
    const directExtraction = extractTeslaReceiptFieldsV2(direct);
    const forwardedExtraction = extractTeslaReceiptFieldsV2(forwarded);
    const forwardedClassification = classifyReceipt(forwarded, forwardedExtraction);
    check('forwarding wrapper does not corrupt the ride date', forwardedExtraction.fields.ride_date === '2026-06-09');
    check('forwarding wrapper does not corrupt distance/duration/plate', forwardedExtraction.fields.distance === 2.8 && forwardedExtraction.fields.duration_minutes === 14 && forwardedExtraction.fields.license_plate === 'XJR2195');
    check('forwarding wrapper does not corrupt pickup/dropoff', forwardedExtraction.fields.pickup_description === directExtraction.fields.pickup_description && forwardedExtraction.fields.dropoff_description === directExtraction.fields.dropoff_description);
    check('forwarded copy is accepted: the forwarded block names tesla.com as the original sender (Phase 2 trust model)', forwardedClassification.status === 'accepted');
    const directHash = await computeReceiptHash(direct, directExtraction);
    const forwardedHash = await computeReceiptHash(forwarded, forwardedExtraction);
    check('direct and forwarded copies of the same ride hash identically (structured-field dedup, not raw body)', directHash === forwardedHash);
  }

  console.log('10. AM/PM edge cases (12 AM and 12 PM must not be confused)');
  {
    const noonMsg = await parseRawEmail(
      'From: robotaxi@tesla.com\nTo: u_test@receipts.example.com\nSubject: Your Tesla Robotaxi Receipt\nMessage-ID: <noon-005@tesla.com>\nDate: Wed, 17 Sep 2026 12:00:00 -0500\nContent-Type: text/plain; charset=utf-8\n\n' +
      'Trip Summary for September 17, 2026\n\n2.0 mi · 5 min · ABC1234\n\n$5.00\n\nTotal\n\nPick up\n\n1 Main St, Austin, TX 78701\n\n12:00 pm\n\nDest\n\n2 Main St, Austin, TX 78701\n\n12:05 am\n\nPayment\n\nTrip Fare $5.00\n'
    );
    const extraction = extractTeslaReceiptFieldsV2(noonMsg);
    check('12:00 pm is noon (12:00), not midnight', extraction.fields.pickup_time === '12:00');
    check('12:05 am is just after midnight (00:05), not noon', extraction.fields.dropoff_time === '00:05');
  }

  console.log('11. Duplicate delivery of the same real-format email is recognized (message-ID path, unaffected by dedupe change)');
  {
    const msgA = await parseRawEmail(fixture('tesla-receipt-real-format.eml'));
    const msgB = await parseRawEmail(fixture('tesla-receipt-real-format.eml'));
    check('same Message-ID on redelivery', msgA.messageId === msgB.messageId);
    const hashA = await computeReceiptHash(msgA, extractTeslaReceiptFieldsV2(msgA));
    const hashB = await computeReceiptHash(msgB, extractTeslaReceiptFieldsV2(msgB));
    check('identical content also hashes identically as a second line of defense', hashA === hashB);
  }

  console.log('12. Hyphenated plates are read whole ("XJR-2195" is XJR2195, never just "XJR")');
  {
    // The real-format fixture with only the plate token changed, so every other line is a real receipt.
    const plateOf = async token => {
      const msg = await parseRawEmail(fixture('tesla-receipt-real-format.eml').replace('2.8 mi · 14 min · XJR2195', `2.8 mi · 14 min · ${token}`));
      const extraction = extractTeslaReceiptFieldsV2(msg);
      return { plate: extraction.fields.license_plate, distance: extraction.fields.distance, minutes: extraction.fields.duration_minutes };
    };
    check('the unchanged plain plate still reads as before', (await plateOf('XJR2195')).plate === 'XJR2195');
    const hy = await plateOf('XJR-2195');
    check('a hyphenated plate is read in full, not cut at the hyphen', hy.plate === 'XJR-2195');
    check('the distance and duration on that line are still read correctly', hy.distance === 2.8 && hy.minutes === 14);
    check('a short first segment works too (AB-1234)', (await plateOf('AB-1234')).plate === 'AB-1234');
    check('three segments work (A-BC-123)', (await plateOf('A-BC-123')).plate === 'A-BC-123');
    // A dash used as the SEPARATOR between the tokens (the line is documented as separator-tolerant) must not be swallowed into the plate.
    const dashSep = async line => {
      const msg = await parseRawEmail(fixture('tesla-receipt-real-format.eml').replace('2.8 mi · 14 min · XJR2195', line));
      return extractTeslaReceiptFieldsV2(msg).fields.license_plate;
    };
    check('"14 min - XJR2195" (dash as separator) still reads XJR2195', (await dashSep('2.8 mi - 14 min - XJR2195')) === 'XJR2195');
    check('"14 min - XJR-2195" (dash separator AND hyphenated plate) reads XJR-2195', (await dashSep('2.8 mi - 14 min - XJR-2195')) === 'XJR-2195');
    check('"14 min | XJR-2195" (pipe separator) reads XJR-2195', (await dashSep('2.8 mi | 14 min | XJR-2195')) === 'XJR-2195');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

run();
