import {
  MYSQL_COLUMNS_SQL,
  MYSQL_FOREIGN_KEYS_SQL,
  PG_CHECKS_SQL,
  PG_COLUMNS_SQL,
  PG_FOREIGN_KEYS_SQL,
  PG_NATIVE_ENUMS_SQL,
} from './introspection-sql';
import {
  buildMysqlSchemaDoc,
  buildPostgresSchemaDoc,
  type MysqlColumnQueryRow,
  type PgCheckQueryRow,
  type PgColumnQueryRow,
  type PgNativeEnumQueryRow,
  type SchemaDocResult,
} from './introspect';
import type { MysqlForeignKeyQueryRow, PgForeignKeyQueryRow } from './schema-fk';

/**
 * Runs one statement and returns object rows.
 *
 * `params` is omitted for the PostgreSQL statements (they have no
 * placeholders). MySQL callers pass the database name as the only element.
 */
export type QueryFn = (
  sql: string,
  params?: readonly unknown[],
) => Promise<readonly Record<string, unknown>[]>;

/** Counts rows the fetch layer dropped, plus short messages with no row values. */
export type IntrospectionWarnings = {
  count: number;
  messages: readonly string[];
};

export type FetchOptions = {
  /** Exact table names, compared to the `table_name` the database returned. */
  includeTables?: readonly string[];
  /** Exact table names. Applied after `includeTables` when both are set. */
  excludeTables?: readonly string[];
  /**
   * Throw when the number of kept tables is greater than this.
   * The catalog is never truncated to the cap.
   */
  maxTables?: number;
  /**
   * When false (default), zero kept column rows throws.
   * When true, the schemaDoc helpers return an empty document, as the builders do.
   */
  allowEmpty?: boolean;
  /**
   * Checked before each statement. It does not cancel a statement that has
   * already been sent; the driver decides whether that statement can be aborted.
   */
  signal?: AbortSignal;
};

export type MysqlFetchOptions = FetchOptions & {
  /** Required. Passed as the `?` parameter. There is no `SELECT DATABASE()` statement. */
  database: string;
};

export type PostgresIntrospectionRows = {
  rows: PgColumnQueryRow[];
  nativeEnumRows: PgNativeEnumQueryRow[];
  checkRows: PgCheckQueryRow[];
  foreignKeyRows: PgForeignKeyQueryRow[];
  warnings: IntrospectionWarnings;
};

export type MysqlIntrospectionRows = {
  rows: MysqlColumnQueryRow[];
  foreignKeyRows: MysqlForeignKeyQueryRow[];
  warnings: IntrospectionWarnings;
};

export type SchemaDocFetchResult = SchemaDocResult & {
  warnings: IntrospectionWarnings;
};

/**
 * Minimal structural type for a node-postgres Client or Pool.
 * The adapter calls `query` with the statement text only.
 */
export type PgQueryable = {
  query(sql: string): Promise<{ rows: readonly Record<string, unknown>[] }>;
};

/**
 * Minimal structural type for a mysql2 promise Connection or Pool.
 * Callback-style clients are not described here.
 */
export type Mysql2Queryable = {
  query(sql: string, values?: unknown): Promise<readonly [unknown, unknown]>;
};

/**
 * Run the four PostgreSQL statements and return builder-ready rows.
 *
 * Statements run one after another. They are not wrapped in a transaction,
 * so the four result sets are not one snapshot. Non-public schemas are out
 * of scope: the shipped statements hardcode `public`, except the native-enum
 * statement, which has no schema predicate (same-named enum types merge by
 * `typname`). Row order is the order the database returns; table order
 * follows the database collation.
 */
