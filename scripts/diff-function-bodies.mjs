/**
 * Diff exported (and helper) function bodies against the ai-bi source
 * frozen at AI_BI_COMMIT under test/reference/.
 *
 * Offline: the reference copies are committed. Imports are stripped before
 * comparison, so schema-fk.ts may import ./schema-enum instead of @ai-bi/shared.
 *
 * Moved files must also match in full once import lines are removed, so a
 * change to MAX_ENUM_VALUES (or any other non-function text) fails this diff.
 *
 * Moved functions must have an empty body diff.
 * buildPostgresSchemaDoc / buildMysqlSchemaDoc are new. Their verbatim slices
 * (typedRows mapping, mergeEnumMaps(native, check), the MySQL enum loop,
 * columnRows mapping, and the tableCount return) are diffed against
 * datasource.service.ts. The three `await this.fetch*` calls are not pure;
 * those lines are the FK/enum mapper calls instead, and this script checks
 * that substitution explicitly.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const AI_BI_COMMIT = 'fa3cbe777545adfb9f3ce2b9c77e394a1daa83e2';
const root = process.cwd();

const FILE_PAIRS = [
  {
    pkg: 'src/schema-enum.ts',
    ref: 'test/reference/ai-bi/packages/shared/src/schema-enum.ts',
  },
  {
    pkg: 'src/schema-parse.ts',
    ref: 'test/reference/ai-bi/packages/shared/src/schema-parse.ts',
  },
  {
    pkg: 'src/schema-fk.ts',
    ref: 'test/reference/ai-bi/apps/api/src/datasource/schema-fk.ts',
  },
];

function read(rel) {
  return readFileSync(path.join(root, rel), 'utf8');
}

function stripImports(src) {
  return src
    .split('\n')
    .filter((line) => !/^\s*import\s/.test(line))
    .join('\n');
}

function sourceFile(rel, src) {
  return ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function functionBodies(rel) {
  const src = stripImports(read(rel));
  const sf = sourceFile(rel, src);
  const bodies = new Map();
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      const start = node.body.getStart(sf);
      bodies.set(node.name.text, src.slice(start, node.body.end));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return bodies;
}

function canonical(text) {
  const lines = text.replace(/\s*$/, '').split('\n');
  while (lines.length > 0 && lines[0].trim() === '') lines.shift();
  const rest = lines.slice(1).filter((line) => line.trim().length > 0);
  const min =
    rest.length > 0
      ? Math.min(...rest.map((line) => line.match(/^ */)[0].length))
      : 0;
  return lines
    .map((line, index) => {
      if (index === 0) return line.trimStart();
      if (line.trim().length === 0) return '';
      const indent = line.match(/^ */)[0].length;
      return line.slice(Math.min(min, indent));
    })
    .join('\n');
}

function grab(src, label, pattern) {
  const match = src.match(pattern);
  if (!match) {
    throw new Error(`missing snippet ${label}`);
  }
  return canonical(match[0]);
}

function grabReturn(src, label, schemaCall) {
  const idx = src.indexOf(schemaCall);
  if (idx < 0) throw new Error(`missing snippet ${label}: ${schemaCall}`);
  const start = src.lastIndexOf('return {', idx);
  const end = src.indexOf('};', idx);
  if (start < 0 || end < 0) throw new Error(`missing return for ${label}`);
  return canonical(src.slice(start, end + 2));
}

function assertEqual(label, actual, expected) {
  if (actual === expected) {
    console.log(`ok ${label}`);
    return;
  }
  console.error(`DIFF ${label}`);
  console.error('--- package ---');
  console.error(actual);
  console.error('--- ai-bi ---');
  console.error(expected);
  process.exitCode = 1;
}

console.log(`ai-bi ${AI_BI_COMMIT}`);

for (const pair of FILE_PAIRS) {
  const pkgBodies = functionBodies(pair.pkg);
  const refBodies = functionBodies(pair.ref);
  const names = [...refBodies.keys()];
  if (names.length === 0) {
    throw new Error(`no functions in ${pair.ref}`);
  }
  for (const name of names) {
    const pkgBody = pkgBodies.get(name);
    const refBody = refBodies.get(name);
    if (pkgBody === undefined) {
      console.error(`missing function ${name} in ${pair.pkg}`);
      process.exitCode = 1;
      continue;
    }
    assertEqual(`${pair.pkg} ${name}`, pkgBody, refBody);
  }
  assertEqual(
    `whole file ${pair.pkg} minus imports`,
    stripImports(read(pair.pkg)),
    stripImports(read(pair.ref)),
  );
}

