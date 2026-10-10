import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnMarkerFromEnv } from '../src/lib/session-origin.js';
import { execFileSync } from 'node:child_process';
import { buildCorpus, bm25Search, docKey, type CorpusDoc, type RecallHit } from '../src/lib/recall.js';

/**
 * A single labelled recall query.
 * - `expected`: docKeys (`type/slug`) that count as a correct hit.
 * - `alt`: additional acceptable docKeys (synonymous / equally-valid targets).
 * - `category`: bucket for per-category aggregation (e.g. "feature", "decision").
 * - `lang`: language of the query (e.g. "en", "tr", "mixed") — reporting only.
 * - `variant`: optional sub-label (e.g. "ascii" for Turkish typed without diacritics).
 */
export interface GoldQuery {
  id: string;
  query: string;
  expected: string[];
  alt?: string[];
  category: string;
  lang: string;
  variant?: string;
}

// ─── Frozen-eval plumbing ────────────────────────────────────────────────────
// Corpora, the pinned clock and sealed per-query results live under one machine-
// local directory OUTSIDE the repo (held-out isolation is physical, not a rule).

/** Mirror of `evalFrozenDir` in recall-cloud-config.ts (output-compared by a test). */
export function frozenDir(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'eval-frozen');
}
export const FROZEN_DIR = frozenDir();
export const FROZEN_RUNS_DIR = join(FROZEN_DIR, 'runs');

/** Snapshot directory name under the frozen dir (mirror of scripts/gold-v2-lib SNAPSHOT_ID). */
export const SNAPSHOT_ID = 'dc-20261010';

/** Where held-out and reserve gold, and their sealed results, live. */
export function sealedDir(home?: string): string {
  return join(frozenDir(home), SNAPSHOT_ID, 'sealed');
}

/** realpath of `p`, resolving only the deepest existing ancestor so not-yet-created paths work. */
function realpathLoose(p: string): string {
  const abs = resolve(p);
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      return join(realpathSync.native(cur), ...tail.reverse());
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return abs;
      tail.push(basename(cur));
      cur = parent;
    }
  }
}

/**
 * Returns the resolved `path` or throws unless its REAL path (symlinks followed) is
 * strictly inside the real `dir` (separator-terminated prefix; the dir itself does not count).
 */
export function assertUnder(dir: string, path: string, what: string): string {
  const realDir = realpathLoose(dir);
  const real = realpathLoose(path);
  if (!real.startsWith(realDir + sep)) {
    throw new Error(`${what} must be under ${dir} (got ${resolve(path)})`);
  }
  return resolve(path);
}

/**
 * The reference time for a measurement run. `undefined` → wall clock; `'frozen'` → the clock
 * pinned in `<FROZEN_DIR>/now.txt`; `'@<dir>'` → `<dir>/now.txt`; anything else must be ISO.
 */
export function loadNow(arg?: string): Date {
  if (arg === undefined) return new Date();
  let text = arg;
  if (arg === 'frozen') text = readFileSync(join(FROZEN_DIR, 'now.txt'), 'utf-8').trim();
  else if (arg.startsWith('@')) text = readFileSync(join(arg.slice(1), 'now.txt'), 'utf-8').trim();
  const t = Date.parse(text);
  if (Number.isNaN(t)) throw new Error(`--now: not an ISO timestamp: ${text}`);
  return new Date(t);
}

// Docs that did not exist when the gold sets were authored / that are session-local noise.
const EXCLUDED_SLUGS = new Set(['recall-context-uplift-v07']);

/** The corpus every A/B measures: capture docs and in-flight tracking noise removed. */
export function stableCorpus(root: string): CorpusDoc[] {
  return filterStable(buildCorpus(root));
}

function filterStable(corpus: CorpusDoc[]): CorpusDoc[] {
  return corpus.filter(
    (d) => !d.capture && !d.slug.startsWith('digest#') && !d.slug.startsWith('bookmark#')
      && !EXCLUDED_SLUGS.has(d.slug),
  );
}

// ─── Engine loader ───────────────────────────────────────────────────────────
// Every engine function is loaded from an engine root (the working tree, or a pristine
// `git archive` such as engines/0ba4c25a) — never imported statically — so one harness
// measures any engine. Only recall.ts is loaded eagerly; the heavier modules on demand.

