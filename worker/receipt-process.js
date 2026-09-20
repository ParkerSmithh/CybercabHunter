// Turns ONE parsed receipt message into a canonical ride and persists it.
// This is the receipt-source adapter's whole pipeline; it is shared by the
// forwarded-email handler and the historical-import API so a pasted or
// uploaded old receipt goes through exactly the same extraction,
// classification, normalization, deduplication and revision logic as one
// that arrives by email. Nothing about "historical" gets a separate path.

import { extractTeslaReceiptFields, extractTeslaReceiptFieldsV2 } from './receipt-extraction.js';
import { classifyReceipt } from './receipt-validation.js';
import { computeReceiptHash } from './receipt-dedupe.js';
import { normalizeRide } from './ride-canonical.js';
import { ingestRide } from './ride-ingest.js';
import { receiptSentAt } from './receipt-ordering.js';

// Try the format confirmed against a real Tesla receipt first; only fall
// back to the older, never-verified format if v2 recognizes nothing at all.
function extractFields(parsedMessage) {
  let extraction = extractTeslaReceiptFieldsV2(parsedMessage);
  if (Object.keys(extraction.fields).length === 0) {
    extraction = extractTeslaReceiptFields(parsedMessage);
  }
  return extraction;
}

// source: 'receipt_email' | 'receipt_import'
// options: { userId, syncRunId, evidenceType, storeEvidence }
// Returns the ingestRide result, or { outcome: 'error', code } if
// extraction itself blew up.
export async function processReceiptMessage(env, parsedMessage, source, options) {
  let extraction;
  try {
    extraction = extractFields(parsedMessage);
  } catch (err) {
    return { outcome: 'error', code: 'extraction_failed', message: String(err).slice(0, 200) };
  }

  const receiptHash = await computeReceiptHash(parsedMessage, extraction);
  const review = classifyReceipt(parsedMessage, extraction);
  const ride = normalizeRide(
    { extraction, receiptHash, review, messageId: parsedMessage.messageId || null, sentAt: receiptSentAt(parsedMessage) },
    source
  );

  const result = await ingestRide(env, ride, options);
  return { ...result, rideDate: ride.rideDate, reason: result.reason || review.reason };
}

// ---- Sync-run tallies ----

export function newCounts() {
  return { seen: 0, created: 0, updated: 0, duplicates: 0, review: 0, rejected: 0, errors: 0 };
}

export function addToCounts(counts, result) {
  counts.seen += 1;
  switch (result.outcome) {
    case 'created':
      counts.created += 1;
      if (result.reviewStatus === 'needs_review') counts.review += 1;
      break;
    case 'updated':
      counts.updated += 1;
      if (result.reviewStatus === 'needs_review') counts.review += 1;
      break;
    case 'duplicate': counts.duplicates += 1; break;
    // No usable ride identity: logged for review, no ride created.
    case 'unidentified': counts.review += 1; break;
    case 'rejected': counts.rejected += 1; break;
    default: counts.errors += 1;
  }
  return counts;
}

export function runStatusFor(counts) {
  if (counts.errors === 0) return 'completed';
  return counts.errors === counts.seen ? 'failed' : 'completed_with_errors';
}
