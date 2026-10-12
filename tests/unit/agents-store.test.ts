import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createAgent,
  getAgent,
  listAgents,
  listAgentTargets,
  removeAgent,
  agentUsage,
  withRestamp,
} from '../../src/lib/agents/store.js';
import { splitLegacyManifest } from '../../src/lib/agents/split.js';
import {
  createAutomation,
  getAutomation,
  getRunTarget,
  listAutomations,
  updateAutomation,
} from '../../src/lib/automations/store.js';
import {
  approveAutomation,
  checkApproval,
  getApproval,
  manifestHash,
  readAutomationsRegistry,
} from '../../src/lib/automations/registry.js';
import type { AutomationManifest } from '../../src/lib/automations/types.js';

const NOW = new Date('2026-10-11T10:00:00Z');

const CALL_FILE = '---\nid: auto_help1\ntitle: Helper\nmode: call\n---\n\n## Prompt\nAnswer when asked.\n';
const SCHED_FILE =
  '---\nid: auto_dig1\ntitle: Digest\nmode: sched\nschedule:\n  days: daily\n  at: "18:00"\n---\n\n## Prompt\nSummarise the day.\n';
const agentFile = (title = 'Scout') => `---\nid: agt_s1\ntitle: ${title}\nshared: false\n---\n\n## Prompt\nScout the market.\n`;

let proj: string;
let ctx: string;
let home: string;

beforeEach(() => {
  proj = mkdtempSync(join(tmpdir(), 'dc-agents-store-'));
  ctx = join(proj, '_dream_context');
  mkdirSync(join(ctx, 'automations'), { recursive: true });
  home = mkdtempSync(join(tmpdir(), 'dc-agents-home-'));
});