export async function fetchPostgresIntrospectionRows(
  query: QueryFn,
  options?: FetchOptions,
): Promise<PostgresIntrospectionRows> {
  throwIfAborted(options?.signal);
  const columns = mapPgColumns(await runQuery(query, 'pg.columns', PG_COLUMNS_SQL));

  throwIfAborted(options?.signal);
  const nativeEnumRows = mapPgNativeEnums(
    await runQuery(query, 'pg.nativeEnums', PG_NATIVE_ENUMS_SQL),
  );

  throwIfAborted(options?.signal);
  const checkRows = mapPgChecks(await runQuery(query, 'pg.checks', PG_CHECKS_SQL));

  throwIfAborted(options?.signal);
  const foreignKeyRows = mapPgForeignKeys(
    await runQuery(query, 'pg.foreignKeys', PG_FOREIGN_KEYS_SQL),
  );

  const keptColumns = selectColumnRows(columns, options);
  const keptTables = tableNames(keptColumns);
  assertMaxTables('pg.columns', keptTables.size, options?.maxTables);
  assertColumnsPresent('pg', columns.length, keptTables.size, options?.allowEmpty === true);

  const checks = filterCheckRows(checkRows, keptTables);
  const foreignKeys = filterPgForeignKeys(foreignKeyRows, keptTables);
  return {
    rows: keptColumns,
    nativeEnumRows,
    checkRows: checks.rows,
    foreignKeyRows: foreignKeys.rows,
    warnings: warningsFor(foreignKeys.dropped, checks.dropped),
  };
}

/**
 * Run the two MySQL statements and return builder-ready rows.
 * `options.database` is the `?` parameter for both statements.
 */
export async function fetchMysqlIntrospectionRows(
  query: QueryFn,
  options: MysqlFetchOptions,
): Promise<MysqlIntrospectionRows> {
  const database = requireDatabase(options);
  throwIfAborted(options.signal);
  const columns = mapMysqlColumns(
    await runQuery(query, 'mysql.columns', MYSQL_COLUMNS_SQL, [database]),
  );

  throwIfAborted(options.signal);
  const foreignKeyRows = mapMysqlForeignKeys(
    await runQuery(query, 'mysql.foreignKeys', MYSQL_FOREIGN_KEYS_SQL, [database]),
  );

  const keptColumns = selectColumnRows(columns, options);
  const keptTables = tableNames(keptColumns);
  assertMaxTables('mysql.columns', keptTables.size, options.maxTables);
  assertColumnsPresent('mysql', columns.length, keptTables.size, options.allowEmpty === true);

  const foreignKeys = filterMysqlForeignKeys(foreignKeyRows, keptTables);
  return {
    rows: keptColumns,
    foreignKeyRows: foreignKeys.rows,
    warnings: warningsFor(foreignKeys.dropped, 0),
  };
}

/** Fetch PostgreSQL rows and pass them to `buildPostgresSchemaDoc`. */
export async function fetchPostgresSchemaDoc(
  query: QueryFn,
  options?: FetchOptions,
): Promise<SchemaDocFetchResult> {
  const fetched = await fetchPostgresIntrospectionRows(query, options);
  const built = buildPostgresSchemaDoc(
    fetched.rows,
    fetched.nativeEnumRows,
    fetched.checkRows,
    fetched.foreignKeyRows,
  );
  return withWarnings(built, fetched.warnings);
}

/** Fetch MySQL rows and pass them to `buildMysqlSchemaDoc`. */
export async function fetchMysqlSchemaDoc(
  query: QueryFn,
  options: MysqlFetchOptions,
): Promise<SchemaDocFetchResult> {
  const fetched = await fetchMysqlIntrospectionRows(query, options);
  const built = buildMysqlSchemaDoc(fetched.rows, fetched.foreignKeyRows);
  return withWarnings(built, fetched.warnings);
}

/**
 * Adapt a node-postgres Client or Pool.
 *
 * PostgreSQL introspection statements have no placeholders. `params` is
 * ignored. The adapter calls `query(sql)` and does not pass an empty array.
 */
export function pgQueryFn(client: PgQueryable): QueryFn {
  return async (sql, _params) => {
    const result = await client.query(sql);
    if (result === null || typeof result !== 'object' || !Array.isArray(result.rows)) {
      throw new Error('pg query result has no rows array');
    }
    return result.rows;
  };
}

