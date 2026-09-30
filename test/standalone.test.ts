import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

describe('standalone names', () => {
  it('finds no extracted-project names in tracked files or commit messages', () => {
    const result = spawnSync(process.execPath, ['scripts/check-standalone.mjs'], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /empty allow-list/);
  });
});