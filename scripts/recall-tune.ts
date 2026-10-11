// Recall tuning (T6b) — TRAIN ONLY. Coordinate descent over the fusion core and the cloud rerank
// stage, on the frozen snapshot, against gold v2 train + the legacy gold. It never reads a sealed
// set (held-out / reserve): a gold path under the sealed dir is refused, only three gold files are
// accepted at all, and a spawned session cannot run it.
//
// Every dense/rerank call goes through the production egress layer (buildEgressPayload ->
// openRouterEmbed / openRouterRerank under evalConsent), so spend lands in the eval ledger
// (DREAMCONTEXT_EVAL_MAX_USD, <= 2.90 enforced here). Rerank scores are cached per (model, query,
// doc) under <snapshot>/cache/rerank/, so a grid never pays twice.
//
// Usage (key: `set -a; . ./.env.recall; set +a`; never printed):
//   npx tsx scripts/recall-tune.ts index                          build/top-up the snapshot voyage index (seeded)
//   npx tsx scripts/recall-tune.ts vectors --source api|nano|e5   embed + cache the query vectors
//   npx tsx scripts/recall-tune.ts stage1 --profile api|nano|e5   fusion core (coordinate descent) + dense gate
//   npx tsx scripts/recall-tune.ts stage2                         cloud rerank grid on the stage-1 cloud core
//   npx tsx scripts/recall-tune.ts report --tier local|cloud-index|cloud|all   metrics of the constants in fusion-config.ts
//   npx tsx scripts/recall-tune.ts verify --tier cloud            real hybridSearch must reproduce the fast path
// Flags: --now @<snapshot> (default: the snapshot's now.txt) · --out <file> · --home <dir> · --sweeps <n>
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bm25Search, docKey, type CorpusDoc, type RecallHit } from '../src/lib/recall.js';
import {
  SNAPSHOT_ID, assertNotSpawned, assertUnder, frozenDir, loadGold, loadNow, sealedDir, stableCorpus, type GoldQuery,
} from '../eval/harness.js';
import { evalSpendCeilingUsd, readRecallCloudUsage, type RecallTier, type RerankModel } from '../src/lib/recall-cloud-config.js';
import { applyRerank, pickBestChunkLexical } from '../src/lib/embeddings/egress-rules.js';
import { buildEgressPayload, isUnderEvalFrozenDir, rerankScoresByKey, type EgressPayload } from '../src/lib/embeddings/egress.js';
import {
  DEFAULT_RERANK_MODEL, FUSION_BY_TIER, SPIKE_FUSION, type DenseGate, type FusionParams,
} from '../src/lib/embeddings/fusion-config.js';
import { denseRankAgg, fuseCandidates, hybridSearch, shouldSkipDense, type DenseHit } from '../src/lib/embeddings/hybrid.js';
import { nanoEmbedQuery } from '../src/lib/embeddings/nano.js';
import { CloudRecallError, openRouterEmbed, openRouterRerank, type CloudCallOpts } from '../src/lib/embeddings/openrouter.js';
import { VOYAGE_4_PROFILE } from '../src/lib/embeddings/profiles.js';
import { EMBED_MODEL, embedQuery } from '../src/lib/embeddings/embedder.js';
import type { DenseIndex, IndexedChunk } from '../src/lib/embeddings/store.js';
import { buildCloudIndex, loadVectorIndex, readVectorMeta } from '../src/lib/embeddings/vector-store.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const POOL = 50; // hybrid.ts POOL: both rankers' candidate depth
const MAX_EVAL_USD = 2.9;
const LANGS = ['tr', 'en', 'mixed'] as const;
type Lang = (typeof LANGS)[number];
type Source = 'api' | 'nano' | 'e5';
const RERANK_BY_SHORT: Record<string, RerankModel> = { lite: 'voyageai/rerank-2.5-lite', '2.5': 'voyageai/rerank-2.5' };
const SHORT_BY_RERANK: Record<RerankModel, string> = { 'voyageai/rerank-2.5-lite': 'lite', 'voyageai/rerank-2.5': '2.5' };

const log = (...a: unknown[]): void => console.error(new Date().toISOString().slice(11, 19), ...a);
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const b64 = (v: Float32Array): string => Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64');
const unb64 = (s: string): Float32Array => {
  const buf = Buffer.from(s, 'base64');
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
};
const pct = (k: number, n: number): number => (n ? (k / n) * 100 : 0);

function atomicWrite(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

// ── guards ───────────────────────────────────────────────────────────────────

function refuseSealed(path: string, home: string): string {
  const abs = resolve(path);
  let sealed = abs.includes(`${sep}sealed${sep}`);
  if (!sealed) {
    try { assertUnder(sealedDir(home), abs, 'gold'); sealed = true; } catch { /* not under the sealed dir: good */ }
  }
  if (sealed) throw new Error(`recall-tune refuses a sealed path: ${abs}`);
  return abs;
}

interface Args { cmd: string; flags: Map<string, string>; has: (f: string) => boolean; get: (f: string, d?: string) => string | undefined }

function parse(argv: string[]): Args {
  const flags = new Map<string, string>();
  const [cmd = 'help', ...rest] = argv;
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith('--')) throw new Error(`unexpected argument: ${rest[i]}`);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) flags.set(rest[i], 'true');
    else { flags.set(rest[i], next); i++; }
  }
  return { cmd, flags, has: (f) => flags.has(f), get: (f, d) => flags.get(f) ?? d };
}

// ── context: snapshot, clock, corpus, gold, BM25 ──────────────────────────────

interface Ctx {
  home: string;
  snapshot: string;
  root: string;
  now: Date;
  corpus: CorpusDoc[];
  byKey: Map<string, CorpusDoc>;
  train: GoldQuery[];
  legacy: GoldQuery[];
  bm25: Map<string, RecallHit[]>;
  runFile: string;
}

function loadContext(args: Args): Ctx {
  assertNotSpawned('recall-tune');
  const home = resolve(args.get('--home') ?? homedir());
  const snapshot = join(frozenDir(home), SNAPSHOT_ID);
  const root = join(snapshot, '_dream_context');
  assertUnder(frozenDir(home), root, 'corpus root');
  if (!isUnderEvalFrozenDir(root, home)) throw new Error('corpus root is not a frozen snapshot (FINGERPRINT.json / now.txt missing)');
  const nowArg = args.get('--now') ?? `@${snapshot}`;
  if (resolve(nowArg.replace(/^@/, '')) !== resolve(snapshot)) throw new Error(`--now must be pinned to the snapshot (@${snapshot})`);
  const now = loadNow(nowArg);

  const trainFile = refuseSealed(join(REPO, 'eval', 'gold-v2', 'train.jsonl'), home);
  const legacyFiles = ['gold.jsonl', 'gold-heldout.jsonl'].map((f) => refuseSealed(join(REPO, 'eval', f), home));
  const train = loadGold(trainFile);
  const legacy = legacyFiles.flatMap((f) => loadGold(f));
  const corpus = stableCorpus(root);
  const date = args.get('--date') ?? new Date().toISOString().slice(0, 10);
  const runFile = resolve(args.get('--out') ?? join(REPO, 'eval', 'runs', `${date}-tune-train.json`));
  assertUnder(join(REPO, 'eval', 'runs'), runFile, '--out');

  const bm25 = new Map<string, RecallHit[]>();
  for (const g of [...train, ...legacy]) bm25.set(g.query, bm25Search(g.query, corpus, POOL, { now }));
  log(`snapshot ${SNAPSHOT_ID} · ${corpus.length} docs · train ${train.length} legacy ${legacy.length} · now ${now.toISOString()}`);
  return { home, snapshot, root, now, corpus, byKey: new Map(corpus.map((d) => [docKey(d), d])), train, legacy, bm25, runFile };
}

