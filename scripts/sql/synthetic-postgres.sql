-- Synthetic Postgres schema for ffp-schema-doc golden capture.
-- No real user data. Separate from the sample schema under scripts/seed.
--
-- Covers: native enum (CJK label), CHECK enum on text (the form
-- parsePgCheckEnum accepts), CHECK enum on varchar (the form it rejects),
-- composite foreign key, a view, mixed-case names, a CJK table name,
-- and CJK enum values.
--
-- public only: the frozen introspection SQL reads public.
--
-- channel is text, so pg_get_constraintdef emits
-- `= ANY (ARRAY['organic'::text, ...])`. parsePgCheckEnum matches that.
-- status_code is varchar. PostgreSQL 16 prints
-- `ANY ((ARRAY['a'::character varying, ...])::text[])`, and parsePgCheckEnum
-- returns null for that text.

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
  status_code character varying(16) NOT NULL,
  CONSTRAINT chk_status CHECK ((status)::text IN ('pending', '已完成', 'shipped')),
  CONSTRAINT chk_channel CHECK (channel IN ('organic', 'paid', '推广')),
  CONSTRAINT chk_status_code CHECK (status_code IN ('a', 'b'))
);

CREATE TABLE "OrderLines" (
  order_id integer NOT NULL,
  line_no integer NOT NULL,
  PRIMARY KEY (order_id, line_no)
);

CREATE TABLE order_items (
  order_id integer NOT NULL,
  line_no integer NOT NULL,
  qty integer NOT NULL,
  PRIMARY KEY (order_id, line_no),
  CONSTRAINT fk_items_order_line FOREIGN KEY (order_id, line_no)
    REFERENCES "OrderLines" (order_id, line_no)
);

CREATE TABLE "订单" (
  id integer PRIMARY KEY,
  note text
);

CREATE VIEW order_status_view AS
  SELECT id, status FROM "Orders";
