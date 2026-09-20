// Working out where a receipt REALLY came from, and handling the mail a
// mail provider sends while a rider is setting up forwarding.
//
// A forwarded receipt reaches us from the rider's own address, so the
// message's own From header says nothing about Tesla. Two ways the
// original sender survives forwarding:
//   1. Automatic forwarding rules (e.g. a Gmail filter) usually keep the
//      original From header.
//   2. A manual "Forward" wraps the original in the body, behind a
//      "---------- Forwarded message ---------" (Gmail), "Begin forwarded
//      message:" (Apple Mail) or "-----Original Message-----" (Outlook)
//      marker followed by the original From: line.
//
// Neither is proof — both are text a sender controls — so a match only
// raises confidence (see receipt-validation.js); the recipient token is
// still what authorizes who the receipt belongs to.

const TESLA_DOMAIN_RE = /(^|\.)tesla\.com$/i;

function emailDomain(address) {
  return ((address || '').split('@')[1] || '').toLowerCase();
}

export function isTeslaAddress(address) {
  return TESLA_DOMAIN_RE.test(emailDomain(address));
}

function toPlainText(message) {
  if (message.text && message.text.trim()) return message.text;
  return (message.html || '')
    .replace(/<(br|\/p|\/div|\/tr|\/li)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

const FORWARD_MARKER_RE =
  /-{2,}\s*Forwarded message\s*-{2,}|Begin forwarded message:|-{2,}\s*Original Message\s*-{2,}/i;
const EMAIL_RE = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/;

// Returns { address, via } — via is 'from_header' or 'forwarded_block' —
// or null when no original sender can be identified.
export function detectOriginalSender(message) {
  if (message.from) return { address: message.from.toLowerCase(), via: 'from_header' };
  return null;
}

// Where the message's own From header is not Tesla (the manual-forward
// case), look inside the forwarded block for the original From line.
export function detectForwardedOriginalSender(message) {
  const text = toPlainText(message);
  const marker = text.match(FORWARD_MARKER_RE);
  if (!marker) return null;

  const after = text.slice(marker.index + marker[0].length).split('\n').slice(0, 14);
  for (const line of after) {
    const m = line.match(/^\s*(?:From|De|Von)\s*:\s*(.+)$/i);
    if (!m) continue;
    const addr = m[1].match(EMAIL_RE);
    return addr ? { address: addr[0].toLowerCase(), via: 'forwarded_block' } : null;
  }
  return null;
}

// The single question the classifier asks: does this message identify
// Tesla as its original sender, by either route?
export function findTeslaSender(message) {
  const direct = detectOriginalSender(message);
  if (direct && isTeslaAddress(direct.address)) return direct;
  const forwarded = detectForwardedOriginalSender(message);
  if (forwarded && isTeslaAddress(forwarded.address)) return forwarded;
  return null;
}

// Gmail will not start auto-forwarding to a new address until the address
// confirms a code that Gmail emails to it. That email lands at the rider's
// Cybercab Hunter address, where the rider can't read it, so the code is
// pulled out to be shown to the rider on Rider Data. Only a message that
// really is from Google is honoured, and only the numeric code is kept —
// never a link.
export function detectGmailForwardingConfirmation(message) {
  const domain = emailDomain(message.from);
  if (domain !== 'google.com' && domain !== 'gmail.com') return null;
  if (!/Gmail\s+Forwarding\s+Confirmation/i.test(message.subject || '')) return null;

  const text = toPlainText(message);
  const m = text.match(/confirmation\s+code\s*[:\-]?\s*(\d{6,9})/i) || text.match(/\bcode\s*[:\-]?\s*(\d{6,9})\b/i);
  return m ? { code: m[1] } : null;
}