function assertSpendCeiling(ctx: Ctx): void {
  const ceiling = evalSpendCeilingUsd(ctx.home);
  if (!(ceiling <= MAX_EVAL_USD + 1e-9)) {
    throw new Error(`set DREAMCONTEXT_EVAL_MAX_USD=${MAX_EVAL_USD} (effective eval ceiling is ${ceiling})`);
  }
}

const evalSpent = (ctx: Ctx): number => readRecallCloudUsage(ctx.home).evalSpentUsd;

// ── run file (merged sections) ───────────────────────────────────────────────

function readRun(ctx: Ctx): Record<string, unknown> {
  try { return JSON.parse(readFileSync(ctx.runFile, 'utf-8')) as Record<string, unknown>; } catch { return {}; }
}
function writeSection(ctx: Ctx, name: string, value: unknown): void {
  const run = readRun(ctx);
  run.label = 'T6b-tune-train';
  run.now = ctx.now.toISOString();
  run.sealedTouched = false;
  run[name] = value;
  atomicWrite(ctx.runFile, `${JSON.stringify(run, null, 1)}\n`);
  log(`wrote section "${name}" -> ${ctx.runFile}`);
}

// ── metrics ──────────────────────────────────────────────────────────────────

interface Cell { n: number; h1: number; h3: number; h5: number; rr: number }
interface Scored {
  cells: Record<Lang | 'all', Cell>;
  exact: { n: number; h1: number };
  rank: Map<string, number | null>;
}
const emptyCell = (): Cell => ({ n: 0, h1: 0, h3: 0, h5: 0, rr: 0 });

function rankOf(g: GoldQuery, keys: string[]): number | null {
  const targets = new Set([...g.expected, ...(g.alt ?? [])]);
  const i = keys.slice(0, 10).findIndex((k) => targets.has(k));
  return i >= 0 ? i + 1 : null;
}

function score(items: GoldQuery[], keysByQuery: Map<string, string[]>): Scored {
  const cells = { tr: emptyCell(), en: emptyCell(), mixed: emptyCell(), all: emptyCell() } as Record<Lang | 'all', Cell>;
  const exact = { n: 0, h1: 0 };
  const rank = new Map<string, number | null>();
  for (const g of items) {
    const r = rankOf(g, keysByQuery.get(g.query) ?? []);
    rank.set(g.id, r);
    for (const c of [cells[g.lang as Lang], cells.all]) {
      if (!c) continue;
      c.n++;
      if (r !== null) { if (r === 1) c.h1++; if (r <= 3) c.h3++; if (r <= 5) c.h5++; c.rr += 1 / r; }
    }
    if (g.category === 'exact-term') { exact.n++; if (r === 1) exact.h1++; }
  }
  return { cells, exact, rank };
}

const worstHits = (s: Scored): number => Math.min(...LANGS.map((l) => s.cells[l].h5));
const worstLang = (s: Scored): Lang => LANGS.reduce((a, b) => (s.cells[b].h5 < s.cells[a].h5 ? b : a));
const mrrOf = (s: Scored): number => (s.cells.all.n ? s.cells.all.rr / s.cells.all.n : 0);

function summarize(s: Scored): Record<string, unknown> {
  const per: Record<string, unknown> = {};
  for (const l of [...LANGS, 'all'] as const) {
    const c = s.cells[l];
    per[l] = { n: c.n, r1: +pct(c.h1, c.n).toFixed(1), r3: +pct(c.h3, c.n).toFixed(1), r5: +pct(c.h5, c.n).toFixed(1), mrr: +(c.n ? c.rr / c.n : 0).toFixed(4), h5: c.h5 };
  }
  return { byLang: per, worstLang: worstLang(s), worstR5: +pct(worstHits(s), 30).toFixed(1), exactTermR1: `${s.exact.h1}/${s.exact.n}` };
}

function table(title: string, s: Scored): string {
  const rows = ([...LANGS, 'all'] as const).map((l) => {
    const c = s.cells[l];
    return `  ${l.padEnd(6)} n=${String(c.n).padStart(3)}  r@1 ${pct(c.h1, c.n).toFixed(1).padStart(5)}  r@3 ${pct(c.h3, c.n).toFixed(1).padStart(5)}  r@5 ${pct(c.h5, c.n).toFixed(1).padStart(5)}  MRR ${(c.n ? c.rr / c.n : 0).toFixed(3)}`;
  });
  return `${title}  (exact-term r@1 ${s.exact.h1}/${s.exact.n})\n${rows.join('\n')}`;
}

// ── dense data (index + query vectors) ───────────────────────────────────────

interface DenseSet {
  name: string;
  /** Changelog-free view hybrid.ts searches (denseEligible). */
  index: DenseIndex;
  /** Full index chunks per doc (best-chunk choice for rerank). */
  byDoc: Map<string, IndexedChunk[]>;
  qvec: Map<string, Float32Array>;
  memo: Map<string, DenseHit[]>;
}

function makeDenseSet(name: string, full: DenseIndex, qvec: Map<string, Float32Array>): DenseSet {
  const byDoc = new Map<string, IndexedChunk[]>();
  for (const c of full.chunks) {
    const list = byDoc.get(c.docKey) ?? [];
    list.push(c);
    byDoc.set(c.docKey, list);
  }
  const index: DenseIndex = { dims: full.dims, chunks: full.chunks.filter((c) => !c.docKey.startsWith('changelog/')) };
  return { name, index, byDoc, qvec, memo: new Map() };
}

function denseHits(ds: DenseSet, g: GoldQuery, p: FusionParams): DenseHit[] {
  const qv = ds.qvec.get(g.query);
  if (!qv) return [];
  const memoKey = `${g.query}|${p.aggregation}|${p.secondWeight}`;
  let hits = ds.memo.get(memoKey);
  if (!hits) { hits = denseRankAgg(qv, ds.index, POOL, p.aggregation, p.secondWeight); ds.memo.set(memoKey, hits); }
  return hits;
}

interface Fusion { fused: Array<{ key: string; fused: number }>; bm25: RecallHit[]; dense: DenseHit[]; skipped: boolean }

