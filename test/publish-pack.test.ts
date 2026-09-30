import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

const scriptSource = path.resolve('scripts/check-publish-pack.mjs');
const workflowPath = path.join(__dirname, '../.github/workflows/publish-npm.yml');

function runScript(script: string, args: readonly string[], env?: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: env === undefined ? process.env : { ...process.env, ...env },
  });
}

function scriptTempDirs(): string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith('publish-pack-'));
}

function withTemp(run: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'pack-fixture-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeFixture(
  dir: string,
  pkg: { name: string; version: string; files: string[] },
  files: Readonly<Record<string, string>>,
): string {
  mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(pkg)}\n`);
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, contents);
  }
  const script = path.join(dir, 'scripts', 'check-publish-pack.mjs');
  cpSync(scriptSource, script);
  return script;
}

function makeTarball(
  dir: string,
  name: string,
  files: Readonly<Record<string, string>>,
  symlink?: { link: string; target: string },
): string {
  const root = path.join(dir, `${name}-root`);
  const packageDir = path.join(root, 'package');
  mkdirSync(packageDir, { recursive: true });
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(packageDir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, contents);
  }
  if (symlink) {
    symlinkSync(symlink.target, path.join(packageDir, symlink.link));
  }
  const tarball = path.join(dir, `${name}.tgz`);
  execFileSync('tar', ['-czf', tarball, '-C', root, 'package']);
  return tarball;
}

function makeMemberTarball(dir: string, name: string, arcname: string): string {
  const tarball = path.join(dir, `${name}.tgz`);
  const script = [
    'import io, sys, tarfile',
    'tarball, arcname = sys.argv[1], sys.argv[2]',
    'data = b"pwned\\n"',
    'with tarfile.open(tarball, "w:gz") as tar:',
    '    info = tarfile.TarInfo(arcname)',
    '    info.size = len(data)',
    '    tar.addfile(info, io.BytesIO(data))',
  ].join('\n');
  execFileSync('python3', ['-c', script, tarball, arcname]);
  return tarball;
}

function makeRootTarball(dir: string, name: string, prepare: (root: string) => void): string {
  const root = path.join(dir, `${name}-root`);
  mkdirSync(root);
  prepare(root);
  const tarball = path.join(dir, `${name}.tgz`);
  execFileSync('tar', ['-czf', tarball, '-C', root, '.']);
  return tarball;
}

const matchingPkg = {
  name: 'pack-fixture',
  version: '0.2.0',
  files: ['dist', 'README.md', 'LICENSE'],
};
const matchingFiles = {
  'README.md': 'readme\n',
  LICENSE: 'license\n',
  'dist/index.js': 'module.exports = {};\n',
};

describe('check-publish-pack manifest', { concurrency: false }, () => {
  it('passes when the packed version matches the tag', () => {
    withTemp((dir) => {
      const script = writeFixture(dir, matchingPkg, matchingFiles);
      const result = runScript(script, ['manifest', '0.2.0']);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /ok: pack version 0\.2\.0/);
    });
  });

  it('fails when the pack version is not the tag', () => {
    withTemp((dir) => {
      const script = writeFixture(dir, matchingPkg, matchingFiles);
      for (const tag of ['0.1.0', 'v0.2.0', '0.2.0-x']) {
        const result = runScript(script, ['manifest', tag]);
        assert.equal(result.status, 1, tag);
        assert.match(result.stderr, new RegExp(`does not equal tag version ${tag.replaceAll('.', '\\.')}`));
      }
    });
  });

  it('fails when the pack contains a file that is not expected', () => {
    withTemp((dir) => {
      const script = writeFixture(
        dir,
        { name: 'pack-fixture', version: '0.2.0', files: ['dist'] },
        { 'dist/index.js': 'module.exports = {};\n', 'README.md': 'readme\n' },
      );
      const result = runScript(script, ['manifest', '0.2.0']);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /unexpected in pack: README\.md/);
    });
  });

  it('fails when an expected file is missing from the pack', () => {
    withTemp((dir) => {
      const script = writeFixture(
        dir,
        { name: 'pack-fixture', version: '0.2.0', files: ['dist'] },
        { 'dist/index.js': 'module.exports = {};\n', 'dist/npm-debug.log': 'noise\n' },
      );
      const result = runScript(script, ['manifest', '0.2.0']);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /missing from pack: dist\/npm-debug\.log/);
    });
  });

  it('fails when the version argument is empty', () => {
    const result = runScript(scriptSource, ['manifest', '']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /manifest check needs the tag version/);
  });

  it('fails when package.json files is an empty array', () => {
    withTemp((dir) => {
      const script = writeFixture(
        dir,
        { name: 'pack-fixture', version: '0.2.0', files: [] },
        { 'secret.txt': 'secret\n' },
      );
      const result = runScript(script, ['manifest', '0.2.0']);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /package\.json files must be a non-empty array/);
    });
  });
});

describe('check-publish-pack contents', { concurrency: false }, () => {
  it('passes when published and local trees match by per-file sha256', () => {
    withTemp((dir) => {
      const files = { 'package.json': '{"name":"fixture","version":"0.2.0"}\n', 'README.md': 'same\n' };
      const published = makeTarball(dir, 'published', files);
      const local = makeTarball(dir, 'local', files);
      const result = runScript(scriptSource, ['contents', published, local]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /packed files match by content sha256/);
    });
  });

  it('fails when package.json content differs', () => {
    withTemp((dir) => {
      const published = makeTarball(dir, 'published', {
        'package.json': '{"name":"fixture","version":"0.2.0"}\n',
        'README.md': 'same\n',
      });
      const local = makeTarball(dir, 'local', {
        'package.json': '{"name":"fixture","version":"0.2.1"}\n',
        'README.md': 'same\n',
      });
      const result = runScript(scriptSource, ['contents', published, local]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /content differs: package\.json/);
    });
  });

  it('fails when a file is only in the local pack', () => {
    withTemp((dir) => {
      const published = makeTarball(dir, 'published', { 'README.md': 'same\n' });
      const local = makeTarball(dir, 'local', { 'README.md': 'same\n', 'extra.txt': 'local-only\n' });
      const result = runScript(scriptSource, ['contents', published, local]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /only in local pack: extra\.txt/);
    });
  });

  it('fails when a file is only in the published pack', () => {
    withTemp((dir) => {
      const published = makeTarball(dir, 'published', { 'README.md': 'same\n', 'extra.txt': 'published-only\n' });
      const local = makeTarball(dir, 'local', { 'README.md': 'same\n' });
      const result = runScript(scriptSource, ['contents', published, local]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /only in published pack: extra\.txt/);
    });
  });

  it('fails when a pack has 0 files', () => {
    withTemp((dir) => {
      const published = makeTarball(dir, 'published', {});
      const local = makeTarball(dir, 'local', {});
      const result = runScript(scriptSource, ['contents', published, local]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /0 files/);
    });
  });

  it('fails when a pack contains a symlink', () => {
    withTemp((dir) => {
      const published = makeTarball(dir, 'published', { 'README.md': 'same\n' }, { link: 'alias', target: 'README.md' });
      const local = makeTarball(dir, 'local', { 'README.md': 'same\n' });
      const result = runScript(scriptSource, ['contents', published, local]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /is not a regular file/);
    });
  });

  it('fails when tar extraction fails and does not leak a temp dir', () => {
    withTemp((dir) => {
      const bogus = path.join(dir, 'not-a-tarball.tgz');
      writeFileSync(bogus, 'not a tarball');
      const before = new Set(scriptTempDirs());
      const result = runScript(scriptSource, ['contents', bogus, bogus]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /failed to extract/);
      const leaked = scriptTempDirs().filter((name) => !before.has(name));
      assert.deepEqual(leaked, []);
    });
  });

  it('leaves no temp dir after a successful contents check', () => {
    withTemp((dir) => {
      const childTmp = path.join(dir, 'child-tmp');
      mkdirSync(childTmp);
      const files = { 'README.md': 'same\n' };
      const published = makeTarball(dir, 'published', files);
      const local = makeTarball(dir, 'local', files);
      const result = runScript(scriptSource, ['contents', published, local], { TMPDIR: childTmp });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.deepEqual(readdirSync(childTmp), []);
    });
  });

  it('does not write absolute or parent-path entries outside the temp dir', () => {
    withTemp((dir) => {
      const outside = path.join(dir, 'outside');
      mkdirSync(outside);
      const absSentinel = path.join(outside, 'abs-sentinel');
      const childTmp = path.join(dir, 'child-tmp');
      mkdirSync(childTmp);
      const dotSentinel = path.join(childTmp, 'outside', 'dotdot-sentinel');
      const absTar = makeMemberTarball(dir, 'abs', absSentinel);
      const dotTar = makeMemberTarball(dir, 'dot', '../outside/dotdot-sentinel');
      for (const tarball of [absTar, dotTar]) {
        const result = runScript(scriptSource, ['contents', tarball, tarball], { TMPDIR: childTmp });
        assert.equal(existsSync(absSentinel), false);
        assert.equal(existsSync(dotSentinel), false);
        assert.ok(result.status === 0 || result.status === 1, `status ${result.status}\n${result.stderr}`);
      }
    });
  });

  it('fails when package/ is missing or is a file', () => {
    withTemp((dir) => {
      const missing = makeRootTarball(dir, 'missing', (root) => {
        writeFileSync(path.join(root, 'README.md'), 'readme\n');
      });
      const asFile = makeRootTarball(dir, 'as-file', (root) => {
        writeFileSync(path.join(root, 'package'), 'not-a-directory\n');
      });
      const missingResult = runScript(scriptSource, ['contents', missing, missing]);
      assert.equal(missingResult.status, 1);
      assert.match(missingResult.stderr, /has no package\/ directory/);
      assert.equal(missingResult.stderr.includes('readdirSync'), false);
      const fileResult = runScript(scriptSource, ['contents', asFile, asFile]);
      assert.equal(fileResult.status, 1);
      assert.match(fileResult.stderr, /package\/ is not a directory/);
      assert.equal(fileResult.stderr.includes('readdirSync'), false);
    });
  });
});

describe('publish workflow lines', () => {
  it('keeps the load-bearing publish job lines', () => {
    const yaml = readFileSync(workflowPath, 'utf8');
    const testJob = yaml.slice(yaml.indexOf('\n  test:'), yaml.indexOf('\n  publish:'));
    const publishJob = yaml.slice(yaml.indexOf('\n  publish:'));
    assert.match(yaml, /--ignore-scripts/);
    assert.match(publishJob, /--provenance/);
    assert.match(publishJob, /environment: npm-publish/);
    assert.match(publishJob, /id-token: write/);
    assert.equal(testJob.includes('id-token: write'), false);
    assert.equal(yaml.includes('NPM_TOKEN'), false);
  });
});
