-- Drops robotaxi_owner_connections (migrations/0004): the server-side Tesla
-- ownerapi experiment's token table. Its routes were removed in Nov 2026
-- (docs/tesla-ride-sync.md) and production held 0 rows when checked
-- (Nov 6, 2026). Nothing reads or writes it any more.
--
-- ORDER: deploy the Worker WITHOUT worker/account.js's delete from this table
-- FIRST, then apply this migration. The reverse order would make account
-- deletion fail (its one D1 transaction would name a missing table).
--
-- No other table references it. tesla_connections (the Fleet API link) and
-- tesla_ride_sync_connections are untouched.
DROP INDEX IF EXISTS idx_robotaxi_owner_connections_user;
DROP TABLE IF EXISTS robotaxi_owner_connections;
