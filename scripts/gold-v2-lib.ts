// Shared constants and pure helpers for the gold-v2 tooling (freeze, sample, check).
//
// T1 owns its OWN copy of the frozen-dir logic on purpose: the eval harness (T3) and the
// cloud config (T4) must not be dependencies of the gold tooling, and a drift test in T4
// compares the three outputs. Do not import from eval/harness.ts here.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { buildCorpus, docKey, type CorpusDoc } from '../src/lib/recall.js';

export const SNAPSHOT_ID = 'dc-20261010';
export const GOLD_SEED = 20261010;

/** Mirror of CLOUD_ELIGIBLE_TYPES (egress-rules.ts); a T4 drift test compares the two. */
export const T1_CLOUD_TYPES = [
  'knowledge', 'feature', 'task', 'objective', 'thesis', 'whiteboard', 'core', 'memory',
] as const;

export const LANGS = ['tr', 'en', 'mixed'] as const;
export type GoldLang = typeof LANGS[number];

export const SPLITS = ['train', 'heldout', 'reserve'] as const;
export type GoldSplit = typeof SPLITS[number];

export const CATEGORIES = ['exact-term', 'field-match', 'paraphrase', 'recency', 'topical-adjacency'] as const;
export type GoldCategory = typeof CATEGORIES[number];

/** Per-language quota per category: train 30, held-out 25, reserve 20 (plan §2.2). */
export const SPLIT_QUOTAS: Readonly<Record<GoldSplit, Readonly<Record<GoldCategory, number>>>> = {
  train: { 'exact-term': 6, 'field-match': 5, paraphrase: 8, recency: 6, 'topical-adjacency': 5 },
  heldout: { 'exact-term': 4, 'field-match': 4, paraphrase: 7, recency: 5, 'topical-adjacency': 5 },
  reserve: { 'exact-term': 3, 'field-match': 3, paraphrase: 5, recency: 4, 'topical-adjacency': 5 },
};

/** How many Turkish queries per split are typed without diacritics (`variant:'ascii'`). */
export const ASCII_VARIANT_COUNT: Readonly<Record<GoldSplit, number>> = { train: 4, heldout: 4, reserve: 3 };

export const SPLIT_PREFIX: Readonly<Record<GoldSplit, 't' | 'h' | 'r'>> = { train: 't', heldout: 'h', reserve: 'r' };

export function splitSize(split: GoldSplit): number {
  return Object.values(SPLIT_QUOTAS[split]).reduce((a, b) => a + b, 0);
}

export interface GoldQueryV2 {
  id: string;
  query: string;
  expected: string[];
  alt?: string[];
  category: GoldCategory;
  lang: GoldLang;
  variant?: 'ascii';
}

export const GOLD_ID_RE = /^g2([thr])-(tr|en|mixed)-(\d{3})$/;

export function goldId(split: GoldSplit, lang: GoldLang, n: number): string {
  return `g2${SPLIT_PREFIX[split]}-${lang}-${String(n).padStart(3, '0')}`;
}

/** `~/.dreamcontext/eval-frozen` (injectable home; mirror of evalFrozenDir/frozenDir). */
export function t1FrozenDir(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'eval-frozen');
}

export function snapshotDir(home: string = homedir(), snapshotId: string = SNAPSHOT_ID): string {
  return join(t1FrozenDir(home), snapshotId);
}

export function sealedDir(home: string = homedir(), snapshotId: string = SNAPSHOT_ID): string {
  return join(snapshotDir(home, snapshotId), 'sealed');
}

/** Realpath of the deepest existing ancestor of `p`, re-joined with the missing tail. */
function realpathLoose(p: string): string {
  const abs = resolve(p);
  let head = abs;
  const tail: string[] = [];
  while (!existsSync(head)) {
    const parent = resolve(head, '..');
    if (parent === head) break;
    tail.unshift(head.slice(parent.length + 1));
    head = parent;
  }
  return join(realpathSync.native(head), ...tail);
}

/** Throws unless `p` resolves strictly inside the frozen dir (symlinks resolved, separator-terminated). */
export function assertUnderFrozen(p: string, home: string = homedir()): string {
  const frozen = t1FrozenDir(home);
  if (!existsSync(frozen)) throw new Error(`frozen dir does not exist: ${frozen}`);
  const real = realpathLoose(p);
  const base = realpathSync.native(frozen) + sep;
  if (!real.startsWith(base)) throw new Error(`path must be under ${frozen} (got ${resolve(p)})`);
  return real;
}