afterEach(() => {
  rmSync(proj, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function writeSlot(slug: string, text: string): void {
  writeFileSync(join(ctx, 'automations', `${slug}.md`), text);
}

function writeAgent(slug: string, text: string = agentFile()): void {
  mkdirSync(join(ctx, 'agents'), { recursive: true });
  writeFileSync(join(ctx, 'agents', `${slug}.md`), text);
}

function bound(slug: string, agent: string): AutomationManifest {
  return createAutomation(ctx, { slug, title: `${slug} job`, agent, days: 'daily', at: '09:00', job: 'Do the daily part.' });
}

function agentTarget(slug: string): AutomationManifest {
  const t = getRunTarget(ctx, slug, 'agent');
  if (!t) throw new Error(`no agent target for ${slug}`);
  return t;
}

function fromList(slug: string): AutomationManifest {
  const t = listAgentTargets(ctx).find((m) => m.slug === slug);
  if (!t) throw new Error(`${slug} missing from listAgentTargets`);
  return t;
}

describe('getRunTarget(…, agent) and listAgentTargets set legacyKey per slot and fill bindings', () => {
  it("slot 'absent': an explicit agent with no automation file of its own", () => {
    writeAgent('scout');
    for (const t of [agentTarget('scout'), fromList('scout')]) {
      expect(t.runKind).toBe('agent');
      expect(t.legacyKey).toBe(true);
      expect(t.bindings).toEqual([]);
    }
  });

  it("slot 'legacy-call': an unsplit on-call file is its own agent, never its own binding", () => {
    writeSlot('helper', CALL_FILE);
    for (const t of [agentTarget('helper'), fromList('helper')]) {
      expect(t.runKind).toBe('agent');
      expect(t.legacyKey).toBe(true);
      expect(t.bindings).toEqual([]);
    }
  });

  it("slot 'automation' (unsplit scheduled pair): legacyKey false, the pair's job is the binding", () => {
    writeSlot('digest', SCHED_FILE);
    const automation = getRunTarget(ctx, 'digest', 'automation') as AutomationManifest;
    const expected = [{ slug: 'digest', sha256: manifestHash(automation) }];
    for (const t of [agentTarget('digest'), fromList('digest')]) {
      expect(t.legacyKey).toBe(false);
      expect(t.bindings).toEqual(expected);
    }
  });

  it('bound automations are bindings with their CURRENT composed hash; a same-slug bound file makes the slot automation', () => {
    writeAgent('scout');
    const daily = bound('scout-daily', 'scout');
    expect(agentTarget('scout').bindings).toEqual([{ slug: 'scout-daily', sha256: manifestHash(daily) }]);
    expect(agentTarget('scout').legacyKey).toBe(true);

    const pair = bound('scout', 'scout');
    const t = agentTarget('scout');
    expect(t.legacyKey).toBe(false);
    // Files are read in path order: `scout-daily.md` sorts before `scout.md`.
    expect(t.bindings).toEqual([
      { slug: 'scout-daily', sha256: manifestHash(daily) },
      { slug: 'scout', sha256: manifestHash(pair) },
    ]);
    expect(fromList('scout')).toEqual(t);
  });

  it("slot 'unreadable': the agent still exists, legacyKey is false", () => {
    writeAgent('scout');
    const outside = join(proj, 'outside.md');
    writeFileSync(outside, CALL_FILE);
    symlinkSync(outside, join(ctx, 'automations', 'scout.md'));
    for (const t of [agentTarget('scout'), fromList('scout')]) {
      expect(t.legacyKey).toBe(false);
      expect(t.bindings).toEqual([]);
    }
  });
});

describe('wiring: approvals the surfaces will read (A14)', () => {
  it('an on-call agent approved before the split is approved to chat AND run, unsplit and after the split', () => {
    writeSlot('helper', CALL_FILE);
    approveAutomation(proj, getAutomation(ctx, 'helper') as AutomationManifest, NOW, home);
    const unsplit = fromList('helper');
    expect(checkApproval(proj, unsplit, home, 'identity').approved).toBe(true);
    expect(checkApproval(proj, unsplit, home, 'run')).toMatchObject({ approved: true, via: 'legacy-key' });

    expect(splitLegacyManifest(ctx, 'helper', { home }).outcome).toBe('split');
    const migrated = fromList('helper');
    expect(checkApproval(proj, migrated, home, 'identity').approved).toBe(true);
    expect(checkApproval(proj, migrated, home, 'run')).toMatchObject({ approved: true, via: 'legacy-key' });
  });

  it("a scheduled pair's agent is approved to chat through its binding, not to run", () => {
    writeSlot('digest', SCHED_FILE);
    approveAutomation(proj, getRunTarget(ctx, 'digest', 'automation') as AutomationManifest, NOW, home);
    const t = fromList('digest');
    expect(checkApproval(proj, t, home, 'identity')).toMatchObject({ approved: true, via: { binding: 'digest' } });
    expect(checkApproval(proj, t, home, 'run').approved).toBe(false);
  });

  it('a same-slug pair created on a (b)-approved agent keeps the agent run-approved (approvePair)', () => {
    writeSlot('helper', CALL_FILE);
    approveAutomation(proj, getAutomation(ctx, 'helper') as AutomationManifest, NOW, home);
    expect(splitLegacyManifest(ctx, 'helper', { home }).outcome).toBe('split');

    const pair = createAutomation(
      ctx,
      { slug: 'helper', title: 'Helper daily', agent: 'helper', days: 'daily', at: '09:00' },
      { approve: { now: NOW, home } },
    );
    expect(checkApproval(proj, pair, home).approved).toBe(true);
    expect(checkApproval(proj, agentTarget('helper'), home, 'run').approved).toBe(true);
  });
});

describe('withRestamp', () => {
  it('re-approves direct grants at the new hash; the legacy record is deleted then written back by the file itself', () => {
    writeSlot('helper', CALL_FILE);
    approveAutomation(proj, getAutomation(ctx, 'helper') as AutomationManifest, NOW, home);
    withRestamp(ctx, proj, 'helper', { prompt: 'Answer briefly when asked.' }, home, NOW);

    expect(getAgent(ctx, 'helper')?.prompt).toBe('Answer briefly when asked.');
    expect(checkApproval(proj, agentTarget('helper'), home, 'run')).toMatchObject({ approved: true, via: 'self' });
    expect(checkApproval(proj, getRunTarget(ctx, 'helper', 'automation') as AutomationManifest, home).approved).toBe(true);
    expect(getApproval(proj, 'helper', home, 'agent')?.manifestSha256).toBe(manifestHash(agentTarget('helper')));
  });

  it('never writes an agent grant for a target approved only through a binding', () => {
    writeSlot('digest', SCHED_FILE);
    approveAutomation(proj, getRunTarget(ctx, 'digest', 'automation') as AutomationManifest, NOW, home);
    withRestamp(ctx, proj, 'digest', { prompt: 'Summarise the day in three lines.' }, home, NOW);

    expect(checkApproval(proj, getRunTarget(ctx, 'digest', 'automation') as AutomationManifest, home).approved).toBe(true);
    expect(getApproval(proj, 'digest', home, 'agent')).toBeNull();
    expect(checkApproval(proj, agentTarget('digest'), home, 'run').approved).toBe(false);
  });

  it('leaves an automation that was never approved here unapproved', () => {
    writeAgent('scout');
    approveAutomation(proj, agentTarget('scout'), NOW, home);
    bound('scout-daily', 'scout');
    withRestamp(ctx, proj, 'scout', { prompt: 'Scout the market weekly.' }, home, NOW);
    expect(checkApproval(proj, agentTarget('scout'), home, 'run').approved).toBe(true);
    expect(checkApproval(proj, getRunTarget(ctx, 'scout-daily', 'automation') as AutomationManifest, home).approved).toBe(false);
  });

  it('refuses a key that is not identity, writing nothing', () => {
    writeAgent('scout');
    const before = readFileSync(join(ctx, 'agents', 'scout.md'), 'utf-8');
    expect(() => withRestamp(ctx, proj, 'scout', { timeoutMinutes: 5 } as never, home, NOW)).toThrow(/cannot change "timeoutMinutes"/);
    expect(readFileSync(join(ctx, 'agents', 'scout.md'), 'utf-8')).toBe(before);
  });
});

describe('removeAgent and the revoke rule', () => {
  it('is refused while an automation runs as the agent (its own unsplit scheduled manifest included)', () => {
    writeAgent('scout');
    bound('scout-daily', 'scout');
    expect(removeAgent(ctx, 'scout', { home })).toEqual({ removed: false, usedBy: ['scout-daily'] });
    writeSlot('digest', SCHED_FILE);
    expect(removeAgent(ctx, 'digest', { home })).toEqual({ removed: false, usedBy: ['digest'] });
    expect(existsSync(join(ctx, 'agents', 'scout.md'))).toBe(true);
  });

  it('an unsplit on-call agent IS its legacy file: both go, and approvals[x] is revoked', () => {
    writeSlot('helper', CALL_FILE);
    approveAutomation(proj, getAutomation(ctx, 'helper') as AutomationManifest, NOW, home);
    expect(removeAgent(ctx, 'helper', { home })).toEqual({ removed: true });
    expect(existsSync(join(ctx, 'automations', 'helper.md'))).toBe(false);
    expect(getApproval(proj, 'helper', home)).toBeNull();
  });

  it('an explicit agent: its file and its direct grant go', () => {
    writeAgent('scout');
    approveAutomation(proj, agentTarget('scout'), NOW, home);
    expect(removeAgent(ctx, 'scout', { home })).toEqual({ removed: true });
    expect(existsSync(join(ctx, 'agents', 'scout.md'))).toBe(false);
    expect(getApproval(proj, 'scout', home, 'agent')).toBeNull();
  });

  it("approvals[x] survives only as a SCHEDULED automation's current record; a mode: call one is revoked", () => {
    writeAgent('other');
    for (const [mode, survives] of [['sched', true], ['call', false]] as const) {
      writeAgent('x');
      writeSlot(
        'x',
        `---\nid: auto_x1\ntitle: X job\nagent: other\nmode: ${mode}\nschedule:\n  days: daily\n  at: "09:00"\n---\n\n## Output instructions\nNone.\n`,
      );
      approveAutomation(proj, getRunTarget(ctx, 'x', 'automation') as AutomationManifest, NOW, home);
      expect(removeAgent(ctx, 'x', { home })).toEqual({ removed: true });
      expect(getApproval(proj, 'x', home) !== null).toBe(survives);
      rmSync(join(ctx, 'automations', 'x.md'));
    }
  });
});

describe('reading', () => {
  it('a symlinked manifest is skipped everywhere', () => {
    const outside = join(proj, 'outside.md');
    writeFileSync(outside, SCHED_FILE);
    symlinkSync(outside, join(ctx, 'automations', 'evil.md'));
    expect(listAutomations(ctx).map((m) => m.slug)).not.toContain('evil');
    expect(getAutomation(ctx, 'evil')).toBeNull();
    expect(listAgents(ctx).map((a) => a.slug)).not.toContain('evil');
  });

  it('an unsplit legacy file wins over agents/<slug>.md', () => {
    writeSlot('helper', CALL_FILE);
    writeAgent('helper', agentFile('Impostor'));
    expect(getAgent(ctx, 'helper')).toMatchObject({ title: 'Helper', implicit: true });
    expect(listAgents(ctx).filter((a) => a.slug === 'helper')).toHaveLength(1);
  });

  it('a bound automation reads identity from its agent and ignores a stray ## Prompt', () => {
    writeAgent('scout');
    bound('scout-daily', 'scout');
    const path = join(ctx, 'automations', 'scout-daily.md');
    writeFileSync(path, `${readFileSync(path, 'utf-8')}\n## Prompt\nDo something else.\n`);
    const m = getRunTarget(ctx, 'scout-daily', 'automation') as AutomationManifest;
    expect(m).toMatchObject({ prompt: 'Scout the market.', agent: 'scout', agentTitle: 'Scout', job: 'Do the daily part.' });
  });

  it("editing a bound automation's prompt edits its agent", () => {
    writeAgent('scout');
    bound('scout-daily', 'scout');
    updateAutomation(ctx, 'scout-daily', { prompt: 'Scout two markets.', title: 'Daily scout' });
    expect(getAgent(ctx, 'scout')?.prompt).toBe('Scout two markets.');
    expect(getRunTarget(ctx, 'scout-daily', 'automation')?.title).toBe('Daily scout');
  });
});

describe('createAgent and agentUsage', () => {
  it('ensures the agents .gitignore block before the file, omits unset keys, and grants directly when asked', () => {
    const a = createAgent(ctx, { slug: 'scout', title: 'Scout', prompt: 'Scout.' }, { approve: { now: NOW, home } });
    expect(readFileSync(join(ctx, '.gitignore'), 'utf-8')).toContain('agents/*.md');
    expect(readFileSync(join(proj, '.gitignore'), 'utf-8')).toContain('_dream_context/agents/*.md');
    const text = readFileSync(a.path, 'utf-8');
    expect(text).not.toMatch(/^effort:/m);
    expect(text).not.toMatch(/^whiteboard:/m);
    expect(text).toMatch(/^learning: true$/m);
    expect(checkApproval(proj, agentTarget('scout'), home, 'run').approved).toBe(true);
    expect(readAutomationsRegistry(home)).toBeTruthy();
  });

  it('refuses a slug already taken by an agent or an automation', () => {
    writeSlot('digest', SCHED_FILE);
    expect(() => createAgent(ctx, { slug: 'digest', title: 'D', prompt: 'p' })).toThrow(/already the name/);
    createAgent(ctx, { slug: 'scout', title: 'Scout', prompt: 'p' });
    expect(() => createAgent(ctx, { slug: 'scout', title: 'Scout', prompt: 'p' })).toThrow(/already the name/);
  });

  it('lists the automations, home board and tasks that use an agent', () => {
    writeAgent('scout', '---\nid: agt_s1\ntitle: Scout\nwhiteboard: growth\n---\n\n## Prompt\nScout.\n');
    bound('scout-daily', 'scout');
    mkdirSync(join(ctx, 'state'), { recursive: true });
    writeFileSync(join(ctx, 'state', 'market-scan.md'), '---\nname: Market scan\nagent: scout\n---\n');
    writeFileSync(join(ctx, 'state', 'other.md'), '---\nname: Other\n---\n');
    expect(agentUsage(ctx, 'scout')).toEqual({ automations: ['scout-daily'], boards: ['growth'], tasks: ['market-scan'] });
  });
});