function fuse(ctx: Ctx, ds: DenseSet, g: GoldQuery, p: FusionParams): Fusion {
  const bm25 = ctx.bm25.get(g.query) as RecallHit[];
  if (shouldSkipDense(bm25, p.denseGate) || !ds.qvec.has(g.query)) {
    return { fused: bm25.map((h) => ({ key: docKey(h.doc), fused: h.rankScore })), bm25, dense: [], skipped: true };
  }
  const dense = denseHits(ds, g, p);
  return { fused: fuseCandidates(bm25, dense, p, { byKey: ctx.byKey, now: ctx.now }), bm25, dense, skipped: false };
}

function rankAll(ctx: Ctx, ds: DenseSet, items: GoldQuery[], p: FusionParams): Scored {
  const keys = new Map<string, string[]>();
  for (const g of items) keys.set(g.query, fuse(ctx, ds, g, p).fused.map((e) => e.key));
  return score(items, keys);
}

function skipRate(ctx: Ctx, ds: DenseSet, items: GoldQuery[], p: FusionParams): number {
  return items.filter((g) => fuse(ctx, ds, g, p).skipped).length / items.length;
}

function rawScored(ctx: Ctx, items: GoldQuery[]): Scored {
  const keys = new Map<string, string[]>();
  for (const g of items) keys.set(g.query, (ctx.bm25.get(g.query) as RecallHit[]).map((h) => docKey(h.doc)));
  return score(items, keys);
}

// ── query vectors ────────────────────────────────────────────────────────────

function readVectorFile(path: string): Map<string, Float32Array> {
  const out = new Map<string, Float32Array>();
  if (!existsSync(path)) return out;
  for (const [h, s] of Object.entries(JSON.parse(readFileSync(path, 'utf-8')) as Record<string, string>)) out.set(h, unb64(s));
  return out;
}
function writeVectorFile(path: string, m: Map<string, Float32Array>): void {
  atomicWrite(path, JSON.stringify(Object.fromEntries([...m].map(([h, v]) => [h, b64(v)]))));
}

const queryCachePath = (ctx: Ctx, src: Source): string => join(ctx.snapshot, 'cache', 'queries', `${src}.json`);

async function retry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try { return await fn(); } catch (err) {
      const transient = err instanceof CloudRecallError && ['timeout', 'network', 'rate_limit'].includes(err.kind);
      if (!transient || attempt >= 4) throw err;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
}

/** Embed (and cache) the query vectors of every train + legacy query for one source. */
async function queryVectors(ctx: Ctx, src: Source): Promise<Map<string, Float32Array>> {
  const path = queryCachePath(ctx, src);
  const cached = readVectorFile(path);
  const out = new Map<string, Float32Array>();
  const todo: GoldQuery[] = [];
  for (const g of [...ctx.train, ...ctx.legacy]) {
    const v = cached.get(sha(g.query));
    if (v) out.set(g.query, v); else if (!out.has(g.query) && !todo.some((t) => t.query === g.query)) todo.push(g);
  }
  if (todo.length === 0) return out;
  if (src === 'api') assertSpendCeiling(ctx);
  log(`${src} query vectors: ${todo.length} to embed, ${out.size} cached`);
  const embedOne = async (g: GoldQuery): Promise<Float32Array | null> => {
    if (src === 'e5') return embedQuery(g.query);
    if (src === 'nano') return nanoEmbedQuery(g.query, { home: ctx.home });
    const minted = buildEgressPayload({ kind: 'query', contextRoot: ctx.root, tier: 'cloud', evalConsent: true, home: ctx.home, query: g.query });
    if (minted.payload === null) { log(`  query ${g.id} withheld (${minted.withheld[0]?.rule ?? '?'})`); return null; }
    const res = await retry(() => openRouterEmbed(minted.payload as EgressPayload<'query'>, { timeoutMs: 30_000 }));
    return res.vectors[0] ?? null;
  };
  const width = src === 'api' ? 4 : 1;
  for (let i = 0; i < todo.length; i += width) {
    const part = todo.slice(i, i + width);
    const vs = await Promise.all(part.map(embedOne));
    part.forEach((g, k) => { const v = vs[k]; if (v) { out.set(g.query, v); cached.set(sha(g.query), v); } });
    if ((i / width) % 10 === 9) { writeVectorFile(path, cached); log(`  ${Math.min(i + width, todo.length)}/${todo.length}`); }
  }
  writeVectorFile(path, cached);
  return out;
}

// ── dense sets per profile ───────────────────────────────────────────────────

function e5Index(ctx: Ctx): DenseIndex {
  const path = join(ctx.root, '.embeddings', 'cache.json');
  if (!existsSync(path)) throw new Error('the snapshot e5 index does not exist yet (TB builds it) — not building it here');
  const cache = JSON.parse(readFileSync(path, 'utf-8')) as {
    version: number; model: string; docs: Record<string, { hashes: string[] }>; vectors: Record<string, string>;
  };
  if (cache.model !== EMBED_MODEL) throw new Error(`e5 cache is for ${cache.model}, expected ${EMBED_MODEL}`);
  const chunks: IndexedChunk[] = [];
  let dims = 0;
  for (const [key, entry] of Object.entries(cache.docs)) {
    entry.hashes.forEach((hash, seq) => {
      const s = cache.vectors[hash];
      if (!s) return;
      const vector = unb64(s);
      dims = vector.length;
      chunks.push({ docKey: key, seq, hash, vector });
    });
  }
  return { dims, chunks };
}

function e5Coverage(ctx: Ctx, index: DenseIndex): { docs: number; covered: number } {
  const have = new Set(index.chunks.map((c) => `${c.docKey}#${c.seq}`));
  let docs = 0;
  let covered = 0;
  for (const d of ctx.corpus) {
    if (d.type === 'changelog') continue;
    docs++;
    const n = VOYAGE_4_PROFILE.chunk(d).length; // same base chunker as e5
    if (n > 0 && Array.from({ length: n }, (_, i) => have.has(`${docKey(d)}#${i}`)).every(Boolean)) covered++;
  }
  return { docs, covered };
}

async function denseSetFor(ctx: Ctx, src: Source): Promise<DenseSet> {
  const qv = await queryVectors(ctx, src);
  if (src === 'e5') {
    const index = e5Index(ctx);
    const cov = e5Coverage(ctx, index);
    log(`e5 index: ${index.chunks.length} chunks · fully covered non-changelog docs ${cov.covered}/${cov.docs}`);
    if (cov.covered / cov.docs < 0.98) throw new Error('e5 index is incomplete — TB is still building it; come back later');
    return makeDenseSet('e5', index, qv);
  }
  const index = loadVectorIndex(ctx.root, 'voyage-4');
  if (!index) throw new Error('no voyage-4 index on the snapshot — run `index` first');
  return makeDenseSet(src === 'api' ? 'voyage+api-query' : 'voyage+nano-query', index, qv);
}

// ── constraints (B0) ─────────────────────────────────────────────────────────

interface Constraints {
  trainExactR1Min: number;
  trainEnR5Min: number;
  legacyExactR1Min: number;
  legacyEnR5Min: number;
  sources: string[];
}

