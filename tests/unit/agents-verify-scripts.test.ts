/**
 * Wave 5, lane T11: the three runtime verify scripts of the agents-own-entity task are wired and
 * still drive what they claim to. The scripts themselves need a build and a browser (the
 * orchestrator runs them); this pins, by source scan, the parts a refactor could silently drop:
 * the npm entries, both themes, the crash seam, the two-home and restore scenarios, the page
 * hooks the Agents page exposes, and the CLI refusal inside an agent run.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf-8');
const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>;

describe('package.json verify entries', () => {
  it.each([
    ['verify:agents-page', 'scripts/verify/agents-page.mjs'],
    ['verify:agents-migration', 'scripts/verify/agents-migration.mjs'],
    ['verify:task-agent-assign', 'scripts/verify/task-agent-assign.mjs'],
    ['verify:chat-agent-picker', 'scripts/verify/chat-agent-picker.mjs'],
  ])('%s runs %s, which exists', (name, file) => {
    expect(scripts[name]).toBe(`node ${file}`);
    expect(existsSync(join(ROOT, file))).toBe(true);
  });
});

describe('every new script', () => {
  it.each(['agents-page', 'agents-migration', 'task-agent-assign'])('%s runs against dist, in both themes, and exits non-zero on a FAIL', (name) => {
    const src = read(`scripts/verify/${name}.mjs`);
    expect(src).toMatch(/distIndex\(REPO\)/);
    expect(src).toMatch(/'light'/);
    expect(src).toMatch(/'dark'/);
    expect(src).toMatch(/process\.exit\(report\.fail === 0 \? 0 : 1\)/);
    // A CLI call must never inherit the orchestrator's Claude-session env (approve refuses there).
    expect(src).toMatch(/k === 'CLAUDECODE'/);
  });
});

describe('agents-migration.mjs', () => {
  const src = read('scripts/verify/agents-migration.mjs');
  it('crashes the split through the seam, with two homes, and checks the restore scenarios', () => {
    expect(src).toContain("DREAMCONTEXT_SPLIT_FAIL_AFTER: 'agent'");
    expect(src).toMatch(/HOME_A[\s\S]*HOME_B/);
    expect(src).toContain("['update', '--yes']");
    expect(src).toContain("['doctor']");
    expect(src).toMatch(/═══ R3\./);
    expect(src).toMatch(/═══ R6\./);
    expect(src).toContain('symlinkSync');
  });
});

describe('agents-page.mjs', () => {
  const src = read('scripts/verify/agents-page.mjs');
  it.each(['data-agent', 'data-agent-profile', 'data-approval', 'data-approval-review', 'data-call-settings', 'data-delete-armed'])(
    'drives the page hook %s',
    (hook) => expect(src).toContain(`[${hook}`),
  );
  it('reads a PROFILE verdict from its row (data-approved), never from a roster-chip class', () => {
    // The profile puts `data-approval` on `.agp-approval-row` (no `--ok` class); a class read
    // there is false forever, which is how the edit re-approval check went red at the final gate.
    expect(src).not.toMatch(/chipOk\(page, `\[data-agent-profile=/);
    expect(src).toMatch(/rowApproved\(page, `\[data-agent-profile=/);
    expect(src).toContain("getAttribute('data-approved')");
  });

  it('opens the deep link and checks Talk to it opens a new chat as the agent', () => {
    expect(src).toContain('dreamcontext://project/proj/page/agents/');
    expect(src).toMatch(/chatAgent=\$\{SCOUT\}/);
  });
});

describe('task-agent-assign.mjs', () => {
  const src = read('scripts/verify/task-agent-assign.mjs');
  it('refuses inside a run env and checks the status rule both ways', () => {
    expect(src).toContain("DREAMCONTEXT_AUTOMATION_RUN: '1'");
    expect(src).toContain("status: 'in_review'");
    expect(src).toContain('Approve and assign');
  });
});

describe('agents-feed.mjs', () => {
  it('switches to the roster through the tab now labelled Automations', () => {
    const src = read('scripts/verify/agents-feed.mjs');
    expect(src).not.toMatch(/\.agents-switch-opt', \{ hasText: 'Agents' \}/);
    expect(src).toMatch(/\.agents-switch-opt', \{ hasText: 'Automations' \}/);
  });
});
