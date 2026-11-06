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
import { processReceiptMessage, previewReceiptMessage, newCounts, addToCounts, runStatusFor } from './receipt-process.js';
import { db } from './db.js';

const MAX_ITEMS = 25;
const MAX_ITEM_CHARS = 2_000_000;   // per receipt
const MAX_BODY_BYTES = 6 * 1024 * 1024;

function newId() {
  return crypto.randomUUID();
}

// Content-Length alone is not a real limit: it's a header the client sets
// and is simply absent on a chunked-transfer request, which Cloudflare's
// Request still accepts — a check against it can be trivially skipped.
// This reads the actual body stream and counts real bytes, aborting the
// read (never buffering past the cap) the moment it's exceeded, so the
// limit holds regardless of how the request declared its own size.
async function readBodyWithLimit(request, maxBytes) {
  const reader = request.body && request.body.getReader ? request.body.getReader() : null;
  if (!reader) return { text: '', tooLarge: false };

  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch (err) { /* best effort */ }
      return { text: null, tooLarge: true };
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { buf.set(chunk, offset); offset += chunk.byteLength; }
  return { text: new TextDecoder().decode(buf), tooLarge: false };
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

// Reads and validates an import request body: { items: [{ kind, content }] }.
// Returns { items, body } or { response } (the error to send back as-is);
// `body` lets a caller read its own extra fields from the same request.
export async function readImportItems(request) {
  // A present, honest Content-Length lets an oversized request be rejected
  // before reading anything — but it's only a fast path: readBodyWithLimit
  // below is what actually enforces the cap against the real byte stream,
  // so a request that omits it (e.g. chunked transfer) can't bypass it.
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > MAX_BODY_BYTES) {
    return { response: Response.json({ success: false, error: 'too_large' }, { status: 413 }) };
  }

  const { text, tooLarge } = await readBodyWithLimit(request, MAX_BODY_BYTES);
  if (tooLarge) {
    return { response: Response.json({ success: false, error: 'too_large' }, { status: 413 }) };
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch (err) {
    return { response: Response.json({ success: false, error: 'invalid_body' }, { status: 400 }) };
  }

  const items = body && body.items;
  const invalid = () => ({ response: Response.json({ success: false, error: 'invalid_items', max_items: MAX_ITEMS }, { status: 400 }) });
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_ITEMS) return invalid();
  for (const item of items) {
    const validKind = item && (item.kind === 'text' || item.kind === 'eml');
    if (!validKind || typeof item.content !== 'string' || item.content.trim() === '' || item.content.length > MAX_ITEM_CHARS) {
      return invalid();
    }
  }
  return { items, body };
}

// Runs every item through the one receipt pipeline as `userId`, inside one
// sync run. Returns { counts, results } where each result is the raw
// processReceiptMessage outcome (callers choose what to expose).
export async function runImport(env, userId, items) {
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
    results.push(result);
  }

  await db.finishSyncRun(sql, runId, {
    status: runStatusFor(counts), ...counts, errorCode: counts.errors ? 'item_errors' : null
  });
  return { counts, results };
}

export const runSummary = counts => ({
  processed: counts.seen, added: counts.created, updated: counts.updated,
  duplicates: counts.duplicates, needs_review: counts.review,
  rejected: counts.rejected, errors: counts.errors
});

export const itemBase = (result, index) => ({
  index,
  outcome: result.outcome,
  review_status: result.reviewStatus || null,
  reason: result.outcome === 'error' ? result.code : (result.reason || null),
  ride_date: result.rideDate || null
});

