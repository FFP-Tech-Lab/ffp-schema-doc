import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { buildMysqlSchemaDoc, buildPostgresSchemaDoc } from '../src/introspect';
import {
  MAX_ENUM_VALUES,
  buildDdl,
  normalizeEnumValues,
  parseMysqlEnumType,
  parsePgCheckEnum,
} from '../src/schema-enum';
import { mapPgForeignKeyRows } from '../src/schema-fk';
import { parseSchemaDoc } from '../src/schema-parse';
import { loadIntrospectionSql } from '../scripts/introspection-sql';

const ENUM_SAMPLES = ['Ä', 'z', 'a', '中文', 'pending', '已完成', 'A', 'Z', 'aa', 'å', 'ä'];

/**
 * Measured on Node v22.14.0, ICU 76.1, by running normalizeEnumValues under
 * each LC_ALL. These arrays are literals. The test does not sort them again.
 */
const ENUM_ORDER_BY_LC_ALL: Record<string, readonly string[]> = {
  'C.UTF-8': ['a', 'A', 'å', 'ä', 'Ä', 'aa', 'pending', 'z', 'Z', '中文', '已完成'],
  'en_US.UTF-8': ['a', 'A', 'å', 'ä', 'Ä', 'aa', 'pending', 'z', 'Z', '中文', '已完成'],
  'zh_CN.UTF-8': ['已完成', '中文', 'a', 'A', 'å', 'ä', 'Ä', 'aa', 'pending', 'z', 'Z'],
  'sv_SE.UTF-8': ['a', 'A', 'aa', 'pending', 'z', 'Z', 'å', 'ä', 'Ä', '中文', '已完成'],
};

const CHANNEL_ORDER_BY_LC_ALL: Record<string, readonly string[]> = {
  'C.UTF-8': ['organic', 'paid', '推广'],
  'en_US.UTF-8': ['organic', 'paid', '推广'],
  'zh_CN.UTF-8': ['推广', 'organic', 'paid'],
  'sv_SE.UTF-8': ['organic', 'paid', '推广'],
};

const VARCHAR_CHECK =
  "CHECK (((status_code)::text = ANY ((ARRAY['a'::character varying, 'b'::character varying])::text[])))";

