-- NOT A MIGRATION, and never run automatically. Run by hand, only with the
-- owner's approval, and only after the Worker without the ownerapi routes is
-- deployed (so nothing can write a new row). Plan: docs/tesla-ride-sync.md.
--
-- robotaxi_owner_connections holds encrypted Tesla ownerapi access/refresh
-- tokens from the removed server-side experiment (Sept-Oct 2026). Tesla's
-- ride-history endpoint refuses these tokens and Tesla documents no third-party
-- use for them, so they serve no purpose. This deletes the rows; the empty
-- table can be dropped by a later migration.

DELETE FROM robotaxi_owner_connections;

-- Check (expect 0):
-- SELECT COUNT(*) AS remaining FROM robotaxi_owner_connections;
