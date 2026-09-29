-- Synthetic schema for ffp-schema-doc MySQL goldens.
-- No real user data. Created for introspection capture only.
-- Features: native ENUM (including CJK values), CHECK-based enum,
-- composite foreign key, a view, mixed-case identifiers, a CJK table name.

CREATE DATABASE IF NOT EXISTS ffp_schema_doc_capture_mysql
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE ffp_schema_doc_capture_mysql;

CREATE TABLE regions (
  id INT NOT NULL,
  name VARCHAR(100) NOT NULL,
  PRIMARY KEY (id)
);

CREATE TABLE Orders (
  id INT NOT NULL,
  region_id INT NULL,
  status ENUM('pending', '已完成', 'cancelled') NOT NULL,
  channel VARCHAR(32) NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT fk_orders_region FOREIGN KEY (region_id) REFERENCES regions (id),
  CONSTRAINT chk_channel CHECK (channel IN ('organic', 'paid'))
);

CREATE TABLE OrderLines (
  order_id INT NOT NULL,
  line_no INT NOT NULL,
  note VARCHAR(50) NULL,
  PRIMARY KEY (order_id, line_no)
);

CREATE TABLE order_items (
  order_id INT NOT NULL,
  line_no INT NOT NULL,
  qty INT NOT NULL,
  PRIMARY KEY (order_id, line_no),
  CONSTRAINT fk_items_order_line FOREIGN KEY (order_id, line_no)
    REFERENCES OrderLines (order_id, line_no)
);

CREATE TABLE 订单 (
  id INT NOT NULL,
  state ENUM('待支付', '已完成') NOT NULL,
  PRIMARY KEY (id)
);

CREATE VIEW order_status_view AS
  SELECT id, status FROM Orders;