/** The corpus every gold tool measures: capture docs and in-flight tracking noise removed. */
export function stableCorpusForGold(root: string): CorpusDoc[] {
  return buildCorpus(root).filter(
    (d) => !d.capture && !d.slug.startsWith('digest#') && !d.slug.startsWith('bookmark#')
      && d.slug !== 'recall-context-uplift-v07',
  );
}

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function sha256File(path: string): string {
  return sha256(readFileSync(path));
}

export function contentHashOf(doc: CorpusDoc): string {
  return sha256(`${doc.title}\n${doc.description}\n${doc.body}`);
}

/** sha256 over the sorted `docKey:contentHash` list of the stable corpus. */
export function corpusFingerprint(docs: readonly CorpusDoc[]): string {
  const lines = docs.map((d) => `${docKey(d)}:${contentHashOf(d)}`).sort();
  return sha256(lines.join('\n'));
}

/** DocKeys that appear once only (a duplicated key cannot be a gold target). */
export function uniqueDocKeys(docs: readonly CorpusDoc[]): Set<string> {
  const seen = new Map<string, number>();
  for (const d of docs) seen.set(docKey(d), (seen.get(docKey(d)) ?? 0) + 1);
  return new Set([...seen].filter(([, n]) => n === 1).map(([k]) => k));
}

/** Parse a JSONL file into objects; a malformed line throws with its line number (never its content). */
export function readJsonl(path: string): unknown[] {
  const out: unknown[] = [];
  readFileSync(path, 'utf-8').split('\n').forEach((line, i) => {
    if (line.trim() === '') return;
    try { out.push(JSON.parse(line)); } catch { throw new Error(`${path}: line ${i + 1} is not valid JSON`); }
  });
  return out;
}

/** Schema errors for one gold line. Messages carry ids, never query text. */
export function validateGoldLine(raw: unknown, split: GoldSplit): string[] {
  const errs: string[] = [];
  if (!raw || typeof raw !== 'object') return ['not_an_object'];
  const q = raw as Record<string, unknown>;
  const id = typeof q.id === 'string' ? q.id : '?';
  const tag = (msg: string): string => `${id}: ${msg}`;
  const m = typeof q.id === 'string' ? GOLD_ID_RE.exec(q.id) : null;
  if (!m) errs.push(tag('bad_id'));
  else {
    if (m[1] !== SPLIT_PREFIX[split]) errs.push(tag('id_split_mismatch'));
    if (m[2] !== q.lang) errs.push(tag('id_lang_mismatch'));
  }
  if (typeof q.query !== 'string' || q.query.trim().length < 8) errs.push(tag('bad_query'));
  if (!Array.isArray(q.expected) || q.expected.length !== 1 || typeof q.expected[0] !== 'string') errs.push(tag('expected_must_be_one_key'));
  if (q.alt !== undefined && !(Array.isArray(q.alt) && q.alt.every((a) => typeof a === 'string'))) errs.push(tag('bad_alt'));
  if (!(LANGS as readonly unknown[]).includes(q.lang)) errs.push(tag('bad_lang'));
  if (!(CATEGORIES as readonly unknown[]).includes(q.category)) errs.push(tag('bad_category'));
  if (q.variant !== undefined && (q.variant !== 'ascii' || q.lang !== 'tr')) errs.push(tag('bad_variant'));
  return errs;
}

/** Hash/count verification of FROZEN.md against the files that exist. Only filled, present files are checked. */
export interface FrozenCheck { checked: string[]; skipped: string[]; mismatches: string[] }

const FROZEN_LINE_RE = /^- (train|heldout|reserve)\.jsonl: sha256=([0-9a-f]{64}|PENDING) count=(\d+|PENDING)\s*$/gm;

export function verifyFrozenHashes(o: { frozenMdPath: string; trainPath: string; home?: string; snapshotId?: string }): FrozenCheck {
  const res: FrozenCheck = { checked: [], skipped: [], mismatches: [] };
  if (!existsSync(o.frozenMdPath)) { res.skipped.push('FROZEN.md'); return res; }
  const text = readFileSync(o.frozenMdPath, 'utf-8');
  for (const m of text.matchAll(FROZEN_LINE_RE)) {
    const split = m[1] as GoldSplit;
    const [, , hash, count] = m;
    const file = split === 'train' ? o.trainPath : join(sealedDir(o.home, o.snapshotId), `${split}.jsonl`);
    if (hash === 'PENDING' || count === 'PENDING' || !existsSync(file)) { res.skipped.push(split); continue; }
    res.checked.push(split);
    if (sha256File(file) !== hash) res.mismatches.push(`${split}: sha256`);
    const lines = readFileSync(file, 'utf-8').split('\n').filter((l) => l.trim() !== '').length;
    if (String(lines) !== count) res.mismatches.push(`${split}: count`);
  }
  return res;
}
