/**
 * Fail if tracked paths, file contents, package metadata, or commit messages
 * contain names tied to the tree this package was extracted from.
 *
 * Terms are joined from fragments so this file does not contain the literals.
 * The allow-list is empty: every hit fails.
 *
 * Also scans `git log` subject and body text for the same terms.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

function term(parts) {
  return parts.join('');
}

const TERMS = [
  term(['ai', '-', 'bi']),
  term(['ai', '_', 'bi']),
  term(['ai', 'bi']),
  term(['@', 'ai', '-', 'bi']),
  term(['Chu', 'Ting', 'zj']),
  term(['Data', 'Mind']),
  term(['Deep', 'Seek']),
  term(['benchmark', '_', 'bi']),
  term(['packages', '/', 'shared']),
  term(['apps', '/', 'api']),
];

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter((file) => file.length > 0);
}

function commitText() {
  return execFileSync('git', ['log', '--format=%s%n%b'], { encoding: 'utf8' });
}

function findHits(label, text) {
  const lower = text.toLowerCase();
  const hits = [];
  for (const needle of TERMS) {
    if (lower.includes(needle.toLowerCase())) {
      hits.push(`${label}: ${needle}`);
    }
  }
  return hits;
}

const hits = [];
for (const file of trackedFiles()) {
  hits.push(...findHits(`path ${file}`, file));
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    hits.push(`path ${file}: unreadable (${err instanceof Error ? err.message : String(err)})`);
    continue;
  }
  hits.push(...findHits(`file ${file}`, text));
}
hits.push(...findHits('git log', commitText()));

if (hits.length > 0) {
  console.error('standalone name check failed');
  for (const hit of hits) {
    console.error(hit);
  }
  process.exit(1);
}

console.log(`ok: tracked files, paths, package metadata, and commit messages (${TERMS.length} terms, empty allow-list)`);
