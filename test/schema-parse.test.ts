import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { filterValidTables, parseSchemaDoc } from '../src/schema-parse';

describe('parseSchemaDoc', () => {
  it('returns [] for empty or whitespace-only schema', () => {
    assert.deepEqual(parseSchemaDoc(''), []);
    assert.deepEqual(parseSchemaDoc('   \n\t  '), []);
  });

  it('parses multiple CREATE TABLE blocks with column types', () => {
    const tables = parseSchemaDoc(`
CREATE TABLE orders (
  id integer NOT NULL,
  status varchar(32) NOT NULL
);

CREATE TABLE users (
  email text,
  created_at timestamp
);
`);
    assert.deepEqual(tables, [
      {
        name: 'orders',
        columns: [
          { name: 'id', type: 'integer' },
          { name: 'status', type: 'varchar' },
        ],
      },
      {
        name: 'users',
        columns: [
          { name: 'email', type: 'text' },
          { name: 'created_at', type: 'timestamp' },
        ],
      },
    ]);
  });

  it('strips quotes from table names', () => {
    const tables = parseSchemaDoc('CREATE TABLE "campaigns" (\n  id int\n);');
    assert.equal(tables.length, 1);
    assert.equal(tables[0].name, 'campaigns');
    assert.deepEqual(tables[0].columns, [{ name: 'id', type: 'int' }]);
  });

  it('skips constraint-only lines but parses FOREIGN KEY relations', () => {
    const tables = parseSchemaDoc(`
CREATE TABLE orders (
  id integer NOT NULL,
  user_id integer,
  PRIMARY KEY (id),
  UNIQUE (user_id),
  CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id),
  CHECK (id > 0),
  INDEX idx_user (user_id),
  KEY idx_id (id)
);
`);
    assert.deepEqual(
      tables[0].columns.map((c) => c.name),
      ['id', 'user_id'],
    );
    assert.deepEqual(tables[0].outgoingRelations, [
      {
        name: 'fk_user',
        fromTable: 'orders',
        fromColumns: ['user_id'],
        toTable: 'users',
        toColumns: ['id'],
      },
    ]);
  });

  it('parses composite FOREIGN KEY constraints', () => {
    const tables = parseSchemaDoc(`
CREATE TABLE order_items (
  order_id integer,
  line_no integer,
  CONSTRAINT fk_items_order_line FOREIGN KEY (order_id, line_no) REFERENCES order_lines (order_id, line_no)
);
`);
    assert.deepEqual(tables[0].outgoingRelations, [
      {
        name: 'fk_items_order_line',
        fromTable: 'order_items',
        fromColumns: ['order_id', 'line_no'],
        toTable: 'order_lines',
        toColumns: ['order_id', 'line_no'],
      },
    ]);
  });

  it('strips parenthesized length from varchar(255)', () => {
    const tables = parseSchemaDoc(`
CREATE TABLE metrics (
  note varchar(255)
);
`);
    assert.deepEqual(tables[0].columns, [{ name: 'note', type: 'varchar' }]);
  });

  it('strips precision params from numeric(p, s) to type numeric', () => {
    const tables = parseSchemaDoc(`
CREATE TABLE metrics (
  amount numeric(12, 2) NOT NULL,
  note varchar(255)
);
`);
    assert.deepEqual(tables[0].columns, [
      { name: 'amount', type: 'numeric' },
      { name: 'note', type: 'varchar' },
    ]);
  });

  it('strips parenthetical params including commas from type tokens', () => {
    const tables = parseSchemaDoc(`
CREATE TABLE products (
  price numeric(12, 2),
  name varchar(255)
);
`);
    assert.equal(tables.length, 1);
    const price = tables[0].columns.find((c) => c.name === 'price');
    const name = tables[0].columns.find((c) => c.name === 'name');
    assert.equal(price?.type, 'numeric');
    assert.equal(name?.type, 'varchar');
  });

  it('ignores blocks that are not CREATE TABLE', () => {
    assert.deepEqual(
      parseSchemaDoc('-- just a comment\nSELECT 1;\nCREATE INDEX idx ON t(id);'),
      [],
    );
  });
});

describe('filterValidTables', () => {
  const schema = `
CREATE TABLE Orders (
  id integer
);
CREATE TABLE users (
  id integer
);
`;

  it('returns [] when candidates are empty or schema has no tables', () => {
    assert.deepEqual(filterValidTables(schema, []), []);
    assert.deepEqual(filterValidTables('', ['orders']), []);
    assert.deepEqual(filterValidTables('not ddl', ['orders']), []);
  });

  it('keeps candidates that exist in schema, case-insensitively', () => {
    assert.deepEqual(filterValidTables(schema, ['orders', 'USERS', 'missing']), [
      'orders',
      'USERS',
    ]);
  });
});
