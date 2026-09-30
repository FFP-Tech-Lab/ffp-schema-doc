import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  INTROSPECTION_SQL_KEYS,
  extractIntrospectionSql,
  sha256,
} from '../scripts/introspection-sql';
import { INTROSPECTION_SQL, type IntrospectionSqlKey } from '../src/introspection-sql';

const FIXTURE = path.join('test', 'fixtures', 'introspection-sql.sha256.json');
const GOLDEN_DIRS = [
  path.join('test', 'golden', 'sample-postgres'),
  path.join('test', 'golden', 'synthetic-postgres'),
  path.join('test', 'golden', 'synthetic-mysql'),
];

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

describe('shipped introspection SQL', () => {
  const fixture = readJson<Record<IntrospectionSqlKey, string>>(FIXTURE);

  it('hashes match the committed fixture and every golden metadata file', () => {
    const actual = {} as Record<IntrospectionSqlKey, string>;
    for (const key of INTROSPECTION_SQL_KEYS) {
      actual[key] = sha256(INTROSPECTION_SQL[key]);
    }
    assert.deepEqual(actual, fixture);
    for (const dir of GOLDEN_DIRS) {
      const metadata = readJson<{ introspectionSqlSha256: Record<string, string> }>(
        path.join(dir, 'metadata.json'),
      );
      assert.deepEqual(metadata.introspectionSqlSha256, fixture);
    }
  });

  it('round-trips through extractIntrospectionSql template-text normalization', () => {
    const source = INTROSPECTION_SQL_KEYS.map((key) => {
      const text = INTROSPECTION_SQL[key];
      assert.equal(text.includes('`'), false);
      assert.equal(text.includes('${'), false);
      return 'const statement = `' + text + '`;';
    }).join('\n');
    assert.deepEqual(extractIntrospectionSql(source), INTROSPECTION_SQL);
  });

  it('is a single SELECT with no statement separator', () => {
    for (const key of INTROSPECTION_SQL_KEYS) {
      const text = INTROSPECTION_SQL[key];
      assert.match(text, /^\s*SELECT\b/i);
      assert.equal(text.includes(';'), false);
    }
  });
});
