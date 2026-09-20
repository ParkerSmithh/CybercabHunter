// THE definition of which rides count toward a rider's statistics. Every
// statistic and the ride-history list are built from these fragments, so
// there is exactly one place to change the rule.
//
// Trust model:
//  - 'pending' / 'approved' submissions COUNT. A receipt the classifier
//    accepted starts as 'pending' (accepted, awaiting optional moderation);
//    a moderator approving it makes it 'approved'.
//  - 'needs_review' rides are kept and shown in ride history, clearly
//    labelled, but are NOT counted — they hold a partial or ambiguous
//    receipt that the classifier would not vouch for. Re-sending a clearer
//    copy of the same ride upgrades it (see ride-ingest.js).
//  - 'rejected' rides never count.
//  - A trip marked superseded_by is a legacy duplicate of another trip and
//    never counts and never appears.
//
// Nothing here is stored as a counter; statistics are always computed live.

export const COUNTED_SUBMISSION_STATUSES = ['pending', 'approved'];

// `trips t` joined to its submission `s`. Alias names are part of the
// contract: callers write `t.` / `s.` columns against these fragments.
export const RIDES_FROM = 'trips t JOIN submissions s ON s.id = t.submission_id';

// Rides that exist as the rider's history (everything except superseded duplicates).
export const LIVE_RIDES_WHERE = 't.superseded_by IS NULL';

// Rides that count toward statistics.
export const COUNTED_RIDES_WHERE =
  `t.superseded_by IS NULL AND s.status IN (${COUNTED_SUBMISSION_STATUSES.map(s => `'${s}'`).join(', ')})`;

// What the UI is told about a single ride, derived from its submission status.
export function rideReviewState(submissionStatus) {
  if (COUNTED_SUBMISSION_STATUSES.includes(submissionStatus)) return 'counted';
  if (submissionStatus === 'rejected') return 'rejected';
  return 'under_review';
}
