// Inbound receipt email -> canonical ride, plus the two authenticated APIs
// that describe the rider's forwarding setup and receipt-sync status.
//
// This file owns only what is specific to the EMAIL source: resolving the
// recipient to a user, size limits, MIME parsing, the attachment, and the
// Gmail forwarding-confirmation message. Everything that turns a receipt
// into a ride lives in receipt-process.js / ride-ingest.js and is shared
// with the historical-import API. Never trusts anything about WHICH USER a
// message belongs to except the opaque token in the recipient address.

import { parseRawEmail } from './receipt-parser.js';
import { detectGmailForwardingConfirmation } from './receipt-forwarding.js';
import { processReceiptMessage, newCounts, addToCounts, runStatusFor } from './receipt-process.js';
import { db } from './db.js';

const MAX_INBOUND_BYTES = 10 * 1024 * 1024; // well under Cloudflare's 25 MiB platform cap
const ALLOWED_ATTACHMENT_MIME_EXT = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png'
};

function newId() {
  return crypto.randomUUID();
}

export async function handleIncomingEmail(message, env) {
  const sql = env.cybercabhunter_db;

  // Resolve recipient -> user via the opaque local-part token ONLY. An
  // address that doesn't parse or doesn't map to an active user is
  // rejected before anything is parsed or stored — there is no user to
  // associate a log entry with, so nothing is written.
  const localPart = (message.to || '').split('@')[0];
  const tokenMatch = localPart.match(/^u_([a-zA-Z0-9]+)$/);
  const token = tokenMatch ? tokenMatch[1] : null;
  const userId = token ? await db.getUserIdByActiveReceiptToken(sql, token) : null;

  if (!userId) {
    message.setReject('Unknown recipient');
    return;
  }

  const runId = newId();
  await db.createSyncRun(sql, { id: runId, userId, source: 'receipt_email' });
  const counts = newCounts();

  if (message.rawSize > MAX_INBOUND_BYTES) {
    await db.createReceiptIngestion(sql, {
      id: newId(), userId, status: 'rejected', outcome: 'rejected', errorCode: 'message_too_large', syncRunId: runId
    });
    await db.finishSyncRun(sql, runId, { status: 'completed', ...tally(addToCounts(counts, { outcome: 'rejected' })) });
    message.setReject('Message too large');
    return;
  }

  let parsedMessage;
  try {
    parsedMessage = await parseRawEmail(message.raw);
  } catch (err) {
    await db.createReceiptIngestion(sql, {
      id: newId(), userId, status: 'parse_error', outcome: 'error',
      errorCode: 'mime_parse_failed', errorMessage: String(err).slice(0, 200), syncRunId: runId
    });
    await db.finishSyncRun(sql, runId, {
      status: 'failed', errorCode: 'mime_parse_failed', ...tally(addToCounts(counts, { outcome: 'error' }))
    });
    return;
  }

  // Gmail's "confirm forwarding" message is delivered to this address, where
  // the rider can't see it. Keep only the code, to show it to them.
  const confirmation = detectGmailForwardingConfirmation(parsedMessage);
  if (confirmation) {
    await db.saveForwardingCode(sql, userId, confirmation.code);
    await db.createReceiptIngestion(sql, {
      id: newId(), userId, status: 'rejected', outcome: 'forwarding_confirmation',
      errorCode: 'gmail_forwarding_confirmation', syncRunId: runId
    });
    counts.seen += 1;
    await db.finishSyncRun(sql, runId, { status: 'completed', ...tally(counts) });
    return;
  }

  // A supported attachment (e.g. a PDF receipt) is kept as private evidence —
  // but only if the ride it belongs to is actually created, so a duplicate
  // never leaves an orphaned file. The email body itself is parsed then
  // discarded; only structured fields and this optional attachment persist.
  const attachment = parsedMessage.attachments.find(a => ALLOWED_ATTACHMENT_MIME_EXT[a.mimeType]);
  const storeEvidence = attachment ? async () => {
    const key = `receipts/${userId}/${newId()}.${ALLOWED_ATTACHMENT_MIME_EXT[attachment.mimeType]}`;
    try {
      await env.EVIDENCE_BUCKET.put(key, attachment.content, {
        httpMetadata: { contentType: attachment.mimeType },
        customMetadata: { verifiedContentType: attachment.mimeType }
      });
      return key;
    } catch (err) {
      return null; // Non-fatal — keep the ride rather than lose it over the attachment.
    }
  } : undefined;

  let result;
  try {
    result = await processReceiptMessage(env, parsedMessage, 'receipt_email', {
      userId, syncRunId: runId, evidenceType: 'email_receipt', storeEvidence
    });
  } catch (err) {
    result = { outcome: 'error', code: 'ingest_failed', message: String(err).slice(0, 200) };
  }

  if (result.outcome === 'error') {
    await db.createReceiptIngestion(sql, {
      id: newId(), userId, messageId: parsedMessage.messageId, status: 'parse_error', outcome: 'error',
      errorCode: result.code, errorMessage: result.message, syncRunId: runId
    });
  } else if (['created', 'updated', 'duplicate', 'unidentified'].includes(result.outcome)) {
    await db.markReceiptReceived(sql, userId);
  }

  addToCounts(counts, result);
  await db.finishSyncRun(sql, runId, {
    status: runStatusFor(counts), errorCode: result.outcome === 'error' ? result.code : null, ...tally(counts)
  });
}

