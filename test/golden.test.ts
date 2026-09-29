import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { buildMysqlSchemaDoc, buildPostgresSchemaDoc } from '../src/introspect';
import { parseSchemaDoc } from '../src/schema-parse';
import {
  buildCheckEnumMap,
  buildDdl,
  buildNativeEnumMap,
  mergeEnumMaps,
  type SchemaColumnRow,
} from '../src/schema-enum';
import type { MysqlForeignKeyQueryRow, PgForeignKeyQueryRow } from '../src/schema-fk';
import type {
  MysqlColumnQueryRow,
  PgCheckQueryRow,
  PgColumnQueryRow,
  PgNativeEnumQueryRow,
} from '../src/introspect';
import {
  introspectionSqlSha256,
  loadIntrospectionSql,
} from '../scripts/introspection-sql';

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

function readText(file: string): string {
  return readFileSync(file, 'utf8').replace(/\n$/, '');
}

const pgDir = path.join('test', 'golden', 'benchmark-postgres');
const mysqlDir = path.join('test', 'golden', 'synthetic-mysql');

describe('benchmark postgres golden', () => {
  const columns = readJson<PgColumnQueryRow[]>(path.join(pgDir, 'columns.json'));
  const nativeEnums = readJson<PgNativeEnumQueryRow[]>(path.join(pgDir, 'native-enums.json'));
  const checks = readJson<PgCheckQueryRow[]>(path.join(pgDir, 'checks.json'));
  const foreignKeys = readJson<PgForeignKeyQueryRow[]>(path.join(pgDir, 'foreign-keys.json'));
  const metadata = readJson<{
    capture: string;
    introspectionSqlSha256: Record<string, string>;
    tableCount: number;
  }>(path.join(pgDir, 'metadata.json'));

  it('was captured from the benchmark seed database', () => {
    assert.equal(metadata.capture, 'db-captured');
  });

  it('matches setup.ts buildDdl with no foreign keys', () => {
    const typedRows: SchemaColumnRow[] = columns.map((row) => ({
      table_name: row.table_name,
      column_name: row.column_name,
      data_type: row.data_type,
      is_nullable: row.is_nullable,
    }));
    const schemaDoc = buildDdl(
      typedRows,
      mergeEnumMaps(buildNativeEnumMap(columns, nativeEnums), buildCheckEnumMap(checks)),
    );
    assert.equal(schemaDoc, readText(path.join(pgDir, 'schema-doc.txt')));
    assert.doesNotMatch(schemaDoc, /FOREIGN KEY/);
    assert.deepEqual(parseSchemaDoc(schemaDoc), readJson(path.join(pgDir, 'parsed-tables.json')));
  });

  it('matches DataSourceService post-processing including foreign keys', () => {
    const built = buildPostgresSchemaDoc(columns, nativeEnums, checks, foreignKeys);
    assert.equal(built.schemaDoc, readText(path.join(pgDir, 'schema-doc-with-fks.txt')));
    assert.equal(built.tableCount, metadata.tableCount);
    assert.match(built.schemaDoc, /FOREIGN KEY/);
    assert.deepEqual(
      parseSchemaDoc(built.schemaDoc),
      readJson(path.join(pgDir, 'parsed-tables-with-fks.json')),
    );
  });

  it('records sha256 of each introspection SQL string', () => {
    assert.deepEqual(metadata.introspectionSqlSha256, introspectionSqlSha256(loadIntrospectionSql()));
  });
});

describe('synthetic mysql golden', () => {
  const columns = readJson<MysqlColumnQueryRow[]>(path.join(mysqlDir, 'columns.json'));
  const foreignKeys = readJson<MysqlForeignKeyQueryRow[]>(path.join(mysqlDir, 'foreign-keys.json'));
  const metadata = readJson<{
    capture: string;
    introspectionSqlSha256: Record<string, string>;
    tableCount: number;
  }>(path.join(mysqlDir, 'metadata.json'));

  it('was captured from the synthetic database', () => {
    assert.equal(metadata.capture, 'db-captured');
  });

  it('matches MySQL post-processing', () => {
    const built = buildMysqlSchemaDoc(columns, foreignKeys);
    const schemaDoc = readText(path.join(mysqlDir, 'schema-doc.txt'));
    assert.equal(built.schemaDoc, schemaDoc);
    assert.equal(built.tableCount, metadata.tableCount);
    const parsed = parseSchemaDoc(schemaDoc);
    assert.deepEqual(parsed, readJson(path.join(mysqlDir, 'parsed-tables.json')));

    assert.match(schemaDoc, /CREATE TABLE order_status_view \(/);
    assert.doesNotMatch(schemaDoc, /CREATE VIEW/);
    assert.ok(parsed.some((table) => table.name === 'order_status_view'));

    assert.match(schemaDoc, /CREATE TABLE 订单 \(/);
    assert.equal(
      parsed.find((table) => table.name === '订单'),
      undefined,
    );

    const orders = parsed.find((table) => table.name === 'Orders');
    assert.ok(orders);
    const channel = orders.columns.find((column) => column.name === 'channel');
    const status = orders.columns.find((column) => column.name === 'status');
    assert.equal(channel?.enumValues, undefined);
    assert.deepEqual(status?.enumValues, ['cancelled', 'pending', '已完成']);

    assert.match(
      schemaDoc,
      /CONSTRAINT fk_items_order_line FOREIGN KEY \(order_id, line_no\) REFERENCES OrderLines \(order_id, line_no\)/,
    );
  });

  it('records sha256 of each introspection SQL string', () => {
    assert.deepEqual(metadata.introspectionSqlSha256, introspectionSqlSha256(loadIntrospectionSql()));
  });
});
