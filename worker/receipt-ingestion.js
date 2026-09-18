// Orchestrates the full inbound-email pipeline: resolve recipient -> user,
// parse MIME, deduplicate, classify, store evidence, create the
// submission + trip, and log every attempt (including failures) to
// receipt_ingestions. Never trusts anything about *which user* this belongs
// to except the opaque token in the recipient address.

import { parseRawEmail } from './receipt-parser.js';
import { extractTeslaReceiptFields, extractTeslaReceiptFieldsV2 } from './receipt-extraction.js';
import { classifyReceipt } from './receipt-validation.js';
import { computeReceiptHash } from './receipt-dedupe.js';
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

  if (message.rawSize > MAX_INBOUND_BYTES) {
    await db.createReceiptIngestion(sql, {
      id: newId(), userId, status: 'rejected', errorCode: 'message_too_large'
    });
    message.setReject('Message too large');
    return;
  }

  let parsedMessage;
  try {
    parsedMessage = await parseRawEmail(message.raw);
  } catch (err) {
    await db.createReceiptIngestion(sql, {
      id: newId(), userId, status: 'parse_error',
      errorCode: 'mime_parse_failed', errorMessage: String(err).slice(0, 200)
    });
    return;
  }

  const messageId = parsedMessage.messageId;

  // Idempotency check #1: a retried/duplicate delivery of a Message-ID this
  // user's address has already successfully processed.
  if (messageId) {
    const existing = await db.findIngestionByMessageId(sql, messageId);
    if (existing) {
      await db.createReceiptIngestion(sql, {
        id: newId(), userId, messageId, receiptHash: existing.receipt_hash,
        parserVersion: existing.parser_version, status: 'duplicate',
        submissionId: existing.submission_id, tripId: existing.trip_id
      });
      return;
    }
  }

  // Try the format confirmed against a real Tesla receipt first; only fall
  // back to the older, never-verified format if v2 recognizes nothing at
  // all in this particular email.
  let extraction;
  try {
    extraction = extractTeslaReceiptFieldsV2(parsedMessage);
    if (Object.keys(extraction.fields).length === 0) {
      extraction = extractTeslaReceiptFields(parsedMessage);
    }
  } catch (err) {
    await db.createReceiptIngestion(sql, {
      id: newId(), userId, messageId, status: 'parse_error',
      errorCode: 'extraction_failed', errorMessage: String(err).slice(0, 200)
    });
    return;
  }

  const receiptHash = await computeReceiptHash(parsedMessage, extraction);

  // Idempotency check #2: same content fingerprint via a different
  // Message-ID (e.g. forwarded twice from different clients).
  const existingByHash = await db.findIngestionByHash(sql, receiptHash);
  if (existingByHash) {
    await db.createReceiptIngestion(sql, {
      id: newId(), userId, messageId, receiptHash,
      parserVersion: extraction.parserVersion, status: 'duplicate',
      submissionId: existingByHash.submission_id, tripId: existingByHash.trip_id
    });
    return;
  }

  const classification = classifyReceipt(parsedMessage, extraction);

  if (classification.status === 'rejected') {
    await db.createReceiptIngestion(sql, {
      id: newId(), userId, messageId, receiptHash,
      parserVersion: extraction.parserVersion, status: 'rejected',
      errorCode: classification.reason
    });
    return;
  }

  // Store a supported attachment (e.g. a PDF receipt) as private evidence.
  // The email body itself is parsed then discarded — only the structured
  // fields below and this optional attachment persist, not the raw email.
  let evidenceRef = null;
  const attachment = parsedMessage.attachments.find(a => ALLOWED_ATTACHMENT_MIME_EXT[a.mimeType]);
  if (attachment) {
    const ext = ALLOWED_ATTACHMENT_MIME_EXT[attachment.mimeType];
    const key = `receipts/${userId}/${newId()}.${ext}`;
    try {
      await env.EVIDENCE_BUCKET.put(key, attachment.content, {
        httpMetadata: { contentType: attachment.mimeType },
        customMetadata: { verifiedContentType: attachment.mimeType }
      });
      evidenceRef = key;
    } catch (err) {
      // Non-fatal — proceed without the attachment rather than losing the ride data.
    }
  }

  const submissionId = newId();
  await db.createSubmission(sql, {
    id: submissionId, userId,
    submissionType: 'ride_receipt',
    evidenceType: 'email_receipt',
    evidenceRef
  });
  if (classification.status === 'needs_review') {
    await db.markSubmissionNeedsReview(sql, submissionId);
  }

  let robotaxiVehicleId = null;
  if (extraction.fields.license_plate) {
    robotaxiVehicleId = await db.findOrCreateRobotaxiVehicleByPlate(sql, extraction.fields.license_plate);
  }

  const tripId = newId();
  await db.createTripFromReceipt(sql, {
    id: tripId,
    submissionId,
    userId,
    serviceArea: extraction.fields.service_area,
    rideDate: extraction.fields.ride_date,
    distance: extraction.fields.distance,
    fareAmountCents: extraction.fields.fare_amount_cents,
    externalRideId: extraction.fields.external_ride_id,
    robotaxiVehicleId,
    sourceMessageId: messageId,
    receiptHash,
    pickupDescription: extraction.fields.pickup_description,
    dropoffDescription: extraction.fields.dropoff_description,
    pickupTime: extraction.fields.pickup_time,
    dropoffTime: extraction.fields.dropoff_time,
    durationMinutes: extraction.fields.duration_minutes,
    durationMinutesDerived: extraction.fieldSources.duration_minutes === 'derived'
  });

  await db.touchIngestionAddressReceived(sql, userId);

  await db.createReceiptIngestion(sql, {
    id: newId(), userId, messageId, receiptHash,
    parserVersion: extraction.parserVersion,
    status: classification.status,
    submissionId, tripId
  });
}

// Authenticated API: returns (creating if needed) this user's receipt
// ingestion address. Only the local-part is meaningful right now since no
// domain is configured for Email Routing yet (see docs/receipt-ingestion.md)
// — `domain_configured: false` tells the frontend not to present this as a
// working address until RECEIPT_DOMAIN is set.
export async function apiGetIngestionAddress(request, env, userId) {
  const token = await db.findOrCreateReceiptIngestionAddress(env.cybercabhunter_db, userId);
  const domain = env.RECEIPT_DOMAIN;
  if (!domain) {
    return Response.json({ success: true, local_part: `u_${token}`, domain_configured: false });
  }
  return Response.json({ success: true, address: `u_${token}@${domain}`, domain_configured: true });
}