type EngineRecall = typeof import('../src/lib/recall.js');
type EngineHybrid = typeof import('../src/lib/embeddings/hybrid.js');
type EngineStore = typeof import('../src/lib/embeddings/store.js');
type EngineExtractor = typeof import('../src/lib/recall-query-extractor.js');

export interface Engine {
  root: string;
  sha: string;
  buildCorpus: EngineRecall['buildCorpus'];
  bm25Search: EngineRecall['bm25Search'];
  docKey: EngineRecall['docKey'];
  stableCorpus(root: string): CorpusDoc[];
  hybrid(): Promise<EngineHybrid>;
  store(): Promise<EngineStore>;
  extractor(): Promise<EngineExtractor>;
}

/** The engine's own git HEAD (only when the root IS a checkout — never an enclosing repo's), else a
 *  sha-named archive directory (engines/0ba4c25a), else 'unknown'. */
function engineSha(root: string): string {
  if (existsSync(join(root, '.git'))) {
    try {
      return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      // fall through to the directory name
    }
  }
  const name = basename(realpathLoose(root));
  return /^[0-9a-f]{7,40}$/.test(name) ? name : 'unknown';
}

export async function loadEngine(engineRoot: string = '.'): Promise<Engine> {
  const root = resolve(engineRoot);
  const load = <T>(rel: string): Promise<T> => {
    const file = join(root, 'src', 'lib', rel);
    if (!existsSync(file)) throw new Error(`engine file missing: ${file}`);
    return import(pathToFileURL(file).href) as Promise<T>;
  };
  const recall = await load<EngineRecall>('recall.ts');
  return {
    root,
    sha: engineSha(root),
    buildCorpus: recall.buildCorpus,
    bm25Search: recall.bm25Search,
    docKey: recall.docKey,
    stableCorpus: (r) => filterStable(recall.buildCorpus(r)),
    hybrid: () => load<EngineHybrid>('embeddings/hybrid.ts'),
    store: () => load<EngineStore>('embeddings/store.ts'),
    extractor: () => load<EngineExtractor>('recall-query-extractor.ts'),
  };
}

/**
 * Parse a JSONL gold file into GoldQuery[]. Blank lines are skipped.
 * Each non-blank line must be a JSON object matching GoldQuery.
 */
export function loadGold(path: string): GoldQuery[] {
  const raw = readFileSync(path, 'utf-8');
  const out: GoldQuery[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    out.push(JSON.parse(trimmed) as GoldQuery);
  }
  return out;
}

interface Metrics {
  recall1: number;
  recall3: number;
  mrr: number;
  n: number;
}

export interface EvalReport {
  overall: { recall1: number; recall3: number; mrr: number; n: number };
  byCategory: Record<string, { recall1: number; recall3: number; mrr: number; n: number }>;
  perQuery: Array<{ id: string; category: string; rank: number | null; hit1: boolean; hit3: boolean }>;
}

/**
 * bm25Search returns RecallHit[] where each hit carries a `.doc` field. Some
 * callers/shapes expose the doc fields directly on the hit; accept either so the
 * harness is robust to the exact return shape.
 */
function hitDoc(hit: RecallHit | CorpusDoc): CorpusDoc {
  if (hit && typeof hit === 'object' && 'doc' in hit && (hit as RecallHit).doc) {
    return (hit as RecallHit).doc;
  }
  return hit as CorpusDoc;
}

/**
 * Evaluate a gold set against a corpus using bm25Search.
 *
 * For each query we take the top-10 hits and find the 1-based rank of the first
 * hit whose docKey is in the query's accepted targets (`expected` ∪ `alt`).
 * recall@1 / recall@3 are reported as percentages (0–100); MRR is 0–1.
 */
