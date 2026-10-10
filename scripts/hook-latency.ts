// End-to-end latency of the per-prompt recall hook, measured on a FROZEN brain.
//
// The hook is a fresh process per prompt, so the numbers that matter are the wall-clock of
// `node <dist>/index.js hook user-prompt-submit` — startup, corpus build, search, (for hybrid)
// model load — not an in-process search call.
//
// Usage (needs a built CLI: `npm run build:cli`, or a prebuilt archive's dist):
//   npx tsx scripts/hook-latency.ts --root <frozen _dream_context> --prompts <gold.jsonl> \
//       --mode raw|hybrid|floor [--tier local|cloud-index|cloud] [--n 50] [--no-model] \
//       [--dist <dir/index.js>] [--engine-root <dir>] [--cpu-prof <dir>] [--keep-scratch]
//
// Modes:
//   raw     DREAMCONTEXT_RECALL_MODE=raw     — BM25 recall; header must read `(BM25`
//   hybrid  DREAMCONTEXT_RECALL_MODE=hybrid  — header must read `(Hybrid` on every run
//   floor   DREAMCONTEXT_MEMORY_HOOK=0       — the recall-free floor; no recall header at all
//   --no-model  HOME → an empty dir, mode hybrid: the fresh-machine fallback. Header must read
//               `(BM25`, and no models dir / embedding cache may appear.
//   --tier      (mode hybrid only) the recall tier to measure. `local` (default) is the e5 hybrid. `cloud-index`
//               and `cloud` grant the SCRATCH copy a real vault consent (the machine's recall key and the
//               snapshot's voyage-4 index must exist; `cloud-index` also needs the nano model on disk) and revoke
//               it in `finally`. Every header must then read `Hybrid · <tier>`. `cloud` spends real money
//               (about $1 per 1,000 queries): keep n small.
//
// Safety:
//   - --root must be `<FROZEN_DIR>/**/_dream_context`. The hook mutates the vault it runs in
//     (knowledge-access bumps), so each invocation set runs against ONE scratch copy of the
//     whole snapshot directory (so FINGERPRINT.json and now.txt come along) — never the frozen
//     root itself. `sealed/` and `vectors/` are NEVER copied.
//   - The child env has every spawn marker removed; the script itself refuses to start in a
//     spawned session.
//
// Prompts: the hook only prints a recall header when a hit's raw score is >= 2.0, so --prompts
// (a gold file) is filtered, with the ENGINE under test, to queries whose target scores raw >= 2.0.
// The first run is a discarded warm-up; p50/p90 (with a bootstrap 95% CI on p90) cover the next n.
//
// Output: one JSON line `{ mode, n, kept, total, p50Ms, p90Ms, p90ci, meanMs, headers, headerOk, ... }`;
// exit code 1 when headerOk is false.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SPAWN_ENV_KEYS } from '../src/lib/session-origin.js';
import { grantVaultConsent, recallCloudKeyInfo, revokeVaultConsent, type RecallTier } from '../src/lib/recall-cloud-config.js';
import { DEFAULT_RERANK_MODEL } from '../src/lib/embeddings/fusion-config.js';
import { isNanoDownloaded } from '../src/lib/embeddings/nano.js';
import { cloudIndexReady } from '../src/lib/embeddings/vector-store.js';
import {
  FROZEN_DIR,
  assertNotSpawned,
  assertUnder,
  bootstrapP90,
  loadEngine,
  loadGold,
  loadNow,
} from '../eval/harness.js';

/** Gate the hook itself applies before it prints a recall block (hook.ts: `score >= 2.0`). */
const STRONG_SCORE = 2.0;
const HEADER_RE = /— Memory recall \(([^,)]+), top \d+\) —/g;
const RUN_TIMEOUT_MS = 120_000;

export type HookMode = 'raw' | 'hybrid' | 'floor';

const TIERS: readonly RecallTier[] = ['local', 'cloud-index', 'cloud'];

export interface HookLatencyArgs {
  root: string;
  prompts: string;
  mode: HookMode;
  tier: RecallTier;
  n: number;
  noModel: boolean;
  dist: string;
  engineRoot: string;
  cpuProfDir: string | null;
  keepScratch: boolean;
}

