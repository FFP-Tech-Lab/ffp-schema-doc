import {
  buildCheckEnumMap,
  buildDdl,
  buildNativeEnumMap,
  columnEnumKey,
  mergeEnumMaps,
  parseMysqlEnumType,
  type EnumValueMap,
  type SchemaColumnRow,
} from './schema-enum';
import {
  mapMysqlForeignKeyRows,
  mapPgForeignKeyRows,
  type MysqlForeignKeyQueryRow,
  type PgForeignKeyQueryRow,
} from './schema-fk';

/**
 * Column rows from the PostgreSQL information_schema.columns query
 * (table_schema hardcoded to public in the caller).
 */
export type PgColumnQueryRow = {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
  udt_name: string;
};

/** Rows from the PostgreSQL pg_enum label query. */
export type PgNativeEnumQueryRow = {
  typname: string;
  enumlabel: string;
};

/** Rows from the PostgreSQL CHECK constraint query. */
export type PgCheckQueryRow = {
  table_name: string;
  check_def: string;
};

/**
 * Column rows from the MySQL INFORMATION_SCHEMA.COLUMNS query.
 * `column_type` carries native ENUM definitions (`enum('a','b')`).
 */
export type MysqlColumnQueryRow = {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_type: string;
};

export type SchemaDocResult = {
  schemaDoc: string;
  tableCount: number;
};

/**
 * Turn PostgreSQL introspection rows into schemaDoc.
 *
 * Callers keep the four SQL strings (columns, native enums, checks, foreign
 * keys) and pass the raw rows here. Foreign-key rows are mapped internally.
 * A mechanical swap in ai-bi replaces the post-processing in
 * `extractPostgresSchema` with:
 *
 * ```ts
 * return buildPostgresSchemaDoc(rows, nativeEnumRows, checkRows, foreignKeyRows);
 * ```
 */
export function buildPostgresSchemaDoc(
  rows: PgColumnQueryRow[],
  nativeEnumRows: PgNativeEnumQueryRow[],
  checkRows: PgCheckQueryRow[],
  foreignKeyRows: PgForeignKeyQueryRow[],
): SchemaDocResult {
  const typedRows: SchemaColumnRow[] = rows.map((r) => ({
    table_name: r.table_name,
    column_name: r.column_name,
    data_type: r.data_type,
    is_nullable: r.is_nullable,
  }));

  const nativeEnums = buildNativeEnumMap(rows, nativeEnumRows);
  const checkEnums = buildCheckEnumMap(checkRows);
  const enumMap = mergeEnumMaps(nativeEnums, checkEnums);
  const foreignKeys = mapPgForeignKeyRows(foreignKeyRows);

  return {
    schemaDoc: buildDdl(typedRows, enumMap, foreignKeys),
    tableCount: new Set(typedRows.map((r) => r.table_name)).size,
  };
}

/**
 * Turn MySQL introspection rows into schemaDoc.
 *
 * Callers keep the two SQL strings (columns, foreign keys) and pass the raw
 * rows here. Foreign-key rows are mapped internally. A mechanical swap in
 * ai-bi replaces the post-processing in `extractMysqlSchema` with:
 *
 * ```ts
 * return buildMysqlSchemaDoc(rows, foreignKeyRows);
 * ```
 */
export function buildMysqlSchemaDoc(
  rows: unknown,
  foreignKeyRows: MysqlForeignKeyQueryRow[],
): SchemaDocResult {
  const typedRows = rows as Array<{
    table_name: string;
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_type: string;
  }>;

  const enumMap: EnumValueMap = new Map();
  for (const row of typedRows) {
    if (row.data_type.toLowerCase() !== 'enum') continue;
    const values = parseMysqlEnumType(row.column_type);
    if (values.length === 0) continue;
    enumMap.set(columnEnumKey(row.table_name, row.column_name), values);
  }

  const columnRows: SchemaColumnRow[] = typedRows.map((r) => ({
    table_name: r.table_name,
    column_name: r.column_name,
    data_type: r.data_type,
    is_nullable: r.is_nullable,
  }));

  const foreignKeys = mapMysqlForeignKeyRows(foreignKeyRows);

  return {
    schemaDoc: buildDdl(columnRows, enumMap, foreignKeys),
    tableCount: new Set(columnRows.map((r) => r.table_name)).size,
  };
}
