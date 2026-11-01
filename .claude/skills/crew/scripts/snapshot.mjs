#!/usr/bin/env node
// Source-identity helper for the /crew workflow. Zero dependencies, Node >= 20.
//
//   node snapshot.mjs capture <baseline.json> [--root <dir>] [--exclude <prefix>]...
//   node snapshot.mjs scope <baseline.json> <scope.json> [--criteria <file>]... [--root <dir>]
//   node snapshot.mjs verify <scope.json> [--source-only] [--root <dir>]
//
// capture: records the SHA-256 of every project file (tracked + untracked, honoring .gitignore
//          when inside Git, including repositories without commits).
// scope:   compares the current tree to a baseline and writes the exact review scope: every
//          added, modified, and removed path with content hashes, the hashes of the criteria
//          files (plan, AGENTS.md, ...), and one fingerprint over all of it.
// verify:  recomputes the scope from the same baseline and exits 1 if anything differs, even
//          when file names, line counts, and diff statistics are unchanged. --source-only ignores
//          criteria changes (for example plan status updates made after acceptance).
//
// Only hashes are stored, never file contents. Secrets-like files are skipped outside Git.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, readlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const ALWAYS_EXCLUDED = ['.git/', '.crew/', 'node_modules/'];
const SECRET_PATTERNS = [/(^|\/)\.env(\..+)?$/, /\.pem$/, /\.key$/];
const SECRET_ALLOWED = [/(^|\/)\.env\.example$/];

