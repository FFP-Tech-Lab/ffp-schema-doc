/**
 * Capture golden introspection rows from local Postgres and MySQL.
 *
 * Postgres sample schema: scripts/seed, schema then data. schemaDoc is
 * buildDdl with no foreign keys. schemaDocWithForeignKeys follows the
 * Postgres post-processing in the frozen datasource.service.ts snapshot.
 *
 * MySQL: scripts/sql/synthetic-mysql.sql (native enum, CHECK enum, composite
 * FK, view, mixed-case names, CJK enum values, CJK table name).
 *
 * Synthetic Postgres: scripts/sql/synthetic-postgres.sql. Its schemaDoc text
 * is produced by scripts/fa3cbe7-postgres-schema-doc.ts (reference copies of
 * the fa3cbe7 helpers), not by buildPostgresSchemaDoc.
 *
 * Requires local servers reachable without a stored password:
 *   sudo -u postgres psql
 *   sudo mysql --socket=/var/run/mysqld/mysqld.sock
 * Override with SCHEMA_DOC_PSQL / SCHEMA_DOC_MYSQL (a command prefix).
 *
 * Throwaway databases are only ffp_schema_doc_capture, ffp_schema_doc_capture_pg,
 * and ffp_schema_doc_capture_mysql. The script refuses to DROP any other name.
 *
 * This script does not embed connection strings. It is not part of CI.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildMysqlSchemaDoc, buildPostgresSchemaDoc } from '../src/introspect';
import { parseSchemaDoc } from '../src/schema-parse';
import {
  buildCheckEnumMap,
  buildDdl,
  buildNativeEnumMap,
  mergeEnumMaps,
  type SchemaColumnRow,
} from '../src/schema-enum';
import type { MysqlForeignKeyQueryRow } from '../src/schema-fk';
import type {
  MysqlColumnQueryRow,
  PgCheckQueryRow,
  PgColumnQueryRow,
  PgNativeEnumQueryRow,
} from '../src/introspect';
import type { PgForeignKeyQueryRow } from '../src/schema-fk';
import { schemaDocFromFa3cbe7Postgres } from './fa3cbe7-postgres-schema-doc';
import {
  REFERENCE_COMMIT,
  introspectionSqlSha256,
  loadIntrospectionSql,
} from './introspection-sql';

const root = process.cwd();
const sql = loadIntrospectionSql(root);
const sqlSha256 = introspectionSqlSha256(sql);

function run(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
}

function psql(database: string, statement: string): string {
  return run('sudo', [
    '-u',
    'postgres',
    'psql',
    '-d',
    database,
    '-v',
    'ON_ERROR_STOP=1',
    '-A',
    '-t',
    '-c',
    statement,
  ]);
}

function psqlFile(database: string, file: string): void {
  run('sudo', [
    '-u',
    'postgres',
    'psql',
    '-d',
    database,
    '-v',
    'ON_ERROR_STOP=1',
    '-f',
    file,
  ]);
}

function psqlJson<T>(database: string, query: string): T[] {
  const wrapped = `SELECT COALESCE(json_agg(row_to_json(q)), '[]'::json) FROM (\n${query}\n) q;`;
  const out = psql(database, wrapped).trim();
  return JSON.parse(out) as T[];
}

function mysql(statement: string): string {
  return run('sudo', [
    'mysql',
    '--socket=/var/run/mysqld/mysqld.sock',
    '--default-character-set=utf8mb4',
    '--batch',
    '--raw',
    '--skip-column-names',
    '-e',
    statement,
  ]);
}

function mysqlScalar(statement: string): string {
  return mysql(statement).trim();
}

function bindMysql(query: string, database: string): string {
  const literal = `'${database.replace(/'/g, "''")}'`;
  if (!query.includes('?')) return query;
  return query.replace('?', literal);
}

function mysqlJsonRows<T>(database: string, query: string, fields: string[]): T[] {
  const bound = bindMysql(query, database);
  const objectArgs = fields
    .map((field) => `'${field}', ${field}`)
    .join(', ');
  const wrapped = `SELECT JSON_OBJECT(${objectArgs}) FROM (\n${bound}\n) q`;
  const out = mysql(`USE ${database}; ${wrapped};`);
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T);
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Names this script is allowed to DROP. All of them are disposable capture
 * databases. Any other name is refused.
 */
const DISPOSABLE_DATABASES = new Set([
  'ffp_schema_doc_capture',
  'ffp_schema_doc_capture_pg',
  'ffp_schema_doc_capture_mysql',
]);