/**
 * Adapt a mysql2 promise Connection or Pool.
 *
 * The promise API resolves `[rows, fields]`. Callback-style clients are not
 * accepted. `rows` must be an array; each row is checked later by the fetch
 * helpers (array-mode rows fail there).
 */
export function mysql2QueryFn(connection: Mysql2Queryable): QueryFn {
  return async (sql, params) => {
    const values = params === undefined ? undefined : [...params];
    const result = await connection.query(sql, values);
    if (!Array.isArray(result) || result.length < 2) {
      throw new Error('mysql2 query result is not a [rows, fields] tuple');
    }
    const rows: unknown = result[0];
    if (!Array.isArray(rows)) {
      throw new Error('mysql2 query rows are not an array');
    }
    return rows as readonly Record<string, unknown>[];
  };
}

function withWarnings(
  built: SchemaDocResult,
  warnings: IntrospectionWarnings,
): SchemaDocFetchResult {
  return {
    schemaDoc: built.schemaDoc,
    tableCount: built.tableCount,
    warnings,
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

async function runQuery(
  query: QueryFn,
  queryKey: string,
  sql: string,
  params?: readonly unknown[],
): Promise<readonly unknown[]> {
  let result: unknown;
  try {
    result = params === undefined ? await query(sql) : await query(sql, params);
  } catch (err) {
    throw new Error(`${queryKey}: query failed`, { cause: err });
  }
  if (!Array.isArray(result)) {
    throw new Error(`${queryKey}: expected an array of rows`);
  }
  return result;
}

function requireDatabase(options: MysqlFetchOptions | undefined): string {
  if (options == null || typeof options.database !== 'string' || options.database === '') {
    throw new Error('mysql.columns: opts.database is required');
  }
  return options.database;
}

function asRow(value: unknown, queryKey: string, sampleKey: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object') {
    throw new Error(`${queryKey}: missing key ${sampleKey}`);
  }
  return value as Record<string, unknown>;
}

function readString(row: Record<string, unknown>, queryKey: string, field: string): string {
  if (!Object.hasOwn(row, field)) {
    throw new Error(`${queryKey}: missing key ${field}`);
  }
  const value = row[field];
  if (typeof value !== 'string') {
    throw new Error(`${queryKey}: ${field} must be a string`);
  }
  return value;
}

function readNullableString(
  row: Record<string, unknown>,
  queryKey: string,
  field: string,
): string | null {
  if (!Object.hasOwn(row, field)) {
    throw new Error(`${queryKey}: missing key ${field}`);
  }
  const value = row[field];
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new Error(`${queryKey}: ${field} must be a string or null`);
  }
  return value;
}

function readOrdinal(row: Record<string, unknown>, queryKey: string, field: string): number {
  if (!Object.hasOwn(row, field)) {
    throw new Error(`${queryKey}: missing key ${field}`);
  }
  const value = row[field];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) return asNumber;
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value);
  throw new Error(`${queryKey}: ${field} must be a number, numeric string, or bigint`);
}

// Every row gets a key check and a typeof check. That is cheap, and a missing
// key on a later row still throws. Rows are not serialized: JSON.stringify
// throws on bigint.
function mapPgColumns(raw: readonly unknown[]): PgColumnQueryRow[] {
  const rows: PgColumnQueryRow[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const row = asRow(raw[i], 'pg.columns', 'table_name');
    rows.push({
      table_name: readString(row, 'pg.columns', 'table_name'),
      column_name: readString(row, 'pg.columns', 'column_name'),
      data_type: readString(row, 'pg.columns', 'data_type'),
      is_nullable: readString(row, 'pg.columns', 'is_nullable'),
      udt_name: readString(row, 'pg.columns', 'udt_name'),
    });
  }
  return rows;
}