function parseArgs(argv) {
  const positional = [];
  const options = { root: process.cwd(), exclude: [], criteria: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--root') options.root = argv[++i];
    else if (arg === '--exclude') options.exclude.push(argv[++i]);
    else if (arg === '--criteria') options.criteria.push(argv[++i]);
    else if (arg === '--source-only') options.sourceOnly = true;
    else if (arg === '-h' || arg === '--help') options.help = true;
    else positional.push(arg);
  }
  options.root = resolve(options.root);
  return { positional, options };
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const toPosix = (p) => p.split(sep).join('/');

function git(root, args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
}

function isExcluded(path, extra) {
  if (ALWAYS_EXCLUDED.some((prefix) => path === prefix.slice(0, -1) || path.startsWith(prefix) || path.includes(`/${prefix}`))) return true;
  return extra.some((prefix) => path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`));
}

function walk(root, dir = root, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    const rel = toPosix(relative(root, abs));
    if (entry.isDirectory()) {
      if (!isExcluded(`${rel}/`, [])) walk(root, abs, out);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      const secret = SECRET_PATTERNS.some((re) => re.test(rel)) && !SECRET_ALLOWED.some((re) => re.test(rel));
      if (!secret) out.push(rel);
    }
  }
  return out;
}

function listFiles(root, exclude) {
  const inGit = git(root, ['rev-parse', '--is-inside-work-tree'])?.trim() === 'true';
  let files;
  if (inGit) {
    // --cached + --others covers tracked and new untracked files, and works before the first commit.
    const out = git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--full-name', '.']);
    const prefix = git(root, ['rev-parse', '--show-prefix'])?.trim() ?? '';
    files = (out ?? '').split('\0').filter(Boolean).map((p) => (prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p));
  } else {
    files = walk(root);
  }
  const unique = [...new Set(files)].filter((p) => !isExcluded(p, exclude)).sort();
  return { inGit, files: unique };
}

const FORMAT = 2;

// Source entries: a symlink's identity is its target path; a file's is its bytes. Distinct type tags
// keep a symlink and a regular file from ever hashing alike.
function hashEntry(root, rel) {
  const abs = join(root, rel);
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    return null;
  }
  if (st.isSymbolicLink()) return sha256(Buffer.concat([Buffer.from('symlink\0'), Buffer.from(readlinkSync(abs))]));
  if (!st.isFile()) return null;
  return sha256(Buffer.concat([Buffer.from('file\0'), readFileSync(abs)]));
}

// Criteria are judged by what they say, so follow symlinks and hash the contents.
function hashContents(root, rel) {
  try {
    return sha256(Buffer.concat([Buffer.from('file\0'), readFileSync(join(root, rel))]));
  } catch {
    return null;
  }
}

function capture(root, exclude) {
  const { inGit, files } = listFiles(root, exclude);
  const head = inGit ? git(root, ['rev-parse', '--verify', '--quiet', 'HEAD'])?.trim() || null : null;
  const hashes = {};
  for (const rel of files) {
    const h = hashEntry(root, rel);
    if (h) hashes[rel] = h;
  }
  return { version: FORMAT, capturedAt: new Date().toISOString(), git: inGit, head, exclude, files: hashes };
}

function computeScope(root, baseline, criteriaPaths) {
  if (baseline.version !== FORMAT) throw new Error(`baseline format ${baseline.version} is not ${FORMAT}; capture a new baseline`);
  const current = capture(root, baseline.exclude ?? []);
  const changes = [];
  const paths = new Set([...Object.keys(baseline.files), ...Object.keys(current.files)]);
  for (const path of [...paths].sort()) {
    const before = baseline.files[path] ?? null;
    const after = current.files[path] ?? null;
    if (before === after) continue;
    changes.push({ path, status: before === null ? 'added' : after === null ? 'removed' : 'modified', before, after });
  }
  const criteria = criteriaPaths.map((p) => ({ path: toPosix(p), hash: hashContents(root, p) }));
  const canonical = JSON.stringify({ changes, criteria });
  return { changes, criteria, fingerprint: sha256(canonical) };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, data) {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

function usage() {
  console.log(`Usage:
  node snapshot.mjs capture <baseline.json> [--root <dir>] [--exclude <prefix>]...
  node snapshot.mjs scope <baseline.json> <scope.json> [--criteria <file>]... [--root <dir>]
  node snapshot.mjs verify <scope.json> [--source-only] [--root <dir>]`);
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, options } = parseArgs(rest);
  if (!command || options.help || command === 'help') {
    usage();
    return command ? 0 : 1;
  }
  if (command === 'capture' && positional[0]) {
    const snap = capture(options.root, options.exclude);
    writeJson(positional[0], snap);
    console.log(`captured ${Object.keys(snap.files).length} files (git: ${snap.git}, head: ${snap.head ?? 'none'}) -> ${positional[0]}`);
    return 0;
  }
  if (command === 'scope' && positional[0] && positional[1]) {
    const baselinePath = resolve(positional[0]);
    const scope = computeScope(options.root, readJson(baselinePath), options.criteria);
    writeJson(positional[1], { version: FORMAT, createdAt: new Date().toISOString(), baseline: toPosix(relative(options.root, baselinePath)), ...scope });
    for (const c of scope.changes) console.log(`${c.status.padEnd(8)} ${c.path}`);
    for (const c of scope.criteria) console.log(`criteria ${c.path} ${c.hash ? c.hash.slice(0, 12) : 'MISSING'}`);
    console.log(`fingerprint ${scope.fingerprint}`);
    return 0;
  }
  if (command === 'verify' && positional[0]) {
    const recorded = readJson(positional[0]);
    const baseline = readJson(resolve(options.root, recorded.baseline));
    const now = computeScope(options.root, baseline, recorded.criteria.map((c) => c.path));
    const sameSource = JSON.stringify(now.changes) === JSON.stringify(recorded.changes);
    if (now.fingerprint === recorded.fingerprint || (options.sourceOnly && sameSource)) {
      console.log(`MATCH ${options.sourceOnly ? 'source of ' : ''}${recorded.fingerprint}`);
      return 0;
    }
    const key = (c) => `${c.path}:${c.status}:${c.after}`;
    const before = new Map(recorded.changes.map((c) => [c.path, c]));
    const after = new Map(now.changes.map((c) => [c.path, c]));
    for (const path of new Set([...before.keys(), ...after.keys()])) {
      const a = before.get(path);
      const b = after.get(path);
      if (!a) console.log(`new change outside reviewed scope: ${path}`);
      else if (!b) console.log(`reviewed change no longer present: ${path}`);
      else if (key(a) !== key(b)) console.log(`content differs from reviewed source: ${path}`);
    }
    for (const c of options.sourceOnly ? [] : recorded.criteria) {
      const match = now.criteria.find((n) => n.path === c.path);
      if (match?.hash !== c.hash) console.log(`criteria changed: ${c.path}`);
    }
    console.log(`MISMATCH reviewed ${recorded.fingerprint} current ${now.fingerprint}`);
    return 1;
  }
  usage();
  return 1;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`error: ${error.message}`);
  process.exitCode = 2;
}