interface B0Report { label: string; perQuery: Array<{ category: string; lang: string; rank: number | null }> }

function readB0(): { train: B0Report[]; legacy: B0Report[] } {
  const dir = join(REPO, 'eval', 'runs');
  const out = { train: [] as B0Report[], legacy: [] as B0Report[] };
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (!/B0/.test(f) || !f.endsWith('.json') || /tune/.test(f)) continue;
    const j = JSON.parse(readFileSync(join(dir, f), 'utf-8')) as Record<string, unknown>;
    const reports: Array<[string, Record<string, unknown>]> = [];
    if (Array.isArray(j.perQuery)) reports.push([String(j.label ?? f), j]);
    for (const v of Object.values(j)) {
      if (v && typeof v === 'object' && Array.isArray((v as { perQuery?: unknown }).perQuery)) reports.push([String((v as { label?: unknown }).label ?? f), v as Record<string, unknown>]);
    }
    for (const [label, r] of reports) {
      const split = String((r as { split?: unknown }).split ?? (/legacy/.test(f) ? 'legacy' : 'train'));
      (split === 'legacy' ? out.legacy : out.train).push({ label: `${f}:${label}`, perQuery: r.perQuery as B0Report['perQuery'] });
    }
  }
  return out;
}

function b0Constraints(ctx: Ctx): Constraints {
  const b0 = readB0();
  const exactR1 = (r: B0Report): number => r.perQuery.filter((q) => q.category === 'exact-term' && q.rank === 1).length;
  const enH5 = (r: B0Report): number => r.perQuery.filter((q) => q.lang === 'en' && q.rank !== null && q.rank <= 5).length;
  const raw = b0.train.filter((r) => /raw/i.test(r.label));
  const sources = b0.train.map((r) => r.label);
  const rawTrain = rawScored(ctx, ctx.train);
  const rawLegacy = rawScored(ctx, ctx.legacy);
  const legacyRaw = b0.legacy.filter((r) => /raw/i.test(r.label));
  return {
    trainExactR1Min: raw.length ? Math.max(...raw.map(exactR1)) : rawTrain.exact.h1,
    trainEnR5Min: b0.train.length ? Math.max(...b0.train.map(enH5)) : rawTrain.cells.en.h5,
    legacyExactR1Min: legacyRaw.length ? Math.max(...legacyRaw.map(exactR1)) : rawLegacy.exact.h1,
    legacyEnR5Min: b0.legacy.length ? Math.max(...b0.legacy.map(enH5)) : rawLegacy.cells.en.h5,
    sources: [...sources, ...b0.legacy.map((r) => r.label)],
  };
}

function feasible(train: Scored, legacy: Scored, c: Constraints): boolean {
  return train.exact.h1 >= c.trainExactR1Min && train.cells.en.h5 >= c.trainEnR5Min
    && legacy.exact.h1 >= c.legacyExactR1Min && legacy.cells.en.h5 >= c.legacyEnR5Min;
}

// ── coordinate descent (stage 1) ─────────────────────────────────────────────

type Mutator = (p: FusionParams) => FusionParams;
interface AxisValue { label: string; apply: Mutator }
interface Axis { name: string; values: AxisValue[] }

/** `--extend` adds lambda values beyond the plan's grid (used only to see whether the optimum sits on the grid edge). */
function axesFor(extend: boolean): Axis[] {
  if (!extend) return AXES;
  return AXES.map((a) => (a.name !== 'relativeLambda' ? a : {
    name: a.name,
    values: [0.1, 0.3, 0.5, 0.7, 0.8, 0.9].map((v) => ({ label: String(v), apply: (p: FusionParams) => ({ ...p, relativeLambda: v }) })),
  }));
}

const AXES: Axis[] = [
  { name: 'rrfBm25Weight', values: [0.6, 0.5, 0.4, 0.3, 0.2, 0.1].map((v) => ({ label: String(v), apply: (p) => ({ ...p, rrfBm25Weight: v }) })) },
  { name: 'relativeLambda', values: [0.1, 0.3, 0.5, 0.7].map((v) => ({ label: String(v), apply: (p) => ({ ...p, relativeLambda: v }) })) },
  { name: 'rawCutoff', values: [18, 12, 24].map((v) => ({ label: String(v), apply: (p) => ({ ...p, rawCutoff: v }) })) },
  { name: 'rrfK', values: [60, 20].map((v) => ({ label: String(v), apply: (p) => ({ ...p, rrfK: v }) })) },
  { name: 'pinMargin', values: [1.35, 0].map((v) => ({ label: v === 0 ? 'off' : String(v), apply: (p) => ({ ...p, pinMargin: v }) })) },
  {
    name: 'aggregation',
    values: [
      { label: 'max', apply: (p) => ({ ...p, aggregation: 'max', secondWeight: 0 }) },
      { label: 'max+0.1*second', apply: (p) => ({ ...p, aggregation: 'max+second', secondWeight: 0.1 }) },
    ],
  },
  { name: 'changelogFactor', values: [0.85, 0.5].map((v) => ({ label: String(v), apply: (p) => ({ ...p, changelogFactor: v }) })) },
];

const COMPLEXITY_KEYS = ['rawCutoff', 'rrfK', 'rrfBm25Weight', 'relativeLambda', 'pinMargin', 'aggregation', 'secondWeight', 'priorGamma', 'changelogFactor'] as const;
function complexity(p: FusionParams, base: FusionParams): number {
  let c = COMPLEXITY_KEYS.filter((k) => p[k] !== base[k]).length;
  if (p.denseGate) c++;
  if (p.langWeights) c++;
  return c;
}

interface TrailRow { axis: string; value: string; worst: number; worstLang: string; mrr: number; train: Record<string, unknown>; legacy: Record<string, unknown>; feasible: boolean; chosen: boolean }

interface Evaluated { p: FusionParams; train: Scored; legacy: Scored; ok: boolean }

