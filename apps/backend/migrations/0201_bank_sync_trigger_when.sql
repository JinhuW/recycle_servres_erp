-- The bank sync's upsert sets settle_status on every row it re-fetches, and
-- an UPDATE OF trigger fires whenever the column is written, changed or not.
-- So 0199's trigger re-read the PO of every linked row on every sync, inside
-- the sync's transaction, to find nothing to do. Updates now fire only when
-- the link or the settlement actually moved, as the orders trigger's WHEN
-- already does; inserts and deletes always do. The function is 0199's.
DROP TRIGGER IF EXISTS bank_transactions_sync_accounting_payer ON bank_transactions;
CREATE TRIGGER bank_transactions_sync_accounting_payer
  AFTER INSERT OR DELETE ON bank_transactions
  FOR EACH ROW
  EXECUTE FUNCTION bank_transactions_sync_accounting_payer();

DROP TRIGGER IF EXISTS bank_transactions_sync_accounting_payer_update ON bank_transactions;
CREATE TRIGGER bank_transactions_sync_accounting_payer_update
  AFTER UPDATE OF order_id, link_kind, settle_status ON bank_transactions
  FOR EACH ROW
  WHEN (OLD.order_id IS DISTINCT FROM NEW.order_id
        OR OLD.link_kind IS DISTINCT FROM NEW.link_kind
        OR OLD.settle_status IS DISTINCT FROM NEW.settle_status)
  EXECUTE FUNCTION bank_transactions_sync_accounting_payer();
