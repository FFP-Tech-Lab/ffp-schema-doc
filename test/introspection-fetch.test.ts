import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import * as publicApi from '../src/index';
import {
  fetchMysqlIntrospectionRows,
  fetchMysqlSchemaDoc,
  fetchPostgresIntrospectionRows,
  fetchPostgresSchemaDoc,
  mysql2QueryFn,
  pgQueryFn,
  type QueryFn,
} from '../src/introspection-fetch';
import {
  MYSQL_COLUMNS_SQL,
  MYSQL_FOREIGN_KEYS_SQL,
  PG_CHECKS_SQL,
  PG_COLUMNS_SQL,
  PG_FOREIGN_KEYS_SQL,
  PG_NATIVE_ENUMS_SQL,
} from '../src/introspection-sql';

const LOCALE_SCHEMA_DOC: Record<string, string> = {
  'C.UTF-8': 'schema-doc.C.txt',
  'en_US.UTF-8': 'schema-doc.en_US.txt',
  'zh_CN.UTF-8': 'schema-doc.zh_CN.txt',
  'sv_SE.UTF-8': 'schema-doc.sv_SE.txt',
};

type Call = { sql: string; params: readonly unknown[] | undefined };

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

function readText(file: string): string {
  return readFileSync(file, 'utf8').replace(/\n$/, '');
}

function localeSchemaDoc(dir: string): string {
  const lcAll = process.env.LC_ALL;
  const file = lcAll ? LOCALE_SCHEMA_DOC[lcAll] : undefined;
  if (!file) {
    throw new Error(`LC_ALL ${JSON.stringify(lcAll ?? '')} has no committed schemaDoc literal`);
  }
  return readText(path.join(dir, file));
}

function pgColumn(
  table: string,
  column = 'id',
  extras?: Partial<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    table_name: table,
    column_name: column,
    data_type: 'integer',
    is_nullable: 'NO',
    udt_name: 'int4',
    ...extras,
  };
}

function mysqlColumn(
  table: string,
  column = 'id',
  extras?: Partial<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    table_name: table,
    column_name: column,
    data_type: 'int',
    is_nullable: 'NO',
    column_type: 'int',
    ...extras,
  };
}

function pgFk(fields: {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  ordinal: unknown;
  name?: string;
}): Record<string, unknown> {
  return {
    constraint_name: fields.name ?? 'fk',
    from_table: fields.fromTable,
    from_column: fields.fromColumn,
    to_table: fields.toTable,
    to_column: fields.toColumn,
    ordinal_position: fields.ordinal,
  };
}

function mysqlFk(fields: {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  ordinal: unknown;
  name?: string;
}): Record<string, unknown> {
  return {
    CONSTRAINT_NAME: fields.name ?? 'fk',
    TABLE_NAME: fields.fromTable,
    COLUMN_NAME: fields.fromColumn,
    REFERENCED_TABLE_NAME: fields.toTable,
    REFERENCED_COLUMN_NAME: fields.toColumn,
    ORDINAL_POSITION: fields.ordinal,
  };
}

/**
 * Replays known statements only. Unknown SQL and unexpected params throw.
 * Yields once per call so an overlapping Promise.all is visible.
 */
function scriptedQuery(
  rowsBySql: ReadonlyMap<string, readonly Record<string, unknown>[]>,
  expectedParams: readonly unknown[] | undefined,
): { query: QueryFn; calls: Call[] } {
  const calls: Call[] = [];
  let active = 0;
  const query: QueryFn = async (sql, params) => {
    if (active !== 0) throw new Error('queries overlapped');
    active += 1;
    calls.push({ sql, params });
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    active -= 1;
    if (expectedParams === undefined) {
      if (params !== undefined) throw new Error('unexpected params');
    } else if (!sameParams(params, expectedParams)) {
      throw new Error('unexpected params');
    }
    const rows = rowsBySql.get(sql);
    if (rows === undefined) throw new Error('unknown SQL');
    return rows;
  };
  return { query, calls };
}

function sameParams(
  actual: readonly unknown[] | undefined,
  expected: readonly unknown[],
): boolean {
  if (actual === undefined || actual.length !== expected.length) return false;
  return actual.every((value, index) => Object.is(value, expected[index]));
}

function pgScript(rows: {
  columns: readonly Record<string, unknown>[];
  nativeEnums?: readonly Record<string, unknown>[];
  checks?: readonly Record<string, unknown>[];
  foreignKeys?: readonly Record<string, unknown>[];
}): { query: QueryFn; calls: Call[] } {
  return scriptedQuery(
    new Map([
      [PG_COLUMNS_SQL, rows.columns],
      [PG_NATIVE_ENUMS_SQL, rows.nativeEnums ?? []],
      [PG_CHECKS_SQL, rows.checks ?? []],
      [PG_FOREIGN_KEYS_SQL, rows.foreignKeys ?? []],
    ]),
    undefined,
  );
}

function mysqlScript(
  database: string,
  rows: {
    columns: readonly Record<string, unknown>[];
    foreignKeys?: readonly Record<string, unknown>[];
  },
): { query: QueryFn; calls: Call[] } {
  return scriptedQuery(
    new Map([
      [MYSQL_COLUMNS_SQL, rows.columns],
      [MYSQL_FOREIGN_KEYS_SQL, rows.foreignKeys ?? []],
    ]),
    [database],
  );
}

async function rejected(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (err) {
    assert.ok(err instanceof Error);
    return err;
  }
  assert.fail('expected an error');
}

const PG_ORDER = [PG_COLUMNS_SQL, PG_NATIVE_ENUMS_SQL, PG_CHECKS_SQL, PG_FOREIGN_KEYS_SQL];
const CHANNEL_CHECK = "CHECK (channel IN ('organic', 'paid'))";