export function evaluate(
  corpus: CorpusDoc[],
  gold: GoldQuery[],
  searchOpts: Parameters<typeof bm25Search>[3] = {},
): EvalReport {
  const perQuery: EvalReport['perQuery'] = [];

  // Accumulators keyed by category, plus a synthetic "overall" bucket.
  const acc = new Map<string, { hit1: number; hit3: number; rr: number; n: number }>();
  const bump = (key: string, hit1: boolean, hit3: boolean, rr: number): void => {
    const cur = acc.get(key) ?? { hit1: 0, hit3: 0, rr: 0, n: 0 };
    cur.hit1 += hit1 ? 1 : 0;
    cur.hit3 += hit3 ? 1 : 0;
    cur.rr += rr;
    cur.n += 1;
    acc.set(key, cur);
  };

  for (const q of gold) {
    const hits = bm25Search(q.query, corpus, 10, searchOpts);
    const targets = new Set([...q.expected, ...(q.alt ?? [])]);

    let rank: number | null = null;
    for (let i = 0; i < hits.length; i++) {
      if (targets.has(docKey(hitDoc(hits[i])))) {
        rank = i + 1;
        break;
      }
    }

    const hit1 = rank === 1;
    const hit3 = rank !== null && rank <= 3;
    const rr = rank ? 1 / rank : 0;

    perQuery.push({ id: q.id, category: q.category, rank, hit1, hit3 });
    bump('__overall__', hit1, hit3, rr);
    bump(q.category, hit1, hit3, rr);
  }

  const toMetrics = (a: { hit1: number; hit3: number; rr: number; n: number }): Metrics => ({
    recall1: a.n ? (a.hit1 / a.n) * 100 : 0,
    recall3: a.n ? (a.hit3 / a.n) * 100 : 0,
    mrr: a.n ? a.rr / a.n : 0,
    n: a.n,
  });

  const overallAcc = acc.get('__overall__') ?? { hit1: 0, hit3: 0, rr: 0, n: 0 };
  const overall = toMetrics(overallAcc);

  const byCategory: EvalReport['byCategory'] = {};
  for (const [key, a] of acc) {
    if (key === '__overall__') continue;
    byCategory[key] = toMetrics(a);
  }

  return { overall, byCategory, perQuery };
}

/**
 * Event-loop-friendly twin of {@link evaluate}: byte-identical computation and
 * result, but it `await`s a macrotask every `yieldEvery` queries. A heavy stress
 * run (a 200-doc capture flood × the full gold set is tens of seconds of purely
 * synchronous BM25) would otherwise block its vitest worker's event loop long
 * enough to starve the reporter heartbeat and trip vitest's "Timeout calling
 * onTaskUpdate" RPC guard — failing the run even though every assertion passed.
 * The yields change nothing about the numbers; they only let the worker breathe.
 */
export async function evaluateAsync(
  corpus: CorpusDoc[],
  gold: GoldQuery[],
  searchOpts: Parameters<typeof bm25Search>[3] = {},
  yieldEvery = 4,
): Promise<EvalReport> {
  const perQuery: EvalReport['perQuery'] = [];
  const acc = new Map<string, { hit1: number; hit3: number; rr: number; n: number }>();
  const bump = (key: string, hit1: boolean, hit3: boolean, rr: number): void => {
    const cur = acc.get(key) ?? { hit1: 0, hit3: 0, rr: 0, n: 0 };
    cur.hit1 += hit1 ? 1 : 0;
    cur.hit3 += hit3 ? 1 : 0;
    cur.rr += rr;
    cur.n += 1;
    acc.set(key, cur);
  };

  let i = 0;
  for (const q of gold) {
    if (i++ % yieldEvery === 0) await new Promise<void>((r) => setImmediate(r));
    const hits = bm25Search(q.query, corpus, 10, searchOpts);
    const targets = new Set([...q.expected, ...(q.alt ?? [])]);

    let rank: number | null = null;
    for (let k = 0; k < hits.length; k++) {
      if (targets.has(docKey(hitDoc(hits[k])))) {
        rank = k + 1;
        break;
      }
    }

    const hit1 = rank === 1;
    const hit3 = rank !== null && rank <= 3;
    const rr = rank ? 1 / rank : 0;

    perQuery.push({ id: q.id, category: q.category, rank, hit1, hit3 });
    bump('__overall__', hit1, hit3, rr);
    bump(q.category, hit1, hit3, rr);
  }

  const toMetrics = (a: { hit1: number; hit3: number; rr: number; n: number }): Metrics => ({
    recall1: a.n ? (a.hit1 / a.n) * 100 : 0,
    recall3: a.n ? (a.hit3 / a.n) * 100 : 0,
    mrr: a.n ? a.rr / a.n : 0,
    n: a.n,
  });

  const overallAcc = acc.get('__overall__') ?? { hit1: 0, hit3: 0, rr: 0, n: 0 };
  const overall = toMetrics(overallAcc);

  const byCategory: EvalReport['byCategory'] = {};
  for (const [key, a] of acc) {
    if (key === '__overall__') continue;
    byCategory[key] = toMetrics(a);
  }

  return { overall, byCategory, perQuery };
}