function assertDisposableDatabase(name: string): void {
  if (!DISPOSABLE_DATABASES.has(name) || !name.startsWith('ffp_schema_doc_capture')) {
    throw new Error(`refusing to drop database ${name}`);
  }
}

function recreatePostgresDatabase(name: string): void {
  assertDisposableDatabase(name);
  psql(
    'postgres',
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${name}' AND pid <> pg_backend_pid();`,
  );
  psql('postgres', `DROP DATABASE IF EXISTS ${name};`);
  psql('postgres', `CREATE DATABASE ${name};`);
}

function dropMysqlDatabase(name: string): void {
  assertDisposableDatabase(name);
  mysql(`DROP DATABASE IF EXISTS ${name};`);
}

function capturePostgres(): void {
  const database = 'ffp_schema_doc_capture';
  recreatePostgresDatabase(database);
  psqlFile(database, path.join(root, 'scripts/seed/01-schema.sql'));
  psqlFile(database, path.join(root, 'scripts/seed/02-data.sql'));

  const columns = psqlJson<PgColumnQueryRow>(database, sql['pg.columns']);
  const nativeEnums = psqlJson<PgNativeEnumQueryRow>(database, sql['pg.nativeEnums']);
  const checks = psqlJson<PgCheckQueryRow>(database, sql['pg.checks']);
  const foreignKeys = psqlJson<PgForeignKeyQueryRow>(database, sql['pg.foreignKeys']);

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
  const withForeignKeys = buildPostgresSchemaDoc(columns, nativeEnums, checks, foreignKeys);
  const version = psql(database, 'SHOW server_version;').trim();

  const dir = path.join(root, 'test/golden/sample-postgres');
  mkdirSync(dir, { recursive: true });
  writeJson(path.join(dir, 'columns.json'), columns);
  writeJson(path.join(dir, 'native-enums.json'), nativeEnums);
  writeJson(path.join(dir, 'checks.json'), checks);
  writeJson(path.join(dir, 'foreign-keys.json'), foreignKeys);
  writeFileSync(path.join(dir, 'schema-doc.txt'), schemaDoc.endsWith('\n') ? schemaDoc : `${schemaDoc}\n`);
  writeFileSync(
    path.join(dir, 'schema-doc-with-fks.txt'),
    withForeignKeys.schemaDoc.endsWith('\n')
      ? withForeignKeys.schemaDoc
      : `${withForeignKeys.schemaDoc}\n`,
  );
  writeJson(path.join(dir, 'parsed-tables.json'), parseSchemaDoc(schemaDoc));
  writeJson(path.join(dir, 'parsed-tables-with-fks.json'), parseSchemaDoc(withForeignKeys.schemaDoc));
  writeJson(path.join(dir, 'metadata.json'), {
    sourceCommit: REFERENCE_COMMIT,
    capture: 'db-captured',
    engine: `PostgreSQL ${version}`,
    database,
    seed: ['scripts/seed/01-schema.sql', 'scripts/seed/02-data.sql'],
    schemaDoc: 'buildDdl with no foreign keys',
    schemaDocWithForeignKeys: 'Postgres post-processing in the frozen datasource.service.ts snapshot, including foreign keys',
    tableCount: withForeignKeys.tableCount,
    introspectionSqlSha256: sqlSha256,
  });
}

