// Seeded, stratified target sampling for gold v2 (plan §2.2).
//
//   npx tsx scripts/gold-v2-sample.ts [--snapshot-root <dir>] [--seed 20261010] [--out-dir <dir>]
//
// One sample file per split x language, written under <snapshot>/samples/. Targets are disjoint
// across every split and language and exclude all legacy gold targets. Sampling is NOT stratified
// on cloud eligibility (the gold must stay independent of the system).
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { docKey, type CorpusDoc } from '../src/lib/recall.js';
import {
  ASCII_VARIANT_COUNT, CATEGORIES, GOLD_SEED, LANGS, SNAPSHOT_ID, SPLIT_QUOTAS, readJsonl,
  snapshotDir, stableCorpusForGold, uniqueDocKeys,
  type GoldCategory, type GoldLang, type GoldSplit,
} from './gold-v2-lib.js';

/** Doc types a gold query can reasonably target. */
const TARGET_TYPES = ['knowledge', 'feature', 'task'] as const;
const MIN_BODY_CHARS = 600;
const RECENCY_POOL_FRACTION = 0.25;

export interface SampledTarget {
  /** 1-based position; the author's id is g2<split>-<lang>-<n padded>. */
  n: number;
  docKey: string;
  relPath: string;
  category: GoldCategory;
  /** Turkish only: the query must be typed without diacritics. */
  ascii: boolean;
}

export interface SampleFile {
  snapshotId: string;
  seed: number;
  split: GoldSplit;
  lang: GoldLang;
  targets: SampledTarget[];
}

function hashSeed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** mulberry32: small, deterministic, good enough for sampling. */
export function makeRng(seed: string): () => number {
  let a = hashSeed(seed);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], rng: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function updatedMs(doc: CorpusDoc): number {
  const t = doc.updatedAt ? Date.parse(doc.updatedAt) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

/** Round-robin across doc types (in a seeded order) so a category is not all tasks. */
function pickBalanced(pool: readonly CorpusDoc[], count: number, rng: () => number): CorpusDoc[] {
  const byType = new Map<string, CorpusDoc[]>();
  for (const d of shuffled(pool, rng)) byType.set(d.type, [...(byType.get(d.type) ?? []), d]);
  const order = shuffled([...byType.keys()], rng);
  const out: CorpusDoc[] = [];
  while (out.length < count && order.some((t) => (byType.get(t) ?? []).length > 0)) {
    for (const t of order) {
      const next = byType.get(t)?.shift();
      if (next && out.length < count) out.push(next);
    }
  }
  return out;
}

export interface SampleRequest {
  root: string;
  seed: number;
  split: GoldSplit;
  lang: GoldLang;
  perCategory: Readonly<Record<GoldCategory, number>>;
  /** DocKeys that must not be sampled (legacy targets and every earlier sample). Not mutated. */
  exclude: ReadonlySet<string>;
  asciiCount?: number;
  /** Test hook: restrict the candidate pool (default: the stable corpus of `root`). */
  corpus?: readonly CorpusDoc[];
}

export function candidatePool(corpus: readonly CorpusDoc[]): CorpusDoc[] {
  const unique = uniqueDocKeys(corpus);
  return corpus.filter((d) => (TARGET_TYPES as readonly string[]).includes(d.type)
    && unique.has(docKey(d)) && d.body.length >= MIN_BODY_CHARS);
}

export function sampleTargets(r: SampleRequest): SampledTarget[] {
  const rng = makeRng(`${r.seed}:${r.split}:${r.lang}`);
  const all = candidatePool(r.corpus ?? stableCorpusForGold(r.root));
  const taken = new Set(r.exclude);
  const picked: Array<{ doc: CorpusDoc; category: GoldCategory }> = [];

  for (const category of CATEGORIES) {
    const want = r.perCategory[category];
    let pool = all.filter((d) => !taken.has(docKey(d)));
    if (category === 'recency') {
      const keep = Math.max(want * 4, Math.ceil(pool.length * RECENCY_POOL_FRACTION));
      pool = [...pool].sort((a, b) => updatedMs(b) - updatedMs(a)).slice(0, keep);
    }
    const chosen = pickBalanced(pool, want, rng);
    if (chosen.length < want) {
      throw new Error(`pool exhausted for ${r.split}/${r.lang}/${category}: wanted ${want}, found ${chosen.length}`);
    }
    for (const doc of chosen) { taken.add(docKey(doc)); picked.push({ doc, category }); }
  }

  const ordered = shuffled(picked, rng);
  const asciiIdx = new Set(r.lang === 'tr' ? shuffled(ordered.map((_, i) => i), rng).slice(0, r.asciiCount ?? 0) : []);
  return ordered.map(({ doc, category }, i) => ({
    n: i + 1, docKey: docKey(doc), relPath: doc.relPath, category, ascii: asciiIdx.has(i),
  }));
}

/** Legacy targets (expected + alt of every query in the given legacy gold files). */
export function legacyTargets(paths: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const p of paths) {
    for (const row of readJsonl(p) as Array<{ expected?: string[]; alt?: string[] }>) {
      for (const k of [...(row.expected ?? []), ...(row.alt ?? [])]) out.add(k);
    }
  }
  return out;
}

