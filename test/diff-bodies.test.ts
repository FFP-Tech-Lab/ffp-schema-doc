import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

describe('whole-file body diff', () => {
  it('fails the listed in-memory mutations', () => {
    const result = spawnSync(
      process.execPath,
      ['scripts/diff-function-bodies.mjs', '--prove-mutation-fails'],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /MAX_ENUM_VALUES 50 -> 51 fails/);
    assert.match(result.stdout, /localeCompare sort reversed fails/);
    assert.match(result.stdout, /parseSchemaDoc table-name regex fails/);
    assert.match(result.stdout, /buildMysqlSchemaDoc enum guard fails/);
    assert.match(result.stdout, /schema-fk\.ts ordinal fallback fails/);
    assert.match(result.stdout, /reference schema-enum\.ts byte change fails the pinned sha256/);
    assert.match(result.stdout, /schema-fk\.ts import redirect fails the pinned import line/);
  });
});