// ─── Mode-generic A/B evaluation (per-language) ──────────────────────────────

/** Any ranked search over the corpus: BM25-only, dense-only, or hybrid RRF. */
export type SearchFn = (query: string, topK: number) => Promise<Array<RecallHit | CorpusDoc>>;

export interface ExtendedMetrics {
  recall1: number;  // %
  recall3: number;  // %
  recall5: number;  // %
  mrr: number;      // 0–1
  ndcg10: number;   // 0–1 (binary relevance, first accepted target)
  n: number;
  /** % of queries the hook would have injected something for (see EvaluateOptions.injectRule). */
  injectionRate?: number;
  /** % of queries that were injected AND had the target in the top 5. */
  effective5?: number;
}

export interface ExtendedReport {
  overall: ExtendedMetrics;
  byCategory: Record<string, ExtendedMetrics>;
  byLang: Record<string, ExtendedMetrics & { r5ci: [number, number] }>;
  byLangCategory: Record<string, Record<string, ExtendedMetrics>>;
  perQuery: Array<{ id: string; category: string; lang: string; variant?: string; rank: number | null; hits: string[]; injected: boolean }>;
  latency: { meanMs: number; p50Ms: number; p90Ms: number; p90ci: [number, number] };
}

export interface EvaluateOptions {
  /** Untimed queries run first (the first call pays JIT / model-load / lazy-cache cost). Default 1. */
  warmup?: number;
  /** How many top hits the hook would print. Default 5 (K=5). */
  injectK?: number;
  /** 'gate' = some printed hit has raw score ≥ 2.0 (the hook gate; hits without a score pass);
   *  'nonempty' = any hit at all (haiku mode, which bypasses the gate). Default 'gate'. */
  injectRule?: 'gate' | 'nonempty';
}

const HOOK_GATE_SCORE = 2.0;

function hitScore(hit: RecallHit | CorpusDoc): number | null {
  return typeof (hit as RecallHit).score === 'number' ? (hit as RecallHit).score : null;
}

/** Index of the p-quantile in an ascending array of length n (matches the legacy p50/p90 picks). */
function quantileIndex(n: number, p: number): number {
  return Math.min(n - 1, Math.floor(n * p));
}

/**
 * Evaluate a gold set against ANY search function (the A/B core). Takes the top-10 per query;
 * rank = first hit whose docKey is in expected ∪ alt. nDCG@10 uses binary relevance with a single
 * accepted target, so per-query nDCG@10 = 1/log2(rank+1) for rank ≤ 10, else 0. Results are
 * aggregated overall, per category, per language and per language × category.
 */
