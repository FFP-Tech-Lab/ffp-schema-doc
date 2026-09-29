/**
 * Whole-file equality against the frozen reference snapshot of the original
 * implementation (commit fa3cbe777545adfb9f3ce2b9c77e394a1daa83e2) under
 * test/reference/fa3cbe7/. Offline: it does not fetch a remote.
 *
 * schema-enum.ts, schema-parse.ts, and schema-fk.ts are compared in full
 * after normalizing import specifiers (`from '...'` -> `from 'NORMALIZED'`).
 * That normalization is the only allowance for the schema-fk.ts specifier,
 * which in the snapshot is a relative `./schema-enum` import. A change to
 * MAX_ENUM_VALUES, a type, a regex, or a new declaration fails.
 *
 * normalizeImports rewrites every `from '...'` specifier, so an import-path
 * redirect (for example schema-fk.ts pointing at a different module) would
 * match the byte compare. The script therefore also requires the exact import
 * lines listed in PINNED_IMPORTS. Those lines are the complete `from '...'`
 * set in the three compared files. A specifier change fails that pin.
 * Residual: `require()` and side-effect `import '...'` (no `from`) are not
 * rewritten and are not in the pin list. None of the compared files use them.
 * A one-sided addition still fails the byte compare. A matching pair of
 * `from` specifiers that is not yet in PINNED_IMPORTS fails the pin until
 * the list is updated in the same change.
 *
 * Each reference file's raw sha256 is pinned in REFERENCE_SHA256, including
 * guidance-types.ts and datasource.service.ts. Editing a reference copy fails
 * even when src/ is edited to match, and even when the edit sits outside a
 * compared slice. The pins are of the bytes in this tree, not a git blob id.
 *
 * introspect.ts is new. Its function bodies are compared to explicit
 * 1-indexed line ranges of datasource.service.ts:
 *   buildPostgresSchemaDoc <- lines 230-245
 *   buildMysqlSchemaDoc    <- lines 341-369
 *
 * datasource.service.ts is not compared as a whole file. Its two package
 * import specifiers were rewritten to the neutral module names
 * `datasource-db` and `schema-doc-shared`. Those lines sit outside the
 * ranges above. The query text is unchanged. The file's sha256 pin still
 * rejects an edit to the reference copy.
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
 * `node scripts/diff-function-bodies.mjs --prove-mutation-fails` checks, in
 * memory, that each of these fails the gate:
 *   - MAX_ENUM_VALUES 50 -> 51
 *   - reversing the localeCompare sort
 *   - widening the parseSchemaDoc table-name regex
 *   - flipping the buildMysqlSchemaDoc enum guard
 *   - changing the schema-fk.ts ordinal fallback
 *   - changing reference schema-enum.ts bytes without updating the sha256 pin
 *   - redirecting the schema-fk.ts import (normalizeImports hides it; the
 *     pinned import line does not)
 * It does not write those edits to disk.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const REFERENCE_COMMIT = 'fa3cbe777545adfb9f3ce2b9c77e394a1daa83e2';
const root = process.cwd();

const REFERENCE_SHA256 = {
  'test/reference/fa3cbe7/schema-enum.ts':
    'ba685975ac8886fde7af8aaba7d92ad2e52a85afe19345a16512f0236749300e',
  'test/reference/fa3cbe7/schema-parse.ts':
    'b63433af98b081bc2dc2878d5aa7c23a26c2905eb341ef520c87622cf263b2cc',
  'test/reference/fa3cbe7/schema-fk.ts':
    '16f9630e5f1d1a03cb53db1b2c98dfaedeb1caed5968e7a0e4b3380c793c8dac',
  'test/reference/fa3cbe7/guidance-types.ts':
    '5b148ab4f5a156a11b990b53b019269d2de805b599630b716d05625477e0923a',
  'test/reference/fa3cbe7/datasource.service.ts':
    '0ce0d59364489f6e32c36684ab8ca7e3a7be5c833a26c4922db11560923b208c',
};

const PINNED_IMPORTS = {
  'src/schema-enum.ts': [],
  'test/reference/fa3cbe7/schema-enum.ts': [],
  'src/schema-parse.ts': ["} from './guidance-types';"],
  'test/reference/fa3cbe7/schema-parse.ts': ["} from './guidance-types';"],
  'src/schema-fk.ts': ["import type { SchemaForeignKeyRow } from './schema-enum';"],
  'test/reference/fa3cbe7/schema-fk.ts': [
    "import type { SchemaForeignKeyRow } from './schema-enum';",
  ],
};

const FILE_PAIRS = [
  {
    pkg: 'src/schema-enum.ts',
    ref: 'test/reference/fa3cbe7/schema-enum.ts',
  },
  {
    pkg: 'src/schema-parse.ts',
    ref: 'test/reference/fa3cbe7/schema-parse.ts',
  },
  {
    pkg: 'src/schema-fk.ts',
    ref: 'test/reference/fa3cbe7/schema-fk.ts',
  },
];

const DATASOURCE = 'test/reference/fa3cbe7/datasource.service.ts';

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

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function importLines(src) {
  return src.split('\n').filter((line) => /from\s+['"]/.test(line));
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

function wholeFileDiffs(pkgOverrides = {}) {
  const diffs = [];
  for (const pair of FILE_PAIRS) {
    const pkg = normalizeImports(pkgOverrides[pair.pkg] ?? read(pair.pkg));
    const ref = normalizeImports(read(pair.ref));
    if (pkg !== ref) {
      diffs.push(`${pair.pkg} !== ${pair.ref}\n${firstDiff(pkg, ref)}`);
    }
  }
  return diffs;
}

function sliceDiffs(introspectOverride) {
  const introspect = introspectOverride ?? read('src/introspect.ts');
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

function hashProblems(overrides = {}) {
  const problems = [];
  for (const [rel, expected] of Object.entries(REFERENCE_SHA256)) {
    const actual = sha256(overrides[rel] ?? read(rel));
    if (actual !== expected) {
      problems.push(`${rel} sha256 ${actual} !== pinned ${expected}`);
    }
  }
  return problems;
}

function importProblems(overrides = {}) {
  const problems = [];
  for (const [rel, expected] of Object.entries(PINNED_IMPORTS)) {
    const actual = importLines(overrides[rel] ?? read(rel));
    if (actual.join('\n') !== expected.join('\n')) {
      problems.push(
        `${rel} import lines ${JSON.stringify(actual)} !== pinned ${JSON.stringify(expected)}`,
      );
    }
  }
  return problems;
}

function requireChange(label, before, after) {
  if (before === after) {
    console.error(`could not apply mutation: ${label}`);
    process.exit(1);
  }
}

function requireDetected(label, diffs) {
  if (diffs.length === 0) {
    console.error(`${label} was not detected`);
    process.exit(1);
  }
  console.log(`ok: ${label} fails the body diff`);
}

function proveMutationFails() {
  const clean = [
    ...wholeFileDiffs(),
    ...sliceDiffs(),
    ...hashProblems(),
    ...importProblems(),
  ];
  if (clean.length > 0) {
    console.error('clean tree does not match the frozen bodies or pins');
    for (const diff of clean) {
      console.error(`\n${diff}`);
    }
    process.exit(1);
  }

  const enumSrc = read('src/schema-enum.ts');
  const maxMutated = enumSrc.replace(
    'const MAX_ENUM_VALUES = 50;',
    'const MAX_ENUM_VALUES = 51;',
  );
  requireChange('MAX_ENUM_VALUES 50 -> 51', enumSrc, maxMutated);
  requireDetected(
    'MAX_ENUM_VALUES 50 -> 51',
    wholeFileDiffs({ 'src/schema-enum.ts': maxMutated }),
  );

  const sortMutated = enumSrc.replace(
    'out.sort((a, b) => a.localeCompare(b));',
    'out.sort((a, b) => b.localeCompare(a));',
  );
  requireChange('localeCompare sort', enumSrc, sortMutated);
  requireDetected(
    'localeCompare sort reversed',
    wholeFileDiffs({ 'src/schema-enum.ts': sortMutated }),
  );

  const parseSrc = read('src/schema-parse.ts');
  const parseMutated = parseSrc.replace(
    '/CREATE TABLE\\s+["\'`]?(\\w+)["\'`]?/i',
    '/CREATE TABLE\\s+["\'`]?(\\w*)["\'`]?/i',
  );
  requireChange('parseSchemaDoc table-name regex', parseSrc, parseMutated);
  requireDetected(
    'parseSchemaDoc table-name regex',
    wholeFileDiffs({ 'src/schema-parse.ts': parseMutated }),
  );

  const introspect = read('src/introspect.ts');
  const mysqlMutated = introspect.replace(
    "if (row.data_type.toLowerCase() !== 'enum') continue;",
    "if (row.data_type.toLowerCase() === 'enum') continue;",
  );
  requireChange('buildMysqlSchemaDoc enum guard', introspect, mysqlMutated);
  requireDetected('buildMysqlSchemaDoc enum guard', sliceDiffs(mysqlMutated));

  const fkSrc = read('src/schema-fk.ts');
  const fkMutated = fkSrc.replace(
    'ordinal_position: Number(r.ordinal_position) || 1,',
    'ordinal_position: Number(r.ordinal_position) || 2,',
  );
  requireChange('schema-fk.ts ordinal fallback', fkSrc, fkMutated);
  requireDetected(
    'schema-fk.ts ordinal fallback',
    wholeFileDiffs({ 'src/schema-fk.ts': fkMutated }),
  );

  const refEnumRel = 'test/reference/fa3cbe7/schema-enum.ts';
  const refEnum = read(refEnumRel);
  const refMutated = refEnum.replace(
    'const MAX_ENUM_VALUES = 50;',
    'const MAX_ENUM_VALUES = 51;',
  );
  requireChange('reference schema-enum.ts bytes', refEnum, refMutated);
  if (sha256(refEnum) !== REFERENCE_SHA256[refEnumRel]) {
    console.error('pinned sha256 does not match the current reference file');
    process.exit(1);
  }
  const refDiffs = hashProblems({ [refEnumRel]: refMutated });
  if (refDiffs.length === 0) {
    console.error('reference byte change was not detected by the pinned sha256');
    process.exit(1);
  }
  console.log('ok: reference schema-enum.ts byte change fails the pinned sha256');

  const redirected = fkSrc.replace("from './schema-enum'", "from './schema-parse'");
  requireChange('schema-fk.ts import redirect', fkSrc, redirected);
  if (normalizeImports(redirected) !== normalizeImports(fkSrc)) {
    console.error('normalizeImports unexpectedly exposed an import-path redirect');
    process.exit(1);
  }
  const importDiffs = importProblems({ 'src/schema-fk.ts': redirected });
  if (importDiffs.length === 0) {
    console.error('pinned import line did not catch the schema-fk.ts redirect');
    process.exit(1);
  }
  console.log(
    'ok: schema-fk.ts import redirect fails the pinned import line (normalizeImports hides it)',
  );
}

if (process.argv.includes('--prove-mutation-fails')) {
  proveMutationFails();
} else {
  const diffs = [
    ...wholeFileDiffs(),
    ...sliceDiffs(),
    ...hashProblems(),
    ...importProblems(),
  ];
  if (diffs.length > 0) {
    console.error(`body diff failed against ${REFERENCE_COMMIT}`);
    for (const diff of diffs) {
      console.error(`\n${diff}`);
    }
    process.exit(1);
  }
  console.log(
    `ok: whole-file and introspect slices match ${REFERENCE_COMMIT}; reference sha256 and import lines are pinned`,
  );
}
