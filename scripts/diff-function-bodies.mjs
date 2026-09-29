/**
 * Whole-file equality against the ai-bi sources frozen at AI_BI_COMMIT
 * under test/reference/. Offline: it does not fetch GitHub.
 *
 * schema-enum.ts, schema-parse.ts, and schema-fk.ts are compared in full
 * after normalizing import specifiers (`from '...'` -> `from 'NORMALIZED'`).
 * A change to MAX_ENUM_VALUES, a type, a regex, or a new declaration fails.
 *
 * introspect.ts is new. Its function bodies are compared to explicit
 * 1-indexed line ranges of datasource.service.ts:
 *   buildPostgresSchemaDoc <- lines 230-245 (extractPostgresSchema)
 *   buildMysqlSchemaDoc    <- lines 341-369 (extractMysqlSchema)
 *
 * Normalization for those slices, and nothing else:
 *   1. Dedent (strip the shared leading indent).
 *   2. Replace these fetch calls with the mapper calls the package uses:
 *        await this.fetchPostgresNativeEnums(client, rows)
 *          -> buildNativeEnumMap(rows, nativeEnumRows)
 *        await this.fetchPostgresCheckEnums(client)
 *          -> buildCheckEnumMap(checkRows)
 *        await this.fetchPostgresForeignKeys(client)
 *          -> mapPgForeignKeyRows(foreignKeyRows)
 *        await this.fetchMysqlForeignKeys(conn, ds.database)
 *          -> mapMysqlForeignKeyRows(foreignKeyRows)
 * Any other difference fails.
 *
 * `node scripts/diff-function-bodies.mjs --prove-mutation-fails` checks that
 * changing MAX_ENUM_VALUES from 50 to 51 fails the whole-file compare, without
 * writing that change to disk.
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

const DATASOURCE = 'test/reference/ai-bi/apps/api/src/datasource/datasource.service.ts';

const SLICES = [
  {
    fn: 'buildPostgresSchemaDoc',
    start: 230,
    end: 245,
    replacements: [
      [
        'const nativeEnums = await this.fetchPostgresNativeEnums(client, rows);',
        'const nativeEnums = buildNativeEnumMap(rows, nativeEnumRows);',
      ],
      [
        'const checkEnums = await this.fetchPostgresCheckEnums(client);',
        'const checkEnums = buildCheckEnumMap(checkRows);',
      ],
      [
        'const foreignKeys = await this.fetchPostgresForeignKeys(client);',
        'const foreignKeys = mapPgForeignKeyRows(foreignKeyRows);',
      ],
    ],
  },
  {
    fn: 'buildMysqlSchemaDoc',
    start: 341,
    end: 369,
    replacements: [
      [
        'const foreignKeys = await this.fetchMysqlForeignKeys(conn, ds.database);',
        'const foreignKeys = mapMysqlForeignKeyRows(foreignKeyRows);',
      ],
    ],
  },
];

function read(rel) {
  return readFileSync(path.join(root, rel), 'utf8');
}

function normalizeImports(src) {
  return src.replace(/from\s+(['"])[^'"]+\1/g, 'from $1NORMALIZED$1');
}

function dedent(text) {
  const lines = text.split('\n');
  const indents = lines
    .filter((line) => line.trim().length > 0)
    .map((line) => line.match(/^[ ]*/)[0].length);
  const min = indents.length === 0 ? 0 : Math.min(...indents);
  return lines
    .map((line) => (line.trim().length === 0 ? '' : line.slice(min)))
    .join('\n');
}

function normalizedBlock(text) {
  return `${dedent(text).trim()}\n`;
}

function sliceLines(src, start, end) {
  const lines = src.split('\n');
  return lines.slice(start - 1, end).join('\n');
}

function applyReplacements(text, replacements) {
  let out = text;
  for (const [from, to] of replacements) {
    if (!out.includes(from)) {
      throw new Error(`reference slice is missing the expected line:\n${from}`);
    }
    out = out.replaceAll(from, to);
  }
  if (out.includes('this.fetch')) {
    throw new Error(`unreplaced this.fetch remains after normalization:\n${out}`);
  }
  return out;
}

function functionBody(src, name) {
  const sourceFile = ts.createSourceFile(
    'introspect.ts',
    src,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let body = null;
  function visit(node) {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name &&
      node.name.text === name &&
      node.body
    ) {
      body = node.body;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  if (!body) {
    throw new Error(`missing function ${name}`);
  }
  const text = body.getText(sourceFile);
  if (!text.startsWith('{') || !text.endsWith('}')) {
    throw new Error(`function ${name} body is not a block`);
  }
  return text.slice(1, -1);
}

function firstDiff(a, b) {
  const aLines = a.split('\n');
  const bLines = b.split('\n');
  const limit = Math.max(aLines.length, bLines.length);
  for (let i = 0; i < limit; i += 1) {
    if (aLines[i] !== bLines[i]) {
      return `line ${i + 1}\n  pkg: ${aLines[i] ?? '<eof>'}\n  ref: ${bLines[i] ?? '<eof>'}`;
    }
  }
  return 'files differ only by length';
}

function wholeFileDiffs() {
  const diffs = [];
  for (const pair of FILE_PAIRS) {
    const pkg = normalizeImports(read(pair.pkg));
    const ref = normalizeImports(read(pair.ref));
    if (pkg !== ref) {
      diffs.push(`${pair.pkg} !== ${pair.ref}\n${firstDiff(pkg, ref)}`);
    }
  }
  return diffs;
}

function sliceDiffs() {
  const introspect = read('src/introspect.ts');
  const datasource = read(DATASOURCE);
  const diffs = [];
  for (const slice of SLICES) {
    const reference = normalizedBlock(
      applyReplacements(sliceLines(datasource, slice.start, slice.end), slice.replacements),
    );
    const body = normalizedBlock(functionBody(introspect, slice.fn));
    if (body !== reference) {
      diffs.push(
        `${slice.fn} !== datasource.service.ts lines ${slice.start}-${slice.end}\n${firstDiff(body, reference)}`,
      );
    }
  }
  return diffs;
}

function proveMutationFails() {
  const pair = FILE_PAIRS[0];
  const original = read(pair.pkg);
  const mutated = original.replace(
    'const MAX_ENUM_VALUES = 50;',
    'const MAX_ENUM_VALUES = 51;',
  );
  if (mutated === original || !mutated.includes('const MAX_ENUM_VALUES = 51;')) {
    console.error('could not mutate MAX_ENUM_VALUES from 50 to 51');
    process.exit(1);
  }
  const ref = normalizeImports(read(pair.ref));
  if (normalizeImports(original) !== ref) {
    console.error(`${pair.pkg} does not match the frozen reference before mutation`);
    process.exit(1);
  }
  if (normalizeImports(mutated) === ref) {
    console.error('MAX_ENUM_VALUES 50 -> 51 was not detected');
    process.exit(1);
  }
  console.log(
    `ok: MAX_ENUM_VALUES 50 -> 51 fails whole-file equality against ${pair.ref} (${AI_BI_COMMIT})`,
  );
}

if (process.argv.includes('--prove-mutation-fails')) {
  proveMutationFails();
} else {
  const diffs = [...wholeFileDiffs(), ...sliceDiffs()];
  if (diffs.length > 0) {
    console.error(`body diff failed against ${AI_BI_COMMIT}`);
    for (const diff of diffs) {
      console.error(`\n${diff}`);
    }
    process.exit(1);
  }
  console.log(`ok: whole-file and introspect slices match ${AI_BI_COMMIT}`);
}