export async function evaluateSearch(
  search: SearchFn,
  gold: GoldQuery[],
  opts: EvaluateOptions = {},
): Promise<ExtendedReport> {
  const warmup = opts.warmup ?? 1;
  const injectK = opts.injectK ?? 5;
  const rule = opts.injectRule ?? 'gate';
  const perQuery: ExtendedReport['perQuery'] = [];
  const times: number[] = [];

  interface Acc { hit1: number; hit3: number; hit5: number; rr: number; ndcg: number; inj: number; eff: number; n: number }
  const fresh = (): Acc => ({ hit1: 0, hit3: 0, hit5: 0, rr: 0, ndcg: 0, inj: 0, eff: 0, n: 0 });
  const overallAcc = fresh();
  const catAcc = new Map<string, Acc>();
  const langAcc = new Map<string, Acc>();
  const langCatAcc = new Map<string, Map<string, Acc>>();
  const bump = (cur: Acc, rank: number | null, injected: boolean): void => {
    if (rank !== null) {
      if (rank === 1) cur.hit1++;
      if (rank <= 3) cur.hit3++;
      if (rank <= 5) cur.hit5++;
      cur.rr += 1 / rank;
      if (rank <= 10) cur.ndcg += 1 / Math.log2(rank + 1);
    }
    if (injected) {
      cur.inj++;
      if (rank !== null && rank <= 5) cur.eff++;
    }
    cur.n++;
  };
  const slot = <K>(m: Map<K, Acc>, key: K): Acc => {
    let a = m.get(key);
    if (!a) { a = fresh(); m.set(key, a); }
    return a;
  };

  for (let i = 0; i < Math.min(warmup, gold.length); i++) await search(gold[i].query, 10);

  for (const q of gold) {
    const t0 = performance.now();
    const hits = await search(q.query, 10);
    times.push(performance.now() - t0);

    const targets = new Set([...q.expected, ...(q.alt ?? [])]);
    const keys = hits.map((h) => docKey(hitDoc(h)));
    const idx = keys.findIndex((k) => targets.has(k));
    const rank = idx >= 0 ? idx + 1 : null;

    const printed = hits.slice(0, injectK);
    const injected = printed.length > 0
      && (rule === 'nonempty' || printed.some((h) => { const s = hitScore(h); return s === null || s >= HOOK_GATE_SCORE; }));

    perQuery.push({ id: q.id, category: q.category, lang: q.lang, ...(q.variant ? { variant: q.variant } : {}), rank, hits: keys, injected });
    bump(overallAcc, rank, injected);
    bump(slot(catAcc, q.category), rank, injected);
    bump(slot(langAcc, q.lang), rank, injected);
    let lc = langCatAcc.get(q.lang);
    if (!lc) { lc = new Map(); langCatAcc.set(q.lang, lc); }
    bump(slot(lc, q.category), rank, injected);
  }

  const toMetrics = (a: Acc): ExtendedMetrics => ({
    recall1: a.n ? (a.hit1 / a.n) * 100 : 0,
    recall3: a.n ? (a.hit3 / a.n) * 100 : 0,
    recall5: a.n ? (a.hit5 / a.n) * 100 : 0,
    mrr: a.n ? a.rr / a.n : 0,
    ndcg10: a.n ? a.ndcg / a.n : 0,
    n: a.n,
    injectionRate: a.n ? (a.inj / a.n) * 100 : 0,
    effective5: a.n ? (a.eff / a.n) * 100 : 0,
  });

  const byCategory: ExtendedReport['byCategory'] = {};
  for (const [key, a] of catAcc) byCategory[key] = toMetrics(a);
  const byLang: ExtendedReport['byLang'] = {};
  for (const [key, a] of langAcc) byLang[key] = { ...toMetrics(a), r5ci: wilson(a.hit5, a.n) };
  const byLangCategory: ExtendedReport['byLangCategory'] = {};
  for (const [lang, cats] of langCatAcc) {
    byLangCategory[lang] = {};
    for (const [cat, a] of cats) byLangCategory[lang][cat] = toMetrics(a);
  }

  const sorted = [...times].sort((a, b) => a - b);
  return {
    overall: toMetrics(overallAcc),
    byCategory,
    byLang,
    byLangCategory,
    perQuery,
    latency: {
      meanMs: times.length ? times.reduce((s, t) => s + t, 0) / times.length : 0,
      p50Ms: sorted.length ? sorted[quantileIndex(sorted.length, 0.5)] : 0,
      p90Ms: sorted.length ? sorted[quantileIndex(sorted.length, 0.9)] : 0,
      p90ci: bootstrapP90(times),
    },
  };
}

// ─── Statistics ──────────────────────────────────────────────────────────────

/** Wilson score interval for k successes of n, as percentages [lo, hi]. n = 0 → [0, 100]. */
export function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 100];
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return [Math.max(0, (centre - half) * 100), Math.min(100, (centre + half) * 100)];
}