describe('golden replay', () => {
  it('replays sample postgres rows into the foreign-key schemaDoc literal', async () => {
    const dir = path.join('test', 'golden', 'sample-postgres');
    const script = pgScript({
      columns: readJson(path.join(dir, 'columns.json')),
      nativeEnums: readJson(path.join(dir, 'native-enums.json')),
      checks: readJson(path.join(dir, 'checks.json')),
      foreignKeys: readJson(path.join(dir, 'foreign-keys.json')),
    });
    const built = await fetchPostgresSchemaDoc(script.query);
    assert.equal(built.schemaDoc, readText(path.join(dir, 'schema-doc-with-fks.txt')));
    assert.equal(built.tableCount, 6);
    assert.deepEqual(built.warnings, { count: 0, messages: [], unmatched: [] });
    assert.deepEqual(
      script.calls.map((call) => call.sql),
      PG_ORDER,
    );
    assert.ok(script.calls.every((call) => call.params === undefined));
  });

  it('replays synthetic postgres rows into the LC_ALL schemaDoc literal', async () => {
    const dir = path.join('test', 'golden', 'synthetic-postgres');
    const script = pgScript({
      columns: readJson(path.join(dir, 'columns.json')),
      nativeEnums: readJson(path.join(dir, 'native-enums.json')),
      checks: readJson(path.join(dir, 'checks.json')),
      foreignKeys: readJson(path.join(dir, 'foreign-keys.json')),
    });
    const built = await fetchPostgresSchemaDoc(script.query);
    assert.equal(built.schemaDoc, localeSchemaDoc(dir));
    assert.equal(built.tableCount, 6);
    assert.equal(built.warnings.count, 0);
    assert.deepEqual(
      script.calls.map((call) => call.sql),
      PG_ORDER,
    );
  });

  it('replays synthetic mysql rows into the LC_ALL schemaDoc literal', async () => {
    const dir = path.join('test', 'golden', 'synthetic-mysql');
    const database = 'ffp_schema_doc_capture_mysql';
    const script = mysqlScript(database, {
      columns: readJson(path.join(dir, 'columns.json')),
      foreignKeys: readJson(path.join(dir, 'foreign-keys.json')),
    });
    const built = await fetchMysqlSchemaDoc(script.query, { database });
    assert.equal(built.schemaDoc, localeSchemaDoc(dir));
    assert.equal(built.tableCount, 6);
    assert.equal(built.warnings.count, 0);
    assert.deepEqual(
      script.calls.map((call) => call.sql),
      [MYSQL_COLUMNS_SQL, MYSQL_FOREIGN_KEYS_SQL],
    );
    assert.deepEqual(
      script.calls.map((call) => call.params),
      [[database], [database]],
    );
    assert.equal(MYSQL_COLUMNS_SQL.includes(database), false);
    assert.equal(MYSQL_FOREIGN_KEYS_SQL.includes(database), false);
  });

  it('throws on unknown SQL instead of returning an empty row set', async () => {
    const script = pgScript({ columns: [pgColumn('regions')] });
    const err = await rejected(() => script.query('SELECT 1'));
    assert.match(err.message, /unknown SQL/);
  });
});

describe('query shape', () => {
  it('rejects a missing key, including on a later row, without serializing the row', async () => {
    const missingFirst = pgScript({
      columns: [
        {
          extra: 1n,
          column_name: 'id',
          data_type: 'integer',
          is_nullable: 'NO',
          udt_name: 'int4',
        },
      ],
    });
    const firstErr = await rejected(() => fetchPostgresSchemaDoc(missingFirst.query));
    assert.equal(firstErr.message, 'pg.columns: missing key table_name');

    const missingLater = pgScript({
      columns: [pgColumn('regions'), { table_name: 'orders' }],
    });
    const laterErr = await rejected(() => fetchPostgresSchemaDoc(missingLater.query));
    assert.equal(laterErr.message, 'pg.columns: missing key column_name');
  });

  it('rejects camelCase keys, array rows, and MySQL key-case mismatches', async () => {
    const camel = pgScript({
      columns: [
        {
          tableName: 'orders',
          columnName: 'id',
          dataType: 'integer',
          isNullable: 'NO',
          udtName: 'int4',
        },
      ],
    });
    assert.equal(
      (await rejected(() => fetchPostgresSchemaDoc(camel.query))).message,
      'pg.columns: missing key table_name',
    );

    const arrayRows = pgScript({
      columns: [['orders', 'id', 'integer', 'NO', 'int4'] as unknown as Record<string, unknown>],
    });
    assert.equal(
      (await rejected(() => fetchPostgresSchemaDoc(arrayRows.query))).message,
      'pg.columns: missing key table_name',
    );

    const upperColumns = mysqlScript('app', {
      columns: [
        {
          TABLE_NAME: 'orders',
          COLUMN_NAME: 'id',
          DATA_TYPE: 'int',
          IS_NULLABLE: 'NO',
          COLUMN_TYPE: 'int',
        },
      ],
    });
    assert.equal(
      (await rejected(() => fetchMysqlSchemaDoc(upperColumns.query, { database: 'app' }))).message,
      'mysql.columns: missing key table_name',
    );

    const lowerKeys = mysqlScript('app', {
      columns: [mysqlColumn('orders'), mysqlColumn('customers')],
      foreignKeys: [
        {
          constraint_name: 'fk',
          table_name: 'orders',
          column_name: 'customer_id',
          referenced_table_name: 'customers',
          referenced_column_name: 'id',
          ordinal_position: 1,
        },
      ],
    });
    assert.equal(
      (await rejected(() => fetchMysqlSchemaDoc(lowerKeys.query, { database: 'app' }))).message,
      'mysql.foreignKeys: missing key CONSTRAINT_NAME',
    );

    const mysqlArrays = mysql2QueryFn({
      async query() {
        return [[['orders', 'id']], []];
      },
    });
    assert.equal(
      (await rejected(() => fetchMysqlSchemaDoc(mysqlArrays, { database: 'app' }))).message,
      'mysql.columns: missing key table_name',
    );
  });

  it('normalizes ordinal_position from number, numeric string, and bigint before the builder', async () => {
    async function foreignKeyLine(ordinalA: unknown, ordinalB: unknown): Promise<string> {
      const script = pgScript({
        columns: [
          pgColumn('child', 'a'),
          pgColumn('child', 'b'),
          pgColumn('parent', 'a'),
          pgColumn('parent', 'b'),
        ],
        foreignKeys: [
          pgFk({
            fromTable: 'child',
            fromColumn: 'b',
            toTable: 'parent',
            toColumn: 'b',
            ordinal: ordinalB,
          }),
          pgFk({
            fromTable: 'child',
            fromColumn: 'a',
            toTable: 'parent',
            toColumn: 'a',
            ordinal: ordinalA,
          }),
        ],
      });
      const fetched = await fetchPostgresIntrospectionRows(script.query);
      assert.equal(typeof fetched.foreignKeyRows[0]?.ordinal_position, 'number');
      assert.equal(typeof fetched.foreignKeyRows[1]?.ordinal_position, 'number');
      assert.deepEqual(
        fetched.foreignKeyRows.map((row) => row.ordinal_position),
        [Number(ordinalB), Number(ordinalA)],
      );
      const built = await fetchPostgresSchemaDoc(script.query);
      return built.schemaDoc;
    }

    const expected = 'FOREIGN KEY (a, b) REFERENCES parent (a, b)';
    assert.match(await foreignKeyLine(1, 2), new RegExp(expected.replace(/[()]/g, '\\$&')));
    assert.match(await foreignKeyLine('1', '2'), new RegExp(expected.replace(/[()]/g, '\\$&')));
    assert.match(await foreignKeyLine(1n, 2n), new RegExp(expected.replace(/[()]/g, '\\$&')));
  });

  it('normalizes MySQL ORDINAL_POSITION the same way', async () => {
    const script = mysqlScript('app', {
      columns: [mysqlColumn('child', 'a'), mysqlColumn('child', 'b'), mysqlColumn('parent', 'id')],
      foreignKeys: [
        mysqlFk({
          fromTable: 'child',
          fromColumn: 'b',
          toTable: 'parent',
          toColumn: 'id',
          ordinal: 2n,
          name: 'fk_b',
        }),
        mysqlFk({
          fromTable: 'child',
          fromColumn: 'a',
          toTable: 'parent',
          toColumn: 'id',
          ordinal: '1',
          name: 'fk_a',
        }),
      ],
    });
    const fetched = await fetchMysqlIntrospectionRows(script.query, { database: 'app' });
    assert.deepEqual(
      fetched.foreignKeyRows.map((row) => row.ORDINAL_POSITION),
      [2, 1],
    );
    assert.ok(fetched.foreignKeyRows.every((row) => typeof row.ORDINAL_POSITION === 'number'));
  });

  it('rejects a non-array result and a bad ordinal without stringifying values', async () => {
    const query: QueryFn = async () => 1n as unknown as readonly Record<string, unknown>[];
    const err = await rejected(() => fetchPostgresSchemaDoc(query));
    assert.equal(err.message, 'pg.columns: expected an array of rows');

    const badOrdinal = pgScript({
      columns: [pgColumn('child'), pgColumn('parent')],
      foreignKeys: [
        pgFk({
          fromTable: 'child',
          fromColumn: 'id',
          toTable: 'parent',
          toColumn: 'id',
          ordinal: 'nope',
        }),
      ],
    });
    assert.equal(
      (await rejected(() => fetchPostgresSchemaDoc(badOrdinal.query))).message,
      'pg.foreignKeys: ordinal_position must be a positive integer',
    );
  });

  it('rejects null for a required string field', async () => {
    const script = pgScript({
      columns: [pgColumn('regions', 'id', { table_name: null })],
    });
    assert.equal(
      (await rejected(() => fetchPostgresSchemaDoc(script.query))).message,
      'pg.columns: table_name must be a string',
    );
  });
});

