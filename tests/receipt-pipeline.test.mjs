// Pure-function tests for the receipt-ingestion pipeline (parsing,
// extraction, classification, dedup hashing) against synthetic fixtures.
// No D1/R2/network — these modules have no Workers-only dependency besides
// Web Crypto, which Node also provides natively. Run: node tests/receipt-pipeline.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseRawEmail } from '../worker/receipt-parser.js';
import { extractTeslaReceiptFields } from '../worker/receipt-extraction.js';
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

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

run();
