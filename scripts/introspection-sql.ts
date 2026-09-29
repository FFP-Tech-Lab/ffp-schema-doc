import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/** Commit the frozen reference snapshot was copied from. */
export const REFERENCE_COMMIT = 'fa3cbe777545adfb9f3ce2b9c77e394a1daa83e2';

export const INTROSPECTION_SQL_KEYS = [
  'pg.columns',
  'pg.foreignKeys',
  'pg.nativeEnums',
  'pg.checks',
  'mysql.columns',
  'mysql.foreignKeys',
] as const;

export type IntrospectionSqlKey = (typeof INTROSPECTION_SQL_KEYS)[number];

const REFERENCE_SQL_FILE = path.join(
  'test',
  'reference',
  'fa3cbe7',
  'datasource.service.ts',
);

/**
 * Pull the six introspection query strings out of the committed
 * datasource.service.ts reference. Order matches their appearance in
 * fa3cbe7: PG columns, PG foreign keys, PG native enums, PG checks,
 * MySQL columns, MySQL foreign keys.
 */
export function extractIntrospectionSql(
  source: string,
): Record<IntrospectionSqlKey, string> {
  const sf = ts.createSourceFile(
    'datasource.service.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isNoSubstitutionTemplateLiteral(node) && node.text.includes('SELECT')) {
      found.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (found.length !== INTROSPECTION_SQL_KEYS.length) {
    throw new Error(
      `expected ${INTROSPECTION_SQL_KEYS.length} introspection SQL strings, found ${found.length}`,
    );
  }
  const out = {} as Record<IntrospectionSqlKey, string>;
  for (let i = 0; i < INTROSPECTION_SQL_KEYS.length; i += 1) {
    const key = INTROSPECTION_SQL_KEYS[i];
    const sql = found[i];
    if (key === undefined || sql === undefined) {
      throw new Error(`missing introspection SQL at index ${i}`);
    }
    out[key] = sql;
  }
  return out;
}

export function loadIntrospectionSql(
  repoRoot = process.cwd(),
): Record<IntrospectionSqlKey, string> {
  const file = path.join(repoRoot, REFERENCE_SQL_FILE);
  return extractIntrospectionSql(readFileSync(file, 'utf8'));
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function introspectionSqlSha256(
  sql: Record<IntrospectionSqlKey, string>,
): Record<IntrospectionSqlKey, string> {
  const out = {} as Record<IntrospectionSqlKey, string>;
  for (const key of INTROSPECTION_SQL_KEYS) {
    out[key] = sha256(sql[key]);
  }
  return out;
}
