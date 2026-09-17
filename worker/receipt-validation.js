// Layered, best-effort classification of whether an inbound email is a
// legitimate Tesla Robotaxi receipt. None of this is cryptographic proof —
// the From header is trivially spoofable — so it can only ever gate
// confidence (accepted / needs_review / rejected), never bypass the
// submissions moderation workflow entirely.

function senderLooksLikeTesla(fromAddress) {
  const domain = (fromAddress || '').split('@')[1] || '';
  return /(^|\.)tesla\.com$/i.test(domain);
}

export function classifyReceipt(message, extraction) {
  const senderMatch = senderLooksLikeTesla(message.from);
  const { signals } = extraction;

  const structuralScore =
    (signals.mentionsRobotaxi ? 1 : 0) +
    (signals.hasFare ? 1 : 0) +
    (signals.hasDistance ? 1 : 0) +
    (signals.hasRideId ? 1 : 0);

  if (!senderMatch && structuralScore === 0) {
    return { status: 'rejected', reason: 'not_recognized_as_tesla_receipt' };
  }
  // Auto-accept requires the sender AND at least 3 of 4 structural signals
  // (fare, distance, ride ID, robotaxi mention) — a receipt missing key
  // fields like fare/ride-ID is real evidence but not confident enough to
  // skip human review.
  if (senderMatch && structuralScore >= 3) {
    return { status: 'accepted', reason: 'sender_and_structure_match' };
  }
  return { status: 'needs_review', reason: 'partial_match' };
}