/**
 * Exact two-sided sign test on discordant pairs: p = min(1, 2·P(X ≤ min(wins, losses))) with
 * X ~ Binomial(wins + losses, 0.5). No discordant pairs → 1.
 */
export function signTest(wins: number, losses: number): number {
  const n = wins + losses;
  if (n === 0) return 1;
  const k = Math.min(wins, losses);
  // log-space binomial pmf: stable for any n.
  const logFact = (m: number): number => { let s = 0; for (let i = 2; i <= m; i++) s += Math.log(i); return s; };
  const lf = logFact(n);
  let tail = 0;
  for (let i = 0; i <= k; i++) tail += Math.exp(lf - logFact(i) - logFact(n - i) - n * Math.LN2);
  return Math.min(1, 2 * tail);
}

/** Paired r@5 comparison of two reports over the same gold ids (optionally one language). */
export function pairedR5(a: ExtendedReport, b: ExtendedReport, lang?: string): { wins: number; losses: number; p: number } {
  const rankB = new Map(b.perQuery.map((p) => [p.id, p.rank]));
  let wins = 0;
  let losses = 0;
  for (const p of a.perQuery) {
    if (lang !== undefined && p.lang !== lang) continue;
    if (!rankB.has(p.id)) continue;
    const hitA = p.rank !== null && p.rank <= 5;
    const rb = rankB.get(p.id) ?? null;
    const hitB = rb !== null && rb <= 5;
    if (hitA && !hitB) wins++;
    else if (!hitA && hitB) losses++;
  }
  return { wins, losses, p: signTest(wins, losses) };
}

/** mulberry32: a small seeded PRNG so the bootstrap is reproducible. */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 95% bootstrap CI (percentile method, seeded) for the p90 of `ms`. Empty → [0, 0]. */
export function bootstrapP90(ms: number[], iters = 1000): [number, number] {
  const n = ms.length;
  if (n === 0) return [0, 0];
  const rand = mulberry32(0x5eed);
  const stats: number[] = [];
  const sample = new Array<number>(n);
  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < n; i++) sample[i] = ms[Math.floor(rand() * n)];
    sample.sort((a, b) => a - b);
    stats.push(sample[quantileIndex(n, 0.9)]);
  }
  stats.sort((a, b) => a - b);
  return [stats[Math.floor(iters * 0.025)], stats[Math.min(iters - 1, Math.floor(iters * 0.975))]];
}

/** Per-language table for N reports: r@1/3/5 (with the r@5 Wilson CI), MRR, injection, effective r@5. */
export function formatLangTable(reports: Record<string, ExtendedReport>): string {
  const lines: string[] = [];
  const langs = [...new Set(Object.values(reports).flatMap((r) => Object.keys(r.byLang)))].sort();
  lines.push(['label', 'lang', 'n', 'r@1', 'r@3', 'r@5', 'r@5 CI95', 'MRR', 'inject%', 'eff@5%'].join(' | '));
  for (const [label, rep] of Object.entries(reports)) {
    for (const lang of [...langs, 'overall']) {
      const m = lang === 'overall' ? rep.overall : rep.byLang[lang];
      if (!m) continue;
      const ci = lang === 'overall'
        ? wilson(Math.round((m.recall5 / 100) * m.n), m.n)
        : (m as ExtendedReport['byLang'][string]).r5ci;
      lines.push([
        label, lang, String(m.n), m.recall1.toFixed(1), m.recall3.toFixed(1), m.recall5.toFixed(1),
        `${ci[0].toFixed(0)}–${ci[1].toFixed(0)}`, m.mrr.toFixed(3),
        (m.injectionRate ?? 0).toFixed(1), (m.effective5 ?? 0).toFixed(1),
      ].join(' | '));
    }
  }
  return lines.join('\n');
}

/**
 * Side-by-side table for N mode reports over the same gold set: one block per
 * metric, one row per category, one column per mode. Made for the BM25 vs
 * hybrid vs dense A/B readout.
 */
