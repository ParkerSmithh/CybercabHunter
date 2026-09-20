// Builders for synthetic Tesla Robotaxi receipt emails in the REAL receipt
// format (tesla_robotaxi_v2), so tests can vary exactly one thing at a time.
// The passenger name and payment last-four are included on purpose: the
// privacy tests assert they never reach the database.

export const PASSENGER_NAME = 'Alex Rider';
export const PAYMENT_LAST4 = '8111';

export function receiptBody(o = {}) {
  const {
    date = 'June 9, 2026',
    summary = '2.8 mi · 14 min · XJR2195',      // null => no summary line at all
    fare = '$6.92',                              // null => no fare lines at all
    pickup = '4301 Hanover St, Dallas, TX 75225',
    pickupTime = '1:04 pm',
    dropoff = 'NorthPark Center, 8687 N Central Expy, Dallas, TX 75225',
    dropoffTime = '1:18 pm'
  } = o;

  const lines = [
    'Tesla', '', `Thanks for the ride, ${PASSENGER_NAME}`, '',
    `Trip Summary for ${date}`, '', 'Tesla', 'Trip Summary', ''
  ];
  if (summary) lines.push(summary, '');
  if (fare) lines.push(fare, '', 'Total', '');
  lines.push('Pick up', '', pickup, '', pickupTime, '', dropoff, '', dropoffTime, '', 'Payment', '');
  if (fare) lines.push(`Trip Fare ${fare}`);
  lines.push(`Payment Method ••••${PAYMENT_LAST4}`, '', 'If you have questions or concerns about your ride contact us.');
  return lines.join('\n');
}

let counter = 0;
// `date` is the message's own Date header. Receipt revision ordering depends on
// it, so tests that need "this receipt was sent later" pass an explicit value
// (see sentAt below); the default is one fixed instant, i.e. "unorderable
// against another default-dated message".
export const DEFAULT_DATE = 'Tue, 9 Jun 2026 13:25:00 -0500';

// The Nth minute after the ride, as an RFC 5322 Date header value.
export function sentAt(minutesAfter = 0) {
  const d = new Date(Date.UTC(2026, 5, 9, 18, 25 + minutesAfter, 0));
  return d.toUTCString().replace('GMT', '+0000');
}

export function eml({ from = 'robotaxi@tesla.com', to = 'u_token@receipts.example.com', subject = 'Your Tesla Robotaxi Receipt', messageId, body, forwardedFrom, date = DEFAULT_DATE }) {
  counter += 1;
  const mid = messageId || `<msg-${counter}-${Math.random().toString(36).slice(2)}@test>`;
  const wrapped = forwardedFrom
    ? `---------- Forwarded message ---------\nFrom: Tesla <${forwardedFrom}>\nDate: Tue, Jun 9, 2026 at 1:25 PM\nSubject: Robotaxi Ride Receipt\nTo: Alex Rider <rider@example.com>\n\n${body}`
    : body;
  return [
    `From: ${from}`, `To: ${to}`, `Subject: ${subject}`, `Message-ID: ${mid}`,
    `Date: ${date}`, 'Content-Type: text/plain; charset=utf-8', '', wrapped
  ].join('\r\n');
}

// A message object shaped like Cloudflare's email() handler input.
export function inboundMessage(rawEml, to) {
  const rejections = [];
  return {
    to, raw: rawEml, rawSize: rawEml.length,
    setReject: reason => rejections.push(reason),
    rejections
  };
}