function descend(ctx: Ctx, ds: DenseSet, start: FusionParams, base: FusionParams, c: Constraints, sweeps: number, axes: Axis[]): { params: FusionParams; trail: TrailRow[] } {
  const evalP = (p: FusionParams): Evaluated => {
    const train = rankAll(ctx, ds, ctx.train, p);
    const legacy = rankAll(ctx, ds, ctx.legacy, p);
    return { p, train, legacy, ok: feasible(train, legacy, c) };
  };
  let cur = start;
  let globalBest = evalP(cur);
  const trail: TrailRow[] = [];
  const better = (a: Evaluated, b: Evaluated): boolean => {
    if (a.ok !== b.ok) return a.ok;
    const wa = worstHits(a.train);
    const wb = worstHits(b.train);
    return wa !== wb ? wa > wb : mrrOf(a.train) > mrrOf(b.train);
  };
  for (let sweep = 0; sweep < sweeps; sweep++) {
    const before = JSON.stringify(cur);
    for (const axis of axes) {
      const rows = axis.values.map((v) => ({ v, e: evalP(v.apply(cur)) }));
      for (const r of rows) if (better(r.e, globalBest)) globalBest = r.e;
      const bestWorst = worstHits(globalBest.train);
      const band = rows.filter((r) => r.e.ok && worstHits(r.e.train) >= bestWorst - 1);
      const pool = band.length ? band : rows.filter((r) => r.e.ok);
      const pick = (pool.length ? pool : rows).reduce((a, b) => {
        const ca = complexity(a.e.p, base);
        const cb = complexity(b.e.p, base);
        if (ca !== cb) return ca < cb ? a : b;
        return mrrOf(b.e.train) > mrrOf(a.e.train) ? b : a;
      });
      for (const r of rows) {
        trail.push({
          axis: `${sweep + 1}:${axis.name}`, value: r.v.label, worst: worstHits(r.e.train), worstLang: worstLang(r.e.train), mrr: +mrrOf(r.e.train).toFixed(4),
          train: summarize(r.e.train), legacy: summarize(r.e.legacy), feasible: r.e.ok, chosen: r === rows.find((x) => x === pick),
        });
      }
      cur = pick.e.p;
      log(`  [${sweep + 1}] ${axis.name} -> ${pick.v.label}  (worst-lang hits ${worstHits(pick.e.train)}/30 ${worstLang(pick.e.train)}, mrr ${mrrOf(pick.e.train).toFixed(3)}, best seen ${bestWorst})`);
    }
    if (JSON.stringify(cur) === before) break;
  }
  return { params: cur, trail };
}

const GATES: DenseGate[] = [];
for (const rawSure of [60, 40, 30, 25, 20]) for (const rawLead of [30, 22, 18, 14]) for (const leadRatio of [3, 2, 1.5]) {
  if (rawLead <= rawSure) GATES.push({ rawSure, rawLead, leadRatio });
}

/** The most aggressive dense gate that loses no r@5 hit in any language and no r@1 hit overall, on train AND legacy (and keeps the constraints). */
function pickGate(ctx: Ctx, ds: DenseSet, core: FusionParams, c: Constraints): { gate: DenseGate | null; rows: Array<Record<string, unknown>> } {
  const baseTrain = rankAll(ctx, ds, ctx.train, core);
  const baseLegacy = rankAll(ctx, ds, ctx.legacy, core);
  const rows: Array<Record<string, unknown>> = [];
  let best: { g: DenseGate; skip: number } | null = null;
  for (const gate of GATES) {
    const p = { ...core, denseGate: gate };
    const t = rankAll(ctx, ds, ctx.train, p);
    const l = rankAll(ctx, ds, ctx.legacy, p);
    const noLoss = LANGS.every((lang) => t.cells[lang].h5 >= baseTrain.cells[lang].h5 && l.cells[lang].h5 >= baseLegacy.cells[lang].h5)
      && t.cells.all.h1 >= baseTrain.cells.all.h1 && l.cells.all.h1 >= baseLegacy.cells.all.h1
      && feasible(t, l, c);
    const skip = (skipRate(ctx, ds, ctx.train, p) + skipRate(ctx, ds, ctx.legacy, p)) / 2;
    rows.push({ gate, noLoss, skipRate: +skip.toFixed(3), trainH5: t.cells.all.h5, legacyH5: l.cells.all.h5 });
    if (noLoss && (best === null || skip > best.skip + 1e-9)) best = { g: gate, skip };
  }
  return { gate: best && best.skip > 0 ? best.g : null, rows };
}

// ── rerank scores (cached per model, query, doc) ─────────────────────────────

class ScoreCache {
  private data: Record<string, Record<string, number | null>> = {};
  private dirty = false;
  constructor(private readonly path: string) {
    if (existsSync(path)) this.data = JSON.parse(readFileSync(path, 'utf-8')) as typeof this.data;
  }
  get(query: string, key: string): number | null | undefined { return this.data[sha(query)]?.[key]; }
  set(query: string, key: string, v: number | null): void {
    (this.data[sha(query)] ??= {})[key] = v;
    this.dirty = true;
  }
  flush(): void { if (this.dirty) { atomicWrite(this.path, JSON.stringify(this.data)); this.dirty = false; } }
}

const caches = new Map<string, ScoreCache>();
function scoreCache(ctx: Ctx, model: RerankModel, salt: string): ScoreCache {
  const path = join(ctx.snapshot, 'cache', 'rerank', salt, `${SHORT_BY_RERANK[model]}.json`);
  let c = caches.get(path);
  if (!c) { c = new ScoreCache(path); caches.set(path, c); }
  return c;
}
const flushCaches = (): void => { for (const c of caches.values()) c.flush(); };

interface Counters { calls: number; cacheHits: number; withheldAll: number; failed: number }
const counters: Counters = { calls: 0, cacheHits: 0, withheldAll: 0, failed: 0 };

/** The chunk of `doc` the query matches best: by similarity over its indexed chunks, else lexically (hybrid.ts bestChunkFor). */
function bestChunkFor(ds: DenseSet, doc: CorpusDoc, qv: Float32Array, query: string) {
  const chunks = VOYAGE_4_PROFILE.chunk(doc);
  const indexed = ds.byDoc.get(docKey(doc));
  if (indexed && indexed.length > 0) {
    let best: IndexedChunk | null = null;
    let bestDot = -Infinity;
    for (const c of indexed) {
      let dot = 0;
      for (let i = 0; i < c.vector.length; i++) dot += c.vector[i] * qv[i];
      if (dot > bestDot || (dot === bestDot && best !== null && c.seq < best.seq)) { best = c; bestDot = dot; }
    }
    const chunk = best ? chunks[best.seq] : undefined;
    if (best && chunk && chunk.hash === best.hash) return chunk;
  }
  return pickBestChunkLexical(chunks, query);
}

/** Relevance per window doc, from the cache or (once) from the API through the egress layer. */
async function windowScores(ctx: Ctx, ds: DenseSet, model: RerankModel, salt: string, g: GoldQuery, window: Array<{ key: string }>): Promise<Map<string, number>> {
  const cache = scoreCache(ctx, model, salt);
  const missing = window.some((e) => cache.get(g.query, e.key) === undefined);
  if (missing) {
    assertSpendCeiling(ctx);
    const qv = ds.qvec.get(g.query) as Float32Array;
    const candidates = window.flatMap((e) => {
      const doc = ctx.byKey.get(e.key);
      return doc ? [{ doc, bestChunk: bestChunkFor(ds, doc, qv, g.query) }] : [];
    });
    const minted = buildEgressPayload({ kind: 'rerank', contextRoot: ctx.root, tier: 'cloud', evalConsent: true, home: ctx.home, model, query: g.query, candidates });
    const scored = new Map<string, number>();
    if (minted.payload === null) counters.withheldAll++;
    else {
      const payload = minted.payload;
      const res = await retry(() => openRouterRerank(payload, { timeoutMs: 40_000 }));
      counters.calls++;
      for (const [k, v] of rerankScoresByKey(payload, res.scores)) scored.set(k, v);
    }
    for (const e of window) cache.set(g.query, e.key, scored.get(e.key) ?? null);
  } else counters.cacheHits++;
  const out = new Map<string, number>();
  for (const e of window) { const v = cache.get(g.query, e.key); if (typeof v === 'number') out.set(e.key, v); }
  return out;
}

