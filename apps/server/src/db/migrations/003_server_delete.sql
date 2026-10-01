-- Deleting a server (spec 2026-10-01-sair-e-excluir-servidor-design.md §3). Never edit after merge.
-- deleting_at: the deadline (ms epoch, the server's clock) set by server.delete; NULL when the
--   server is not being deleted. server.restore clears it before the deadline.
-- deleted_at: when the data was erased, once the deadline passed. Never cleared: the server
--   refuses everyone from then on, whatever the clock says.
ALTER TABLE server_meta ADD COLUMN deleting_at INTEGER;
ALTER TABLE server_meta ADD COLUMN deleted_at INTEGER;
