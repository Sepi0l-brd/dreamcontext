import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { breakerOpen, cloudTierReady, cloudWarmAt, hybridSearch, markCloudWarm, type RecallTiming } from './embeddings/hybrid.js';
import { resolvePromptTier } from './recall-cloud-config.js';
import { cloudIndexChildEnv } from './recall-cloud-index-spawn.js';
import { buildCorpusCached } from './recall-corpus-cache.js';

/**
 * Cloud recall warm-up. A provider that has been idle answers its first query and rerank slowly (measured
 * 2026-10-12: a cold rerank missed its 1.8 s budget, the next two calls took ~0.7 s), so the FIRST prompt
 * after a grant or a fresh session used to land on a cold provider. A warm-up runs one real query + rerank
 * off the prompt path, with generous budgets, at the moments a prompt is about to come: cloud recall was
 * just granted (or its index just finished building), and a session just started.
 *
 * It is one ordinary cloud search: the same egress layer, consent, daily cap and spend metering as a prompt
 * (it counts as one query toward the cap). It never trips the breaker or the rerank backoff.
 */

/** A cloud call that succeeded this recently means the provider is warm: no warm-up. */
export const WARM_TTL_MS = 5 * 60_000;

/** How long an in-flight warm-up holds the slot: long enough to dedupe sessions starting together, short enough that a failed one does not suppress the next. */
export const WARM_CLAIM_MS = 30_000;

/** The warm-up's query. Content-free on purpose; the rerank candidates are the vault's own consented docs. */
export const WARMUP_QUERY = 'recall warm-up';

export type WarmSkipReason = 'not_cloud' | 'not_hybrid' | 'breaker_open' | 'not_ready' | 'warm' | 'no_cli';

/** Why no warm-up should run now, or null when one should. Cheap: config and manifest reads, no network. */
export function cloudWarmSkipReason(
  contextRoot: string,
  o: { mode: string; env?: NodeJS.ProcessEnv; home?: string; now?: number },
): WarmSkipReason | null {
  const home = o.home ?? homedir();
  if (o.mode !== 'hybrid') return 'not_hybrid';
  // resolvePromptTier applies the same downgrades a prompt gets: spawned session, daily cap, env override.
  if (resolvePromptTier(contextRoot, o.env ?? process.env, home).tier !== 'cloud') return 'not_cloud';
  if (breakerOpen(home)) return 'breaker_open';
  if (!cloudTierReady('cloud', contextRoot, false, home)) return 'not_ready';
  const at = cloudWarmAt(home);
  if (at !== null && (o.now ?? Date.now()) - at < WARM_TTL_MS) return 'warm';
  return null;
}

/**
 * Run the warm-up in THIS process (the dashboard server, or the detached `recall cloud warm` child).
 * Returns the search timing, or null when it was skipped. Never throws.
 */
export async function warmCloudRecall(
  contextRoot: string,
  o: { mode?: string; env?: NodeJS.ProcessEnv; home?: string } = {},
): Promise<{ timing: RecallTiming | null; skipped: WarmSkipReason | null }> {
  const home = o.home ?? homedir();
  try {
    const skipped = cloudWarmSkipReason(contextRoot, { mode: o.mode ?? 'hybrid', env: o.env, home });
    if (skipped !== null) return { timing: null, skipped };
    // Claim the slot for WARM_CLAIM_MS only, so sessions starting together send one warm-up, not one each;
    // the full WARM_TTL_MS is recorded only once the provider actually answered.
    const now = Date.now();
    markCloudWarm(home, now - WARM_TTL_MS + WARM_CLAIM_MS);
    const timing: RecallTiming = { tier: 'cloud', querySource: 'none', fallback: 'none' };
    await hybridSearch(WARMUP_QUERY, buildCorpusCached(contextRoot), contextRoot, 1, { tier: 'cloud', home, timing, warmup: true });
    if (timing.querySource === 'api') markCloudWarm(home);
    return { timing, skipped: null };
  } catch {
    return { timing: null, skipped: null };
  }
}

export interface SpawnWarmupDeps {
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Starts the detached child. Tests inject a recorder; the default launches `recall cloud warm --auto`. */
  launch?: (cliEntry: string, cwd: string, env: NodeJS.ProcessEnv) => void;
  /** CLI entry script. Default: the running CLI (`process.argv[1]`). */
  cliEntry?: string;
}

function defaultLaunch(cliEntry: string, cwd: string, env: NodeJS.ProcessEnv): void {
  const child = spawn(process.execPath, [cliEntry, 'recall', 'cloud', 'warm', '--auto'], { detached: true, stdio: 'ignore', cwd, env });
  child.unref();
}

/**
 * Fire-and-forget warm-up from a short-lived process (the SessionStart hook, `recall cloud enable`): the
 * gates run here so a skipped warm-up costs no process, and the work runs in a detached child the caller
 * never waits on. The child gets the index-build child's env (no recall key in it: it reads the key file).
 */
export function spawnCloudWarmup(
  contextRoot: string,
  mode: string,
  deps: SpawnWarmupDeps = {},
): { spawned: boolean; reason: WarmSkipReason | null } {
  const env = deps.env ?? process.env;
  const reason = cloudWarmSkipReason(contextRoot, { mode, env, home: deps.home });
  if (reason !== null) return { spawned: false, reason };
  const cliEntry = deps.cliEntry ?? process.argv[1];
  if (!cliEntry) return { spawned: false, reason: 'no_cli' };
  (deps.launch ?? defaultLaunch)(cliEntry, dirname(contextRoot), cloudIndexChildEnv(env));
  return { spawned: true, reason: null };
}