type RerankCfg = NonNullable<FusionParams['rerank']>;

/** hybrid.ts rerankWindow, replicated. */
function rerankWindow(f: Fusion, rr: RerankCfg): Array<{ key: string; fused: number }> {
  if ((rr.pool ?? 'fused-top') === 'fused-top') return f.fused.slice(0, rr.candidates);
  const half = Math.max(1, Math.floor(rr.candidates / 2));
  const pick = new Set<string>([...f.bm25.slice(0, half).map((h) => docKey(h.doc)), ...f.dense.slice(0, half).map((h) => h.docKey)]);
  return f.fused.filter((e) => pick.has(e.key));
}

async function rerankedKeys(ctx: Ctx, ds: DenseSet, model: RerankModel, salt: string, g: GoldQuery, p: FusionParams): Promise<string[]> {
  const f = fuse(ctx, ds, g, p);
  const rr = p.rerank;
  const base = f.fused.map((e) => e.key);
  if (rr === null || f.skipped) return base;
  const window = rerankWindow(f, rr);
  if (window.length === 0) return base;
  const scores = await windowScores(ctx, ds, model, salt, g, window);
  if ((rr.pool ?? 'fused-top') === 'fused-top') return applyRerank(f.fused, scores, rr.blendAlpha, rr.candidates);
  const reranked = applyRerank(window, scores, rr.blendAlpha, window.length);
  const inUnion = new Set(reranked);
  return [...reranked, ...base.filter((k) => !inUnion.has(k))];
}

async function rankAllReranked(ctx: Ctx, ds: DenseSet, model: RerankModel, salt: string, items: GoldQuery[], p: FusionParams): Promise<Scored> {
  const keys = new Map<string, string[]>();
  for (const g of items) keys.set(g.query, await rerankedKeys(ctx, ds, model, salt, g, p));
  return score(items, keys);
}

// ── commands ─────────────────────────────────────────────────────────────────

async function cmdIndex(ctx: Ctx): Promise<void> {
  assertSpendCeiling(ctx);
  const seed = readVectorFile(join(ctx.snapshot, 'cache', 'vectors', 'voyage-4.json'));
  log(`seed vectors: ${seed.size} · eval spent so far $${evalSpent(ctx).toFixed(4)}`);
  const res = await buildCloudIndex(ctx.root, 'voyage-4', ctx.corpus, {
    trigger: 'eval', evalConsent: true, home: ctx.home, seedVectors: seed, batchSize: 64,
    onProgress: (done, total, usd) => log(`  embedded ${done}/${total} · $${usd.toFixed(4)}`),
  });
  const meta = readVectorMeta(ctx.root, 'voyage-4');
  log(`index: embedded ${res.embedded} reused ${res.reused} evicted ${res.evicted} aborted ${res.aborted ?? 'no'} · covered ${meta?.coveredDocs}/${meta?.eligibleTotal}`);
  if (res.aborted) throw new Error(`index build aborted: ${res.aborted}`);
  console.log(JSON.stringify({ embedded: res.embedded, reused: res.reused, covered: meta?.coveredDocs, eligibleTotal: meta?.eligibleTotal, evalSpentUsd: evalSpent(ctx) }));
}

function profileSource(args: Args): Source {
  const s = args.get('--profile') ?? args.get('--source');
  if (s !== 'api' && s !== 'nano' && s !== 'e5') throw new Error('--profile must be api, nano or e5');
  return s;
}

async function cmdVectors(ctx: Ctx, args: Args): Promise<void> {
  const src = profileSource(args);
  const v = await queryVectors(ctx, src);
  console.log(JSON.stringify({ source: src, vectors: v.size, evalSpentUsd: evalSpent(ctx) }));
}

async function cmdStage1(ctx: Ctx, args: Args): Promise<void> {
  const src = profileSource(args);
  const ds = await denseSetFor(ctx, src);
  const c = b0Constraints(ctx);
  log(`constraints: train exact-term r@1 >= ${c.trainExactR1Min}, train EN hits >= ${c.trainEnR5Min}; legacy exact-term r@1 >= ${c.legacyExactR1Min}, legacy EN hits >= ${c.legacyEnR5Min}  [B0 files: ${c.sources.join(', ') || 'none'}]`);
  const tier: RecallTier = src === 'e5' ? 'local' : src === 'nano' ? 'cloud-index' : 'cloud';
  const base = SPIKE_FUSION.local;
  const start = base;
  const baseTrain = rankAll(ctx, ds, ctx.train, base);
  const baseLegacy = rankAll(ctx, ds, ctx.legacy, base);
  console.error(table(`BASELINE production fusion (${ds.name}) train`, baseTrain));
  console.error(table(`BASELINE production fusion (${ds.name}) legacy`, baseLegacy));
  console.error(table('RAW BM25 train', rawScored(ctx, ctx.train)));
  const { params: core, trail } = descend(ctx, ds, start, base, c, Number(args.get('--sweeps') ?? 2), axesFor(args.has('--extend')));
  const gate = pickGate(ctx, ds, core, c);
  const tuned: FusionParams = { ...core, denseGate: gate.gate };
  const trainFinal = rankAll(ctx, ds, ctx.train, tuned);
  const legacyFinal = rankAll(ctx, ds, ctx.legacy, tuned);
  console.error(table(`TUNED (${ds.name}) train`, trainFinal));
  console.error(table(`TUNED (${ds.name}) legacy`, legacyFinal));
  console.error(`tuned core: ${JSON.stringify(core)}\ngate: ${JSON.stringify(gate.gate)}`);
  writeSection(ctx, `stage1_${src}`, {
    tier, dense: ds.name, constraints: c,
    baseline: { train: summarize(baseTrain), legacy: summarize(baseLegacy) },
    raw: { train: summarize(rawScored(ctx, ctx.train)), legacy: summarize(rawScored(ctx, ctx.legacy)) },
    core, gate: gate.gate, gateGrid: gate.rows, params: tuned,
    tunedCore: { train: summarize(rankAll(ctx, ds, ctx.train, core)), legacy: summarize(rankAll(ctx, ds, ctx.legacy, core)) },
    tuned: { train: summarize(trainFinal), legacy: summarize(legacyFinal), skipRateTrain: +skipRate(ctx, ds, ctx.train, tuned).toFixed(3) },
    trail,
  });
  console.log(JSON.stringify({ tier, params: tuned, worstR5Train: pct(worstHits(trainFinal), 30), baselineWorstR5: pct(worstHits(baseTrain), 30) }));
}

interface Stage2Row {
  model: string; pool: string; n: number; alpha: number; worst: number; worstLang: string; mrr: number; r1: number;
  train: Record<string, unknown>; legacy?: Record<string, unknown>; ok: boolean; chosen?: boolean;
}

