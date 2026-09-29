import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_ENUM_VALUES,
  buildCheckEnumMap,
  buildDdl,
  buildNativeEnumMap,
  columnEnumKey,
  formatEnumComment,
  mergeEnumMaps,
  normalizeEnumValues,
  parseMysqlEnumType,
  parsePgCheckEnum,
} from '../src/schema-enum';
import { parseSchemaDoc } from '../src/schema-parse';

describe('normalizeEnumValues', () => {
  it('dedupes, sorts, and caps at MAX_ENUM_VALUES', () => {
    const values = Array.from({ length: MAX_ENUM_VALUES + 5 }, (_, i) =>
      String(MAX_ENUM_VALUES + 5 - i),
    );
    values.push('3', ' 2 ');
    const result = normalizeEnumValues(values);
    assert.equal(result.length, MAX_ENUM_VALUES);
    assert.deepEqual(result.slice(0, 3), ['1', '10', '11']);
  });
});

describe('formatEnumComment', () => {
  it('formats sorted pipe-separated comment', () => {
    assert.equal(
      formatEnumComment(['pending', 'completed']),
      '  -- enum: completed | pending',
    );
  });

  it('returns empty string for no values', () => {
    assert.equal(formatEnumComment([]), '');
  });
});

describe('parsePgCheckEnum', () => {
  it('parses CHECK (... IN (...))', () => {
    const parsed = parsePgCheckEnum(
      "CHECK (status IN ('completed', 'pending', 'cancelled'))",
    );
    assert.deepEqual(parsed, {
      column: 'status',
      values: ['cancelled', 'completed', 'pending'],
    });
  });

  it('parses CHECK (... = ANY (ARRAY[...]))', () => {
    const parsed = parsePgCheckEnum(
      "CHECK (((channel)::text = ANY (ARRAY['organic'::text, 'paid'::text, 'referral'::text])))",
    );
    assert.ok(parsed);
    assert.equal(parsed!.column, 'channel');
    assert.deepEqual(parsed!.values, ['organic', 'paid', 'referral']);
  });

  it('returns null for unrecognized constraints', () => {
    assert.equal(parsePgCheckEnum('CHECK (amount > 0)'), null);
  });
});

describe('parseMysqlEnumType', () => {
  it('parses enum column type', () => {
    assert.deepEqual(parseMysqlEnumType("enum('a','c','b')"), ['a', 'b', 'c']);
  });

  it('returns empty for non-enum types', () => {
    assert.deepEqual(parseMysqlEnumType('varchar(50)'), []);
  });
});

describe('buildDdl', () => {
  it('appends enum comments for mapped columns', () => {
    const ddl = buildDdl(
      [
        {
          table_name: 'orders',
          column_name: 'id',
          data_type: 'integer',
          is_nullable: 'NO',
        },
        {
          table_name: 'orders',
          column_name: 'status',
          data_type: 'USER-DEFINED',
          is_nullable: 'NO',
        },
      ],
      new Map([
        [columnEnumKey('orders', 'status'), ['completed', 'pending']],
      ]),
    );

    assert.match(
      ddl,
      /status USER-DEFINED NOT NULL {2}-- enum: completed \| pending/,
    );
    assert.match(ddl, /id integer NOT NULL,/);
  });

  it('appends single-column FOREIGN KEY constraints', () => {
    const ddl = buildDdl(
      [
        {
          table_name: 'orders',
          column_name: 'id',
          data_type: 'integer',
          is_nullable: 'NO',
        },
        {
          table_name: 'orders',
          column_name: 'user_id',
          data_type: 'integer',
          is_nullable: 'YES',
        },
        {
          table_name: 'users',
          column_name: 'id',
          data_type: 'integer',
          is_nullable: 'NO',
        },
      ],
      undefined,
      [
        {
          constraint_name: 'fk_orders_user',
          from_table: 'orders',
          from_column: 'user_id',
          to_table: 'users',
          to_column: 'id',
          ordinal_position: 1,
        },
      ],
    );

    assert.match(
      ddl,
      /CONSTRAINT fk_orders_user FOREIGN KEY \(user_id\) REFERENCES users \(id\)/,
    );
  });

  it('groups composite FOREIGN KEY columns by ordinal_position', () => {
    const ddl = buildDdl(
      [
        {
          table_name: 'order_items',
          column_name: 'order_id',
          data_type: 'integer',
          is_nullable: 'NO',
        },
        {
          table_name: 'order_items',
          column_name: 'line_no',
          data_type: 'integer',
          is_nullable: 'NO',
        },
      ],
      undefined,
      [
        {
          constraint_name: 'fk_items_order_line',
          from_table: 'order_items',
          from_column: 'line_no',
          to_table: 'order_lines',
          to_column: 'line_no',
          ordinal_position: 2,
        },
        {
          constraint_name: 'fk_items_order_line',
          from_table: 'order_items',
          from_column: 'order_id',
          to_table: 'order_lines',
          to_column: 'order_id',
          ordinal_position: 1,
        },
      ],
    );

    assert.match(
      ddl,
      /CONSTRAINT fk_items_order_line FOREIGN KEY \(order_id, line_no\) REFERENCES order_lines \(order_id, line_no\)/,
    );
  });
});

describe('buildNativeEnumMap / buildCheckEnumMap / mergeEnumMaps', () => {
  it('maps native enums by udt_name', () => {
    const map = buildNativeEnumMap(
      [
        {
          table_name: 'orders',
          column_name: 'status',
          udt_name: 'order_status',
        },
      ],
      [
        { typname: 'order_status', enumlabel: 'pending' },
        { typname: 'order_status', enumlabel: 'completed' },
      ],
    );
    assert.deepEqual(map.get('orders.status'), ['completed', 'pending']);
  });

  it('maps check enums and prefers native on merge', () => {
    const native = buildNativeEnumMap(
      [{ table_name: 'orders', column_name: 'status', udt_name: 'order_status' }],
      [{ typname: 'order_status', enumlabel: 'completed' }],
    );
    const check = buildCheckEnumMap([
      {
        table_name: 'orders',
        check_def: "CHECK (status IN ('completed', 'shipped'))",
      },
    ]);
    const merged = mergeEnumMaps(native, check);
    assert.deepEqual(merged.get('orders.status'), ['completed', 'shipped']);
  });
});

describe('parseSchemaDoc enumValues', () => {
  it('parses -- enum comments into enumValues', () => {
    const tables = parseSchemaDoc(`
CREATE TABLE orders (
  id integer NOT NULL,
  status order_status NOT NULL  -- enum: cancelled | completed | pending
);
`);
    assert.equal(tables.length, 1);
    const status = tables[0].columns.find((c) => c.name === 'status');
    assert.ok(status);
    assert.deepEqual(status!.enumValues, [
      'cancelled',
      'completed',
      'pending',
    ]);
    const id = tables[0].columns.find((c) => c.name === 'id');
    assert.equal(id?.enumValues, undefined);
  });
});