function captureMysql(): void {
  const database = 'ffp_schema_doc_capture_mysql';
  dropMysqlDatabase(database);
  const createSql = readFileSync(path.join(root, 'scripts/sql/synthetic-mysql.sql'), 'utf8');
  mysql(createSql);

  const columnFields = ['table_name', 'column_name', 'data_type', 'is_nullable', 'column_type'];
  const fkFields = [
    'CONSTRAINT_NAME',
    'TABLE_NAME',
    'COLUMN_NAME',
    'REFERENCED_TABLE_NAME',
    'REFERENCED_COLUMN_NAME',
    'ORDINAL_POSITION',
  ];
  const columns = mysqlJsonRows<MysqlColumnQueryRow>(database, sql['mysql.columns'], columnFields);
  const foreignKeys = mysqlJsonRows<MysqlForeignKeyQueryRow>(database, sql['mysql.foreignKeys'], fkFields);
  const built = buildMysqlSchemaDoc(columns, foreignKeys);
  const version = mysqlScalar('SELECT VERSION();');

  const dir = path.join(root, 'test/golden/synthetic-mysql');
  mkdirSync(dir, { recursive: true });
  writeJson(path.join(dir, 'columns.json'), columns);
  writeJson(path.join(dir, 'foreign-keys.json'), foreignKeys);
  writeFileSync(
    path.join(dir, 'schema-doc.txt'),
    built.schemaDoc.endsWith('\n') ? built.schemaDoc : `${built.schemaDoc}\n`,
  );
  writeJson(path.join(dir, 'parsed-tables.json'), parseSchemaDoc(built.schemaDoc));
  writeJson(path.join(dir, 'metadata.json'), {
    sourceCommit: REFERENCE_COMMIT,
    capture: 'db-captured',
    engine: `MySQL ${version}`,
    database,
    creationScript: 'scripts/sql/synthetic-mysql.sql',
    features: [
      'native enum',
      'CHECK-based enum',
      'composite foreign key',
      'view',
      'mixed-case names',
      'CJK enum values',
      'CJK table name',
    ],
    tableCount: built.tableCount,
    note: 'CHECK (channel IN ...) is present in the database. The MySQL post-processing only reads native ENUM column types, so channel has no enum comment. The view is returned by INFORMATION_SCHEMA.COLUMNS and emitted as CREATE TABLE. The CJK table name is in schemaDoc and dropped by parseSchemaDoc. Rows are mysql JSON_OBJECT output, not mysql2 driver values.',
    introspectionSqlSha256: sqlSha256,
  });
}

function captureSyntheticPostgres(): void {
  const database = 'ffp_schema_doc_capture_pg';
  recreatePostgresDatabase(database);
  psqlFile(database, path.join(root, 'scripts/sql/synthetic-postgres.sql'));

  const columns = psqlJson<PgColumnQueryRow>(database, sql['pg.columns']);
  const nativeEnums = psqlJson<PgNativeEnumQueryRow>(database, sql['pg.nativeEnums']);
  const checks = psqlJson<PgCheckQueryRow>(database, sql['pg.checks']);
  const foreignKeys = psqlJson<PgForeignKeyQueryRow>(database, sql['pg.foreignKeys']);
  const built = schemaDocFromFa3cbe7Postgres(columns, nativeEnums, checks, foreignKeys);
  const version = psql(database, 'SHOW server_version;').trim();

  const dir = path.join(root, 'test/golden/synthetic-postgres');
  mkdirSync(dir, { recursive: true });
  writeJson(path.join(dir, 'columns.json'), columns);
  writeJson(path.join(dir, 'native-enums.json'), nativeEnums);
  writeJson(path.join(dir, 'checks.json'), checks);
  writeJson(path.join(dir, 'foreign-keys.json'), foreignKeys);
  writeFileSync(
    path.join(dir, 'schema-doc.txt'),
    built.schemaDoc.endsWith('\n') ? built.schemaDoc : `${built.schemaDoc}\n`,
  );
  writeJson(path.join(dir, 'parsed-tables.json'), parseSchemaDoc(built.schemaDoc));
  writeJson(path.join(dir, 'metadata.json'), {
    sourceCommit: REFERENCE_COMMIT,
    capture: 'db-captured',
    engine: `PostgreSQL ${version}`,
    database,
    creationScript: 'scripts/sql/synthetic-postgres.sql',
    schemaDocGeneratedBy:
      'fa3cbe7 reference copies (test/reference/fa3cbe7) composed as the frozen Postgres post-processing: buildNativeEnumMap, buildCheckEnumMap, mergeEnumMaps(native, check), mapPgForeignKeyRows, buildDdl. Not buildPostgresSchemaDoc.',
    features: [
      'native enum',
      'CHECK-based enum',
      'varchar CHECK enum that parsePgCheckEnum rejects',
      'composite foreign key',
      'view',
      'mixed-case names',
      'CJK table name',
      'CJK enum values',
    ],
    tableCount: built.tableCount,
    note: 'status is a native enum and also has a CHECK, so mergeEnumMaps unions them (shipped comes only from the CHECK; cancelled comes only from the enum). channel is text so pg_get_constraintdef stays in the ANY (ARRAY[...]::text) form parsePgCheckEnum accepts. status_code is varchar; its CHECK text uses ::character varying inside ANY ((ARRAY[...])::text[]) and parsePgCheckEnum returns null, so status_code has no enum comment. The view is emitted as CREATE TABLE and does not inherit the table CHECK, so its status comment is native labels only. The CJK table name is in schemaDoc and dropped by parseSchemaDoc. Rows are psql json_agg output, not node-pg driver values.',
    introspectionSqlSha256: sqlSha256,
  });
}

capturePostgres();
captureMysql();
captureSyntheticPostgres();
console.log('wrote test/golden');