const guidancePkg = read('src/guidance-types.ts').trim();
const guidanceRef = read('test/reference/ai-bi/packages/shared/src/guidance-types.ts');
if (!guidanceRef.includes(guidancePkg)) {
  console.error('DIFF src/guidance-types.ts is not a verbatim slice of ai-bi guidance-types.ts');
  process.exitCode = 1;
} else if (/GuidanceMessageIntent|isGuidanceMessageIntent|GuidanceFilter|GuidancePayload/.test(guidancePkg)) {
  console.error('guidance-types.ts includes types parse does not need');
  process.exitCode = 1;
} else {
  console.log('ok src/guidance-types.ts interfaces');
}

const service = read('test/reference/ai-bi/apps/api/src/datasource/datasource.service.ts');
const introspect = read('src/introspect.ts');

const slices = [
  {
    label: 'pg typedRows mapping',
    pattern:
      /const typedRows: SchemaColumnRow\[\] = rows\.map\(\(r\) => \(\{[\s\S]*?is_nullable: r\.is_nullable,[\s\S]*?\}\)\);/,
  },
  {
    label: 'pg mergeEnumMaps(native, check)',
    pattern: /const enumMap = mergeEnumMaps\(nativeEnums, checkEnums\);/,
  },
  {
    label: 'pg tableCount return',
    schemaCall: 'schemaDoc: buildDdl(typedRows, enumMap, foreignKeys)',
  },
  {
    label: 'mysql typedRows cast',
    pattern:
      /const typedRows = rows as Array<\{[\s\S]*?column_type: string;[\s\S]*?\}>;/,
  },
  {
    label: 'mysql enum loop',
    pattern:
      /const enumMap: EnumValueMap = new Map\(\);[\s\S]*?for \(const row of typedRows\) \{[\s\S]*?if \(row\.data_type\.toLowerCase\(\) !== 'enum'\) continue;[\s\S]*?enumMap\.set\(columnEnumKey\(row\.table_name, row\.column_name\), values\);[\s\S]*?\}/,
  },
  {
    label: 'mysql columnRows mapping',
    pattern:
      /const columnRows: SchemaColumnRow\[\] = typedRows\.map\(\(r\) => \(\{[\s\S]*?is_nullable: r\.is_nullable,[\s\S]*?\}\)\);/,
  },
  {
    label: 'mysql tableCount return',
    schemaCall: 'schemaDoc: buildDdl(columnRows, enumMap, foreignKeys)',
  },
];

for (const slice of slices) {
  const actual = slice.schemaCall
    ? grabReturn(introspect, `${slice.label} package`, slice.schemaCall)
    : grab(introspect, `${slice.label} package`, slice.pattern);
  const expected = slice.schemaCall
    ? grabReturn(service, `${slice.label} ai-bi`, slice.schemaCall)
    : grab(service, `${slice.label} ai-bi`, slice.pattern);
  assertEqual(slice.label, actual, expected);
}

const pgFn = grab(
  introspect,
  'buildPostgresSchemaDoc',
  /export function buildPostgresSchemaDoc[\s\S]*?\n\}/,
);
const mysqlFn = grab(
  introspect,
  'buildMysqlSchemaDoc',
  /export function buildMysqlSchemaDoc[\s\S]*?\n\}/,
);

function mustInclude(label, haystack, needle) {
  if (!haystack.includes(needle)) {
    console.error(`missing ${label}: ${needle}`);
    process.exitCode = 1;
  } else {
    console.log(`ok ${label}`);
  }
}

mustInclude('pg native enum mapper', pgFn, 'buildNativeEnumMap(rows, nativeEnumRows)');
mustInclude('pg check enum mapper', pgFn, 'buildCheckEnumMap(checkRows)');
mustInclude('pg fk mapper', pgFn, 'mapPgForeignKeyRows(foreignKeyRows)');
mustInclude('mysql fk mapper', mysqlFn, 'mapMysqlForeignKeyRows(foreignKeyRows)');

if (pgFn.includes('await this.fetch') || mysqlFn.includes('await this.fetch')) {
  console.error('pure builders still call this.fetch*');
  process.exitCode = 1;
} else {
  console.log('ok builders do not call this.fetch*');
}

if (process.exitCode) {
  console.error('function body diff failed');
  process.exit(process.exitCode);
}
console.log('function body diff empty');
