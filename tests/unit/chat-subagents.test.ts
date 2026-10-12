/**
 * The project's agents as sub-agents of a Chat (lib/automations/chat-subagents.ts): every
 * APPROVED agent becomes an `--agents` definition and a roster line; an unapproved one, and the
 * agent a tab itself speaks as, never do.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { automationPath, createAutomation, getRunTarget } from '../../src/lib/automations/store.js';
import { approveAutomation, checkApproval } from '../../src/lib/automations/registry.js';
import { createAgent } from '../../src/lib/agents/store.js';
import { splitLegacyManifest } from '../../src/lib/agents/split.js';
import { chatSubagents, subagentPrompt, MAX_CHAT_SUBAGENTS } from '../../src/lib/automations/chat-subagents.js';

let projectRoot: string;
let contextRoot: string;
let home: string;
const NOW = new Date('2026-10-07T09:00:00.000Z');

function agent(slug: string, title: string, prompt: string, opts: { approve?: boolean; learning?: boolean } = {}) {
  const m = createAutomation(contextRoot, { slug, title, mode: 'call', prompt, review: 'agent', learning: opts.learning ?? false });
  if (opts.approve !== false) approveAutomation(projectRoot, m, NOW, home);
  return m;
}

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-chat-subagents-'));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(contextRoot, { recursive: true });
  home = mkdtempSync(join(tmpdir(), 'dc-chat-subagents-home-'));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('chatSubagents', () => {
  it('is null when the project has no approved agent', () => {
    expect(chatSubagents(contextRoot, { home })).toBeNull();
    agent('draft-agent', 'Draft agent', 'Do drafts.', { approve: false });
    expect(chatSubagents(contextRoot, { home })).toBeNull();
  });

  it('defines every approved agent, keyed by slug, and names each in the roster', () => {
    const m = agent('funnel-watch', 'Funnel watch', 'Watch the signup funnel and flag any step that drops.', { learning: true });
    agent('weekly-brief', 'Weekly brief', 'Write the weekly brief.');
    const out = chatSubagents(contextRoot, { home })!;
    expect(Object.keys(out.agents)).toEqual(['funnel-watch', 'weekly-brief']);
    expect(out.agents['funnel-watch'].description).toContain('Funnel watch, a dreamcontext agent of this project: Watch the signup funnel');
    expect(out.agents['funnel-watch'].prompt).toBe(subagentPrompt(m));
    expect(out.agents['funnel-watch'].prompt).toContain('dreamcontext automations learn funnel-watch --lesson');
    expect(out.roster).toContain('`subagent_type`');
    expect(out.roster).toContain('- `funnel-watch` Funnel watch: Watch the signup funnel');
    expect(out.roster).toContain('- `weekly-brief` Weekly brief: Write the weekly brief.');
  });

  it('leaves out an unapproved agent, and one whose manifest changed after approval', () => {
    agent('funnel-watch', 'Funnel watch', 'Watch the funnel.');
    agent('draft-agent', 'Draft agent', 'Do drafts.', { approve: false });
    agent('edited-agent', 'Edited agent', 'Original job.');
    const path = automationPath(contextRoot, 'edited-agent');
    writeFileSync(path, readFileSync(path, 'utf-8').replace('Original job.', 'A job nobody approved.'));
    expect(Object.keys(chatSubagents(contextRoot, { home })!.agents)).toEqual(['funnel-watch']);
  });

  it('leaves out the agent the tab itself speaks as', () => {
    agent('funnel-watch', 'Funnel watch', 'Watch the funnel.');
    agent('weekly-brief', 'Weekly brief', 'Write the weekly brief.');
    const out = chatSubagents(contextRoot, { home, exclude: 'funnel-watch' })!;
    expect(Object.keys(out.agents)).toEqual(['weekly-brief']);
    expect(out.roster).not.toContain('funnel-watch');
  });

  it('caps the roster, and shortens a long prompt to one line', () => {
    for (let i = 0; i < MAX_CHAT_SUBAGENTS + 3; i++) agent(`agent-${String(i).padStart(2, '0')}`, `Agent ${i}`, `Line one.\n\nLine two ${'x'.repeat(300)}`);
    const out = chatSubagents(contextRoot, { home })!;
    expect(Object.keys(out.agents)).toHaveLength(MAX_CHAT_SUBAGENTS);
    const line = out.roster.split('\n').find((l) => l.startsWith('- `agent-00`'))!;
    expect(line).not.toContain('\n');
    expect(line.endsWith('…')).toBe(true);
    expect(line).toContain('Line one. Line two');
  });
});

/**
 * WIRING (A14): the roster is every AGENT from `listAgentTargets`, checked for `'identity'`.
 *
 * Mutation-tested against two mutations of `chatSubagents`:
 *  - `listAgentTargets(contextRoot)` swapped back to `listAutomations(contextRoot)`: the bound
 *    job `daily-digest` (a job, not an agent) joins the roster, so the exact key list fails;
 *  - `checkApproval(…, 'identity')` swapped for the default `'run'`: `digest` and `writer` are
 *    approved only through their binding (rule (c)), so both drop out and the key list fails.
 */
