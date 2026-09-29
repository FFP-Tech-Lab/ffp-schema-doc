import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

describe('whole-file body diff', () => {
  it('fails when MAX_ENUM_VALUES changes from 50 to 51', () => {
    const result = spawnSync(
      process.execPath,
      ['scripts/diff-function-bodies.mjs', '--prove-mutation-fails'],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /MAX_ENUM_VALUES 50 -> 51 fails/);
  });
});