describe('known limits', () => {
  it('pins MAX_ENUM_VALUES at 50 and drops the 51st sorted value', () => {
    assert.equal(MAX_ENUM_VALUES, 50);
    const values = Array.from({ length: 51 }, (_, i) => `v${String(i).padStart(2, '0')}`);
    const result = normalizeEnumValues(values);
    assert.equal(result.length, 50);
    assert.deepEqual(result, values.slice(0, 50));
    assert.equal(result.includes('v50'), false);
  });

  it('drops CJK table names that are not ASCII word characters', () => {
    const ddl = buildDdl([
      {
        table_name: '订单',
        column_name: 'id',
        data_type: 'int',
        is_nullable: 'NO',
      },
    ]);
    assert.match(ddl, /CREATE TABLE 订单 \(/);
    assert.deepEqual(parseSchemaDoc(ddl), []);
  });

  it('emits every relation as CREATE TABLE, including views', () => {
    const ddl = buildDdl([
      {
        table_name: 'order_status_view',
        column_name: 'id',
        data_type: 'int',
        is_nullable: 'NO',
      },
    ]);
    assert.match(ddl, /^CREATE TABLE order_status_view \(/);
    assert.doesNotMatch(ddl, /CREATE VIEW/);
    assert.equal(parseSchemaDoc(ddl)[0]?.name, 'order_status_view');
  });

  it('sorts enum values with localeCompare, pinned per LC_ALL', () => {
    assert.match(
      readFileSync('src/schema-enum.ts', 'utf8'),
      /out\.sort\(\(a, b\) => a\.localeCompare\(b\)\)/,
    );
    assert.notDeepEqual(ENUM_ORDER_BY_LC_ALL['zh_CN.UTF-8'], ENUM_ORDER_BY_LC_ALL['en_US.UTF-8']);
    assert.notDeepEqual(ENUM_ORDER_BY_LC_ALL['sv_SE.UTF-8'], ENUM_ORDER_BY_LC_ALL['en_US.UTF-8']);
    const swedish = ENUM_ORDER_BY_LC_ALL['sv_SE.UTF-8'] ?? [];
    const chinese = ENUM_ORDER_BY_LC_ALL['zh_CN.UTF-8'] ?? [];
    assert.ok(swedish.indexOf('Ä') > swedish.indexOf('z'));
    assert.ok(chinese.indexOf('中文') < chinese.indexOf('a'));

    const current = process.env.LC_ALL ?? '';
    const currentOrder = ENUM_ORDER_BY_LC_ALL[current];
    assert.ok(currentOrder, `LC_ALL ${JSON.stringify(current)} has no pinned enum order`);
    assert.deepEqual(normalizeEnumValues(ENUM_SAMPLES), currentOrder);

    for (const [lcAll, expected] of Object.entries(ENUM_ORDER_BY_LC_ALL)) {
      const child = spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          '-e',
          `const { normalizeEnumValues } = require('./src/schema-enum.ts');
           const samples = ${JSON.stringify(ENUM_SAMPLES)};
           process.stdout.write(JSON.stringify({
             locale: Intl.DateTimeFormat().resolvedOptions().locale,
             values: normalizeEnumValues(samples),
           }));`,
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, LC_ALL: lcAll },
        },
      );
      assert.equal(child.status, 0, `${lcAll}\n${child.stderr}`);
      const parsed = JSON.parse(child.stdout) as { locale: string; values: string[] };
      assert.deepEqual(parsed.values, expected, lcAll);
      if (lcAll === 'zh_CN.UTF-8') {
        assert.equal(parsed.locale, 'zh-CN');
      } else if (lcAll === 'sv_SE.UTF-8') {
        assert.equal(parsed.locale, 'sv-SE');
      } else {
        assert.equal(parsed.locale, 'en-US');
      }
    }
  });

  it('returns null for the captured varchar CHECK and keeps the text CHECK', () => {
    const checks = JSON.parse(
      readFileSync('test/golden/synthetic-postgres/checks.json', 'utf8'),
    ) as Array<{ check_def: string }>;
    const varcharCheck = checks.find((row) => row.check_def === VARCHAR_CHECK);
    assert.ok(varcharCheck);
    assert.equal(parsePgCheckEnum(varcharCheck.check_def), null);

    const textCheck = checks.find((row) => row.check_def.includes("ARRAY['organic'::text"));
    assert.ok(textCheck);
    assert.match(textCheck.check_def, /= ANY \(ARRAY\[/);
    assert.doesNotMatch(textCheck.check_def, /character varying/);
    const parsed = parsePgCheckEnum(textCheck.check_def);
    assert.ok(parsed);
    assert.equal(parsed.column, 'channel');
    const channelOrder = CHANNEL_ORDER_BY_LC_ALL[process.env.LC_ALL ?? ''];
    assert.ok(channelOrder, `LC_ALL ${JSON.stringify(process.env.LC_ALL ?? '')} has no pinned channel order`);
    assert.deepEqual(parsed.values, channelOrder);
  });

  it('truncates an enum value that contains a comma', () => {
    const ddl = buildDdl(
      [
        {
          table_name: 't',
          column_name: 'status',
          data_type: 'text',
          is_nullable: 'YES',
        },
        {
          table_name: 't',
          column_name: 'id',
          data_type: 'int',
          is_nullable: 'NO',
        },
      ],
      new Map([['t.status', ['w', 'x,y', '(z)']]]),
    );
    assert.equal(
      ddl,
      'CREATE TABLE t (\n  status text  -- enum: (z) | w | x,y,\n  id int NOT NULL\n);',
    );
    const parsed = parseSchemaDoc(ddl);
    assert.deepEqual(parsed[0]?.columns.find((column) => column.name === 'status')?.enumValues, [
      '(z)',
      'w',
      'x',
    ]);
    assert.equal(
      parsed[0]?.columns.some((column) => column.enumValues?.includes('x,y')),
      false,
    );
  });

  it('splits a comma inside an enum value and does not invent a column', () => {
    const ddl = buildDdl(
      [
        {
          table_name: 't',
          column_name: 'status',
          data_type: 'text',
          is_nullable: 'YES',
        },
        {
          table_name: 't',
          column_name: 'id',
          data_type: 'int',
          is_nullable: 'NO',
        },
      ],
      new Map([['t.status', ['Washington, DC', 'NY']]]),
    );
    assert.equal(
      ddl,
      'CREATE TABLE t (\n  status text  -- enum: NY | Washington, DC,\n  id int NOT NULL\n);',
    );
    const parsed = parseSchemaDoc(ddl);
    assert.deepEqual(
      parsed[0]?.columns.map((column) => column.name),
      ['status', 'id'],
    );
    assert.deepEqual(parsed[0]?.columns.find((column) => column.name === 'status')?.enumValues, [
      'NY',
      'Washington',
    ]);
  });

  it('drops columns after an unclosed parenthesis in an enum value', () => {
    const ddl = buildDdl(
      [
        {
          table_name: 't',
          column_name: 'status',
          data_type: 'text',
          is_nullable: 'YES',
        },
        {
          table_name: 't',
          column_name: 'id',
          data_type: 'int',
          is_nullable: 'NO',
        },
        {
          table_name: 't',
          column_name: 'note',
          data_type: 'text',
          is_nullable: 'YES',
        },
      ],
      new Map([['t.status', ['a (b', 'c']]]),
    );
    assert.equal(
      ddl,
      'CREATE TABLE t (\n  status text  -- enum: a (b | c,\n  id int NOT NULL,\n  note text\n);',
    );
    assert.deepEqual(parseSchemaDoc(ddl), [
      {
        name: 't',
        columns: [{ name: 'status', type: 'text' }],
      },
    ]);
  });

  it('splits an enum value on a pipe character', () => {
    const ddl = buildDdl(
      [
        {
          table_name: 't',
          column_name: 'status',
          data_type: 'text',
          is_nullable: 'YES',
        },
      ],
      new Map([['t.status', ['a|b', 'c']]]),
    );
    assert.equal(ddl, 'CREATE TABLE t (\n  status text  -- enum: a|b | c\n);');
    assert.deepEqual(parseSchemaDoc(ddl)[0]?.columns[0]?.enumValues, ['a', 'b', 'c']);
  });

  it('parses a MySQL doubled quote as three enum values', () => {
    assert.deepEqual(parseMysqlEnumType("enum('it''s','b')"), ['b', 'it', 's']);
    const built = buildMysqlSchemaDoc(
      [
        {
          table_name: 't',
          column_name: 'status',
          data_type: 'enum',
          is_nullable: 'YES',
          column_type: "enum('it''s','b')",
        },
      ],
      [],
    );
    assert.equal(built.schemaDoc, 'CREATE TABLE t (\n  status enum  -- enum: b | it | s\n);');
    assert.deepEqual(parseSchemaDoc(built.schemaDoc)[0]?.columns[0]?.enumValues, ['b', 'it', 's']);
  });

  it('drops a CJK column name', () => {
    const ddl = buildDdl([
      {
        table_name: 't',
        column_name: '名称',
        data_type: 'text',
        is_nullable: 'YES',
      },
      {
        table_name: 't',
        column_name: 'id',
        data_type: 'int',
        is_nullable: 'NO',
      },
    ]);
    assert.equal(ddl, 'CREATE TABLE t (\n  名称 text,\n  id int NOT NULL\n);');
    assert.deepEqual(parseSchemaDoc(ddl)[0]?.columns, [{ name: 'id', type: 'int' }]);
  });

  it('stops an identifier at the first character outside \\w', () => {
    const hyphen = buildDdl([
      {
        table_name: 'order-items',
        column_name: 'id',
        data_type: 'int',
        is_nullable: 'NO',
      },
    ]);
    assert.equal(parseSchemaDoc(hyphen)[0]?.name, 'order');

    const spaced = buildDdl([
      {
        table_name: 'order items',
        column_name: 'id',
        data_type: 'int',
        is_nullable: 'NO',
      },
    ]);
    assert.equal(parseSchemaDoc(spaced)[0]?.name, 'order');

    const dollar = buildDdl([
      {
        table_name: 'order$items',
        column_name: 'id',
        data_type: 'int',
        is_nullable: 'NO',
      },
    ]);
    assert.equal(parseSchemaDoc(dollar)[0]?.name, 'order');

    const leadingDollar = buildDdl([
      {
        table_name: '$id',
        column_name: 'id',
        data_type: 'int',
        is_nullable: 'NO',
      },
    ]);
    assert.deepEqual(parseSchemaDoc(leadingDollar), []);

    const fullName = buildDdl([
      {
        table_name: 't',
        column_name: 'full name',
        data_type: 'int',
        is_nullable: 'NO',
      },
      {
        table_name: 't',
        column_name: 'id',
        data_type: 'int',
        is_nullable: 'NO',
      },
    ]);
    assert.deepEqual(parseSchemaDoc(fullName)[0]?.columns, [
      { name: 'full', type: 'name' },
      { name: 'id', type: 'int' },
    ]);

    const amount = buildDdl([
      {
        table_name: 't',
        column_name: '$amount',
        data_type: 'int',
        is_nullable: 'NO',
      },
      {
        table_name: 't',
        column_name: 'id',
        data_type: 'int',
        is_nullable: 'NO',
      },
    ]);
    assert.deepEqual(parseSchemaDoc(amount)[0]?.columns, [{ name: 'id', type: 'int' }]);

    const unitPrice = buildDdl([
      {
        table_name: 't',
        column_name: 'unit-price',
        data_type: 'int',
        is_nullable: 'NO',
      },
      {
        table_name: 't',
        column_name: 'id',
        data_type: 'int',
        is_nullable: 'NO',
      },
    ]);
    assert.deepEqual(parseSchemaDoc(unitPrice)[0]?.columns, [{ name: 'id', type: 'int' }]);
  });

  it('stores character varying as type character', () => {
    const ddl = buildDdl([
      {
        table_name: 't',
        column_name: 'status',
        data_type: 'character varying',
        is_nullable: 'YES',
      },
    ]);
    assert.equal(ddl, 'CREATE TABLE t (\n  status character varying\n);');
    assert.deepEqual(parseSchemaDoc(ddl), [
      {
        name: 't',
        columns: [{ name: 'status', type: 'character' }],
      },
    ]);
  });

  it('maps ordinal 0 to 1 and keeps a numeric string', () => {
    const rows = mapPgForeignKeyRows([
      {
        constraint_name: 'fk',
        from_table: 'c',
        from_column: 'a',
        to_table: 'p',
        to_column: 'id',
        ordinal_position: '2' as unknown as number,
      },
      {
        constraint_name: 'fk',
        from_table: 'c',
        from_column: 'b',
        to_table: 'p',
        to_column: 'id',
        ordinal_position: 0,
      },
    ]);
    assert.equal(rows[0]?.ordinal_position, 2);
    assert.equal(rows[1]?.ordinal_position, 1);
    const ddl = buildDdl(
      [
        {
          table_name: 'c',
          column_name: 'a',
          data_type: 'int',
          is_nullable: 'NO',
        },
        {
          table_name: 'c',
          column_name: 'b',
          data_type: 'int',
          is_nullable: 'NO',
        },
      ],
      undefined,
      rows,
    );
    assert.equal(
      ddl,
      'CREATE TABLE c (\n  a int NOT NULL,\n  b int NOT NULL,\n  CONSTRAINT fk FOREIGN KEY (b, a) REFERENCES p (id, id)\n);',
    );
  });

  it('renders a non-public table name and an unqualified foreign key', () => {
    const built = buildPostgresSchemaDoc(
      [
        {
          table_name: 'secret_accounts',
          column_name: 'region_id',
          data_type: 'int',
          is_nullable: 'YES',
          udt_name: 'int4',
        },
      ],
      [],
      [],
      [
        {
          constraint_name: 'fk_region',
          from_table: 'secret_accounts',
          from_column: 'region_id',
          to_table: 'regions',
          to_column: 'id',
          ordinal_position: 1,
        },
      ],
    );
    assert.equal(
      built.schemaDoc,
      'CREATE TABLE secret_accounts (\n  region_id int,\n  CONSTRAINT fk_region FOREIGN KEY (region_id) REFERENCES regions (id)\n);',
    );
    assert.equal(built.tableCount, 1);
    assert.doesNotMatch(built.schemaDoc, /REFERENCES public\./);
  });

  it('pins the PostgreSQL column query to schema public', () => {
    const columnsSql = loadIntrospectionSql()['pg.columns'];
    assert.match(columnsSql, /table_schema = 'public'/);
    assert.doesNotMatch(columnsSql, /\$1|TABLE_SCHEMA = \?/);
  });

  it('pins the foreign-key query to an unqualified referenced table', () => {
    const fkSql = loadIntrospectionSql()['pg.foreignKeys'];
    assert.match(fkSql, /nsp\.nspname = 'public'/);
    assert.match(fkSql, /JOIN pg_class rel_to ON rel_to\.oid = con\.confrelid/);
    const afterReferenced = fkSql.split('JOIN pg_class rel_to')[1] ?? '';
    assert.doesNotMatch(afterReferenced, /nspname/);
  });
});
