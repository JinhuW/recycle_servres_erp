-- The commission is sometimes paid from the company's account rather than by a
-- manager in person. The company is not a user, so it is a flag beside
-- commission_paid_by (0162), and the two never both hold. A bank row linked as
-- the PO's commission also reads as company-paid, but that is read live from
-- bank_transactions, not written here, so an unlink needs no write-back.
ALTER TABLE orders
  ADD COLUMN commission_paid_by_company BOOLEAN NOT NULL DEFAULT FALSE,
  ADD CONSTRAINT orders_commission_paid_by_one
    CHECK (NOT commission_paid_by_company OR commission_paid_by IS NULL);