// POST /api/rides/import/preview  { items: [ONE { kind, content }] }
// What importing this receipt would do, from the same parser, classifier and
// duplicate rules as /api/rides/import, WITHOUT writing anything: the app's
// review step for a scanned, photographed or shared receipt. Missing fields
// stay null (never guessed); `uncertain` lists what the rider should check.
// Only the signed-in rider's own receipt and duplicate state are returned.
export async function apiPreviewReceipt(request, env, userId) {
  const read = await readImportItems(request);
  if (read.response) return read.response;
  if (read.items.length !== 1) return Response.json({ success: false, error: 'one_item_only' }, { status: 400 });
  let preview;
  try {
    preview = await previewReceiptMessage(env, await toParsedMessage(read.items[0]), 'receipt_import', userId);
  } catch (err) {
    return Response.json({ success: false, error: 'not_readable' }, { status: 422 });
  }
  const { ride, fieldSources, verdict } = preview;
  const fields = {
    ride_date: ride.rideDate, pickup_time: ride.pickupTime, dropoff_time: ride.dropoffTime,
    pickup: ride.pickupDescription, dropoff: ride.dropoffDescription,
    fare_amount_cents: ride.fareAmountCents, currency: ride.currency,
    distance_miles: ride.distance, duration_minutes: ride.durationMinutes,
    license_plate: ride.licensePlate, service_area: ride.serviceArea, timezone: ride.timezone
  };
  const uncertain = [];
  if (!ride.pickupTime) uncertain.push('pickup_time');
  if (!ride.rideDate) uncertain.push('ride_date');
  if (ride.fareAmountCents === null || ride.fareAmountCents === undefined) uncertain.push('fare');
  if (!ride.licensePlate) uncertain.push('license_plate');
  for (const [k, v] of Object.entries(fieldSources)) if (v && v !== 'extracted' && !uncertain.includes(k)) uncertain.push(k);
  return Response.json({
    success: true,
    would: verdict.would,
    reason: verdict.reason || null,
    review_status: ride.review ? ride.review.status : null,
    fields,
    uncertain
  }, { headers: { 'Cache-Control': 'private, no-store' } });
}

// GET /api/rides/imports?cursor=  the rider's own recent receipt imports.
// `source`: email (the forwarding address), gmail (Connect Gmail) or import
// (pasted, scanned, photographed or shared in the app or on the website).
// `result` is what happened, in plain terms; `error` is a stable code the
// app turns into an action (e.g. needs a pickup time).
const IMPORT_PAGE = 20;
const SOURCE_NAMES = { receipt_email: 'email', gmail_api: 'gmail', receipt_import: 'import', moderator_import: 'import' };
export async function apiListImports(request, env, userId) {
  const raw = new URL(request.url).searchParams.get('cursor');
  let after = null;
  if (raw) {
    try { after = JSON.parse(atob(raw.replace(/-/g, '+').replace(/_/g, '/'))); } catch (e) { after = null; }
    if (!after || typeof after.t !== 'string' || typeof after.id !== 'string') {
      return Response.json({ success: false, error: 'invalid_cursor' }, { status: 400 });
    }
  }
  const rows = await db.listRecentImports(env.cybercabhunter_db, userId, { limit: IMPORT_PAGE + 1, after });
  const page = rows.slice(0, IMPORT_PAGE);
  const result = r => {
    if (r.outcome === 'created') return 'imported';
    if (r.outcome === 'updated') return 'updated';
    if (r.outcome === 'duplicate' || r.status === 'duplicate') return 'duplicate';
    if (r.outcome === 'unidentified') return 'needs_details';
    if (r.outcome === 'rejected' || r.status === 'rejected') return 'not_a_receipt';
    return r.status === 'accepted' ? 'imported' : 'failed';
  };
  const last = page[page.length - 1];
  return Response.json({
    imports: page.map(r => ({
      id: r.id,
      received_at: r.received_at ? `${String(r.received_at).replace(' ', 'T')}Z` : null,
      source: SOURCE_NAMES[r.run_source] || (r.run_source ? 'import' : 'email'),
      result: result(r),
      error: ['imported', 'updated'].includes(result(r)) ? null : (r.error_code || null),
      ride: r.trip_id && r.trip_live ? {
        id: r.trip_id, ride_date: r.ride_date, pickup_time: r.pickup_time,
        pickup: r.pickup_description, dropoff: r.dropoff_description,
        fare_amount_cents: r.fare_amount_cents, currency: r.currency
      } : null
    })),
    next_cursor: rows.length > IMPORT_PAGE ? btoa(JSON.stringify({ t: last.received_at, id: last.id })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : null
  }, { headers: { 'Cache-Control': 'private, no-store' } });
}

export async function apiImportReceipts(request, env, userId) {
  const read = await readImportItems(request);
  if (read.response) return read.response;

  const { counts, results } = await runImport(env, userId, read.items);
  return Response.json({
    success: true,
    run: runSummary(counts),
    results: results.map(itemBase)
  });
}
