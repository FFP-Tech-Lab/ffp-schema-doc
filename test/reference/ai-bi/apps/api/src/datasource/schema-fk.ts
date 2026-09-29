import type { SchemaForeignKeyRow } from '@ai-bi/shared';

export type PgForeignKeyQueryRow = {
  constraint_name: string;
  from_table: string;
  from_column: string;
  to_table: string;
  to_column: string;
  ordinal_position: number;
};

export type MysqlForeignKeyQueryRow = {
  CONSTRAINT_NAME: string;
  TABLE_NAME: string;
  COLUMN_NAME: string;
  REFERENCED_TABLE_NAME: string | null;
  REFERENCED_COLUMN_NAME: string | null;
  ORDINAL_POSITION: number;
};

export function mapPgForeignKeyRows(
  rows: PgForeignKeyQueryRow[],
): SchemaForeignKeyRow[] {
  return rows
    .filter(
      (r) =>
        r.constraint_name &&
        r.from_table &&
        r.from_column &&
        r.to_table &&
        r.to_column,
    )
    .map((r) => ({
      constraint_name: r.constraint_name,
      from_table: r.from_table,
      from_column: r.from_column,
      to_table: r.to_table,
      to_column: r.to_column,
      ordinal_position: Number(r.ordinal_position) || 1,
    }));
}

export function mapMysqlForeignKeyRows(
  rows: MysqlForeignKeyQueryRow[],
): SchemaForeignKeyRow[] {
  return rows
    .filter(
      (r) =>
        r.CONSTRAINT_NAME &&
        r.TABLE_NAME &&
        r.COLUMN_NAME &&
        r.REFERENCED_TABLE_NAME &&
        r.REFERENCED_COLUMN_NAME,
    )
    .map((r) => ({
      constraint_name: r.CONSTRAINT_NAME,
      from_table: r.TABLE_NAME,
      from_column: r.COLUMN_NAME,
      to_table: r.REFERENCED_TABLE_NAME!,
      to_column: r.REFERENCED_COLUMN_NAME!,
      ordinal_position: Number(r.ORDINAL_POSITION) || 1,
    }));
}
