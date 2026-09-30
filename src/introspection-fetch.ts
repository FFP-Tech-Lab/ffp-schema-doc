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

/**
 * Rows the fetch layer dropped, caller filter names that matched nothing,
 * and short messages. Messages do not include database row values.
 * `unmatched` echoes the names the caller passed.
 */
export type IntrospectionWarnings = {
  count: number;
  messages: readonly string[];
  unmatched: readonly string[];
};

export type FetchOptions = {
  /** Exact table names, compared to the `table_name` the database returned. */
  includeTables?: readonly string[];
  /** Exact table names. Applied after `includeTables` when both are set. */
  excludeTables?: readonly string[];
  /**
   * Unmatched `excludeTables` names throw unless this is `false`.
   * Unmatched `includeTables` names are warnings unless this is `true`,
   * which throws for those names too. `false` records an unmatched exclude
   * name in `warnings` and does not remove a table.
   */
  strictFilters?: boolean;
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
 * `typname`). Returned native-enum rows are those whose `typname` equals
 * `udt_name` on a kept column. Row order is the order the database returns.
 * On PostgreSQL 12+, `information_schema.columns.table_name` sorts with
 * collation "C", not the database collation.
 */
export async function fetchPostgresIntrospectionRows(
  query: QueryFn,
  options?: FetchOptions,
): Promise<PostgresIntrospectionRows> {
  assertFetchOptions(options, 'pg.columns');
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
  throwIfAborted(options?.signal);

  const kept = resolveKeptColumns(columns, options, 'pg.columns');
  const fetchedTables = tableNames(columns);
  const keptTables = tableNames(kept.rows);
  assertMaxTables('pg.columns', keptTables.size, options?.maxTables);
  assertColumnsPresent('pg', columns.length, keptTables.size, options?.allowEmpty === true);

  const checks = filterCheckRows(checkRows, fetchedTables, keptTables);
  const foreignKeys = filterPgForeignKeys(foreignKeyRows, keptTables);
  const nativeEnums = filterNativeEnumRows(nativeEnumRows, columns, kept.rows);
  return {
    rows: kept.rows,
    nativeEnumRows: nativeEnums.rows,
    checkRows: checks.rows,
    foreignKeyRows: foreignKeys.rows,
    warnings: warningsFor({
      droppedForeignKeys: foreignKeys.dropped,
      droppedChecks: checks.dropped,
      droppedEnums: nativeEnums.dropped,
      emptyForeignKeyColumns: foreignKeys.emptyColumns,
      unmatched: kept.unmatched,
    }),
  };
}

/**
 * Run the two MySQL statements and return builder-ready rows.
 * `options.database` is the value `mysql2QueryFn` passes to `query`.
 */
export async function fetchMysqlIntrospectionRows(
  query: QueryFn,
  options: MysqlFetchOptions,
): Promise<MysqlIntrospectionRows> {
  assertFetchOptions(options, 'mysql.columns');
  const database = requireDatabase(options);
  throwIfAborted(options.signal);
  const columns = mapMysqlColumns(
    await runQuery(query, 'mysql.columns', MYSQL_COLUMNS_SQL, [database]),
  );

  throwIfAborted(options.signal);
  const foreignKeyRows = mapMysqlForeignKeys(
    await runQuery(query, 'mysql.foreignKeys', MYSQL_FOREIGN_KEYS_SQL, [database]),
  );
  throwIfAborted(options.signal);

  const kept = resolveKeptColumns(columns, options, 'mysql.columns');
  const keptTables = tableNames(kept.rows);
  assertMaxTables('mysql.columns', keptTables.size, options.maxTables);
  assertColumnsPresent('mysql', columns.length, keptTables.size, options.allowEmpty === true);

  const foreignKeys = filterMysqlForeignKeys(foreignKeyRows, keptTables);
  return {
    rows: kept.rows,
    foreignKeyRows: foreignKeys.rows,
    warnings: warningsFor({
      droppedForeignKeys: foreignKeys.dropped,
      droppedChecks: 0,
      droppedEnums: 0,
      emptyForeignKeyColumns: foreignKeys.emptyColumns,
      unmatched: kept.unmatched,
    }),
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
 * The promise API resolves `[rows, fields]`. `query` escapes values on the
 * client. It is not a server-side bind. Callback-style clients are not
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

function assertFetchOptions(options: FetchOptions | undefined, queryKey: string): void {
  if (options === undefined) return;
  assertStringList(options.includeTables, queryKey, 'includeTables');
  assertStringList(options.excludeTables, queryKey, 'excludeTables');
  if (options.strictFilters !== undefined && typeof options.strictFilters !== 'boolean') {
    throw new Error(`${queryKey}: strictFilters must be a boolean`);
  }
  if (options.allowEmpty !== undefined && typeof options.allowEmpty !== 'boolean') {
    throw new Error(`${queryKey}: allowEmpty must be a boolean`);
  }
  if (
    options.maxTables !== undefined &&
    (!Number.isInteger(options.maxTables) || options.maxTables < 0)
  ) {
    throw new Error(`${queryKey}: maxTables must be a non-negative integer`);
  }
}

function assertStringList(value: unknown, queryKey: string, field: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw new Error(`${queryKey}: ${field} must be an array of strings`);
  }
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new Error(`${queryKey}: ${field} must be an array of strings`);
    }
  }
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

