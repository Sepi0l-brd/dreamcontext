import { join } from 'node:path';
import { splitAllLegacy } from '../lib/agents/split.js';
import type { Migration, MigrationStepResult } from './types.js';

/**
 * Migration 0.31.0: an agent becomes its own entity.
 *
 * Every legacy automation manifest (no `agent:` key) is split with the ONE split
 * function every path shares (`splitLegacyManifest`): a scheduled file becomes
 * agent `x` (`agents/x.md`) plus automation `x` bound to it; an on-call file
 * becomes the agent alone, its run settings carried as call settings. Readers
 * already compose an unsplit file byte-identically, so this step changes files,
 * never behaviour: each split self-checks that the composed hash equals the
 * legacy hash, and approvals carry over with NO registry write (a pair through
 * `approvals[x]`, a call agent through the legacy-key rule).
 *
 * Only `io-error` counts in `failedCount` (it is retried, and pins
 * `setupVersion` until it succeeds). A `mismatch` restores the legacy file, a
 * `conflict` (a foreign `agents/x.md`, a symlinked or unparseable manifest)
 * leaves it untouched: both are deterministic outcomes that would re-fail
 * forever, so they are named in `summary` and by `doctor agents-split`, and the
 * vault keeps reading the legacy file exactly as before.
 */
export const migration0310: Migration = {
  version: '0.31.0',
  steps: [
    (root: string): MigrationStepResult => {
      const step = 'split-automation-agents';
      const { results, failed } = splitAllLegacy(root);
      const split = results.filter((r) => r.outcome === 'split');
      const named = results.filter((r) => r.outcome !== 'split' && r.outcome !== 'already-split');

      if (split.length === 0 && named.length === 0) {
        return {
          step,
          filesTouched: [],
          summary: 'No legacy automation manifests — every agent is already its own file',
          detected: true,
        };
      }

      const filesTouched = split.flatMap((r) => [join(root, 'agents', `${r.slug}.md`), join(root, 'automations', `${r.slug}.md`)]);
      const parts: string[] = [];
      if (split.length > 0) {
        parts.push(`Split ${split.length} agent${split.length === 1 ? '' : 's'} out of their automations (${split.map((r) => r.slug).join(', ')})`);
      }
      for (const kind of ['mismatch', 'conflict', 'io-error'] as const) {
        const slugs = named.filter((r) => r.outcome === kind).map((r) => r.slug);
        if (slugs.length > 0) parts.push(`${kind}: ${slugs.join(', ')} (left in the legacy format — see \`dreamcontext doctor\`)`);
      }
      return {
        step,
        filesTouched,
        summary: parts.join('; '),
        detected: split.length === 0,
        ...(failed > 0 ? { failedCount: failed } : {}),
      };
    },
  ],
};