function mapPgNativeEnums(raw: readonly unknown[]): PgNativeEnumQueryRow[] {
  const rows: PgNativeEnumQueryRow[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const row = asRow(raw[i], 'pg.nativeEnums', 'typname');
    rows.push({
      typname: readString(row, 'pg.nativeEnums', 'typname'),
      enumlabel: readString(row, 'pg.nativeEnums', 'enumlabel'),
    });
  }
  return rows;
}

function mapPgChecks(raw: readonly unknown[]): PgCheckQueryRow[] {
  const rows: PgCheckQueryRow[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const row = asRow(raw[i], 'pg.checks', 'table_name');
    rows.push({
      table_name: readString(row, 'pg.checks', 'table_name'),
      check_def: readString(row, 'pg.checks', 'check_def'),
    });
  }
  return rows;
}

function mapPgForeignKeys(raw: readonly unknown[]): PgForeignKeyQueryRow[] {
  const rows: PgForeignKeyQueryRow[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const row = asRow(raw[i], 'pg.foreignKeys', 'constraint_name');
    rows.push({
      constraint_name: readString(row, 'pg.foreignKeys', 'constraint_name'),
      from_table: readString(row, 'pg.foreignKeys', 'from_table'),
      from_column: readString(row, 'pg.foreignKeys', 'from_column'),
      to_table: readString(row, 'pg.foreignKeys', 'to_table'),
      to_column: readString(row, 'pg.foreignKeys', 'to_column'),
      ordinal_position: readOrdinal(row, 'pg.foreignKeys', 'ordinal_position'),
    });
  }
  return rows;
}

function mapMysqlColumns(raw: readonly unknown[]): MysqlColumnQueryRow[] {
  const rows: MysqlColumnQueryRow[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const row = asRow(raw[i], 'mysql.columns', 'table_name');
    rows.push({
      table_name: readString(row, 'mysql.columns', 'table_name'),
      column_name: readString(row, 'mysql.columns', 'column_name'),
      data_type: readString(row, 'mysql.columns', 'data_type'),
      is_nullable: readString(row, 'mysql.columns', 'is_nullable'),
      column_type: readString(row, 'mysql.columns', 'column_type'),
    });
  }
  return rows;
}

function mapMysqlForeignKeys(raw: readonly unknown[]): MysqlForeignKeyQueryRow[] {
  const rows: MysqlForeignKeyQueryRow[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const row = asRow(raw[i], 'mysql.foreignKeys', 'CONSTRAINT_NAME');
    rows.push({
      CONSTRAINT_NAME: readString(row, 'mysql.foreignKeys', 'CONSTRAINT_NAME'),
      TABLE_NAME: readString(row, 'mysql.foreignKeys', 'TABLE_NAME'),
      COLUMN_NAME: readString(row, 'mysql.foreignKeys', 'COLUMN_NAME'),
      REFERENCED_TABLE_NAME: readNullableString(
        row,
        'mysql.foreignKeys',
        'REFERENCED_TABLE_NAME',
      ),
      REFERENCED_COLUMN_NAME: readNullableString(
        row,
        'mysql.foreignKeys',
        'REFERENCED_COLUMN_NAME',
      ),
      ORDINAL_POSITION: readOrdinal(row, 'mysql.foreignKeys', 'ORDINAL_POSITION'),
    });
  }
  return rows;
}

function selectColumnRows<T extends { table_name: string }>(
  rows: readonly T[],
  options: FetchOptions | undefined,
): T[] {
  const include = options?.includeTables;
  const exclude = options?.excludeTables;
  const includeSet = include ? new Set(include) : undefined;
  const excludeSet = exclude ? new Set(exclude) : undefined;
  const kept: T[] = [];
  for (const row of rows) {
    if (includeSet && !includeSet.has(row.table_name)) continue;
    if (excludeSet && excludeSet.has(row.table_name)) continue;
    kept.push(row);
  }
  return kept;
}

