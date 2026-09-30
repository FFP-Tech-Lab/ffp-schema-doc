/**
 * Real pg and mysql2 against the synthetic schemas.
 *
 * `pnpm test` does not run this file. `pnpm test:integration` does.
 * The database names are fixed. The test resets only those databases.
 *
 * Goldens were captured on PostgreSQL 16.15 and MySQL 8.0.46. A later minor
 * release can change CHECK text from pg_get_constraintdef. When schemaDoc
 * differs, re-capture with `pnpm capture-golden` and review the diff.
 * Table order follows the database collation. The workflow initializes
 * Postgres with locale C.UTF-8 so ORDER BY matches the committed golden.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createConnection, createPool, type Connection, type Pool as MysqlPool } from 'mysql2/promise';
import { Client, Pool } from 'pg';
import { fetchMysqlSchemaDoc, fetchPostgresSchemaDoc, mysql2QueryFn, pgQueryFn } from '../../src/introspection-fetch';

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
  return {
    host: requiredEnv('SCHEMA_DOC_PG_HOST'),
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
  return {
    host: requiredEnv('SCHEMA_DOC_MYSQL_HOST'),
    port: Number(requiredEnv('SCHEMA_DOC_MYSQL_PORT')),
    user: requiredEnv('SCHEMA_DOC_MYSQL_USER'),
    password: requiredEnv('SCHEMA_DOC_MYSQL_PASSWORD'),
    charset: 'utf8mb4',
    connectTimeout: 5000,
  };
}

describe('postgres driver', () => {
  it('matches the C.UTF-8 golden through Client and Pool', async () => {
    assert.equal(process.env.LC_ALL, 'C.UTF-8');
    const config = pgConfig();
    const client = new Client(config);
    const pool = new Pool(config);
    const literal = readText(path.join('test', 'golden', 'synthetic-postgres', 'schema-doc.C.txt'));
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
      assert.equal(fromClient.warnings.count, 0);
      assert.equal(fromPool.warnings.count, 0);
    } finally {
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
      assert.equal(fromConnection.warnings.count, 0);
      assert.equal(fromPool.warnings.count, 0);
    } finally {
      await connection.end();
      await pool.end();
    }
  });
});