const SAMPLE_ORDER: readonly GoldSplit[] = ['heldout', 'reserve', 'train'];

/** Every split x language, with one shared exclusion set so all samples are disjoint. */
export function sampleAll(o: { root: string; seed: number; legacy: ReadonlySet<string> }): SampleFile[] {
  const corpus = stableCorpusForGold(o.root);
  const exclude = new Set(o.legacy);
  const files: SampleFile[] = [];
  for (const split of SAMPLE_ORDER) {
    for (const lang of LANGS) {
      const targets = sampleTargets({
        root: o.root, seed: o.seed, split, lang, perCategory: SPLIT_QUOTAS[split], exclude,
        asciiCount: ASCII_VARIANT_COUNT[split], corpus,
      });
      for (const t of targets) exclude.add(t.docKey);
      files.push({ snapshotId: SNAPSHOT_ID, seed: o.seed, split, lang, targets });
    }
  }
  return files;
}

export function writeSamples(files: readonly SampleFile[], outDir: string): string[] {
  mkdirSync(outDir, { recursive: true });
  const paths = files.map((f) => join(outDir, `${f.split}-${f.lang}.json`));
  const existing = paths.filter((p) => existsSync(p));
  if (existing.length > 0) throw new Error(`refusing to overwrite existing samples: ${existing.join(', ')}`);
  files.forEach((f, i) => writeFileSync(paths[i], `${JSON.stringify(f, null, 2)}\n`));
  return paths;
}

function argValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

const HELP = `Usage: npx tsx scripts/gold-v2-sample.ts [--snapshot-root <dir>] [--seed ${GOLD_SEED}] [--out-dir <dir>] [--legacy <jsonl> ...]
  --snapshot-root  the snapshot dir holding _dream_context (default: ~/.dreamcontext/eval-frozen/${SNAPSHOT_ID})
  --out-dir        where sample files go (default: <snapshot-root>/samples); never overwrites
  --legacy         legacy gold files whose targets are excluded (default: eval/gold.jsonl, eval/gold-heldout.jsonl)`;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP);
  } else {
    const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
    try {
      const snap = resolve(argValue(argv, '--snapshot-root') ?? snapshotDir());
      const legacyArgs = argv.flatMap((a, i) => (a === '--legacy' ? [argv[i + 1]] : []));
      const legacy = legacyTargets(legacyArgs.length > 0 ? legacyArgs : [join(repo, 'eval', 'gold.jsonl'), join(repo, 'eval', 'gold-heldout.jsonl')]);
      const files = sampleAll({ root: join(snap, '_dream_context'), seed: Number(argValue(argv, '--seed') ?? GOLD_SEED), legacy });
      const paths = writeSamples(files, resolve(argValue(argv, '--out-dir') ?? join(snap, 'samples')));
      for (const f of files) console.log(`${f.split}/${f.lang}: ${f.targets.length} targets`);
      console.log(`wrote ${paths.length} sample files`);
    } catch (err) {
      console.error(`sample failed: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  }
}