export interface HookLatencyResult {
  mode: HookMode;
  tier: RecallTier;
  noModel: boolean;
  n: number;
  kept: number;
  total: number;
  p50Ms: number;
  p90Ms: number;
  p90ci: [number, number];
  meanMs: number;
  /** Recall header counts by label, e.g. `{ BM25: 28, Hybrid: 0 }`. */
  headers: Record<string, number>;
  /** Recall header counts by FULL label, e.g. `{ 'Hybrid · cloud': 50 }`. */
  fullHeaders: Record<string, number>;
  /** Runs (of the n measured) that printed no recall header at all. */
  noHeaderRuns: number;
  headerOk: boolean;
  notes: string[];
}

export function parseArgs(argv: string[]): HookLatencyArgs {
  const value = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const has = (flag: string): boolean => argv.includes(flag);

  const root = value('--root');
  const prompts = value('--prompts');
  if (!root) throw new Error('--root <frozen _dream_context> is required');
  if (!prompts) throw new Error('--prompts <gold.jsonl> is required');
  if (basename(resolve(root)) !== '_dream_context') throw new Error('--root must point at a _dream_context directory');

  const noModel = has('--no-model');
  const modeArg = value('--mode') ?? (noModel ? 'hybrid' : 'raw');
  if (modeArg !== 'raw' && modeArg !== 'hybrid' && modeArg !== 'floor') {
    throw new Error(`--mode must be raw, hybrid or floor (got ${modeArg})`);
  }
  if (noModel && modeArg !== 'hybrid') throw new Error('--no-model tests the hybrid fallback: use --mode hybrid (or omit --mode)');

  const tierArg = value('--tier') ?? 'local';
  if (!(TIERS as readonly string[]).includes(tierArg)) throw new Error(`--tier must be local, cloud-index or cloud (got ${tierArg})`);
  const tier = tierArg as RecallTier;
  if (tier !== 'local' && modeArg !== 'hybrid') throw new Error(`--tier ${tier} measures the hybrid hook: use --mode hybrid`);
  if (tier !== 'local' && noModel) throw new Error(`--tier ${tier} needs the machine's recall key: it cannot run with --no-model (empty HOME)`);

  const n = Number(value('--n') ?? 50);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--n must be a positive integer (got ${value('--n')})`);

  const engineRoot = resolve(value('--engine-root') ?? (value('--dist') ? dirname(dirname(resolve(value('--dist')!))) : '.'));
  const dist = resolve(value('--dist') ?? join(engineRoot, 'dist', 'index.js'));

  return {
    root: assertUnder(FROZEN_DIR, root, '--root'),
    prompts: resolve(prompts),
    mode: modeArg,
    tier,
    n,
    noModel,
    dist,
    engineRoot,
    cpuProfDir: value('--cpu-prof') ? resolve(value('--cpu-prof')!) : null,
    keepScratch: has('--keep-scratch'),
  };
}

/** Recall header labels (`— Memory recall (<label>[, …], top N) —`) in a hook's stdout. */
export function headerLabels(stdout: string): string[] {
  return [...stdout.matchAll(HEADER_RE)].map((m) => m[1].split(/\s|·/)[0]);
}

/** Full recall header labels, e.g. `Hybrid · cloud` (the part before `, top N`). */
export function fullHeaderLabels(stdout: string): string[] {
  return [...stdout.matchAll(HEADER_RE)].map((m) => m[1].trim());
}

/** The environment a measured hook child gets: spawn markers removed, auto-upgrade/ensure off. */
export function childEnv(base: NodeJS.ProcessEnv, extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ...extra };
  for (const key of SPAWN_ENV_KEYS) delete env[key];
  return env;
}

function percentile(sorted: number[], p: number): number {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0;
}

/** Gold queries whose accepted target scores raw >= STRONG_SCORE with the engine under test. */
async function strongPrompts(engineRoot: string, root: string, goldPath: string, now: Date): Promise<{ prompts: string[]; total: number }> {
  const engine = await loadEngine(engineRoot);
  const corpus = engine.stableCorpus(root);
  const gold = loadGold(goldPath);
  const prompts = gold
    .filter((q) => {
      const targets = new Set([...q.expected, ...(q.alt ?? [])]);
      return engine.bm25Search(q.query, corpus, 10, { now }).some((h) => targets.has(engine.docKey(h.doc)) && h.score >= STRONG_SCORE);
    })
    .map((q) => q.query);
  return { prompts, total: gold.length };
}

/** Copy the whole snapshot directory, never `sealed/` or `vectors/`. */
function rsyncCopy(from: string, to: string, excludeIndex: boolean): void {
  mkdirSync(to, { recursive: true });
  const excludes = ['sealed', 'vectors', ...(excludeIndex ? ['.embeddings'] : [])].flatMap((e) => ['--exclude', e]);
  const r = spawnSync('rsync', ['-a', ...excludes, `${from}/`, `${to}/`], { encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`rsync failed: ${r.stderr || r.error?.message}`);
}

export async function run(args: HookLatencyArgs): Promise<HookLatencyResult> {
  assertNotSpawned('hook-latency');
  if (!existsSync(args.dist)) throw new Error(`${args.dist} not found — run \`npm run build:cli\` (or point --dist at a built archive) first`);
  const snapshotDir = dirname(args.root);
  const now = loadNow(existsSync(join(snapshotDir, 'now.txt')) ? `@${snapshotDir}` : 'frozen');
  const notes: string[] = [];

  const { prompts, total } = await strongPrompts(args.engineRoot, args.root, args.prompts, now);
  if (prompts.length === 0) throw new Error('no prompt has a target with raw score >= 2.0 on this corpus — nothing to measure');

  const scratchBase = join(FROZEN_DIR, 'scratch');
  const scratch = join(scratchBase, `${Date.now()}-${process.pid}`);
  assertUnder(scratchBase, scratch, 'scratch dir');
  const scratchProject = join(scratch, basename(snapshotDir)); // contains _dream_context, now.txt, FINGERPRINT.json
  const emptyHome = args.noModel ? mkdtempSync(join(tmpdir(), 'hook-latency-home-')) : null;
  let consentedRoot: string | null = null;
  const revokeConsent = (): void => {
    if (consentedRoot === null) return;
    const root = consentedRoot;
    consentedRoot = null;
    revokeVaultConsent(root);
  };
  // `finally` does not run on a signal: a real consent must not outlive an interrupted run.
  const onSignal = (): void => { revokeConsent(); process.exit(130); };

  try {
    // ONE copy per invocation. The no-model scenario drops the index so its "no cache.json appears"
    // assertion means something.
    rsyncCopy(snapshotDir, scratchProject, args.noModel);
    const scratchRoot = join(scratchProject, '_dream_context');

    if (args.tier !== 'local') {
      // The prerequisites are checked BEFORE a consent is granted, so a missing one fails without a grant.
      if (!recallCloudKeyInfo().present) throw new Error(`--tier ${args.tier}: no recall key on this machine (dreamcontext recall cloud key set)`);
      if (!cloudIndexReady(scratchRoot, 'voyage-4')) throw new Error(`--tier ${args.tier}: the snapshot has no ready voyage-4 index under ${join(snapshotDir, '_dream_context', '.embeddings')}`);
      if (args.tier === 'cloud-index' && !isNanoDownloaded()) throw new Error('--tier cloud-index: the voyage-4-nano query model is not on disk');
      process.once('SIGINT', onSignal);
      process.once('SIGTERM', onSignal);
      grantVaultConsent(scratchRoot, { tier: args.tier, rerankModel: args.tier === 'cloud' ? DEFAULT_RERANK_MODEL : null, surface: 'cli-tty' });
      consentedRoot = scratchRoot;
      notes.push(`real ${args.tier} consent granted to the scratch copy and revoked afterwards`);
    }

    const env = childEnv(process.env, {
      DREAMCONTEXT_RECALL_MODE: args.mode === 'hybrid' ? 'hybrid' : 'raw',
      ...(args.tier === 'local' ? { DREAMCONTEXT_RECALL_TIER: 'local' } : {}),
      DREAMCONTEXT_AUTO_UPGRADE: '0',
      DREAMCONTEXT_EMBED_AUTO: '0',
      ...(args.mode === 'floor' ? { DREAMCONTEXT_MEMORY_HOOK: '0' } : {}),
      ...(emptyHome ? { HOME: emptyHome } : {}),
    });
    // A cloud tier is only measured if nothing in the parent's env forces local.
    if (args.tier !== 'local') delete env.DREAMCONTEXT_RECALL_TIER;

    if (args.mode === 'hybrid' && !args.noModel) {
      const warm = spawnSync(process.execPath, [args.dist, 'embed', 'refresh'], { cwd: scratchProject, env, encoding: 'utf-8', timeout: 30 * 60_000 });
      if (warm.status !== 0) throw new Error(`embed refresh (warm-up) failed: ${warm.stderr || warm.stdout}`);
    }

    const nodeFlags = args.cpuProfDir ? ['--cpu-prof', `--cpu-prof-dir=${args.cpuProfDir}`] : [];
    const times: number[] = [];
    const headers: Record<string, number> = {};
    const fullHeaders: Record<string, number> = {};
    let noHeaderRuns = 0;

    for (let i = 0; i <= args.n; i++) { // run 0 is the discarded warm-up
      const prompt = prompts[i % prompts.length];
      const t0 = performance.now();
      const r = spawnSync(process.execPath, [...nodeFlags, args.dist, 'hook', 'user-prompt-submit'], {
        cwd: scratchProject,
        env,
        input: JSON.stringify({ prompt, session_id: 'hook-latency', hook_event_name: 'UserPromptSubmit' }),
        encoding: 'utf-8',
        timeout: RUN_TIMEOUT_MS,
      });
      const ms = performance.now() - t0;
      if (r.error || r.status !== 0) throw new Error(`hook run ${i} failed: ${r.error?.message ?? `exit ${r.status}: ${r.stderr}`}`);
      if (i === 0) continue;
      times.push(ms);
      const labels = headerLabels(r.stdout);
      if (labels.length === 0) noHeaderRuns++;
      for (const l of labels) headers[l] = (headers[l] ?? 0) + 1;
      for (const l of fullHeaderLabels(r.stdout)) fullHeaders[l] = (fullHeaders[l] ?? 0) + 1;
    }

    const labelCount = Object.values(headers).reduce((s, c) => s + c, 0);
    const only = (label: string): boolean => labelCount > 0 && (headers[label] ?? 0) === labelCount;
    let headerOk: boolean;
    if (args.mode === 'floor') {
      headerOk = labelCount === 0;
      if (!headerOk) notes.push('floor mode printed a recall header — DREAMCONTEXT_MEMORY_HOOK=0 did not disable recall');
    } else if (args.mode === 'hybrid' && !args.noModel) {
      headerOk = only('Hybrid');
      if (!headerOk) notes.push(labelCount === 0 ? 'no run printed a recall header' : 'a run fell back off Hybrid — is the model on disk and the index warm?');
      // The label names the EFFECTIVE tier: a cloud measurement whose headers say another tier measured nothing.
      // (Not asserted for `local`: an older dist, measured for the baseline, prints a bare `Hybrid`.)
      const wanted = `Hybrid · ${args.tier}`;
      if (headerOk && args.tier !== 'local' && (fullHeaders[wanted] ?? 0) !== labelCount) {
        headerOk = false;
        notes.push(`expected every header to read "${wanted}", got ${JSON.stringify(fullHeaders)} — the consent, key or index was not honoured`);
      }
    } else {
      headerOk = only('BM25'); // raw mode, and the no-model fallback
      if (!headerOk) notes.push(labelCount === 0 ? 'no run printed a recall header' : 'a run printed a non-BM25 recall header');
    }

    if (args.noModel) {
      const modelsDir = join(emptyHome!, '.dreamcontext', 'models');
      const cache = join(scratchRoot, '.embeddings', 'cache.json');
      if (existsSync(modelsDir)) { headerOk = false; notes.push(`${modelsDir} was created — the hook started a model download`); }
      if (existsSync(cache)) { headerOk = false; notes.push(`${cache} was created — the hook built an index in-line`); }
    }

    const sorted = [...times].sort((a, b) => a - b);
    const [lo, hi] = bootstrapP90(times);
    return {
      mode: args.mode,
      tier: args.tier,
      noModel: args.noModel,
      n: times.length,
      kept: prompts.length,
      total,
      p50Ms: Math.round(percentile(sorted, 0.5)),
      p90Ms: Math.round(percentile(sorted, 0.9)),
      p90ci: [Math.round(lo), Math.round(hi)],
      meanMs: Math.round(times.reduce((s, t) => s + t, 0) / times.length),
      headers,
      fullHeaders,
      noHeaderRuns,
      headerOk,
      notes,
    };
  } finally {
    revokeConsent();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    if (!args.keepScratch) rmSync(scratch, { recursive: true, force: true });
    if (emptyHome) rmSync(emptyHome, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(parseArgs(process.argv.slice(2)))
    .then((result) => {
      console.log(JSON.stringify(result));
      process.exitCode = result.headerOk ? 0 : 1;
    })
    .catch((err) => {
      console.error(`hook-latency: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 2;
    });
}
