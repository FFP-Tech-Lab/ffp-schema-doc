import type { Client, Pool } from 'pg';
import type { Connection, Pool as MysqlPool } from 'mysql2/promise';
import {
  fetchMysqlSchemaDoc,
  fetchPostgresSchemaDoc,
  mysql2QueryFn,
  pgQueryFn,
  type FetchOptions,
  type IntrospectionWarnings,
  type Mysql2Queryable,
  type MysqlFetchOptions,
  type PgQueryable,
  type QueryFn,
  type SchemaDocFetchResult,
} from '../src/introspection-fetch';

type Expect<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

type QueryParams = Parameters<QueryFn>;
type _sql = Expect<Equal<QueryParams[0], string>>;
type _params = Expect<Equal<QueryParams[1], readonly unknown[] | undefined>>;

type Result = Awaited<ReturnType<typeof fetchPostgresSchemaDoc>>;
type _result = Expect<Equal<Result, SchemaDocFetchResult>>;
type _warnings = Expect<
  Equal<IntrospectionWarnings, { count: number; messages: readonly string[] }>
>;
type _schemaDoc = Expect<Equal<SchemaDocFetchResult['schemaDoc'], string>>;
type _tableCount = Expect<Equal<SchemaDocFetchResult['tableCount'], number>>;

void (null as unknown as _sql);
void (null as unknown as _params);
void (null as unknown as _result);
void (null as unknown as _warnings);
void (null as unknown as _schemaDoc);
void (null as unknown as _tableCount);

function assignablePg(client: PgQueryable): QueryFn {
  return pgQueryFn(client);
}

function assignableMysql(connection: Mysql2Queryable): QueryFn {
  return mysql2QueryFn(connection);
}

function pgClientAssignable(client: Client): QueryFn {
  return assignablePg(client);
}

function pgPoolAssignable(pool: Pool): QueryFn {
  return assignablePg(pool);
}

function mysqlConnectionAssignable(connection: Connection): QueryFn {
  return assignableMysql(connection);
}

function mysqlPoolAssignable(pool: MysqlPool): QueryFn {
  return assignableMysql(pool);
}

function optionsProbe(): void {
  const options = {
    includeTables: ['orders'],
    excludeTables: ['secret_accounts'],
    maxTables: 10,
    allowEmpty: false,
    signal: new AbortController().signal,
  } satisfies FetchOptions;
  const mysql = { ...options, database: 'app' } satisfies MysqlFetchOptions;
  void options;
  void mysql;
  void fetchMysqlSchemaDoc;
  void fetchPostgresSchemaDoc;

  // @ts-expect-error database is required for MySQL fetch options
  const missingDatabase: MysqlFetchOptions = { allowEmpty: true };
  void missingDatabase;

  pgQueryFn({
    query(sql: string) {
      void sql;
      return Promise.resolve({ rows: [] });
    },
  });

  mysql2QueryFn({
    query(sql: string, values?: unknown) {
      void sql;
      void values;
      return Promise.resolve([[], []]);
    },
  });
}

void optionsProbe;
void pgClientAssignable;
void pgPoolAssignable;
void mysqlConnectionAssignable;
void mysqlPoolAssignable;