function tableNames(rows: readonly { table_name: string }[]): Set<string> {
  const names = new Set<string>();
  for (const row of rows) names.add(row.table_name);
  return names;
}

/**
 * Same table-name normalization as `buildCheckEnumMap`: strip one leading
 * `public.` prefix, then strip double quotes.
 */
function normalizeCheckTableName(tableName: string): string {
  return tableName.replace(/^public\./, '').replace(/"/g, '');
}

function filterCheckRows(
  rows: readonly PgCheckQueryRow[],
  keptTables: ReadonlySet<string>,
): { rows: PgCheckQueryRow[]; dropped: number } {
  const kept: PgCheckQueryRow[] = [];
  let dropped = 0;
  for (const row of rows) {
    if (!keptTables.has(normalizeCheckTableName(row.table_name))) {
      dropped += 1;
      continue;
    }
    kept.push(row);
  }
  return { rows: kept, dropped };
}

function filterPgForeignKeys(
  rows: readonly PgForeignKeyQueryRow[],
  keptTables: ReadonlySet<string>,
): { rows: PgForeignKeyQueryRow[]; dropped: number } {
  const kept: PgForeignKeyQueryRow[] = [];
  let dropped = 0;
  for (const row of rows) {
    if (!keptTables.has(row.from_table) || !keptTables.has(row.to_table)) {
      dropped += 1;
      continue;
    }
    kept.push(row);
  }
  return { rows: kept, dropped };
}

function filterMysqlForeignKeys(
  rows: readonly MysqlForeignKeyQueryRow[],
  keptTables: ReadonlySet<string>,
): { rows: MysqlForeignKeyQueryRow[]; dropped: number } {
  const kept: MysqlForeignKeyQueryRow[] = [];
  let dropped = 0;
  for (const row of rows) {
    if (
      row.REFERENCED_TABLE_NAME === null ||
      !keptTables.has(row.TABLE_NAME) ||
      !keptTables.has(row.REFERENCED_TABLE_NAME)
    ) {
      dropped += 1;
      continue;
    }
    kept.push(row);
  }
  return { rows: kept, dropped };
}

function warningsFor(droppedForeignKeys: number, droppedChecks: number): IntrospectionWarnings {
  const messages: string[] = [];
  if (droppedForeignKeys > 0) {
    messages.push(
      `dropped ${droppedForeignKeys} foreign-key row(s) because one or both tables are not among the kept tables`,
    );
  }
  if (droppedChecks > 0) {
    messages.push(`dropped ${droppedChecks} check row(s) for tables that are not kept`);
  }
  return { count: droppedForeignKeys + droppedChecks, messages };
}

function assertMaxTables(queryKey: string, tableCount: number, maxTables: number | undefined): void {
  if (maxTables === undefined) return;
  if (!Number.isInteger(maxTables) || maxTables < 0) {
    throw new Error(`${queryKey}: maxTables must be a non-negative integer`);
  }
  if (tableCount > maxTables) {
    throw new Error(`${queryKey}: ${tableCount} tables exceed maxTables ${maxTables}`);
  }
}

function assertColumnsPresent(
  dialect: 'pg' | 'mysql',
  rawColumnCount: number,
  keptTableCount: number,
  allowEmpty: boolean,
): void {
  if (keptTableCount > 0 || allowEmpty) return;
  const queryKey = dialect === 'pg' ? 'pg.columns' : 'mysql.columns';
  if (rawColumnCount === 0) {
    switch (dialect) {
      case 'pg':
        throw new Error(
          `${queryKey}: no column rows. The shipped query only reads schema public. Confirm the database, that relations exist in public, and that the role can read them.`,
        );
      case 'mysql':
        throw new Error(
          `${queryKey}: no column rows. Confirm opts.database, that the schema contains tables or views, and that the role can read them.`,
        );
      default: {
        const unexpected: never = dialect;
        throw new Error(unexpected);
      }
    }
  }
  throw new Error(`${queryKey}: no column rows left after includeTables/excludeTables`);
}