describe('filters and empty catalogs', () => {
  it('drops a foreign key that points at an excluded table', async () => {
    const script = pgScript({
      columns: [pgColumn('orders', 'id'), pgColumn('orders', 'customer_id'), pgColumn('customers')],
      foreignKeys: [
        pgFk({
          fromTable: 'orders',
          fromColumn: 'customer_id',
          toTable: 'customers',
          toColumn: 'id',
          ordinal: 1,
          name: 'fk_orders_customer',
        }),
      ],
    });
    const built = await fetchPostgresSchemaDoc(script.query, { excludeTables: ['customers'] });
    assert.match(built.schemaDoc, /CREATE TABLE orders \(/);
    assert.doesNotMatch(built.schemaDoc, /CREATE TABLE customers \(/);
    assert.doesNotMatch(built.schemaDoc, /FOREIGN KEY/);
    assert.doesNotMatch(built.schemaDoc, /customers/);
    assert.equal(built.warnings.count, 1);
    assert.equal(built.warnings.messages[0]?.includes('customers'), false);
    assert.match(built.warnings.messages[0] ?? '', /not among the kept tables/);
    assert.equal(script.calls[0]?.sql, PG_COLUMNS_SQL);
  });

  it('drops a foreign key whose from_table has no column rows', async () => {
    const script = pgScript({
      columns: [pgColumn('regions')],
      foreignKeys: [
        pgFk({
          fromTable: 'secret_accounts',
          fromColumn: 'region_id',
          toTable: 'regions',
          toColumn: 'id',
          ordinal: 1,
        }),
      ],
    });
    const fetched = await fetchPostgresIntrospectionRows(script.query);
    assert.equal(fetched.foreignKeyRows.length, 0);
    assert.equal(fetched.warnings.count, 1);
    assert.equal(fetched.warnings.messages.join('\n').includes('secret_accounts'), false);
    const built = await fetchPostgresSchemaDoc(script.query);
    assert.doesNotMatch(built.schemaDoc, /secret_accounts/);
    assert.doesNotMatch(built.schemaDoc, /FOREIGN KEY/);
    assert.match(built.schemaDoc, /CREATE TABLE regions \(/);
  });

  it('keeps a mixed-case quoted check and drops checks for excluded tables', async () => {
    const checks = [
      { table_name: '"Orders"', check_def: CHANNEL_CHECK },
      { table_name: 'public."Orders"', check_def: CHANNEL_CHECK },
      { table_name: 'regions', check_def: "CHECK (name IN ('a', 'b'))" },
    ];
    const columns = [
      pgColumn('Orders', 'channel', { data_type: 'text', udt_name: 'text' }),
      pgColumn('regions', 'name', { data_type: 'text', udt_name: 'text' }),
    ];
    const kept = await fetchPostgresIntrospectionRows(
      pgScript({ columns, checks }).query,
      { includeTables: ['Orders', 'regions'] },
    );
    assert.equal(kept.checkRows.length, 3);
    const built = await fetchPostgresSchemaDoc(pgScript({ columns, checks }).query);
    assert.match(built.schemaDoc, /channel text NOT NULL {2}-- enum: organic \| paid/);

    const excluded = await fetchPostgresIntrospectionRows(
      pgScript({ columns, checks }).query,
      { excludeTables: ['Orders'] },
    );
    assert.deepEqual(
      excluded.checkRows.map((row) => row.table_name),
      ['regions'],
    );
    assert.equal(excluded.warnings.count, 2);
    assert.equal(excluded.warnings.messages.join('\n').includes('Orders'), false);
    assert.match(excluded.warnings.messages.join('\n'), /check row/);
  });

  it('throws when the column query is empty unless allowEmpty is set', async () => {
    const empty = pgScript({ columns: [] });
    const err = await rejected(() => fetchPostgresSchemaDoc(empty.query));
    assert.match(err.message, /pg\.columns: no column rows/);
    assert.match(err.message, /schema public/);

    const allowed = await fetchPostgresSchemaDoc(pgScript({ columns: [] }).query, {
      allowEmpty: true,
    });
    assert.deepEqual(
      { schemaDoc: allowed.schemaDoc, tableCount: allowed.tableCount },
      { schemaDoc: '', tableCount: 0 },
    );

    const mysqlErr = await rejected(() =>
      fetchMysqlSchemaDoc(mysqlScript('missing_db', { columns: [] }).query, {
        database: 'missing_db',
      }),
    );
    assert.match(mysqlErr.message, /mysql\.columns: no column rows/);
    assert.match(mysqlErr.message, /opts\.database/);

    const filtered = await rejected(() =>
      fetchPostgresSchemaDoc(pgScript({ columns: [pgColumn('orders')] }).query, {
        includeTables: ['other'],
      }),
    );
    assert.match(filtered.message, /no column rows left after includeTables\/excludeTables/);
  });

  it('throws when kept tables exceed maxTables and does not truncate', async () => {
    const script = pgScript({
      columns: [pgColumn('alpha'), pgColumn('beta')],
    });
    const err = await rejected(() => fetchPostgresSchemaDoc(script.query, { maxTables: 1 }));
    assert.equal(err.message, 'pg.columns: 2 tables exceed maxTables 1');
    assert.equal(err.message.includes('alpha'), false);
    assert.equal(err.message.includes('beta'), false);

    const capped = await fetchPostgresSchemaDoc(
      pgScript({ columns: [pgColumn('alpha'), pgColumn('beta')] }).query,
      { maxTables: 2 },
    );
    assert.equal(capped.tableCount, 2);

    const fractional = await rejected(() =>
      fetchPostgresSchemaDoc(pgScript({ columns: [pgColumn('alpha')] }).query, { maxTables: 1.5 }),
    );
    assert.match(fractional.message, /maxTables must be a non-negative integer/);

    const stillThrows = await rejected(() =>
      fetchPostgresSchemaDoc(pgScript({ columns: [pgColumn('alpha'), pgColumn('beta')] }).query, {
        maxTables: 1,
        allowEmpty: true,
      }),
    );
    assert.match(stillThrows.message, /exceed maxTables/);
  });

  it('requires opts.database and passes it only as a parameter', async () => {
    let calls = 0;
    const query: QueryFn = async () => {
      calls += 1;
      return [];
    };
    const missing = await rejected(() =>
      fetchMysqlSchemaDoc(query, undefined as unknown as { database: string }),
    );
    assert.equal(missing.message, 'mysql.columns: opts.database is required');
    assert.equal(calls, 0);
    const blank = await rejected(() => fetchMysqlSchemaDoc(query, { database: '' }));
    assert.equal(blank.message, 'mysql.columns: opts.database is required');
    assert.equal(calls, 0);
  });
});

describe('known limits of the fetch helpers', () => {
  it('merges same-named native enums because the statement has no schema predicate', async () => {
    assert.doesNotMatch(PG_NATIVE_ENUMS_SQL, /nspname|table_schema|pg_namespace/);
    assert.match(PG_COLUMNS_SQL, /table_schema = 'public'/);
    assert.equal(PG_COLUMNS_SQL.includes('?'), false);
    const script = pgScript({
      columns: [
        pgColumn('orders', 'status', { data_type: 'USER-DEFINED', udt_name: 'status' }),
      ],
      nativeEnums: [
        { typname: 'status', enumlabel: 'from_schema_a' },
        { typname: 'status', enumlabel: 'from_schema_b' },
      ],
    });
    const built = await fetchPostgresSchemaDoc(script.query);
    assert.match(built.schemaDoc, /from_schema_a/);
    assert.match(built.schemaDoc, /from_schema_b/);
  });

  it('keeps the row order returned by the database', async () => {
    assert.match(PG_COLUMNS_SQL, /ORDER BY table_name, ordinal_position/);
    assert.match(MYSQL_COLUMNS_SQL, /ORDER BY TABLE_NAME, ORDINAL_POSITION/);
    const script = pgScript({
      columns: [pgColumn('z_table'), pgColumn('a_table')],
    });
    const built = await fetchPostgresSchemaDoc(script.query);
    assert.ok(built.schemaDoc.indexOf('z_table') < built.schemaDoc.indexOf('a_table'));
  });
});

describe('failures', () => {
  it('wraps a query error with the query key and preserves the cause', async () => {
    const secret = 'super-secret-token';
    const cause = new Error(`connect ${secret}`) as Error & { host?: string; user?: string; sql?: string };
    cause.host = 'db.internal';
    cause.user = 'app_user';
    cause.sql = PG_COLUMNS_SQL;
    let calls = 0;
    const query: QueryFn = async (sql) => {
      calls += 1;
      if (sql === PG_COLUMNS_SQL) throw cause;
      throw new Error('unknown SQL');
    };
    const err = await rejected(() => fetchPostgresSchemaDoc(query));
    assert.equal(err.message, 'pg.columns: query failed');
    assert.equal(err.message.includes(secret), false);
    assert.equal(err.cause, cause);
    assert.equal('host' in err, false);
    assert.equal(cause.host, 'db.internal');
    assert.equal(calls, 1);
  });

  it('names the statement that failed and does not run the next one', async () => {
    let calls = 0;
    const cause = new Error('boom');
    const query: QueryFn = async (sql) => {
      calls += 1;
      if (sql === PG_NATIVE_ENUMS_SQL) throw cause;
      if (sql === PG_COLUMNS_SQL) return [pgColumn('regions')];
      throw new Error('unknown SQL');
    };
    const err = await rejected(() => fetchPostgresSchemaDoc(query));
    assert.equal(err.message, 'pg.nativeEnums: query failed');
    assert.equal(err.cause, cause);
    assert.equal(calls, 2);
  });

  it('checks AbortSignal between statements and does not cancel the current one', async () => {
    const already = new AbortController();
    already.abort();
    let earlyCalls = 0;
    const early: QueryFn = async () => {
      earlyCalls += 1;
      return [];
    };
    const earlyErr = await rejected(() => fetchPostgresSchemaDoc(early, { signal: already.signal }));
    assert.equal(earlyErr.name, 'AbortError');
    assert.equal(earlyCalls, 0);

    const controller = new AbortController();
    let calls = 0;
    const query: QueryFn = async () => {
      calls += 1;
      controller.abort();
      return [pgColumn('regions')];
    };
    const err = await rejected(() => fetchPostgresSchemaDoc(query, { signal: controller.signal }));
    assert.equal(err.name, 'AbortError');
    assert.equal(err.message.includes('query failed'), false);
    assert.equal(calls, 1);
  });

  it('honours an abort during the last statement before building schemaDoc', async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const query: QueryFn = async (sql) => {
      calls.push(sql);
      if (sql === PG_FOREIGN_KEYS_SQL) controller.abort();
      if (sql === PG_COLUMNS_SQL) return [pgColumn('regions')];
      return [];
    };
    const err = await rejected(() => fetchPostgresSchemaDoc(query, { signal: controller.signal }));
    assert.equal(err.name, 'AbortError');
    assert.deepEqual(calls, PG_ORDER);

    const mysqlController = new AbortController();
    let mysqlCalls = 0;
    const mysqlQuery: QueryFn = async (sql) => {
      mysqlCalls += 1;
      if (sql === MYSQL_FOREIGN_KEYS_SQL) mysqlController.abort();
      if (sql === MYSQL_COLUMNS_SQL) return [mysqlColumn('regions')];
      return [];
    };
    const mysqlErr = await rejected(() =>
      fetchMysqlSchemaDoc(mysqlQuery, { database: 'app', signal: mysqlController.signal }),
    );
    assert.equal(mysqlErr.name, 'AbortError');
    assert.equal(mysqlCalls, 2);
  });
});

describe('adapters', () => {
  it('pgQueryFn unwraps rows and does not forward params', async () => {
    const seen: unknown[][] = [];
    const query = pgQueryFn({
      async query(sql) {
        seen.push([sql]);
        return { rows: [pgColumn('regions')] };
      },
    });
    const rows = await query(PG_COLUMNS_SQL, ['ignored']);
    assert.deepEqual(seen, [[PG_COLUMNS_SQL]]);
    assert.equal(seen[0]?.length, 1);
    assert.equal(rows[0]?.table_name, 'regions');

    const missing = pgQueryFn({
      async query() {
        return { rows: undefined as unknown as readonly Record<string, unknown>[] };
      },
    });
    const err = await rejected(() => missing('SELECT 1'));
    assert.equal(err.message, 'pg query result has no rows array');
  });

  it('calls pg query with arguments.length exactly 1', async () => {
    const seenLengths: number[] = [];
    const query = pgQueryFn({
      query: async function query(sql: string) {
        seenLengths.push(arguments.length);
        if (sql === PG_COLUMNS_SQL) return { rows: [pgColumn('regions')] };
        return { rows: [] };
      },
    });
    await fetchPostgresSchemaDoc(query);
    assert.deepEqual(seenLengths, [1, 1, 1, 1]);
  });

  it('mysql2QueryFn unwraps the promise tuple', async () => {
    const seen: unknown[] = [];
    const query = mysql2QueryFn({
      async query(sql, values) {
        seen.push(sql, values);
        return [[mysqlColumn('orders')], [{ name: 'table_name' }]];
      },
    });
    const rows = await query(MYSQL_COLUMNS_SQL, ['app']);
    assert.deepEqual(seen, [MYSQL_COLUMNS_SQL, ['app']]);
    assert.equal(rows[0]?.table_name, 'orders');

    const notTuple = mysql2QueryFn({
      async query() {
        return { affectedRows: 1 } as unknown as readonly [unknown, unknown];
      },
    });
    assert.equal(
      (await rejected(() => notTuple('SELECT 1'))).message,
      'mysql2 query result is not a [rows, fields] tuple',
    );

    const rowsNotArray = mysql2QueryFn({
      async query() {
        return [{ affectedRows: 1 }, []];
      },
    });
    assert.equal(
      (await rejected(() => rowsNotArray('SELECT 1'))).message,
      'mysql2 query rows are not an array',
    );
  });
});

describe('unmatched table filters', () => {
  it('throws when a misspelled excludeTables name matches no fetched table', async () => {
    const script = pgScript({
      columns: [pgColumn('secret_accounts', 'id'), pgColumn('orders', 'id')],
    });
    const err = await rejected(() =>
      fetchPostgresSchemaDoc(script.query, { excludeTables: ['secret_acounts'] }),
    );
    assert.equal(err.message, 'pg.columns: unmatched excludeTables: secret_acounts');

    const wrongCase = await rejected(() =>
      fetchPostgresSchemaDoc(pgScript({ columns: [pgColumn('Orders')] }).query, {
        excludeTables: ['orders'],
      }),
    );
    assert.equal(wrongCase.message, 'pg.columns: unmatched excludeTables: orders');

    const mysqlErr = await rejected(() =>
      fetchMysqlSchemaDoc(mysqlScript('app', { columns: [mysqlColumn('orders')] }).query, {
        database: 'app',
        excludeTables: ['Orders'],
      }),
    );
    assert.equal(mysqlErr.message, 'mysql.columns: unmatched excludeTables: Orders');
  });

  it('downgrades an unmatched excludeTables name to a warning when strictFilters is false', async () => {
    const script = pgScript({
      columns: [pgColumn('secret_accounts', 'id'), pgColumn('orders', 'id')],
    });
    const built = await fetchPostgresSchemaDoc(script.query, {
      excludeTables: ['secret_acounts'],
      strictFilters: false,
    });
    assert.match(built.schemaDoc, /CREATE TABLE secret_accounts \(/);
    assert.deepEqual(built.warnings.unmatched, ['secret_acounts']);
    assert.match(built.warnings.messages.join('\n'), /unmatched filter name\(s\): secret_acounts/);

    const stillExcluded = await fetchPostgresSchemaDoc(
      pgScript({
        columns: [pgColumn('secret_accounts'), pgColumn('orders')],
      }).query,
      { excludeTables: ['secret_accounts'], strictFilters: false },
    );
    assert.doesNotMatch(stillExcluded.schemaDoc, /secret_accounts/);
    assert.deepEqual(stillExcluded.warnings.unmatched, []);
  });

  it('warns on an unmatched includeTables name and throws when strictFilters is true', async () => {
    const columns = [pgColumn('orders', 'id')];
    const warned = await fetchPostgresSchemaDoc(pgScript({ columns }).query, {
      includeTables: ['typo_b', 'orders', 'typo_a', 'typo_b'],
    });
    assert.match(warned.schemaDoc, /CREATE TABLE orders \(/);
    assert.doesNotMatch(warned.schemaDoc, /typo/);
    assert.deepEqual(warned.warnings.unmatched, ['typo_b', 'typo_a']);
    assert.equal(warned.warnings.count, 2);
    assert.match(warned.warnings.messages.join('\n'), /unmatched filter name\(s\): typo_b, typo_a/);

    const strictInclude = await rejected(() =>
      fetchPostgresSchemaDoc(pgScript({ columns }).query, {
        includeTables: ['orders', 'typo'],
        strictFilters: true,
      }),
    );
    assert.equal(strictInclude.message, 'pg.columns: unmatched includeTables: typo');

    const both = await rejected(() =>
      fetchPostgresSchemaDoc(pgScript({ columns }).query, {
        includeTables: ['orders', 'typo'],
        excludeTables: ['bad_ex'],
        strictFilters: true,
      }),
    );
    assert.equal(
      both.message,
      'pg.columns: unmatched excludeTables: bad_ex; unmatched includeTables: typo',
    );
  });
});

describe('row validation', () => {
  it('pg.columns rejects an empty table_name and an is_nullable other than YES or NO', async () => {
    const emptyName = pgScript({
      columns: [pgColumn('orders', 'id', { table_name: '' })],
    });
    assert.equal(
      (await rejected(() => fetchPostgresIntrospectionRows(emptyName.query))).message,
      'pg.columns: table_name must be a non-empty string',
    );
    const badFlag = pgScript({
      columns: [pgColumn('orders', 'id', { is_nullable: 'yes' })],
    });
    assert.equal(
      (await rejected(() => fetchPostgresIntrospectionRows(badFlag.query))).message,
      'pg.columns: is_nullable must be YES or NO',
    );
  });

  it('pg.nativeEnums rejects a null enumlabel', async () => {
    const script = pgScript({
      columns: [pgColumn('orders', 'status', { udt_name: 'status' })],
      nativeEnums: [{ typname: 'status', enumlabel: null }],
    });
    assert.equal(
      (await rejected(() => fetchPostgresIntrospectionRows(script.query))).message,
      'pg.nativeEnums: enumlabel must be a string',
    );
  });

  it('pg.checks rejects an empty table_name', async () => {
    const script = pgScript({
      columns: [pgColumn('orders')],
      checks: [{ table_name: '', check_def: CHANNEL_CHECK }],
    });
    assert.equal(
      (await rejected(() => fetchPostgresIntrospectionRows(script.query))).message,
      'pg.checks: table_name must be a non-empty string',
    );
  });

  it('pg.foreignKeys rejects ordinal 0, negatives, and fractions', async () => {
    for (const ordinal of [0, -1, 1.5, 0n, -1n, '0', '-1', '1.5']) {
      const script = pgScript({
        columns: [pgColumn('child'), pgColumn('parent')],
        foreignKeys: [
          pgFk({
            fromTable: 'child',
            fromColumn: 'id',
            toTable: 'parent',
            toColumn: 'id',
            ordinal,
          }),
        ],
      });
      assert.equal(
        (await rejected(() => fetchPostgresIntrospectionRows(script.query))).message,
        'pg.foreignKeys: ordinal_position must be a positive integer',
        `ordinal ${String(ordinal)}`,
      );
    }
  });

  it('mysql.columns rejects an empty table_name and an is_nullable other than YES or NO', async () => {
    const emptyName = mysqlScript('app', {
      columns: [mysqlColumn('orders', 'id', { table_name: '' })],
    });
    assert.equal(
      (await rejected(() => fetchMysqlIntrospectionRows(emptyName.query, { database: 'app' }))).message,
      'mysql.columns: table_name must be a non-empty string',
    );
    const badFlag = mysqlScript('app', {
      columns: [mysqlColumn('orders', 'id', { is_nullable: 'Yes' })],
    });
    assert.equal(
      (await rejected(() => fetchMysqlIntrospectionRows(badFlag.query, { database: 'app' }))).message,
      'mysql.columns: is_nullable must be YES or NO',
    );
  });

  it('mysql.foreignKeys rejects ordinal 0, negatives, and fractions', async () => {
    for (const ordinal of [0, -2, 1.5, '0', '1.5']) {
      const script = mysqlScript('app', {
        columns: [mysqlColumn('child'), mysqlColumn('parent')],
        foreignKeys: [
          mysqlFk({
            fromTable: 'child',
            fromColumn: 'id',
            toTable: 'parent',
            toColumn: 'id',
            ordinal,
          }),
        ],
      });
      assert.equal(
        (await rejected(() => fetchMysqlIntrospectionRows(script.query, { database: 'app' }))).message,
        'mysql.foreignKeys: ORDINAL_POSITION must be a positive integer',
        `ordinal ${String(ordinal)}`,
      );
    }
  });

  it('rejects nestTables-style rows', async () => {
    const nestedPg = pgScript({
      columns: [
        {
          table_name: 'orders',
          columns: [pgColumn('orders')],
        },
      ],
    });
    assert.equal(
      (await rejected(() => fetchPostgresIntrospectionRows(nestedPg.query))).message,
      'pg.columns: missing key column_name',
    );

    const nestedMysql = mysqlScript('app', {
      columns: [
        {
          table_name: 'orders',
          columns: [mysqlColumn('orders')],
        },
      ],
    });
    assert.equal(
      (await rejected(() => fetchMysqlIntrospectionRows(nestedMysql.query, { database: 'app' }))).message,
      'mysql.columns: missing key column_name',
    );

    const nestedFk = pgScript({
      columns: [pgColumn('child'), pgColumn('parent')],
      foreignKeys: [
        {
          constraint_name: 'fk',
          from_table: 'child',
          columns: [{ from_column: 'id', to_column: 'id' }],
          to_table: 'parent',
        },
      ],
    });
    assert.equal(
      (await rejected(() => fetchPostgresIntrospectionRows(nestedFk.query))).message,
      'pg.foreignKeys: missing key from_column',
    );
  });
});

describe('silent foreign-key column drops', () => {
  it('counts a postgres foreign-key row with an empty from_column', async () => {
    const script = pgScript({
      columns: [pgColumn('child', 'id'), pgColumn('parent', 'id')],
      foreignKeys: [
        pgFk({
          fromTable: 'child',
          fromColumn: '',
          toTable: 'parent',
          toColumn: 'id',
          ordinal: 1,
        }),
      ],
    });
    const fetched = await fetchPostgresIntrospectionRows(script.query);
    assert.equal(fetched.foreignKeyRows.length, 0);
    assert.match(
      fetched.warnings.messages.join('\n'),
      /dropped 1 foreign-key row\(s\) with an empty or null constraint or column name/,
    );
    assert.equal(fetched.warnings.messages.join('\n').includes('child'), false);
    const built = await fetchPostgresSchemaDoc(script.query);
    assert.doesNotMatch(built.schemaDoc, /FOREIGN KEY/);
    assert.match(built.schemaDoc, /CREATE TABLE child \(/);
  });

  it('counts a mysql foreign-key row with a null REFERENCED_COLUMN_NAME', async () => {
    const script = mysqlScript('app', {
      columns: [mysqlColumn('child', 'id'), mysqlColumn('parent', 'id')],
      foreignKeys: [
        {
          CONSTRAINT_NAME: 'fk',
          TABLE_NAME: 'child',
          COLUMN_NAME: 'id',
          REFERENCED_TABLE_NAME: 'parent',
          REFERENCED_COLUMN_NAME: null,
          ORDINAL_POSITION: 1,
        },
      ],
    });
    const fetched = await fetchMysqlIntrospectionRows(script.query, { database: 'app' });
    assert.equal(fetched.foreignKeyRows.length, 0);
    assert.match(
      fetched.warnings.messages.join('\n'),
      /dropped 1 foreign-key row\(s\) with an empty or null constraint or column name/,
    );
    assert.equal(fetched.warnings.messages.join('\n').includes('parent'), false);
    const built = await fetchMysqlSchemaDoc(script.query, { database: 'app' });
    assert.doesNotMatch(built.schemaDoc, /FOREIGN KEY/);
  });
});

describe('native enum filtering', () => {
  it('omits an unused native enum without counting it, and counts one removed by a filter', async () => {
    const columns = [
      pgColumn('orders', 'status', { data_type: 'USER-DEFINED', udt_name: 'order_status' }),
      pgColumn('orders', 'flags', { data_type: 'ARRAY', udt_name: '_order_status' }),
    ];
    const nativeEnums = [
      { typname: 'order_status', enumlabel: 'open' },
      { typname: 'hidden_status', enumlabel: 'secret_label' },
    ];
    const fetched = await fetchPostgresIntrospectionRows(pgScript({ columns, nativeEnums }).query);
    assert.deepEqual(
      fetched.nativeEnumRows.map((row) => row.typname),
      ['order_status'],
    );
    assert.equal(fetched.warnings.count, 0);
    const built = await fetchPostgresSchemaDoc(pgScript({ columns, nativeEnums }).query);
    assert.match(built.schemaDoc, /open/);
    assert.doesNotMatch(built.schemaDoc, /secret_label/);

    const filtered = await fetchPostgresIntrospectionRows(pgScript({ columns, nativeEnums }).query, {
      excludeTables: ['orders'],
      allowEmpty: true,
    });
    assert.equal(filtered.nativeEnumRows.length, 0);
    assert.match(
      filtered.warnings.messages.join('\n'),
      /dropped 1 native-enum row\(s\) whose type is used only by a filtered-out table/,
    );
    assert.equal(filtered.warnings.messages.join('\n').includes('secret_label'), false);
  });
});

describe('option shapes', () => {
  it('rejects a string excludeTables or includeTables before running a query', async () => {
    let calls = 0;
    const query: QueryFn = async () => {
      calls += 1;
      return [pgColumn('secret'), pgColumn('s')];
    };
    const excluded = await rejected(() =>
      fetchPostgresSchemaDoc(query, {
        excludeTables: 'secret' as unknown as string[],
        strictFilters: false,
      }),
    );
    assert.equal(excluded.message, 'pg.columns: excludeTables must be an array of strings');
    assert.equal(calls, 0);

    const included = await rejected(() =>
      fetchMysqlSchemaDoc(query, {
        database: 'app',
        includeTables: 'orders' as unknown as string[],
      }),
    );
    assert.equal(included.message, 'mysql.columns: includeTables must be an array of strings');
    assert.equal(calls, 0);

    const badItem = await rejected(() =>
      fetchPostgresSchemaDoc(query, { includeTables: ['orders', 1] as unknown as string[] }),
    );
    assert.equal(badItem.message, 'pg.columns: includeTables must be an array of strings');
    assert.equal(calls, 0);

    const badStrict = await rejected(() =>
      fetchPostgresSchemaDoc(query, { strictFilters: 'false' as unknown as boolean }),
    );
    assert.equal(badStrict.message, 'pg.columns: strictFilters must be a boolean');
    assert.equal(calls, 0);
  });

  it('treats includeTables [] as an empty allow-list and [""] as an unmatched name', async () => {
    const columns = [pgColumn('orders'), pgColumn('customers')];
    const emptyList = await rejected(() =>
      fetchPostgresSchemaDoc(pgScript({ columns }).query, { includeTables: [] }),
    );
    assert.match(emptyList.message, /no column rows left after includeTables\/excludeTables/);

    const allowed = await fetchPostgresSchemaDoc(pgScript({ columns }).query, {
      includeTables: [],
      allowEmpty: true,
    });
    assert.equal(allowed.schemaDoc, '');
    assert.deepEqual(allowed.warnings.unmatched, []);

    const blankName = await fetchPostgresSchemaDoc(pgScript({ columns }).query, {
      includeTables: [''],
      allowEmpty: true,
    });
    assert.equal(blankName.schemaDoc, '');
    assert.deepEqual(blankName.warnings.unmatched, ['']);
  });

  it('applies includeTables before excludeTables and dedupes a name listed in both', async () => {
    const columns = [pgColumn('a'), pgColumn('b'), pgColumn('c')];
    const built = await fetchPostgresSchemaDoc(pgScript({ columns }).query, {
      includeTables: ['a', 'b'],
      excludeTables: ['a'],
    });
    assert.match(built.schemaDoc, /CREATE TABLE b \(/);
    assert.doesNotMatch(built.schemaDoc, /CREATE TABLE a \(/);
    assert.doesNotMatch(built.schemaDoc, /CREATE TABLE c \(/);
    assert.deepEqual(built.warnings.unmatched, []);

    const shared = await fetchPostgresSchemaDoc(pgScript({ columns }).query, {
      includeTables: ['a', 'missing'],
      excludeTables: ['missing', 'missing'],
      strictFilters: false,
    });
    assert.match(shared.schemaDoc, /CREATE TABLE a \(/);
    assert.doesNotMatch(shared.schemaDoc, /CREATE TABLE b \(/);
    assert.deepEqual(shared.warnings.unmatched, ['missing']);
  });

  it('counts a role-invisible excludeTables name as unmatched', async () => {
    const err = await rejected(() =>
      fetchPostgresSchemaDoc(pgScript({ columns: [pgColumn('regions')] }).query, {
        excludeTables: ['secret_accounts'],
        allowEmpty: true,
      }),
    );
    assert.equal(err.message, 'pg.columns: unmatched excludeTables: secret_accounts');
  });
});

describe('maxTables counting', () => {
  it('counts kept tables, and rejects a bad maxTables before any query', async () => {
    let calls = 0;
    const query: QueryFn = async () => {
      calls += 1;
      return [pgColumn('orders')];
    };
    for (const maxTables of [-1, Number.NaN, 1.5]) {
      calls = 0;
      const err = await rejected(() => fetchPostgresSchemaDoc(query, { maxTables }));
      assert.equal(err.message, 'pg.columns: maxTables must be a non-negative integer');
      assert.equal(calls, 0);
    }

    const rows = [pgColumn('orders', 'id'), pgColumn('orders', 'name'), pgColumn('customers', 'id')];
    const twoTables = await fetchPostgresIntrospectionRows(pgScript({ columns: rows }).query, {
      maxTables: 2,
    });
    assert.equal(new Set(twoTables.rows.map((row) => row.table_name)).size, 2);
    assert.equal(twoTables.rows.length, 3);

    const over = await rejected(() =>
      fetchPostgresSchemaDoc(pgScript({ columns: rows }).query, { maxTables: 1 }),
    );
    assert.equal(over.message, 'pg.columns: 2 tables exceed maxTables 1');

    const keptOne = await fetchPostgresSchemaDoc(pgScript({ columns: rows }).query, {
      excludeTables: ['customers'],
      maxTables: 1,
    });
    assert.equal(keptOne.tableCount, 1);
    assert.match(keptOne.schemaDoc, /CREATE TABLE orders \(/);
    assert.doesNotMatch(keptOne.schemaDoc, /customers/);

    let zeroCapCalls = 0;
    const zeroCapQuery: QueryFn = async (sql) => {
      zeroCapCalls += 1;
      if (sql === PG_COLUMNS_SQL) return [pgColumn('orders')];
      return [];
    };
    const zeroCap = await rejected(() => fetchPostgresSchemaDoc(zeroCapQuery, { maxTables: 0 }));
    assert.equal(zeroCap.message, 'pg.columns: 1 tables exceed maxTables 0');
    assert.equal(zeroCapCalls, 4);
  });
});

describe('mysql filters', () => {
  it('drops column and foreign-key rows for includeTables and excludeTables', async () => {
    const columns = [mysqlColumn('orders', 'id'), mysqlColumn('orders', 'customer_id'), mysqlColumn('customers')];
    const foreignKeys = [
      mysqlFk({
        fromTable: 'orders',
        fromColumn: 'customer_id',
        toTable: 'customers',
        toColumn: 'id',
        ordinal: 1,
      }),
    ];
    const excluded = await fetchMysqlSchemaDoc(mysqlScript('app', { columns, foreignKeys }).query, {
      database: 'app',
      excludeTables: ['customers'],
    });
    assert.match(excluded.schemaDoc, /CREATE TABLE orders \(/);
    assert.doesNotMatch(excluded.schemaDoc, /customers/);
    assert.doesNotMatch(excluded.schemaDoc, /FOREIGN KEY/);
    assert.equal(excluded.warnings.count, 1);
    assert.match(excluded.warnings.messages.join('\n'), /not among the kept tables/);

    const included = await fetchMysqlIntrospectionRows(mysqlScript('app', { columns, foreignKeys }).query, {
      database: 'app',
      includeTables: ['orders'],
    });
    assert.deepEqual(
      included.rows.map((row) => row.table_name),
      ['orders', 'orders'],
    );
    assert.equal(included.foreignKeyRows.length, 0);
    assert.equal(included.warnings.count, 1);
  });

  it('returns an empty document when allowEmpty is set and no columns remain', async () => {
    const empty = await fetchMysqlSchemaDoc(mysqlScript('app', { columns: [] }).query, {
      database: 'app',
      allowEmpty: true,
    });
    assert.deepEqual(
      { schemaDoc: empty.schemaDoc, tableCount: empty.tableCount },
      { schemaDoc: '', tableCount: 0 },
    );

    const filtered = await fetchMysqlSchemaDoc(
      mysqlScript('app', { columns: [mysqlColumn('orders')] }).query,
      { database: 'app', excludeTables: ['orders'], allowEmpty: true },
    );
    assert.equal(filtered.schemaDoc, '');
    assert.equal(filtered.tableCount, 0);
    assert.deepEqual(filtered.warnings.unmatched, []);
  });
});

describe('foreign-key identifier groups', () => {
  it('counts an empty constraint_name and drops the whole composite constraint', async () => {
    const columns = [
      pgColumn('child', 'a'),
      pgColumn('child', 'b'),
      pgColumn('parent', 'a'),
      pgColumn('parent', 'b'),
    ];
    const emptyName = pgScript({
      columns,
      foreignKeys: [
        pgFk({
          fromTable: 'child',
          fromColumn: 'a',
          toTable: 'parent',
          toColumn: 'a',
          ordinal: 1,
          name: '',
        }),
      ],
    });
    const named = await fetchPostgresSchemaDoc(emptyName.query);
    assert.doesNotMatch(named.schemaDoc, /FOREIGN KEY/);
    assert.match(
      named.warnings.messages.join('\n'),
      /dropped 1 foreign-key row\(s\) with an empty or null constraint or column name/,
    );

    const composite = pgScript({
      columns,
      foreignKeys: [
        pgFk({
          fromTable: 'child',
          fromColumn: 'a',
          toTable: 'parent',
          toColumn: 'a',
          ordinal: 1,
          name: 'fk_ab',
        }),
        pgFk({
          fromTable: 'child',
          fromColumn: '',
          toTable: 'parent',
          toColumn: 'b',
          ordinal: 2,
          name: 'fk_ab',
        }),
      ],
    });
    const built = await fetchPostgresSchemaDoc(composite.query);
    assert.doesNotMatch(built.schemaDoc, /FOREIGN KEY/);
    assert.match(built.warnings.messages.join('\n'), /dropped 2 foreign-key row/);
    const fetched = await fetchPostgresIntrospectionRows(composite.query);
    assert.equal(fetched.foreignKeyRows.length, 0);

    const mysql = mysqlScript('app', {
      columns: [mysqlColumn('child', 'a'), mysqlColumn('child', 'b'), mysqlColumn('parent', 'a'), mysqlColumn('parent', 'b')],
      foreignKeys: [
        mysqlFk({
          fromTable: 'child',
          fromColumn: 'a',
          toTable: 'parent',
          toColumn: 'a',
          ordinal: 1,
          name: '',
        }),
        mysqlFk({
          fromTable: 'child',
          fromColumn: 'b',
          toTable: 'parent',
          toColumn: 'b',
          ordinal: 2,
          name: '',
        }),
      ],
    });
    const mysqlBuilt = await fetchMysqlSchemaDoc(mysql.query, { database: 'app' });
    assert.doesNotMatch(mysqlBuilt.schemaDoc, /FOREIGN KEY/);
    assert.match(mysqlBuilt.warnings.messages.join('\n'), /dropped 2 foreign-key row/);
  });

  it('counts an empty to_column by dropping every row of that constraint', async () => {
    const script = pgScript({
      columns: [pgColumn('child', 'a'), pgColumn('child', 'b'), pgColumn('parent', 'id')],
      foreignKeys: [
        pgFk({
          fromTable: 'child',
          fromColumn: 'a',
          toTable: 'parent',
          toColumn: 'id',
          ordinal: 1,
          name: 'fk_ab',
        }),
        pgFk({
          fromTable: 'child',
          fromColumn: 'b',
          toTable: 'parent',
          toColumn: '',
          ordinal: 2,
          name: 'fk_ab',
        }),
      ],
    });
    const built = await fetchPostgresSchemaDoc(script.query);
    assert.doesNotMatch(built.schemaDoc, /FOREIGN KEY \(a\)/);
    assert.doesNotMatch(built.schemaDoc, /FOREIGN KEY/);
    assert.equal(built.warnings.count, 2);
  });
});

describe('check-row warnings', () => {
  it('does not count a domain check or a quoted name the normalizer would retarget', async () => {
    const columns = [pgColumn('weird', 'channel', { data_type: 'text', udt_name: 'text' }), pgColumn('we"ird', 'channel', { data_type: 'text', udt_name: 'text' })];
    const checks = [
      { table_name: '-', check_def: CHANNEL_CHECK },
      { table_name: '"we""ird"', check_def: "CHECK (channel IN ('quoted_only', 'paid'))" },
      { table_name: 'other.weird', check_def: CHANNEL_CHECK },
    ];
    const fetched = await fetchPostgresIntrospectionRows(pgScript({ columns, checks }).query);
    assert.equal(fetched.checkRows.length, 0);
    assert.equal(fetched.warnings.count, 0);
    const built = await fetchPostgresSchemaDoc(pgScript({ columns, checks }).query);
    assert.doesNotMatch(built.schemaDoc, /quoted_only/);
    assert.doesNotMatch(built.schemaDoc, /organic/);

    const dotted = await fetchPostgresSchemaDoc(
      pgScript({
        columns: [pgColumn('a.b', 'channel', { data_type: 'text', udt_name: 'text' })],
        checks: [{ table_name: 'public."a.b"', check_def: CHANNEL_CHECK }],
      }).query,
    );
    assert.match(dotted.schemaDoc, /organic \| paid/);
    assert.equal(dotted.warnings.count, 0);
  });
});

describe('public exports', () => {
  it('exports the fetch helpers and SQL constants from the package entry', () => {
    assert.deepEqual(Object.keys(publicApi), [
      'INTROSPECTION_SQL',
      'MAX_ENUM_VALUES',
      'MYSQL_COLUMNS_SQL',
      'MYSQL_FOREIGN_KEYS_SQL',
      'PG_CHECKS_SQL',
      'PG_COLUMNS_SQL',
      'PG_FOREIGN_KEYS_SQL',
      'PG_NATIVE_ENUMS_SQL',
      'buildCheckEnumMap',
      'buildDdl',
      'buildMysqlSchemaDoc',
      'buildNativeEnumMap',
      'buildPostgresSchemaDoc',
      'columnEnumKey',
      'fetchMysqlIntrospectionRows',
      'fetchMysqlSchemaDoc',
      'fetchPostgresIntrospectionRows',
      'fetchPostgresSchemaDoc',
      'filterValidTables',
      'formatEnumComment',
      'mapMysqlForeignKeyRows',
      'mapPgForeignKeyRows',
      'mergeEnumMaps',
      'mysql2QueryFn',
      'normalizeEnumValues',
      'parseMysqlEnumType',
      'parsePgCheckEnum',
      'parseSchemaDoc',
      'pgQueryFn',
    ]);
  });
});
