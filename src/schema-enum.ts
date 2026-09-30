/** Max enum values retained per column in schemaDoc comments. */
export const MAX_ENUM_VALUES = 50;

export type SchemaColumnRow = {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
};

/** One column of a FOREIGN KEY constraint (composite keys use multiple rows). */
export type SchemaForeignKeyRow = {
  constraint_name: string;
  from_table: string;
  from_column: string;
  to_table: string;
  to_column: string;
  ordinal_position: number;
};

/** Key format: `table_name.column_name` (case-sensitive as returned by the DB). */
export type EnumValueMap = Map<string, string[]>;

export function columnEnumKey(tableName: string, columnName: string): string {
  return `${tableName}.${columnName}`;
}

/** Normalize, dedupe, sort, and cap enum values. */
export function normalizeEnumValues(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const v = raw.trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  out.sort((a, b) => a.localeCompare(b));
  return out.slice(0, MAX_ENUM_VALUES);
}

/** Format trailing column comment: ` -- enum: a | b | c` */
export function formatEnumComment(values: string[]): string {
  const normalized = normalizeEnumValues(values);
  if (normalized.length === 0) return '';
  return `  -- enum: ${normalized.join(' | ')}`;
}

/**
 * Merge enum maps. When both have values for the same key, prefer primary
 * and union with secondary (then normalize).
 */
export function mergeEnumMaps(
  primary: EnumValueMap,
  secondary: EnumValueMap,
): EnumValueMap {
  const out: EnumValueMap = new Map();
  const keys = new Set([...primary.keys(), ...secondary.keys()]);
  for (const key of keys) {
    const a = primary.get(key) ?? [];
    const b = secondary.get(key) ?? [];
    if (a.length > 0) {
      out.set(key, normalizeEnumValues([...a, ...b]));
    } else if (b.length > 0) {
      out.set(key, normalizeEnumValues(b));
    }
  }
  return out;
}

/**
 * Parse PostgreSQL CHECK constraint definitions for column IN / ANY lists.
 * Returns null when the constraint is not a recognizable single-column enum.
 *
 * Supported forms:
 * - CHECK (status IN ('a', 'b'))
 * - CHECK ((status)::text = ANY (ARRAY['a'::text, 'b'::text]))
 */
export function parsePgCheckEnum(
  checkDef: string,
): { column: string; values: string[] } | null {
  const def = checkDef.trim();
  if (!def) return null;

  const inMatch = def.match(
    /CHECK\s*\(\s*"?(\w+)"?\s+IN\s*\(([^)]+)\)\s*\)/i,
  );
  if (inMatch) {
    const values = extractQuotedLiterals(inMatch[2]);
    if (values.length === 0) return null;
    return { column: inMatch[1], values: normalizeEnumValues(values) };
  }

  // e.g. CHECK (((channel)::text = ANY (ARRAY['a'::text, 'b'::text])))
  const anyMatch = def.match(
    /CHECK\s*\(+[\s(]*"?(\w+)"?\s*\)?(?:::\w+)?\s*=\s*ANY\s*\(\s*ARRAY\[([^\]]+)\]/i,
  );
  if (anyMatch) {
    const values = extractQuotedLiterals(anyMatch[2]);
    if (values.length === 0) return null;
    return { column: anyMatch[1], values: normalizeEnumValues(values) };
  }

  return null;
}

/** Parse MySQL COLUMN_TYPE like `enum('a','b')` into values. */
export function parseMysqlEnumType(columnType: string): string[] {
  const m = columnType.trim().match(/^enum\s*\((.*)\)\s*$/i);
  if (!m) return [];
  return normalizeEnumValues(extractQuotedLiterals(m[1]));
}

function extractQuotedLiterals(fragment: string): string[] {
  const values: string[] = [];
  const re = /'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(fragment)) !== null) {
    const raw = match[1] ?? match[2] ?? '';
    values.push(raw.replace(/\\'/g, "'").replace(/\\"/g, '"'));
  }
  return values;
}

