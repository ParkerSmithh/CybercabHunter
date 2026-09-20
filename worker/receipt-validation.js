// Layered, best-effort classification of whether an inbound receipt is a
// legitimate Tesla Robotaxi receipt. None of this is cryptographic proof —
// sender text is trivially forgeable — so it can only ever gate confidence
// (accepted / needs_review / rejected), never bypass moderation entirely.
//
// Trust model:
//  - WHO the receipt belongs to is decided elsewhere and never here: the
//    opaque token in the rider's forwarding address (or, for an import,
//    their signed-in session) ties the receipt to a user.
//  - WHETHER it is a Tesla receipt is decided here from evidence in the
//    message itself: Tesla as the original sender (directly or inside a
//    forwarded block) plus the receipt's own structure.
//  - A message with no sender evidence at all (a pasted receipt has no
//    headers) can still be accepted, but only if it has EVERY field of the
//    real receipt format. Anything weaker goes to review; a message with no
//    receipt structure and no Tesla sender is rejected.

import { findTeslaSender } from './receipt-forwarding.js';

export function classifyReceipt(message, extraction) {
  const { signals } = extraction;
  const teslaSender = findTeslaSender(message);

  // A receipt whose "Total" and "Trip Fare" figures disagree is real
  // evidence of a ride, but the fare itself is ambiguous — never
  // auto-accept that, regardless of how strong the rest of the match is.
  if (signals.fareMismatch) {
    return { status: 'needs_review', reason: 'fare_mismatch' };
  }

  // hasPickupDropoff/hasTripDate come from the real (v2) receipt format,
  // which does not include a ride ID at all — real receipts must still be
  // able to reach the threshold below without hasRideId or a literal
  // "robotaxi" mention in the body, both of which are unreliable/absent.
  const structuralScore =
    (signals.mentionsRobotaxi ? 1 : 0) +
    (signals.hasFare ? 1 : 0) +
    (signals.hasDistance ? 1 : 0) +
    (signals.hasRideId ? 1 : 0) +
    (signals.hasPickupDropoff ? 1 : 0) +
    (signals.hasTripDate ? 1 : 0);

  const completeRealFormat =
    !!signals.hasTripDate && !!signals.hasPickupDropoff && !!signals.hasFare && !!signals.hasDistance;

  if (!teslaSender && structuralScore === 0) {
    return { status: 'rejected', reason: 'not_recognized_as_tesla_receipt' };
  }
  if (teslaSender && structuralScore >= 3) {
    return { status: 'accepted', reason: 'tesla_sender_and_structure_match' };
  }
  if (!teslaSender && completeRealFormat) {
    return { status: 'accepted', reason: 'complete_real_receipt_format' };
  }
  return { status: 'needs_review', reason: 'partial_match' };
}