export function formatComparison(reports: Record<string, ExtendedReport>): string {
  const modes = Object.keys(reports);
  const cats = ['overall', ...Object.keys(reports[modes[0]].byCategory).sort()];
  const metric = (r: ExtendedReport, cat: string): ExtendedMetrics =>
    cat === 'overall' ? r.overall : r.byCategory[cat];

  const catWidth = Math.max(8, ...cats.map((c) => c.length));
  const colWidth = Math.max(8, ...modes.map((m) => m.length));
  const lines: string[] = [];

  const metricDefs: Array<{ label: string; get: (m: ExtendedMetrics) => string }> = [
    { label: 'recall@1 %', get: (m) => m.recall1.toFixed(1) },
    { label: 'recall@3 %', get: (m) => m.recall3.toFixed(1) },
    { label: 'recall@5 %', get: (m) => m.recall5.toFixed(1) },
    { label: 'MRR', get: (m) => m.mrr.toFixed(3) },
    { label: 'nDCG@10', get: (m) => m.ndcg10.toFixed(3) },
  ];

  for (const def of metricDefs) {
    lines.push('', `## ${def.label}`);
    lines.push([''.padEnd(catWidth), ...modes.map((m) => m.padStart(colWidth)), '    n'].join(' | '));
    lines.push([('-').repeat(catWidth), ...modes.map(() => '-'.repeat(colWidth)), '-----'].join('-+-'));
    for (const cat of cats) {
      const n = metric(reports[modes[0]], cat).n;
      lines.push([
        cat.padEnd(catWidth),
        ...modes.map((m) => def.get(metric(reports[m], cat)).padStart(colWidth)),
        String(n).padStart(5),
      ].join(' | '));
    }
  }

  lines.push('', '## latency (per query)');
  lines.push([''.padEnd(10), ...modes.map((m) => m.padStart(colWidth))].join(' | '));
  for (const stat of ['meanMs', 'p50Ms', 'p90Ms'] as const) {
    lines.push([
      stat.padEnd(10),
      ...modes.map((m) => reports[m].latency[stat].toFixed(1).padStart(colWidth)),
    ].join(' | '));
  }
  return lines.join('\n');
}

/**
 * Render an EvalReport as a clean fixed-width ASCII table: an overall row plus
 * one row per category. recall@1 / recall@3 are %, MRR is 0–1, all rounded to
 * 1 decimal. Categories are listed alphabetically for stable output.
 */
export function formatReport(report: EvalReport): string {
  const f1 = (v: number): string => v.toFixed(1);

  const rows: Array<[string, Metrics]> = [['overall', report.overall]];
  for (const cat of Object.keys(report.byCategory).sort()) {
    rows.push([cat, report.byCategory[cat]]);
  }

  const catWidth = Math.max(8, ...rows.map(([name]) => name.length));
  const cols = [
    { label: 'category', width: catWidth, align: 'left' as const },
    { label: 'recall@1%', width: 9, align: 'right' as const },
    { label: 'recall@3%', width: 9, align: 'right' as const },
    { label: 'MRR', width: 6, align: 'right' as const },
    { label: 'n', width: 5, align: 'right' as const },
  ];

  const pad = (text: string, width: number, align: 'left' | 'right'): string =>
    align === 'left' ? text.padEnd(width) : text.padStart(width);

  const line = (cells: string[]): string =>
    cells.map((c, i) => pad(c, cols[i].width, cols[i].align)).join(' | ');

  const sep = cols.map((c) => '-'.repeat(c.width)).join('-+-');

  const lines: string[] = [];
  lines.push(line(cols.map((c) => c.label)));
  lines.push(sep);
  for (const [name, m] of rows) {
    lines.push(line([name, f1(m.recall1), f1(m.recall3), m.mrr.toFixed(3), String(m.n)]));
  }
  return lines.join('\n');
}

// ─── Spawned-session guard ───────────────────────────────────────────────────

/**
 * Measurement scripts cost CPU (and, on cloud tiers, money) and must be started by a human
 * or the orchestrator — never from a spawned session (automation, auto-sleep, Develop, peer, lab).
 */
export function assertNotSpawned(what: string, env: NodeJS.ProcessEnv = process.env): void {
  const marker = spawnMarkerFromEnv(env);
  if (marker) throw new Error(`${what} refuses to run in a spawned session (spawn marker: ${marker.by}).`);
}