/** Map PG native enum labels onto columns via udt_name. */
export function buildNativeEnumMap(
  columns: Array<{
    table_name: string;
    column_name: string;
    udt_name: string;
  }>,
  enumLabels: Array<{ typname: string; enumlabel: string }>,
): EnumValueMap {
  const byType = new Map<string, string[]>();
  for (const row of enumLabels) {
    if (!byType.has(row.typname)) byType.set(row.typname, []);
    byType.get(row.typname)!.push(row.enumlabel);
  }

  const enumMap: EnumValueMap = new Map();
  for (const col of columns) {
    const values = byType.get(col.udt_name);
    if (!values?.length) continue;
    enumMap.set(
      columnEnumKey(col.table_name, col.column_name),
      normalizeEnumValues(values),
    );
  }
  return enumMap;
}

/** Map parsed CHECK constraints onto table.columns. */
export function buildCheckEnumMap(
  checks: Array<{ table_name: string; check_def: string }>,
): EnumValueMap {
  const enumMap: EnumValueMap = new Map();
  for (const row of checks) {
    const tableName = row.table_name
      .replace(/^public\./, '')
      .replace(/"/g, '');
    const parsed = parsePgCheckEnum(row.check_def);
    if (!parsed) continue;
    const key = columnEnumKey(tableName, parsed.column);
    const existing = enumMap.get(key) ?? [];
    enumMap.set(key, normalizeEnumValues([...existing, ...parsed.values]));
  }
  return enumMap;
}

type FkConstraintGroup = {
  constraint_name: string;
  from_table: string;
  to_table: string;
  from_columns: string[];
  to_columns: string[];
};

/** Group FK column rows by constraint; drop incomplete groups. */
function groupForeignKeys(
  foreignKeys: SchemaForeignKeyRow[],
): FkConstraintGroup[] {
  const byConstraint = new Map<string, SchemaForeignKeyRow[]>();
  for (const row of foreignKeys) {
    if (
      !row.constraint_name ||
      !row.from_table ||
      !row.from_column ||
      !row.to_table ||
      !row.to_column
    ) {
      continue;
    }
    const key = `${row.from_table}::${row.constraint_name}`;
    if (!byConstraint.has(key)) byConstraint.set(key, []);
    byConstraint.get(key)!.push(row);
  }

  const groups: FkConstraintGroup[] = [];
  for (const rows of byConstraint.values()) {
    rows.sort((a, b) => a.ordinal_position - b.ordinal_position);
    const first = rows[0];
    if (
      rows.some(
        (r) =>
          r.from_table !== first.from_table || r.to_table !== first.to_table,
      )
    ) {
      continue;
    }
    const from_columns = rows.map((r) => r.from_column);
    const to_columns = rows.map((r) => r.to_column);
    if (
      from_columns.length === 0 ||
      from_columns.length !== to_columns.length ||
      from_columns.some((c) => !c) ||
      to_columns.some((c) => !c)
    ) {
      continue;
    }
    groups.push({
      constraint_name: first.constraint_name,
      from_table: first.from_table,
      to_table: first.to_table,
      from_columns,
      to_columns,
    });
  }
  return groups;
}

/**
 * Build schemaDoc DDL text from column rows, optionally appending enum comments
 * and FOREIGN KEY constraint lines.
 */
export function buildDdl(
  rows: SchemaColumnRow[],
  enumMap?: EnumValueMap,
  foreignKeys?: SchemaForeignKeyRow[],
): string {
  const tables = new Map<string, string[]>();
  for (const row of rows) {
    if (!tables.has(row.table_name)) tables.set(row.table_name, []);
    const enums = enumMap?.get(
      columnEnumKey(row.table_name, row.column_name),
    );
    const comment = enums?.length ? formatEnumComment(enums) : '';
    tables
      .get(row.table_name)!
      .push(
        `  ${row.column_name} ${row.data_type}${row.is_nullable === 'NO' ? ' NOT NULL' : ''}${comment}`,
      );
  }

  if (foreignKeys?.length) {
    for (const group of groupForeignKeys(foreignKeys)) {
      if (!tables.has(group.from_table)) tables.set(group.from_table, []);
      const fromList = group.from_columns.join(', ');
      const toList = group.to_columns.join(', ');
      tables
        .get(group.from_table)!
        .push(
          `  CONSTRAINT ${group.constraint_name} FOREIGN KEY (${fromList}) REFERENCES ${group.to_table} (${toList})`,
        );
    }
  }

  return Array.from(tables.entries())
    .map(([name, cols]) => `CREATE TABLE ${name} (\n${cols.join(',\n')}\n);`)
    .join('\n\n');
}