function tally(counts) {
  return {
    seen: counts.seen, created: counts.created, updated: counts.updated, duplicates: counts.duplicates,
    review: counts.review, rejected: counts.rejected, errors: counts.errors
  };
}

// Authenticated API: returns (creating if needed) this user's receipt
// ingestion address. Only the local-part is meaningful until a domain is
// configured for Email Routing — `domain_configured: false` tells the
// frontend not to present this as a working address until RECEIPT_DOMAIN is set.
export async function apiGetIngestionAddress(request, env, userId) {
  const token = await db.findOrCreateReceiptIngestionAddress(env.cybercabhunter_db, userId);
  const domain = env.RECEIPT_DOMAIN;
  if (!domain) {
    return Response.json({ success: true, local_part: `u_${token}`, domain_configured: false });
  }
  return Response.json({ success: true, address: `u_${token}@${domain}`, domain_configured: true });
}

// Authenticated API: the rider's own receipt-sync picture. These are three
// DIFFERENT facts and are reported separately (the Tesla account link is a
// fourth, reported by /api/me): whether a forwarding address exists, whether
// mail has actually arrived through it, and how many rides came in.
// "receiving" is only true once a real receipt has arrived by email — an
// address existing is not evidence that forwarding was ever set up.
export async function apiGetSyncStatus(request, env, userId) {
  const status = await db.getSyncStatus(env.cybercabhunter_db, userId);
  const domain = env.RECEIPT_DOMAIN;
  const address = status.address;
  const totals = status.totals || {};

  return Response.json({
    forwarding: {
      address_issued: !!address,
      address: address && domain ? `u_${address.opaque_token}@${domain}` : null,
      local_part: address ? `u_${address.opaque_token}` : null,
      domain_configured: !!domain,
      confirmation_code: address ? address.forwarding_code : null,
      confirmation_code_received_at: address ? address.forwarding_code_received_at : null,
      // A receipt that arrived BY EMAIL and was recognised — even one we already
      // had — proves forwarding works. An imported ride does not. last_received_at
      // is only ever set by the email path, and also covers receipts that arrived
      // before receipt-sync runs were recorded.
      receiving: (totals.email_receipts || 0) > 0 || !!(address && address.last_received_at),
      last_received_at: address ? address.last_received_at : null
    },
    receipt_sync: {
      last_run: status.lastRun && {
        source: status.lastRun.source,
        started_at: status.lastRun.started_at,
        finished_at: status.lastRun.finished_at,
        status: status.lastRun.status,
        processed: status.lastRun.seen_count,
        added: status.lastRun.created_count,
        updated: status.lastRun.updated_count,
        duplicates: status.lastRun.duplicate_count,
        needs_review: status.lastRun.review_count,
        rejected: status.lastRun.rejected_count,
        errors: status.lastRun.error_count
      },
      last_ride_received_at: status.lastRideReceivedAt,
      totals: {
        processed: totals.seen || 0,
        added: totals.created || 0,
        updated: totals.updated || 0,
        duplicates: totals.duplicates || 0,
        needs_review: totals.review || 0,
        rejected: totals.rejected || 0,
        errors: totals.errors || 0
      },
      // Receipts that were recognized but had no readable date/pickup time, so
      // no ride was created (distinct receipts, not attempts).
      not_added_unreadable: status.unidentified || 0,
      rides_from_email: totals.email_created || 0,
      rides_from_import: totals.import_created || 0,
      under_review: status.underReview
    }
  });
}
