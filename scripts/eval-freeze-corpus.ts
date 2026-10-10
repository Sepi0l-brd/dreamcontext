// Freeze a brain into an immutable eval snapshot (plan §2.1).
//
//   npx tsx scripts/eval-freeze-corpus.ts [--src <_dream_context>] [--snapshot dc-20261010] [--now <ISO>]
//
// Creates <frozen>/<snapshot>/{_dream_context,now.txt,FINGERPRINT.json}. The sibling `vectors/`
// directory that may already exist is left alone. Refuses if `_dream_context/` already exists.
// Fails (writing nothing usable) on any symlink or on any entry whose realpath leaves the source.
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SNAPSHOT_ID, assertUnderFrozen, corpusFingerprint, snapshotDir, stableCorpusForGold,
} from './gold-v2-lib.js';

/** Top-level directories never copied (huge, private, or machine-local). */
const EXCLUDED_ROOT_DIRS = new Set(['marketing', 'tmp', 'workspace', 'inbox', 'council']);
/** Directory names excluded at any depth. */
const EXCLUDED_ANY_DEPTH_DIRS = new Set(['.embeddings', '.recall-cache']);
/** Exact root-relative files excluded (credential-class / machine-local). */
const EXCLUDED_FILES = new Set(['state/.config.json', 'state/.brain-local.json']);

/** True when the root-relative path (posix separators) must not be copied. */
export function isExcluded(rel: string, isDir: boolean): boolean {
  const parts = rel.split('/');
  if (EXCLUDED_ROOT_DIRS.has(parts[0]) && (parts.length > 1 || isDir)) return true;
  if (parts.some((p, i) => EXCLUDED_ANY_DEPTH_DIRS.has(p) && (i < parts.length - 1 || isDir))) return true;
  if (EXCLUDED_FILES.has(rel)) return true;
  const name = parts[parts.length - 1];
  if (!isDir && /^\.env/.test(name)) return true;
  if (!isDir && parts[0] === 'lab' && parts.length === 2 && /^credentials\./.test(name)) return true;
  return false;
}

export class FreezeError extends Error {
  constructor(message: string) { super(message); this.name = 'FreezeError'; }
}

function underRoot(realSrc: string, p: string): boolean {
  return p === realSrc || p.startsWith(realSrc + sep);
}

/** Walk the source; return the files to copy, or throw on a symlink / outside-root entry. */
function planCopy(srcRoot: string): string[] {
  const realSrc = realpathSync.native(srcRoot);
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      const rel = relative(srcRoot, abs).split(sep).join('/');
      const st = lstatSync(abs);
      if (isExcluded(rel, st.isDirectory())) continue;
      if (st.isSymbolicLink()) throw new FreezeError(`symlink found, refusing to freeze: ${rel}`);
      if (!underRoot(realSrc, realpathSync.native(abs))) throw new FreezeError(`entry resolves outside the source root: ${rel}`);
      if (st.isDirectory()) walk(abs);
      else if (st.isFile()) files.push(rel);
    }
  };
  walk(srcRoot);
  return files;
}

export interface FreezeOptions {
  src: string;
  snapshotId?: string;
  /** ISO timestamp pinned as the snapshot clock. Defaults to the current time. */
  now?: string;
  home?: string;
}

export interface FreezeResult { dir: string; contextRoot: string; docs: number; files: number; fingerprint: string }

export function freezeCorpus(o: FreezeOptions): FreezeResult {
  const home = o.home ?? homedir();
  const id = o.snapshotId ?? SNAPSHOT_ID;
  const dir = snapshotDir(home, id);
  assertUnderFrozen(dir, home);
  const contextRoot = join(dir, '_dream_context');
  if (existsSync(contextRoot)) throw new FreezeError(`refusing to overwrite an existing snapshot: ${contextRoot}`);
  if (!existsSync(o.src)) throw new FreezeError(`source does not exist: ${o.src}`);
  const now = o.now ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(now))) throw new FreezeError(`--now is not an ISO timestamp: ${now}`);

  const files = planCopy(o.src); // throws before anything is written
  mkdirSync(dir, { recursive: true });
  try {
    for (const rel of files) {
      const dest = join(contextRoot, ...rel.split('/'));
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(join(o.src, ...rel.split('/')), dest, { preserveTimestamps: true });
    }
    const docs = stableCorpusForGold(contextRoot);
    const fingerprint = corpusFingerprint(docs);
    // Marker files live NEXT TO _dream_context: isUnderEvalFrozenDir requires both in the parent.
    writeFileSync(join(dir, 'now.txt'), `${now}\n`);
    writeFileSync(join(dir, 'FINGERPRINT.json'), `${JSON.stringify({
      snapshotId: id, docs: docs.length, files: files.length, fingerprint, now, createdAt: new Date().toISOString(),
      source: basename(dirname(resolve(o.src))),
    }, null, 2)}\n`);
    return { dir, contextRoot, docs: docs.length, files: files.length, fingerprint };
  } catch (err) {
    rmSync(contextRoot, { recursive: true, force: true });
    throw err;
  }
}

function argValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

const HELP = `Usage: npx tsx scripts/eval-freeze-corpus.ts [--src <dir>] [--snapshot <id>] [--now <ISO>]
  --src       brain to freeze (default: <repo>/_dream_context)
  --snapshot  snapshot id under ~/.dreamcontext/eval-frozen (default: ${SNAPSHOT_ID})
  --now       pinned clock written to now.txt (default: current time)
Refuses when <snapshot>/_dream_context exists, on any symlink, and on any entry outside the source.`;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP);
  } else {
    const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
    try {
      const r = freezeCorpus({
        src: resolve(argValue(argv, '--src') ?? join(repo, '_dream_context')),
        snapshotId: argValue(argv, '--snapshot'),
        now: argValue(argv, '--now'),
      });
      console.log(`frozen ${r.files} files / ${r.docs} stable docs -> ${r.contextRoot}\nfingerprint ${r.fingerprint}`);
    } catch (err) {
      console.error(`freeze failed: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  }
}
