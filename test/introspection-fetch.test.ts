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
    assert.deepEqual(built.warnings, { count: 0, messages: [] });
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
      'pg.foreignKeys: ordinal_position must be a number, numeric string, or bigint',
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

describe('public exports', () => {
  it('exports the fetch helpers and SQL constants from the package entry', () => {
    const api = publicApi as Record<string, unknown>;
    for (const name of [
      'PG_COLUMNS_SQL',
      'PG_FOREIGN_KEYS_SQL',
      'PG_NATIVE_ENUMS_SQL',
      'PG_CHECKS_SQL',
      'MYSQL_COLUMNS_SQL',
      'MYSQL_FOREIGN_KEYS_SQL',
    ]) {
      assert.equal(typeof api[name], 'string');
    }
    assert.equal(typeof api.INTROSPECTION_SQL, 'object');
    for (const name of [
      'fetchPostgresIntrospectionRows',
      'fetchMysqlIntrospectionRows',
      'fetchPostgresSchemaDoc',
      'fetchMysqlSchemaDoc',
      'pgQueryFn',
      'mysql2QueryFn',
      'buildPostgresSchemaDoc',
      'buildMysqlSchemaDoc',
      'buildDdl',
      'parseSchemaDoc',
    ]) {
      assert.equal(typeof api[name], 'function');
    }
  });
});
