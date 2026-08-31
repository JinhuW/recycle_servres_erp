-- Which buying channel the box came from, answered once when the package is
-- added. Nullable because rows that predate this column have no answer and
-- inventing one would be a lie — "required" is enforced at the API boundary
-- and in the add form, not by NOT NULL.
-- (Mirrors PACKAGE_SOURCES in packages/shared/src/packageSource.ts — extend
-- both together.)
ALTER TABLE packages ADD COLUMN source TEXT
  CHECK (source IN ('facebook','local','reddit','other'));