describe('chatSubagents iterates the agents, for conversation', () => {
  it('a call agent approved before the split is in the roster, unsplit and migrated', () => {
    agent('helper', 'Helper', 'Help with anything.');
    expect(Object.keys(chatSubagents(contextRoot, { home })!.agents)).toEqual(['helper']);

    expect(splitLegacyManifest(contextRoot, 'helper', { home }).outcome).toBe('split');
    const target = getRunTarget(contextRoot, 'helper', 'agent')!;
    expect(target.runKind).toBe('agent');
    expect(checkApproval(projectRoot, target, home, 'run').approved).toBe(true);
    const out = chatSubagents(contextRoot, { home })!;
    expect(Object.keys(out.agents)).toEqual(['helper']);
    expect(out.roster).toContain('- `helper` Helper: Help with anything.');
  });

  it("a scheduled pair's agent and a bound agent are in it via their binding; the jobs never are", () => {
    const digest = createAutomation(contextRoot, { slug: 'digest', title: 'Digest', prompt: 'Write the digest.', days: 'daily', at: '09:00' });
    approveAutomation(projectRoot, digest, NOW, home);
    createAgent(contextRoot, { slug: 'writer', title: 'Writer', prompt: 'Write clearly.' });
    createAutomation(
      contextRoot,
      { slug: 'daily-digest', title: 'Daily digest', agent: 'writer', days: 'daily', at: '08:00', job: 'Write the daily digest.' },
      { approve: { now: NOW, home } },
    );

    // Neither agent may RUN: their only approvals are their automations' records.
    expect(checkApproval(projectRoot, getRunTarget(contextRoot, 'digest', 'agent')!, home, 'run').approved).toBe(false);
    expect(checkApproval(projectRoot, getRunTarget(contextRoot, 'writer', 'agent')!, home, 'run').approved).toBe(false);

    const out = chatSubagents(contextRoot, { home })!;
    expect(Object.keys(out.agents)).toEqual(['digest', 'writer']);
    expect(out.roster).toContain('- `writer` Writer: Write clearly.');
    // A conversation never carries the job.
    expect(out.agents.writer.prompt).not.toContain('Write the daily digest.');

    // Migrating the pair changes nothing: the binding's hash is the legacy hash.
    expect(splitLegacyManifest(contextRoot, 'digest', { home }).outcome).toBe('split');
    expect(Object.keys(chatSubagents(contextRoot, { home })!.agents)).toEqual(['digest', 'writer']);
  });

  it('an agent approved neither directly nor through a binding is absent', () => {
    agent('helper', 'Helper', 'Help with anything.');
    createAgent(contextRoot, { slug: 'loner', title: 'Loner', prompt: 'Alone.' });
    createAgent(contextRoot, { slug: 'quiet', title: 'Quiet', prompt: 'Quiet.' });
    createAutomation(contextRoot, { slug: 'quiet-job', title: 'Quiet job', agent: 'quiet', days: 'daily', at: '07:00' });
    const out = chatSubagents(contextRoot, { home })!;
    expect(Object.keys(out.agents)).toEqual(['helper']);
    expect(out.roster).not.toContain('loner');
    expect(out.roster).not.toContain('quiet');
  });
});
