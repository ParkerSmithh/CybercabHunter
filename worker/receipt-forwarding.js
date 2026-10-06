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
// confirms the request. That email lands at the rider's Cybercab Hunter
// address, where the rider can't read it, so what they need to confirm is
// pulled out and shown to them on /link-gmail. Gmail's confirmation has
// carried a numeric code, a confirm link, or (since 2026) only the link, so
// both are read. Only a message that claims to be from Google is honoured,
// and only an https link on Google's mail-settings hosts is kept, so a
// spoofed message can never put a link to anywhere else on the page.
//
// Returns null for anything that is not a Gmail forwarding confirmation, and
// otherwise { code, link, requestedBy } where each may be null (both null:
// recognised but unreadable; it is still never treated as a receipt).
const CONFIRM_LINK_HOSTS = new Set(['mail-settings.google.com', 'mail.google.com']);
const URL_RE = /https:\/\/[^\s"'<>]+/gi;

function confirmLink(message) {
  const candidates = [
    ...((message.html || '').match(/href\s*=\s*["']([^"']+)["']/gi) || []).map(h => h.replace(/^href\s*=\s*["']|["']$/gi, '')),
    ...(toPlainText(message).match(URL_RE) || [])
  ];
  for (const raw of candidates) {
    const candidate = raw.replace(/&amp;/gi, '&').replace(/[).,;]+$/, '');
    let url;
    try { url = new URL(candidate); } catch (e) { continue; }
    if (url.protocol === 'https:' && CONFIRM_LINK_HOSTS.has(url.hostname) && /^\/mail\//.test(url.pathname) && candidate.length <= 2048) return url.href;
  }
  return null;
}

export function detectGmailForwardingConfirmation(message) {
  const domain = emailDomain(message.from);
  if (domain !== 'google.com' && domain !== 'gmail.com') return null;
  const subject = message.subject || '';
  if (!/Gmail\s+Forwarding\s+Confirmation/i.test(subject)) return null;

  const text = toPlainText(message);
  const m = text.match(/confirmation\s+code\s*[:\-]?\s*(\d{6,9})/i) || text.match(/\bcode\s*[:\-]?\s*(\d{6,9})\b/i) || subject.match(/\(#(\d{6,9})\)/);
  const from = subject.match(/Receive\s+Mail\s+from\s+(\S+@[^\s)]+)/i);
  return {
    code: m ? m[1] : null,
    link: confirmLink(message),
    requestedBy: from ? from[1].toLowerCase().slice(0, 254) : null
  };
}