async function cmdStage2(ctx: Ctx, args: Args): Promise<void> {
  assertSpendCeiling(ctx);
  const run = readRun(ctx) as { stage1_api?: { params: FusionParams } };
  const core = args.has('--from-config') || !run.stage1_api ? FUSION_BY_TIER.cloud : run.stage1_api.params;
  const coreNoRerank: FusionParams = { ...core, rerank: null };
  const ds = await denseSetFor(ctx, 'api');
  const c = b0Constraints(ctx);
  const salt = args.get('--salt') ?? 'chunk-v1';
  const models = (args.get('--models') ?? 'lite,2.5').split(',').map((m) => RERANK_BY_SHORT[m]);
  const pools = (args.get('--pools') ?? 'bm25-dense-union,fused-top').split(',') as Array<'fused-top' | 'bm25-dense-union'>;
  const ns = (args.get('--ns') ?? '40,30,20').split(',').map(Number);
  const alphas = (args.get('--alphas') ?? '1,0.7').split(',').map(Number);
  const spent0 = evalSpent(ctx);
  log(`stage 2 on core ${JSON.stringify(coreNoRerank)} · models ${models.join(',')} pools ${pools.join(',')} N ${ns.join(',')} alpha ${alphas.join(',')}`);

  const noRerankTrain = rankAll(ctx, ds, ctx.train, coreNoRerank);
  console.error(table('NO RERANK (cloud core) train', noRerankTrain));
  const rows: Stage2Row[] = [];
  for (const model of models) for (const pool of pools) for (const n of ns) for (const alpha of alphas) {
    const p: FusionParams = { ...coreNoRerank, rerank: { candidates: n, blendAlpha: alpha, pool } };
    const train = await rankAllReranked(ctx, ds, model, salt, ctx.train, p);
    flushCaches();
    const row: Stage2Row = {
      model: SHORT_BY_RERANK[model], pool, n, alpha, worst: worstHits(train), worstLang: worstLang(train), mrr: +mrrOf(train).toFixed(4),
      r1: +pct(train.cells.all.h1, train.cells.all.n).toFixed(1), train: summarize(train), ok: true,
    };
    rows.push(row);
    log(`  ${row.model} ${pool} N=${n} a=${alpha}: worst ${row.worst}/30 (${row.worstLang}) tr ${train.cells.tr.h5} en ${train.cells.en.h5} mx ${train.cells.mixed.h5} · r@1 ${row.r1} mrr ${row.mrr} · api calls ${counters.calls} hits ${counters.cacheHits} · $${(evalSpent(ctx) - spent0).toFixed(4)}`);
  }
  // Legacy + constraints for every candidate that could be chosen (cached scores make this cheap after the first pass).
  const bestWorst = Math.max(...rows.map((r) => r.worst));
  const contenders = rows.filter((r) => r.worst >= bestWorst - 1);
  for (const r of contenders) {
    const p: FusionParams = { ...coreNoRerank, rerank: { candidates: r.n, blendAlpha: r.alpha, pool: r.pool as 'fused-top' | 'bm25-dense-union' } };
    const model = RERANK_BY_SHORT[r.model];
    const legacy = await rankAllReranked(ctx, ds, model, salt, ctx.legacy, p);
    flushCaches();
    r.legacy = summarize(legacy);
    const trainScored = await rankAllReranked(ctx, ds, model, salt, ctx.train, p);
    r.ok = feasible(trainScored, legacy, c);
    log(`  contender ${r.model} ${r.pool} N=${r.n} a=${r.alpha}: legacy ${JSON.stringify((r.legacy as { byLang: unknown }).byLang)} feasible ${r.ok}`);
  }
  const ok = contenders.filter((r) => r.ok);
  const cost = (r: Stage2Row): number => (r.model === '2.5' ? 3 : 0) + (r.n === 40 ? 2 : r.n === 30 ? 1 : 0) + (r.alpha === 1 ? 0 : 1);
  const pick = (ok.length ? ok : contenders).reduce((a, b) => {
    if (cost(a) !== cost(b)) return cost(a) < cost(b) ? a : b;
    if (a.pool !== b.pool) return a.pool === 'bm25-dense-union' ? a : b;
    return b.mrr > a.mrr ? b : a;
  });
  pick.chosen = true;
  flushCaches();
  const spent = evalSpent(ctx) - spent0;
  log(`stage 2 winner: ${pick.model} ${pick.pool} N=${pick.n} alpha=${pick.alpha} · worst ${pick.worst}/30 · eval spend this run $${spent.toFixed(4)} · api calls ${counters.calls}, cache hits ${counters.cacheHits}`);
  writeSection(ctx, 'stage2_cloud', {
    core: coreNoRerank, salt, noRerank: summarize(noRerankTrain), rows, winner: pick,
    rerankModel: RERANK_BY_SHORT[pick.model], params: { ...coreNoRerank, rerank: { candidates: pick.n, blendAlpha: pick.alpha, pool: pick.pool } },
    spendUsdThisRun: +spent.toFixed(4), evalLedgerUsd: +evalSpent(ctx).toFixed(4), counters,
  });
  console.log(JSON.stringify({ winner: pick, evalLedgerUsd: evalSpent(ctx) }));
}

/** No spend: how often is the target inside each rerank window (rerank can only reorder what it is given)? */
async function cmdCandidates(ctx: Ctx): Promise<void> {
  const run = readRun(ctx) as { stage1_api?: { params: FusionParams } };
  const core: FusionParams = { ...(run.stage1_api?.params ?? FUSION_BY_TIER.cloud), rerank: null };
  const ds = await denseSetFor(ctx, 'api');
  const out: Array<Record<string, unknown>> = [];
  for (const pool of ['bm25-dense-union', 'fused-top'] as const) for (const n of [20, 30, 40]) {
    const rr: RerankCfg = { candidates: n, blendAlpha: 1, pool };
    const row: Record<string, unknown> = { pool, n };
    for (const [name, items] of [['train', ctx.train], ['legacy', ctx.legacy]] as const) {
      const inWindow: Record<string, number> = { tr: 0, en: 0, mixed: 0 };
      let size = 0;
      for (const g of items) {
        const f = fuse(ctx, ds, g, core);
        const w = rerankWindow(f, rr);
        size += w.length;
        const targets = new Set([...g.expected, ...(g.alt ?? [])]);
        if (w.some((e) => targets.has(e.key))) inWindow[g.lang]++;
      }
      row[name] = { ...inWindow, meanWindow: +(size / items.length).toFixed(1), of: LANGS.map((l) => items.filter((g) => g.lang === l).length).join('/') };
    }
    out.push(row);
    console.error(`${pool.padEnd(17)} N=${n}: ${JSON.stringify(row.train)} | legacy ${JSON.stringify(row.legacy)}`);
  }
  writeSection(ctx, 'candidate_recall', out);
}

/** Rerank model of `--tier cloud` constants: DEFAULT_RERANK_MODEL, else lite. */
const constantsModel = (): RerankModel => DEFAULT_RERANK_MODEL ?? 'voyageai/rerank-2.5-lite';

