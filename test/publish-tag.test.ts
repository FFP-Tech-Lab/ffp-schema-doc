import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

const version = JSON.parse(readFileSync('package.json', 'utf8')).version as string;

function run(tag: string) {
  return spawnSync(process.execPath, ['scripts/check-publish-tag.mjs', tag], {
    encoding: 'utf8',
  });
}

describe('publish tag matches package.json', () => {
  it('accepts v plus the package version', () => {
    const result = run(`v${version}`);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, new RegExp(`tag v${version} matches`));
  });

  it('rejects a stable tag that is not the package version', () => {
    const result = run('v9.9.9');
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      new RegExp(`v9\\.9\\.9 does not equal v${version.replaceAll('.', '\\.')}`),
    );
  });
});
