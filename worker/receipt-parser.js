// Raw-MIME-to-structured-message parsing. Uses postal-mime — the parser
// Cloudflare's own Email Workers documentation recommends — because it has
// no Node built-ins and runs in the Workers runtime. This module has no
// Tesla-specific knowledge; it just turns bytes into a normalized message.

import PostalMime from 'postal-mime';

export async function parseRawEmail(raw) {
  const parsed = await PostalMime.parse(raw);
  return {
    from: parsed.from?.address || '',
    to: (parsed.to || []).map(t => t.address).filter(Boolean),
    replyTo: (parsed.replyTo || []).map(t => t.address).filter(Boolean),
    subject: parsed.subject || '',
    messageId: parsed.messageId || null,
    date: parsed.date || null,
    text: parsed.text || '',
    html: parsed.html || '',
    attachments: (parsed.attachments || []).map(a => ({
      filename: a.filename || null,
      mimeType: a.mimeType || '',
      content: a.content // Uint8Array
    }))
  };
}