async function reportTier(ctx: Ctx, tier: RecallTier, args: Args): Promise<Record<string, unknown>> {
  const p = FUSION_BY_TIER[tier];
  const src: Source = tier === 'local' ? 'e5' : tier === 'cloud' ? 'api' : (args.has('--nano-proxy') ? 'api' : 'nano');
  const ds = await denseSetFor(ctx, src);
  const salt = args.get('--salt') ?? 'chunk-v1';
  const res: Record<string, Scored> = {};
  for (const [name, items] of [['train', ctx.train], ['legacy', ctx.legacy]] as const) {
    res[name] = tier === 'cloud' ? await rankAllReranked(ctx, ds, constantsModel(), salt, items, p) : rankAll(ctx, ds, items, p);
    console.error(table(`${tier} (${ds.name}) ${name}`, res[name]));
  }
  flushCaches();
  return {
    tier, dense: ds.name, params: p, rerankModel: tier === 'cloud' ? constantsModel() : null,
    train: summarize(res.train), legacy: summarize(res.legacy),
    skipRateTrain: +skipRate(ctx, ds, ctx.train, p).toFixed(3),
    perQueryTrain: Object.fromEntries(res.train.rank),
  };
}

async function cmdReport(ctx: Ctx, args: Args): Promise<void> {
  const want = args.get('--tier', 'all') as string;
  const tiers: RecallTier[] = want === 'all' ? ['local', 'cloud-index', 'cloud'] : [want as RecallTier];
  const out: Record<string, unknown> = {};
  const failures: string[] = [];
  const spent0 = evalSpent(ctx);
  for (const t of tiers) {
    try { out[t] = await reportTier(ctx, t, args); } catch (err) { failures.push(`${t}: ${err instanceof Error ? err.message : String(err)}`); }
  }
  const b0 = b0Constraints(ctx);
  out.constraints = b0;
  out.raw = { train: summarize(rawScored(ctx, ctx.train)), legacy: summarize(rawScored(ctx, ctx.legacy)) };
  out.spendUsdThisRun = +(evalSpent(ctx) - spent0).toFixed(4);
  out.failures = failures;
  writeSection(ctx, `final_${want}`, out);
  if (failures.length) console.error(`report failures:\n  ${failures.join('\n  ')}`);
}

/** The real hybridSearch, with the constants as shipped, must reproduce the fast path's ranks. */
async function cmdVerify(ctx: Ctx, args: Args): Promise<void> {
  assertSpendCeiling(ctx);
  const tier = (args.get('--tier') ?? 'cloud') as RecallTier;
  const src: Source = tier === 'local' ? 'e5' : tier === 'cloud' ? 'api' : 'nano';
  const ds = await denseSetFor(ctx, src);
  const salt = args.get('--salt') ?? 'chunk-v1';
  const model = constantsModel();
  const cache = scoreCache(ctx, model, salt);
  const items = [...ctx.train, ...(args.has('--legacy') ? ctx.legacy : [])];
  const p = FUSION_BY_TIER[tier];
  const spent0 = evalSpent(ctx);
  const mismatches: string[] = [];
  const fallbacks: Record<string, number> = {};
  const keysReal = new Map<string, string[]>();
  const keysFast = new Map<string, string[]>();
  for (const g of items) {
    const timing = { tier, querySource: 'none' as const, fallback: 'none' as string };
    const rerankImpl = async (payload: EgressPayload<'rerank'>, o: CloudCallOpts) => {
      if (payload.itemKeys.every((k) => typeof cache.get(g.query, k) === 'number')) {
        counters.cacheHits++;
        return { scores: payload.itemKeys.map((k, index) => ({ index, relevance: cache.get(g.query, k) as number })), costUsd: 0 };
      }
      const res = await retry(() => openRouterRerank(payload, { ...o, timeoutMs: 40_000 }));
      counters.calls++;
      payload.itemKeys.forEach((k, i) => { const r = res.scores.find((s) => s.index === i); if (r) cache.set(g.query, k, r.relevance); });
      return res;
    };
    const opts = {
      now: ctx.now, tier, evalConsent: true, home: ctx.home, rerankModel: model, queryVec: ds.qvec.get(g.query), rerankImpl,
      ...(tier === 'local' ? { fusionParams: p, maxInlineEmbed: 0 } : {}), timing,
    } as Parameters<typeof hybridSearch>[4];
    const hits = await hybridSearch(g.query, ctx.corpus, ctx.root, 10, opts);
    fallbacks[timing.fallback] = (fallbacks[timing.fallback] ?? 0) + 1;
    keysReal.set(g.query, hits.map((h) => docKey(h.doc)));
    const fast = tier === 'cloud' ? await rerankedKeys(ctx, ds, model, salt, g, p) : fuse(ctx, ds, g, p).fused.map((e) => e.key);
    keysFast.set(g.query, fast);
    const a = JSON.stringify(keysReal.get(g.query)?.slice(0, 10));
    const b = JSON.stringify(fast.slice(0, 10));
    if (a !== b) mismatches.push(g.id);
  }
  flushCaches();
  const real = score(items, keysReal);
  const fast = score(items, keysFast);
  console.error(table(`hybridSearch (real) ${tier}`, real));
  console.error(table(`fast path ${tier}`, fast));
  log(`verify ${tier}: ${items.length} queries · rank mismatches ${mismatches.length}${mismatches.length ? ` (${mismatches.slice(0, 10).join(', ')})` : ''} · fallbacks ${JSON.stringify(fallbacks)} · eval spend $${(evalSpent(ctx) - spent0).toFixed(4)}`);
  writeSection(ctx, `verify_${tier}`, {
    tier, queries: items.length, mismatches, fallbacks, real: summarize(real), fast: summarize(fast),
    spendUsdThisRun: +(evalSpent(ctx) - spent0).toFixed(4),
  });
  if (mismatches.length) process.exitCode = 3;
}

async function main(): Promise<void> {
  const args = parse(process.argv.slice(2));
  if (args.cmd === 'help' || args.has('--help')) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf-8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
    return;
  }
  const ctx = loadContext(args);
  const t0 = Date.now();
  switch (args.cmd) {
    case 'index': await cmdIndex(ctx); break;
    case 'vectors': await cmdVectors(ctx, args); break;
    case 'stage1': await cmdStage1(ctx, args); break;
    case 'stage2': await cmdStage2(ctx, args); break;
    case 'candidates': await cmdCandidates(ctx); break;
    case 'report': await cmdReport(ctx, args); break;
    case 'verify': await cmdVerify(ctx, args); break;
    default: throw new Error(`unknown command: ${args.cmd}`);
  }
  flushCaches();
  log(`${args.cmd} done in ${Math.round((Date.now() - t0) / 1000)}s · eval ledger $${evalSpent(ctx).toFixed(4)} (ceiling $${evalSpendCeilingUsd(ctx.home).toFixed(2)})`);
}

main().catch((err) => {
  flushCaches();
  console.error(`recall-tune: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 2;
});
