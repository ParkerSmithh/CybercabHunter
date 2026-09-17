// Evidence upload + submission API. Authentication is resolved by the
// caller (worker/index.js, via tesla.requireUserId) before any of these
// run — every function here takes an already-verified userId, never a
// user_id from request input.

import { db } from './db.js';

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

// The ONLY source of truth for what file types are accepted, and the ONLY
// source of the file extension used in the storage key — never derived
// from the browser-supplied filename.
const ALLOWED_MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf'
};

const ALLOWED_EVIDENCE_TYPES = new Set(['receipt', 'screenshot', 'photo', 'other']);
const ALLOWED_SUBMISSION_TYPES = new Set(['ride_receipt', 'vehicle_sighting', 'photo_evidence', 'other']);

function newId() {
  return crypto.randomUUID();
}

export async function apiCreateSubmission(request, env, userId) {
  // Cheap early rejection before spending effort parsing a huge body.
  const declaredLength = Number(request.headers.get('Content-Length') || 0);
  if (declaredLength && declaredLength > MAX_FILE_BYTES * 2) {
    return Response.json({ success: false, error: 'file_too_large' }, { status: 413 });
  }

  let form;
  try {
    form = await request.formData();
  } catch (err) {
    return Response.json({ success: false, error: 'invalid_form_data' }, { status: 400 });
  }

  const submissionType = form.get('submission_type');
  const evidenceType = form.get('evidence_type');
  const file = form.get('evidence');

  if (typeof submissionType !== 'string' || !ALLOWED_SUBMISSION_TYPES.has(submissionType)) {
    return Response.json({ success: false, error: 'invalid_submission_type' }, { status: 400 });
  }
  if (typeof evidenceType !== 'string' || !ALLOWED_EVIDENCE_TYPES.has(evidenceType)) {
    return Response.json({ success: false, error: 'invalid_evidence_type' }, { status: 400 });
  }
  if (!file || typeof file === 'string') {
    return Response.json({ success: false, error: 'missing_file' }, { status: 400 });
  }

  const ext = ALLOWED_MIME_EXT[file.type];
  if (!ext) {
    return Response.json({ success: false, error: 'unsupported_file_type' }, { status: 400 });
  }
  if (file.size > MAX_FILE_BYTES) {
    return Response.json({ success: false, error: 'file_too_large' }, { status: 413 });
  }

  // Server-generated, unguessable key — never the original filename, and
  // namespaced by user so a leaked single key can't be walked to find
  // another user's evidence by pattern-guessing.
  const objectKey = `evidence/${userId}/${newId()}.${ext}`;

  try {
    await env.EVIDENCE_BUCKET.put(objectKey, file.stream(), {
      httpMetadata: { contentType: file.type },
      customMetadata: { verifiedContentType: file.type }
    });
  } catch (err) {
    return Response.json({ success: false, error: 'upload_failed' }, { status: 502 });
  }

  const submissionId = newId();
  try {
    await db.createSubmission(env.cybercabhunter_db, {
      id: submissionId, userId, submissionType, evidenceType, evidenceRef: objectKey
    });
  } catch (err) {
    // The upload succeeded but the record didn't — don't leave orphaned
    // evidence behind, and don't claim success.
    try {
      await env.EVIDENCE_BUCKET.delete(objectKey);
    } catch (cleanupErr) {
      // Best-effort cleanup; the primary error below is still reported either way.
    }
    return Response.json({ success: false, error: 'submission_create_failed' }, { status: 500 });
  }

  return Response.json({
    success: true,
    submission: {
      id: submissionId,
      submission_type: submissionType,
      evidence_type: evidenceType,
      status: 'pending'
    }
  }, { status: 201 });
}

export async function apiListSubmissions(request, env, userId) {
  const submissions = await db.getSubmissionsByUser(env.cybercabhunter_db, userId);
  return Response.json({ submissions });
}

// Deletes a submission the caller owns, along with its R2 evidence.
// Restricted to 'pending' submissions: an approved one may already have a
// trip referencing it (trips.submission_id cascades on delete), so once a
// submission has been reviewed it becomes part of the historical record
// rather than something the submitter can retract.
export async function apiDeleteSubmission(request, env, userId, submissionId) {
  const submission = await db.getSubmissionForOwner(env.cybercabhunter_db, submissionId, userId);
  if (!submission) {
    return Response.json({ success: false, error: 'not_found' }, { status: 404 });
  }
  if (submission.status !== 'pending') {
    return Response.json({ success: false, error: 'not_deletable' }, { status: 409 });
  }

  if (submission.evidence_ref) {
    try {
      await env.EVIDENCE_BUCKET.delete(submission.evidence_ref);
    } catch (err) {
      return Response.json({ success: false, error: 'evidence_delete_failed' }, { status: 502 });
    }
  }

  await db.deleteSubmission(env.cybercabhunter_db, submissionId, userId);
  return Response.json({ success: true, deleted: true });
}

export async function apiGetEvidence(request, env, userId, submissionId) {
  const submission = await db.getSubmissionForOwner(env.cybercabhunter_db, submissionId, userId);
  if (!submission || !submission.evidence_ref) {
    return Response.json({ success: false, error: 'not_found' }, { status: 404 });
  }

  const object = await env.EVIDENCE_BUCKET.get(submission.evidence_ref);
  if (!object) {
    return Response.json({ success: false, error: 'evidence_missing' }, { status: 404 });
  }

  // Trust our own recorded, validated type over anything R2 echoes back
  // from upload-time metadata that could theoretically be stale.
  const contentType = object.customMetadata?.verifiedContentType
    || object.httpMetadata?.contentType
    || 'application/octet-stream';

  return new Response(object.body, {
    headers: { 'Content-Type': contentType }
  });
}
