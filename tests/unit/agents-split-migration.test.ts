/**
 * The 0.31.0 code step `split-automation-agents` (src/migrations/0.31.0.ts), through the real
 * migration runner: split outcomes are named in `summary`; only `io-error` counts in
 * `failedCount` (and so pins `setupVersion`); mismatch/conflict/symlink never do; nothing is
 * written to the approval registry; a second run is `detected`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { migration0310 } from '../../src/migrations/0.31.0.js';
import { pendingMigrations } from '../../src/migrations/index.js';
import { runMigrations } from '../../src/lib/migration-runner.js';
import { checkAgentsSplit } from '../../src/cli/commands/doctor.js';
import { createAutomation, getRunTarget } from '../../src/lib/automations/store.js';
import { approveAutomation, automationsRegistryPath, checkApproval } from '../../src/lib/automations/registry.js';

const NOW = new Date('2026-10-12T09:00:00.000Z');
let proj: string;
let ctx: string;
let home: string;
let realHome: string | undefined;

beforeEach(() => {
  proj = mkdtempSync(join(tmpdir(), 'dc-split-migration-'));
  ctx = join(proj, '_dream_context');
  mkdirSync(join(ctx, 'automations'), { recursive: true });
  realHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), 'dc-split-migration-home-'));
  // The step backs files up under ~/.dreamcontext and the registry lives there too.
  process.env.HOME = home;
});

afterEach(() => {
  try { chmodSync(join(ctx, 'agents'), 0o755); } catch { /* never made read-only */ }
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  rmSync(proj, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const step = () => migration0310.steps[0](ctx);

function seedLegacy(): void {
  const digest = createAutomation(ctx, { slug: 'digest', title: 'Digest', prompt: 'Write the digest.', days: 'daily', at: '18:00' });
  approveAutomation(proj, digest, NOW, home);
  const helper = createAutomation(ctx, { slug: 'helper', title: 'Helper', mode: 'call', prompt: 'Help.', review: 'agent' });
  approveAutomation(proj, helper, NOW, home);
}

describe('split-automation-agents', () => {
  it('is selected by (0.30.6, 0.31.0]', () => {
    expect(pendingMigrations('0.30.6', '0.31.0').map((m) => m.version)).toContain('0.31.0');
    expect(pendingMigrations('0.31.0', '0.31.0')).toEqual([]);
  });

  it('splits every legacy manifest, names them, writes no registry, and keeps every verdict', () => {
    seedLegacy();
    const registryBefore = readFileSync(automationsRegistryPath(home), 'utf-8');
    const r = step();
    expect(r).toMatchObject({ step: 'split-automation-agents', detected: false });
    expect(r.failedCount).toBeUndefined();
    expect(r.summary).toContain('digest');
    expect(r.summary).toContain('helper');
    expect(existsSync(join(ctx, 'agents', 'digest.md'))).toBe(true);
    expect(existsSync(join(ctx, 'agents', 'helper.md'))).toBe(true);
    expect(existsSync(join(ctx, 'automations', 'helper.md'))).toBe(false);
    expect(readFileSync(automationsRegistryPath(home), 'utf-8')).toBe(registryBefore);
    expect(checkApproval(proj, getRunTarget(ctx, 'digest', 'automation')!, home, 'run').approved).toBe(true);
    expect(checkApproval(proj, getRunTarget(ctx, 'helper', 'agent')!, home, 'run').approved).toBe(true);

    // Idempotent: nothing left to do.
    expect(step()).toMatchObject({ detected: true, filesTouched: [] });
  });

  it('a conflict and a symlinked manifest are named in summary, never counted as failed', () => {
    seedLegacy();
    mkdirSync(join(ctx, 'agents'), { recursive: true });
    writeFileSync(join(ctx, 'agents', 'digest.md'), '---\nid: agt_other\ntitle: Someone else\nmigrated_from: auto_somewhere_else\n---\n\n## Prompt\n\nNot ours.\n');
    const real = join(proj, 'outside.md');
    writeFileSync(real, readFileSync(join(ctx, 'automations', 'helper.md'), 'utf-8'));
    symlinkSync(real, join(ctx, 'automations', 'linked.md'));

    const r = step();
    expect(r.failedCount).toBeUndefined();
    expect(r.summary).toMatch(/conflict: [^;]*digest/);
    expect(r.summary).toMatch(/conflict: [^;]*linked/);
    // The legacy file is untouched and still reads.
    expect(getRunTarget(ctx, 'digest', 'automation')).not.toBeNull();

    const run = runMigrations(ctx, '0.30.6', '0.31.0');
    expect(run.failedSteps).toBe(0);
  });

  it('an io-error is counted, so the runner reports a failed step (setupVersion stays pinned)', () => {
    seedLegacy();
    mkdirSync(join(ctx, 'agents'), { recursive: true });
    // The agents folder refuses writes: each split fails on its agent-file write.
    chmodSync(join(ctx, 'agents'), 0o555);
    const r = step();
    if (process.getuid && process.getuid() === 0) return; // root ignores the mode bits
    expect(r.failedCount).toBe(2);
    expect(r.summary).toContain('io-error');
    expect(existsSync(join(ctx, 'automations', 'helper.md'))).toBe(true);

    const run = runMigrations(ctx, '0.30.6', '0.31.0');
    expect(run.failedSteps).toBeGreaterThan(0);
  });
});

describe('doctor agents-split', () => {
  it('names legacy, conflicting and symlinked slugs; a fully split vault is silent', () => {
    seedLegacy();
    mkdirSync(join(ctx, 'agents'), { recursive: true });
    writeFileSync(join(ctx, 'agents', 'digest.md'), '---\nid: agt_other\ntitle: Other\nmigrated_from: auto_elsewhere\n---\n\n## Prompt\n\nNot ours.\n');
    const real = join(proj, 'outside.md');
    writeFileSync(real, readFileSync(join(ctx, 'automations', 'helper.md'), 'utf-8'));
    symlinkSync(real, join(ctx, 'automations', 'linked.md'));

    const text = checkAgentsSplit(ctx).map((r) => r.message).join('\n');
    expect(text).toMatch(/legacy format \([^)]*digest/);
    expect(text).toMatch(/conflicts[^\n]*digest/);
    expect(text).toContain('automations/linked.md');

    rmSync(join(ctx, 'agents', 'digest.md'));
    rmSync(join(ctx, 'automations', 'linked.md'));
    step();
    expect(checkAgentsSplit(ctx)).toEqual([]);
  });
});
