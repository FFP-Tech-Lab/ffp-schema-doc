/**
 * schemaDoc from the fa3cbe7 Postgres post-processing path in datasource.service.ts.
 *
 * Imports the committed reference copies only. Does not call
 * buildPostgresSchemaDoc or anything under src/.
 *
 * The SQL stays outside this function. Callers pass the raw rows from the
 * frozen queries. The body matches the service post-processing:
 * typedRows, buildNativeEnumMap (fetchPostgresNativeEnums),
 * buildCheckEnumMap (fetchPostgresCheckEnums), mergeEnumMaps(native, check),
 * mapPgForeignKeyRows (fetchPostgresForeignKeys), buildDdl, tableCount.
 */
import {
  buildCheckEnumMap,
  buildDdl,
  buildNativeEnumMap,
  mergeEnumMaps,
  type SchemaColumnRow,
} from '../test/reference/fa3cbe7/schema-enum';
import {
  mapPgForeignKeyRows,
  type PgForeignKeyQueryRow,
} from '../test/reference/fa3cbe7/schema-fk';

export type Fa3cbe7PgColumnRow = {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
  udt_name: string;
};

export type Fa3cbe7PgNativeEnumRow = {
  typname: string;
  enumlabel: string;
};

export type Fa3cbe7PgCheckRow = {
  table_name: string;
  check_def: string;
};

export function schemaDocFromFa3cbe7Postgres(
  rows: Fa3cbe7PgColumnRow[],
  nativeEnumRows: Fa3cbe7PgNativeEnumRow[],
  checkRows: Fa3cbe7PgCheckRow[],
  foreignKeyRows: PgForeignKeyQueryRow[],
): { schemaDoc: string; tableCount: number } {
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
