/**
 * Pack checks for the publish job.
 *
 *   node scripts/check-publish-pack.mjs manifest <version>
 *   node scripts/check-publish-pack.mjs contents <published.tgz> <local.tgz>
 *
 * `manifest` fails unless `npm pack --dry-run --json` lists exactly
 * package.json plus every file under the package.json `files` entries, and
 * the packed version equals <version>.
 *
 * `contents` compares per-file sha256 of the two extracted tarballs.
 * Tar headers and gzip metadata are ignored.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function walkFiles(absDir, relDir) {
  const names = readdirSync(absDir).sort();
  const files = [];
  for (const name of names) {
    const abs = path.join(absDir, name);
    const rel = relDir ? `${relDir}/${name}` : name;
    const info = statSync(abs);
    if (info.isDirectory()) {
      files.push(...walkFiles(abs, rel));
      continue;
    }
    if (!info.isFile()) {
      fail(`${rel} is not a regular file`);
    }
    files.push(toPosix(rel));
  }
  return files;
}

function expectedPackedFiles() {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (!Array.isArray(pkg.files) || pkg.files.length === 0) {
    fail('package.json files must be a non-empty array');
  }
  const expected = new Set(['package.json']);
  for (const entry of pkg.files) {
    if (typeof entry !== 'string' || entry.length === 0) {
      fail('package.json files entries must be non-empty strings');
    }
    const abs = path.join(root, entry);
    let info;
    try {
      info = statSync(abs);
    } catch (err) {
      fail(`files entry ${entry} is missing (${err instanceof Error ? err.message : String(err)})`);
    }
    if (info.isFile()) {
      expected.add(toPosix(entry));
      continue;
    }
    if (info.isDirectory()) {
      for (const file of walkFiles(abs, entry)) expected.add(file);
      continue;
    }
    fail(`files entry ${entry} is not a file or directory`);
  }
  return expected;
}

function readPackManifest() {
  const result = spawnSync(
    'npm',
    ['pack', '--dry-run', '--json', '--ignore-scripts'],
    { cwd: root, encoding: 'utf8' },
  );
  if (result.error) fail(result.error.message);
  if (result.status !== 0) {
    fail(result.stderr || result.stdout || 'npm pack --dry-run failed');
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (err) {
    fail(`npm pack --dry-run did not print JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  const item = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!item || typeof item.version !== 'string' || !Array.isArray(item.files)) {
    fail('npm pack --dry-run JSON has no version or files');
  }
  const files = item.files.map((file) => {
    if (typeof file === 'string') return file;
    if (file && typeof file.path === 'string') return file.path;
    fail('npm pack --dry-run listed a file without a path');
  });
  return { version: item.version, files };
}

function checkManifest(version) {
  if (typeof version !== 'string' || version.length === 0) {
    fail('manifest check needs the tag version (X.Y.Z)');
  }
  const packed = readPackManifest();
  if (packed.version !== version) {
    fail(`packed version ${packed.version} does not equal tag version ${version}`);
  }
  const expected = expectedPackedFiles();
  const actual = new Set(packed.files);
  const missing = [...expected].filter((file) => !actual.has(file)).sort();
  const extra = [...actual].filter((file) => !expected.has(file)).sort();
  if (missing.length > 0 || extra.length > 0) {
    if (missing.length > 0) console.error(`missing from pack: ${missing.join(', ')}`);
    if (extra.length > 0) console.error(`unexpected in pack: ${extra.join(', ')}`);
    fail('packed file list does not match package.json files plus package.json');
  }
  console.log(`ok: pack version ${packed.version} lists ${actual.size} files`);
}

function fileHashes(tarball) {
  const dir = mkdtempSync(path.join(tmpdir(), 'publish-pack-'));
  try {
    const extracted = spawnSync('tar', ['-xzf', tarball, '-C', dir], { encoding: 'utf8' });
    if (extracted.status !== 0) {
      fail(extracted.stderr || `failed to extract ${tarball}`);
    }
    const packageDir = path.join(dir, 'package');
    let info;
    try {
      info = statSync(packageDir);
    } catch (err) {
      fail(`${tarball} has no package/ directory (${err instanceof Error ? err.message : String(err)})`);
    }
    if (!info.isDirectory()) fail(`${tarball} package/ is not a directory`);
    const hashes = new Map();
    for (const rel of walkFiles(packageDir, '')) {
      const bytes = readFileSync(path.join(packageDir, rel));
      hashes.set(rel, createHash('sha256').update(bytes).digest('hex'));
    }
    return hashes;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function checkContents(publishedTarball, localTarball) {
  if (!publishedTarball || !localTarball) {
    fail('contents check needs the published tarball and the local tarball');
  }
  const published = fileHashes(publishedTarball);
  const local = fileHashes(localTarball);
  const keys = new Set([...published.keys(), ...local.keys()]);
  const problems = [];
  for (const key of [...keys].sort()) {
    if (!published.has(key)) problems.push(`only in local pack: ${key}`);
    else if (!local.has(key)) problems.push(`only in published pack: ${key}`);
    else if (published.get(key) !== local.get(key)) problems.push(`content differs: ${key}`);
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    fail('published tarball file contents do not match the local pack');
  }
  console.log(`ok: ${published.size} packed files match by content sha256`);
}

const [command, first, second] = process.argv.slice(2);
switch (command) {
  case 'manifest':
    checkManifest(first);
    break;
  case 'contents':
    checkContents(first, second);
    break;
  default:
    fail('usage: node scripts/check-publish-pack.mjs manifest <version> | contents <published.tgz> <local.tgz>');
}
