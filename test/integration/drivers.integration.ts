/**
 * Real pg and mysql2 against the synthetic schemas.
 *
 * `pnpm test` does not run this file. `pnpm test:integration` does.
 * The database names are fixed. The test resets only those databases.
 *
 * Goldens were captured on PostgreSQL 16.15 and MySQL 8.0.46. A later minor
 * release can change CHECK text from pg_get_constraintdef. When schemaDoc
 * differs, re-capture with `pnpm capture-golden` and review the diff.
 * PostgreSQL 12+ sorts information_schema.columns.table_name with
 * collation "C" (sql_identifier; PostgreSQL 12 release notes). The initdb
 * locale does not decide that order. Enum labels follow LC_ALL. MySQL table
 * order is whatever the server returns; this suite does not assume another
 * collation.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createConnection, createPool, type Connection, type Pool as MysqlPool } from 'mysql2/promise';
import { Client, Pool } from 'pg';
import { fetchMysqlIntrospectionRows, fetchMysqlSchemaDoc, fetchPostgresIntrospectionRows, fetchPostgresSchemaDoc, mysql2QueryFn, pgQueryFn } from '../../src/introspection-fetch';
import { assertLoopbackHost } from './loopback-host';

const PG_DATABASE = 'ffp_schema_doc_capture_pg';
const MYSQL_DATABASE = 'ffp_schema_doc_capture_mysql';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`missing ${name}`);
  }
  return value;
}

function readText(file: string): string {
  return readFileSync(file, 'utf8').replace(/\n$/, '');
}

function pgConfig(): {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  connectionTimeoutMillis: number;
} {
  const database = requiredEnv('SCHEMA_DOC_PG_DATABASE');
  if (database !== PG_DATABASE) {
    throw new Error(`refusing to reset database ${database}`);
  }
  const host = requiredEnv('SCHEMA_DOC_PG_HOST');
  assertLoopbackHost(host);
  return {
    host,
    port: Number(requiredEnv('SCHEMA_DOC_PG_PORT')),
    user: requiredEnv('SCHEMA_DOC_PG_USER'),
    password: requiredEnv('SCHEMA_DOC_PG_PASSWORD'),
    database,
    connectionTimeoutMillis: 5000,
  };
}

function mysqlConfig(): {
  host: string;
  port: number;
  user: string;
  password: string;
  charset: 'utf8mb4';
  connectTimeout: number;
} {
  const database = requiredEnv('SCHEMA_DOC_MYSQL_DATABASE');
  if (database !== MYSQL_DATABASE) {
    throw new Error(`refusing to reset database ${database}`);
  }
  const host = requiredEnv('SCHEMA_DOC_MYSQL_HOST');
  assertLoopbackHost(host);
  return {
    host,
    port: Number(requiredEnv('SCHEMA_DOC_MYSQL_PORT')),
    user: requiredEnv('SCHEMA_DOC_MYSQL_USER'),
    password: requiredEnv('SCHEMA_DOC_MYSQL_PASSWORD'),
    charset: 'utf8mb4',
    connectTimeout: 5000,
  };
}

async function dropPgReader(client: Client): Promise<void> {
  const exists = await client.query(`SELECT 1 FROM pg_roles WHERE rolname = 'ffp_schema_doc_reader'`);
  if (exists.rowCount === 0) return;
  await client.query(`REVOKE ALL PRIVILEGES ON DATABASE ${PG_DATABASE} FROM ffp_schema_doc_reader`);
  await client.query(`REVOKE ALL PRIVILEGES ON SCHEMA public FROM ffp_schema_doc_reader`);
  await client.query(
    `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ffp_schema_doc_reader`,
  );
  await client.query(`DROP ROLE ffp_schema_doc_reader`);
}

describe('postgres driver', () => {
  it('matches the C.UTF-8 golden through Client and Pool', async () => {
    assert.equal(process.env.LC_ALL, 'C.UTF-8');
    const config = pgConfig();
    const client = new Client(config);
    const pool = new Pool(config);
    const literal = readText(path.join('test', 'golden', 'synthetic-postgres', 'schema-doc.C.txt'));
    const emptyWarnings = { count: 0, messages: [], unmatched: [] };
    let reader: Client | undefined;
    try {
      await client.connect();
      await client.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
      await client.query(readFileSync(path.join('scripts', 'sql', 'synthetic-postgres.sql'), 'utf8'));
      const version = await client.query<{ server_version: string }>('SHOW server_version');
      const serverVersion = version.rows[0]?.server_version ?? 'unknown';
      const fromClient = await fetchPostgresSchemaDoc(pgQueryFn(client));
      const fromPool = await fetchPostgresSchemaDoc(pgQueryFn(pool));
      const message =
        `PostgreSQL ${serverVersion} schemaDoc differed from the golden captured on 16.15. ` +
        'CHECK text can change across minor releases; re-capture with pnpm capture-golden and review the diff.';
      assert.equal(fromClient.schemaDoc, literal, message);
      assert.equal(fromPool.schemaDoc, literal, message);
      assert.equal(fromClient.tableCount, 6);
      assert.equal(fromPool.tableCount, 6);
      assert.deepEqual(fromClient.warnings, emptyWarnings);
      assert.deepEqual(fromPool.warnings, emptyWarnings);

      const fetched = await fetchPostgresIntrospectionRows(pgQueryFn(client));
      assert.ok(fetched.rows.some((row) => row.table_name === '订单'));
      assert.ok(fetched.rows.some((row) => row.table_name === 'Orders'));
      assert.ok(
        fetched.checkRows.some(
          (row) => row.table_name === '"Orders"' || row.table_name === 'public."Orders"',
        ),
      );

      await dropPgReader(client);
      await client.query(`CREATE ROLE ffp_schema_doc_reader LOGIN PASSWORD 'ffp_schema_doc_reader'`);
      await client.query(`GRANT CONNECT ON DATABASE ${PG_DATABASE} TO ffp_schema_doc_reader`);
      await client.query(`GRANT USAGE ON SCHEMA public TO ffp_schema_doc_reader`);
      await client.query(`GRANT SELECT ON TABLE public.regions TO ffp_schema_doc_reader`);
      reader = new Client({
        ...config,
        user: 'ffp_schema_doc_reader',
        password: 'ffp_schema_doc_reader',
      });
      await reader.connect();
      const limitedRows = await fetchPostgresIntrospectionRows(pgQueryFn(reader));
      const limited = await fetchPostgresSchemaDoc(pgQueryFn(reader));
      assert.deepEqual(
        [...new Set(limitedRows.rows.map((row) => row.table_name))],
        ['regions'],
      );
      assert.equal(limitedRows.foreignKeyRows.length, 0);
      assert.equal(limitedRows.checkRows.length, 0);
      assert.equal(limitedRows.nativeEnumRows.length, 0);
      assert.equal(
        limited.schemaDoc,
        'CREATE TABLE regions (\n  id integer NOT NULL,\n  name text NOT NULL\n);',
      );
      assert.equal(limited.tableCount, 1);
      assert.deepEqual(limited.warnings.unmatched, []);
      assert.deepEqual(limited.warnings, {
        count: 3,
        messages: [
          'dropped 3 foreign-key row(s) because one or both tables are not among the kept tables',
        ],
        unmatched: [],
      });
      const hidden = ['Orders', 'OrderLines', 'order_items', 'order_status_view', '订单', '已完成'];
      for (const name of hidden) {
        assert.equal(limited.schemaDoc.includes(name), false, name);
        assert.equal(limited.warnings.messages.join('\n').includes(name), false, name);
      }
      assert.doesNotMatch(limited.schemaDoc, /FOREIGN KEY/);
    } finally {
      await reader?.end();
      await dropPgReader(client).catch(() => undefined);
      await client.end();
      await pool.end();
    }
  });
});

describe('mysql2 driver', () => {
  it('matches the C.UTF-8 golden through a promise Connection and Pool', async () => {
    assert.equal(process.env.LC_ALL, 'C.UTF-8');
    const config = mysqlConfig();
    const literal = readText(path.join('test', 'golden', 'synthetic-mysql', 'schema-doc.C.txt'));
    const loader = await createConnection({ ...config, multipleStatements: true });
    try {
      await loader.query(`DROP DATABASE IF EXISTS \`${MYSQL_DATABASE}\``);
      await loader.query(readFileSync(path.join('scripts', 'sql', 'synthetic-mysql.sql'), 'utf8'));
    } finally {
      await loader.end();
    }
    const connection: Connection = await createConnection({ ...config, database: MYSQL_DATABASE });
    const pool: MysqlPool = createPool({ ...config, database: MYSQL_DATABASE, connectionLimit: 2 });
    try {
      const [versionRows] = await connection.query('SELECT VERSION() AS version');
      const versionList = versionRows as Array<{ version?: string }>;
      const serverVersion = versionList[0]?.version ?? 'unknown';
      const fromConnection = await fetchMysqlSchemaDoc(mysql2QueryFn(connection), {
        database: MYSQL_DATABASE,
      });
      const fromPool = await fetchMysqlSchemaDoc(mysql2QueryFn(pool), {
        database: MYSQL_DATABASE,
      });
      const message =
        `MySQL ${serverVersion} schemaDoc differed from the golden captured on 8.0.46. ` +
        'When the text drifts, re-capture with pnpm capture-golden and review the diff.';
      assert.equal(fromConnection.schemaDoc, literal, message);
      assert.equal(fromPool.schemaDoc, literal, message);
      assert.equal(fromConnection.tableCount, 6);
      assert.equal(fromPool.tableCount, 6);
      const emptyWarnings = { count: 0, messages: [], unmatched: [] };
      assert.deepEqual(fromConnection.warnings, emptyWarnings);
      assert.deepEqual(fromPool.warnings, emptyWarnings);

      const fetched = await fetchMysqlIntrospectionRows(mysql2QueryFn(connection), {
        database: MYSQL_DATABASE,
      });
      assert.ok(fetched.rows.some((row) => row.table_name === '订单'));
      assert.ok(fetched.rows.some((row) => row.table_name === 'Orders'));
      assert.match(fromConnection.schemaDoc, /CREATE TABLE Orders \(/);
      assert.match(fromConnection.schemaDoc, /CREATE TABLE 订单 \(/);
      const [checkRows] = await connection.query(
        `SELECT TABLE_NAME AS table_name
         FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
         WHERE CONSTRAINT_SCHEMA = ? AND CONSTRAINT_TYPE = 'CHECK' AND TABLE_NAME = 'Orders'`,
        [MYSQL_DATABASE],
      );
      const checks = checkRows as Array<{ table_name?: string }>;
      assert.ok(checks.some((row) => row.table_name === 'Orders'));
    } finally {
      await connection.end();
      await pool.end();
    }
  });
});
