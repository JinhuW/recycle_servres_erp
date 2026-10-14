-- The public forms' daily budget was read before the slow part (image
-- decoding, uploads) and counted only rows that had already been stored, so
-- every request in flight saw the same room and a burst at the last slot
-- all got in. A request now reserves its place here, under one advisory
-- lock, before any work, and the budget counts live reservations with the
-- stored rows. A reservation is released when its request settles; one a
-- crash left behind is ignored after ten minutes.
CREATE TABLE public_form_reservations (
  id         BIGSERIAL PRIMARY KEY,
  sender     TEXT,
  bytes      BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX public_form_reservations_created_idx ON public_form_reservations (created_at);