function readTableName(row: Record<string, unknown>, queryKey: string): string {
  const value = readString(row, queryKey, 'table_name');
  if (value === '') {
    throw new Error(`${queryKey}: table_name must be a non-empty string`);
  }
  return value;
}

function readNullableFlag(row: Record<string, unknown>, queryKey: string): 'YES' | 'NO' {
  const value = readString(row, queryKey, 'is_nullable');
  if (value === 'YES' || value === 'NO') return value;
  throw new Error(`${queryKey}: is_nullable must be YES or NO`);
}

function readOrdinal(row: Record<string, unknown>, queryKey: string, field: string): number {
  if (!Object.hasOwn(row, field)) {
    throw new Error(`${queryKey}: missing key ${field}`);
  }
  const value = row[field];
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1) return value;
  if (typeof value === 'bigint' && value >= 1n && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(value);
  }
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) {
    const asNumber = Number(value);
    if (Number.isSafeInteger(asNumber)) return asNumber;
  }
  throw new Error(`${queryKey}: ${field} must be a positive integer`);
}

// Every row gets a key check and a typeof check. That is cheap, and a missing
// key on a later row still throws. Rows are not serialized: JSON.stringify
// throws on bigint.
function mapPgColumns(raw: readonly unknown[]): PgColumnQueryRow[] {
  const rows: PgColumnQueryRow[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const row = asRow(raw[i], 'pg.columns', 'table_name');
    rows.push({
      table_name: readTableName(row, 'pg.columns'),
      column_name: readString(row, 'pg.columns', 'column_name'),
      data_type: readString(row, 'pg.columns', 'data_type'),
      is_nullable: readNullableFlag(row, 'pg.columns'),
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
      table_name: readTableName(row, 'pg.checks'),
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
      table_name: readTableName(row, 'mysql.columns'),
      column_name: readString(row, 'mysql.columns', 'column_name'),
      data_type: readString(row, 'mysql.columns', 'data_type'),
      is_nullable: readNullableFlag(row, 'mysql.columns'),
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

function resolveKeptColumns<T extends { table_name: string }>(
  rows: readonly T[],
  options: FetchOptions | undefined,
  queryKey: string,
): { rows: T[]; unmatched: readonly string[] } {
  const fetched = tableNames(rows);
  const unmatchedInclude = namesNotFetched(options?.includeTables, fetched);
  const unmatchedExclude = namesNotFetched(options?.excludeTables, fetched);
  const strictFilters = options?.strictFilters;
  const failExclude = strictFilters !== false && unmatchedExclude.length > 0;
  const failInclude = strictFilters === true && unmatchedInclude.length > 0;
  if (failExclude || failInclude) {
    const parts: string[] = [];
    if (failExclude) parts.push(`unmatched excludeTables: ${unmatchedExclude.join(', ')}`);
    if (failInclude) parts.push(`unmatched includeTables: ${unmatchedInclude.join(', ')}`);
    throw new Error(`${queryKey}: ${parts.join('; ')}`);
  }
  return {
    rows: selectColumnRows(rows, options),
    unmatched: dedupeNames([...unmatchedInclude, ...unmatchedExclude]),
  };
}

function namesNotFetched(
  requested: readonly string[] | undefined,
  fetched: ReadonlySet<string>,
): string[] {
  if (requested === undefined) return [];
  const unmatched: string[] = [];
  const seen = new Set<string>();
  for (const name of requested) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (!fetched.has(name)) unmatched.push(name);
  }
  return unmatched;
}

function dedupeNames(names: readonly string[]): string[] {
  const unmatched: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    unmatched.push(name);
  }
  return unmatched;
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

/**
 * `buildCheckEnumMap` strips one leading `public.` and then every `"`.
 * A domain constraint is `table_name` `-`. A name with an embedded `"`
 * (`""` in regclass text) normalizes to a different table. Those rows are
 * omitted and are not warnings. A warning counts only a check whose
 * normalized name is a fetched table the caller filtered out.
 */
function isLossyCheckTableName(tableName: string): boolean {
  if (tableName.includes('""')) return true;
  const stripped = tableName.replace(/^public\./, '');
  if (!stripped.includes('"')) return false;
  return !/^"[^"]*"$/.test(stripped);
}

function filterCheckRows(
  rows: readonly PgCheckQueryRow[],
  fetchedTables: ReadonlySet<string>,
  keptTables: ReadonlySet<string>,
): { rows: PgCheckQueryRow[]; dropped: number } {
  const kept: PgCheckQueryRow[] = [];
  let dropped = 0;
  for (const row of rows) {
    if (row.table_name === '-' || isLossyCheckTableName(row.table_name)) continue;
    const normalized = normalizeCheckTableName(row.table_name);
    if (keptTables.has(normalized)) {
      kept.push(row);
      continue;
    }
    if (fetchedTables.has(normalized)) dropped += 1;
  }
  return { rows: kept, dropped };
}

function filterNativeEnumRows(
  rows: readonly PgNativeEnumQueryRow[],
  fetchedColumns: readonly { udt_name: string }[],
  keptColumns: readonly { udt_name: string }[],
): { rows: PgNativeEnumQueryRow[]; dropped: number } {
  const fetchedTypes = new Set<string>();
  for (const column of fetchedColumns) fetchedTypes.add(column.udt_name);
  const keptTypes = new Set<string>();
  for (const column of keptColumns) keptTypes.add(column.udt_name);
  const kept: PgNativeEnumQueryRow[] = [];
  let dropped = 0;
  for (const row of rows) {
    if (keptTypes.has(row.typname)) {
      kept.push(row);
      continue;
    }
    if (fetchedTypes.has(row.typname)) dropped += 1;
  }
  return { rows: kept, dropped };
}

function dropIncompleteFkGroups<T>(
  rows: readonly T[],
  groupKey: (row: T) => string,
  invalid: (row: T) => boolean,
): { rows: T[]; dropped: number } {
  const groups = new Map<string, T[]>();
  const order: string[] = [];
  for (const row of rows) {
    const key = groupKey(row);
    const existing = groups.get(key);
    if (existing) {
      existing.push(row);
      continue;
    }
    groups.set(key, [row]);
    order.push(key);
  }
  const kept: T[] = [];
  let dropped = 0;
  for (const key of order) {
    const group = groups.get(key);
    if (!group) continue;
    if (group.some(invalid)) {
      dropped += group.length;
      continue;
    }
    kept.push(...group);
  }
  return { rows: kept, dropped };
}

function filterPgForeignKeys(
  rows: readonly PgForeignKeyQueryRow[],
  keptTables: ReadonlySet<string>,
): { rows: PgForeignKeyQueryRow[]; dropped: number; emptyColumns: number } {
  const kept: PgForeignKeyQueryRow[] = [];
  let dropped = 0;
  for (const row of rows) {
    if (!keptTables.has(row.from_table) || !keptTables.has(row.to_table)) {
      dropped += 1;
      continue;
    }
    kept.push(row);
  }
  const identifiers = dropIncompleteFkGroups(
    kept,
    (row) => `${row.from_table}::${row.constraint_name}`,
    (row) =>
      row.constraint_name === '' ||
      row.from_table === '' ||
      row.from_column === '' ||
      row.to_table === '' ||
      row.to_column === '',
  );
  return { rows: identifiers.rows, dropped, emptyColumns: identifiers.dropped };
}

function filterMysqlForeignKeys(
  rows: readonly MysqlForeignKeyQueryRow[],
  keptTables: ReadonlySet<string>,
): { rows: MysqlForeignKeyQueryRow[]; dropped: number; emptyColumns: number } {
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
  const identifiers = dropIncompleteFkGroups(
    kept,
    (row) => `${row.TABLE_NAME}::${row.CONSTRAINT_NAME}`,
    (row) =>
      row.CONSTRAINT_NAME === '' ||
      row.TABLE_NAME === '' ||
      row.COLUMN_NAME === '' ||
      row.REFERENCED_TABLE_NAME === '' ||
      row.REFERENCED_COLUMN_NAME === null ||
      row.REFERENCED_COLUMN_NAME === '',
  );
  return { rows: identifiers.rows, dropped, emptyColumns: identifiers.dropped };
}

function warningsFor(counts: {
  droppedForeignKeys: number;
  droppedChecks: number;
  droppedEnums: number;
  emptyForeignKeyColumns: number;
  unmatched: readonly string[];
}): IntrospectionWarnings {
  const messages: string[] = [];
  if (counts.droppedForeignKeys > 0) {
    messages.push(
      `dropped ${counts.droppedForeignKeys} foreign-key row(s) because one or both tables are not among the kept tables`,
    );
  }
  if (counts.droppedChecks > 0) {
    messages.push(`dropped ${counts.droppedChecks} check row(s) for tables that are not kept`);
  }
  if (counts.droppedEnums > 0) {
    messages.push(
      `dropped ${counts.droppedEnums} native-enum row(s) whose type is used only by a filtered-out table`,
    );
  }
  if (counts.emptyForeignKeyColumns > 0) {
    messages.push(
      `dropped ${counts.emptyForeignKeyColumns} foreign-key row(s) with an empty or null constraint or column name`,
    );
  }
  if (counts.unmatched.length > 0) {
    messages.push(`unmatched filter name(s): ${counts.unmatched.join(', ')}`);
  }
  return {
    count:
      counts.droppedForeignKeys +
      counts.droppedChecks +
      counts.droppedEnums +
      counts.emptyForeignKeyColumns +
      counts.unmatched.length,
    messages,
    unmatched: counts.unmatched,
  };
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
