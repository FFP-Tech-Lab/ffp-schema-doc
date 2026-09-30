/**
 * Introspection statements shipped with the package.
 *
 * Each value is the template-literal body of the statement (no surrounding
 * backticks), the same text extractIntrospectionSql returns. Hashes of these
 * strings are recorded in test/fixtures/introspection-sql.sha256.json and
 * matched to introspectionSqlSha256 in the golden metadata files. Table
 * filters do not edit these strings.
 *
 * PostgreSQL statements have no placeholders. The column, check, and
 * foreign-key statements read schema public. The native-enum statement has
 * no schema predicate. MySQL statements take the database name as the single
 * ? parameter.
 */

export const PG_COLUMNS_SQL = `
        SELECT table_name, column_name, data_type, is_nullable, udt_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
        ORDER BY table_name, ordinal_position
      `;

export const PG_FOREIGN_KEYS_SQL = `
      SELECT
        con.conname AS constraint_name,
        rel_from.relname AS from_table,
        att_from.attname AS from_column,
        rel_to.relname AS to_table,
        att_to.attname AS to_column,
        ord.ordinal_position::int AS ordinal_position
      FROM pg_constraint con
      JOIN pg_class rel_from ON rel_from.oid = con.conrelid
      JOIN pg_namespace nsp
        ON nsp.oid = rel_from.relnamespace AND nsp.nspname = 'public'
      JOIN pg_class rel_to ON rel_to.oid = con.confrelid
      JOIN LATERAL unnest(con.conkey, con.confkey)
        WITH ORDINALITY AS ord(from_attnum, to_attnum, ordinal_position)
        ON true
      JOIN pg_attribute att_from
        ON att_from.attrelid = con.conrelid
        AND att_from.attnum = ord.from_attnum
      JOIN pg_attribute att_to
        ON att_to.attrelid = con.confrelid
        AND att_to.attnum = ord.to_attnum
      WHERE con.contype = 'f'
      ORDER BY con.conname, ord.ordinal_position
    `;

export const PG_NATIVE_ENUMS_SQL = `
      SELECT t.typname, e.enumlabel
      FROM pg_type t
      JOIN pg_enum e ON t.oid = e.enumtypid
      ORDER BY t.typname, e.enumsortorder
    `;

export const PG_CHECKS_SQL = `
      SELECT
        c.conrelid::regclass::text AS table_name,
        pg_get_constraintdef(c.oid) AS check_def
      FROM pg_constraint c
      JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE c.contype = 'c'
        AND n.nspname = 'public'
    `;

export const MYSQL_COLUMNS_SQL = `SELECT TABLE_NAME as table_name, COLUMN_NAME as column_name,
                DATA_TYPE as data_type, IS_NULLABLE as is_nullable,
                COLUMN_TYPE as column_type
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = ?
         ORDER BY TABLE_NAME, ORDINAL_POSITION`;

export const MYSQL_FOREIGN_KEYS_SQL = `SELECT CONSTRAINT_NAME, TABLE_NAME, COLUMN_NAME,
              REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME, ORDINAL_POSITION
       FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA = ?
         AND REFERENCED_TABLE_NAME IS NOT NULL
       ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION`;

export const INTROSPECTION_SQL = {
  'pg.columns': PG_COLUMNS_SQL,
  'pg.foreignKeys': PG_FOREIGN_KEYS_SQL,
  'pg.nativeEnums': PG_NATIVE_ENUMS_SQL,
  'pg.checks': PG_CHECKS_SQL,
  'mysql.columns': MYSQL_COLUMNS_SQL,
  'mysql.foreignKeys': MYSQL_FOREIGN_KEYS_SQL,
} as const;

export type IntrospectionSqlKey = keyof typeof INTROSPECTION_SQL;
