/**
 * Fail unless the pushed tag equals `v` plus the version in package.json.
 *
 * Usage: node scripts/check-publish-tag.mjs vX.Y.Z
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tag = process.argv[2];
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const expected = `v${pkg.version}`;

if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
  console.error('package.json version is missing');
  process.exit(1);
}

if (tag !== expected) {
  console.error(`tag ${tag ?? '<missing>'} does not equal ${expected} (package.json version ${pkg.version})`);
  process.exit(1);
}

console.log(`ok: tag ${tag} matches package.json version ${pkg.version}`);
