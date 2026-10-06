-- Cybercab Hunter — keep Gmail's forwarding-confirmation LINK, not just a code.
--
-- Gmail's confirmation email (2026) carries a confirm link and no numeric
-- code, so the code-only reader stored nothing and the rider was left with
-- nothing to confirm (bug 2026-10-05). The link is shown to the signed-in
-- owner of the address on /link-gmail, next to the Gmail account that asked
-- to forward, so they can confirm it is their own. Only https links on
-- Google's mail-settings hosts are ever stored (receipt-forwarding.js).
--
-- Like forwarding_code, both are cleared when the next receipt arrives and
-- when the address is replaced; forwarding_code_received_at dates either.

ALTER TABLE receipt_ingestion_addresses ADD COLUMN forwarding_link TEXT;
ALTER TABLE receipt_ingestion_addresses ADD COLUMN forwarding_requested_by TEXT;
