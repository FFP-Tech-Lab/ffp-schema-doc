import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { MAX_ENUM_VALUES, buildDdl, normalizeEnumValues, parsePgCheckEnum } from '../src/schema-enum';
import { parseSchemaDoc } from '../src/schema-parse';
import { loadIntrospectionSql } from '../scripts/introspection-sql';

const ENUM_SAMPLES = ['Ä', 'z', 'a', '中文', 'pending', '已完成'];

/**
 * Measured on Node 22.14.0, ICU 76.1. Node's Intl default follows LC_ALL
 * even when the OS locale is not installed.
 */
const ENUM_ORDER_BY_LC_ALL: Record<string, string[]> = {
  'C.UTF-8': ['a', 'Ä', 'pending', 'z', '中文', '已完成'],
  'en_US.UTF-8': ['a', 'Ä', 'pending', 'z', '中文', '已完成'],
  'zh_CN.UTF-8': ['已完成', '中文', 'a', 'Ä', 'pending', 'z'],
  'sv_SE.UTF-8': ['a', 'pending', 'z', 'Ä', '中文', '已完成'],
};

const VARCHAR_CHECK =
  "CHECK (((status_code)::text = ANY ((ARRAY['a'::character varying, 'b'::character varying])::text[])))";

describe('known limits', () => {
  it('pins MAX_ENUM_VALUES at 50 and drops the 51st sorted value', () => {
    assert.equal(MAX_ENUM_VALUES, 50);
    const values = Array.from({ length: 51 }, (_, i) => `v${String(i).padStart(2, '0')}`);
    const sorted = [...values].sort((a, b) => a.localeCompare(b));
    const result = normalizeEnumValues(values);
    assert.equal(result.length, 50);
    assert.deepEqual(result, sorted.slice(0, 50));
    const dropped = sorted[50];
    assert.ok(dropped);
    assert.equal(result.includes(dropped), false);
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
    assert.deepEqual(
      normalizeEnumValues(ENUM_SAMPLES),
      [...ENUM_SAMPLES].sort((a, b) => a.localeCompare(b)),
    );
    assert.notDeepEqual(ENUM_ORDER_BY_LC_ALL['zh_CN.UTF-8'], ENUM_ORDER_BY_LC_ALL['en_US.UTF-8']);
    assert.notDeepEqual(ENUM_ORDER_BY_LC_ALL['sv_SE.UTF-8'], ENUM_ORDER_BY_LC_ALL['en_US.UTF-8']);
    const swedish = ENUM_ORDER_BY_LC_ALL['sv_SE.UTF-8'] ?? [];
    const chinese = ENUM_ORDER_BY_LC_ALL['zh_CN.UTF-8'] ?? [];
    assert.ok(swedish.indexOf('Ä') > swedish.indexOf('z'));
    assert.ok(chinese.indexOf('中文') < chinese.indexOf('a'));

    const current = process.env.LC_ALL;
    if (current && Object.hasOwn(ENUM_ORDER_BY_LC_ALL, current)) {
      assert.deepEqual(normalizeEnumValues(ENUM_SAMPLES), ENUM_ORDER_BY_LC_ALL[current]);
    }

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
    assert.deepEqual(
      parsed.values,
      ['organic', 'paid', '推广'].sort((a, b) => a.localeCompare(b)),
    );
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
