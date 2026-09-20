// Historical receipt import: a signed-in rider hands us old Tesla receipts —
// pasted text or uploaded .eml files — and they run through EXACTLY the same
// pipeline as a forwarded email (receipt-process.js -> ride-ingest.js).
// There is no separate storage path for "historical" rides: the same
// canonical ride, the same identity/duplicate/revision rules, the same
// review-status rules. Importing a receipt and later receiving the same
// receipt by email therefore cannot create a duplicate.
//
// The user is resolved by the caller from the bearer session — never read
// from the request body. Receipt contents are parsed and discarded; only the
// structured ride fields persist, and the response echoes back no addresses,
// payment details or names.

import { parseRawEmail } from './receipt-parser.js';
import { processReceiptMessage, newCounts, addToCounts, runStatusFor } from './receipt-process.js';
import { db } from './db.js';

const MAX_ITEMS = 25;
const MAX_ITEM_CHARS = 2_000_000;   // per receipt
const MAX_BODY_BYTES = 6 * 1024 * 1024;

function newId() {
  return crypto.randomUUID();
}

function toParsedMessage(item) {
  if (item.kind === 'text') {
    // A pasted receipt has no headers, so there is no sender or Message-ID to
    // go on — it is trusted only if its own structure is complete (see
    // receipt-validation.js).
    return Promise.resolve({
      from: '', to: [], replyTo: [], subject: '', messageId: null, date: null,
      text: item.content, html: '', attachments: []
    });
  }
  return parseRawEmail(item.content);
}

export async function apiImportReceipts(request, env, userId) {
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > MAX_BODY_BYTES) {
    return Response.json({ success: false, error: 'too_large' }, { status: 413 });
  }

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return Response.json({ success: false, error: 'invalid_body' }, { status: 400 });
  }

  const items = body && body.items;
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_ITEMS) {
    return Response.json({ success: false, error: 'invalid_items', max_items: MAX_ITEMS }, { status: 400 });
  }
  for (const item of items) {
    const validKind = item && (item.kind === 'text' || item.kind === 'eml');
    if (!validKind || typeof item.content !== 'string' || item.content.trim() === '' || item.content.length > MAX_ITEM_CHARS) {
      return Response.json({ success: false, error: 'invalid_items', max_items: MAX_ITEMS }, { status: 400 });
    }
  }

  const sql = env.cybercabhunter_db;
  const runId = newId();
  await db.createSyncRun(sql, { id: runId, userId, source: 'receipt_import' });
  const counts = newCounts();
  const results = [];

  for (let index = 0; index < items.length; index++) {
    let result;
    try {
      const parsed = await toParsedMessage(items[index]);
      result = await processReceiptMessage(env, parsed, 'receipt_import', {
        userId, syncRunId: runId, evidenceType: 'pasted_receipt'
      });
    } catch (err) {
      result = { outcome: 'error', code: 'import_failed' };
    }
    addToCounts(counts, result);
    results.push({
      index,
      outcome: result.outcome,
      review_status: result.reviewStatus || null,
      reason: result.outcome === 'error' ? result.code : (result.reason || null),
      ride_date: result.rideDate || null
    });
  }

  await db.finishSyncRun(sql, runId, {
    status: runStatusFor(counts), ...counts, errorCode: counts.errors ? 'item_errors' : null
  });

  return Response.json({
    success: true,
    run: {
      processed: counts.seen, added: counts.created, updated: counts.updated,
      duplicates: counts.duplicates, needs_review: counts.review,
      rejected: counts.rejected, errors: counts.errors
    },
    results
  });
}
