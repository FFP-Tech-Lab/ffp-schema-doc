import type {
  SchemaColumnMeta,
  SchemaRelationMeta,
  SchemaTableMeta,
} from './guidance-types';

/**
 * Parse CREATE TABLE DDL blocks from a schemaDoc string into table + column metadata.
 * Shared by API (guidance SSE) and web (Lab browser / guidance wizard).
 */
export function parseSchemaDoc(schemaDoc: string): SchemaTableMeta[] {
  if (!schemaDoc.trim()) return [];

  return schemaDoc
    .split(/(?=CREATE TABLE)/i)
    .map((block) => block.trim())
    .filter((block) => /^CREATE TABLE/i.test(block))
    .map((ddl) => {
      const nameMatch = ddl.match(/CREATE TABLE\s+["'`]?(\w+)["'`]?/i);
      const name = nameMatch?.[1] ?? 'unknown';
      const { columns, outgoingRelations } = parseTableBody(ddl, name);
      return {
        name,
        columns,
        ...(outgoingRelations.length > 0 ? { outgoingRelations } : {}),
      };
    })
    .filter((t) => t.name !== 'unknown');
}

function parseTableBody(
  ddl: string,
  tableName: string,
): { columns: SchemaColumnMeta[]; outgoingRelations: SchemaRelationMeta[] } {
  const open = ddl.indexOf('(');
  const close = ddl.lastIndexOf(')');
  if (open < 0 || close <= open) return { columns: [], outgoingRelations: [] };

  const body = ddl.slice(open + 1, close);
  const lines = splitColumnDefs(body);
  const columns: SchemaColumnMeta[] = [];
  const outgoingRelations: SchemaRelationMeta[] = [];

  for (const raw of lines) {
    const line = raw.trim().replace(/,\s*$/, '');
    if (!line) continue;

    const fk = parseForeignKeyLine(line, tableName);
    if (fk) {
      outgoingRelations.push(fk);
      continue;
    }

    // Skip other constraint-only lines
    if (
      /^(PRIMARY\s+KEY|UNIQUE|CONSTRAINT|FOREIGN\s+KEY|CHECK|INDEX|KEY)\b/i.test(
        line,
      )
    ) {
      continue;
    }
    const colMatch = line.match(/^["'`]?(\w+)["'`]?\s+(\w+(?:\([^)]*\))?)?/i);
    if (!colMatch) continue;
    const enumValues = parseEnumComment(line);
    columns.push({
      name: colMatch[1],
      type: colMatch[2]?.replace(/\([^)]*\)/, '') || undefined,
      ...(enumValues.length > 0 ? { enumValues } : {}),
    });
  }

  return { columns, outgoingRelations };
}

/**
 * Parse CONSTRAINT … FOREIGN KEY (…) REFERENCES … (…) or bare FOREIGN KEY lines.
 */
function parseForeignKeyLine(
  line: string,
  fromTable: string,
): SchemaRelationMeta | null {
  const m = line.match(
    /^(?:CONSTRAINT\s+["'`]?(\w+)["'`]?\s+)?FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+["'`]?(\w+)["'`]?\s*\(([^)]+)\)/i,
  );
  if (!m) return null;

  const fromColumns = splitIdentList(m[2]);
  const toColumns = splitIdentList(m[4]);
  if (
    fromColumns.length === 0 ||
    fromColumns.length !== toColumns.length
  ) {
    return null;
  }

  return {
    ...(m[1] ? { name: m[1] } : {}),
    fromTable,
    fromColumns,
    toTable: m[3],
    toColumns,
  };
}

function splitIdentList(fragment: string): string[] {
  return fragment
    .split(',')
    .map((p) => p.trim().replace(/^["'`]|["'`]$/g, ''))
    .filter(Boolean);
}

/** Extract values from a trailing `-- enum: a | b | c` comment. */
function parseEnumComment(line: string): string[] {
  const m = line.match(/--\s*enum:\s*(.+)$/i);
  if (!m) return [];
  return m[1]
    .split('|')
    .map((v) => v.trim())
    .filter(Boolean);
}

/** Split column definitions on commas that are not inside parentheses. */
function splitColumnDefs(body: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  for (const ch of body) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

/** Return table names from schemaDoc that appear in `candidates` (case-insensitive). */
export function filterValidTables(
  schemaDoc: string,
  candidates: string[],
): string[] {
  if (!candidates.length) return [];
  const known = new Set(
    parseSchemaDoc(schemaDoc).map((t) => t.name.toLowerCase()),
  );
  // If schema has no parseable tables, treat empty schema as no valid tables
  if (known.size === 0) return [];
  return candidates.filter((c) => known.has(c.toLowerCase()));
}
