import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { buildDdl, normalizeEnumValues } from '../src/schema-enum';
import { parseSchemaDoc } from '../src/schema-parse';
import { loadIntrospectionSql } from '../scripts/introspection-sql';

describe('known limits', () => {
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

  it('sorts enum values with localeCompare (depends on ICU)', () => {
    assert.match(
      readFileSync('src/schema-enum.ts', 'utf8'),
      /out\.sort\(\(a, b\) => a\.localeCompare\(b\)\)/,
    );
    assert.deepEqual(normalizeEnumValues(['Z', 'a', 'Ä', '中文', 'b']), [
      'a',
      'Ä',
      'b',
      'Z',
      '中文',
    ]);
    assert.equal(
      normalizeEnumValues(['Z', 'a', 'Ä', '中文', 'b']).join('|'),
      ['Z', 'a', 'Ä', '中文', 'b'].sort((a, b) => a.localeCompare(b)).join('|'),
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
