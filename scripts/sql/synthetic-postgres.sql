-- Synthetic Postgres schema for ffp-schema-doc golden capture.
-- No real user data. Not the ai-bi benchmark seed.
--
-- Native enum (CJK label), CHECK enums, a view, a mixed-case table name,
-- and a foreign key in public (the frozen introspection SQL only reads public).
--
-- channel is text, and chk_status casts the enum to text, so PostgreSQL 16
-- pg_get_constraintdef emits `= ANY (ARRAY[...])`. That is the form
-- parsePgCheckEnum accepts. A varchar CHECK is rewritten to
-- `ANY ((ARRAY[...])::text[])`, which that regex does not recognize.

CREATE TYPE order_status AS ENUM ('pending', '已完成', 'cancelled');

CREATE TABLE regions (
  id integer PRIMARY KEY,
  name text NOT NULL
);

CREATE TABLE "Orders" (
  id integer PRIMARY KEY,
  region_id integer REFERENCES regions (id),
  status order_status NOT NULL,
  channel text NOT NULL,
  CONSTRAINT chk_status CHECK ((status)::text IN ('pending', '已完成', 'shipped')),
  CONSTRAINT chk_channel CHECK (channel IN ('organic', 'paid', '推广'))
);

CREATE VIEW order_status_view AS
  SELECT id, status FROM "Orders";
