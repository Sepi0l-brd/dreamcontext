/**
 * Composing run targets from an agent and an automation job.
 *
 * The load-bearing claim (A2): for EVERY legacy manifest, the composed run target hashes
 * exactly like the manifest did, so splitting it into agent + automation keeps every
 * approval on every machine with no registry write. The fixtures are real files written
 * by the store's own `createAutomation` + `writeFlowSection(deriveFlowFromManifest(...))`,
 * the way the dashboard creates an agent, because the derived `## Flow` embeds the title,
 * cadence, model and effort into the hash.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { composeRun, deriveAgentId, identityOnly, legacyPair } from '../../src/lib/agents/compose.js';
import { DEFAULT_CALL_SETTINGS } from '../../src/lib/agents/types.js';
import {
  automationPath,
  createAutomation,
  deriveFlowFromManifest,
  readAutomationFile,
  writeFlowSection,
  type CreateAutomationInput,
} from '../../src/lib/automations/store.js';
import { canonicalApprovalPayload, manifestHash } from '../../src/lib/automations/registry.js';
import type { AutomationManifest } from '../../src/lib/automations/types.js';

let projectRoot: string;
let contextRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-compose-'));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(contextRoot, { recursive: true });
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

/** Create the way the dashboard does (create, then write the derived flow), and
 *  read back from disk, so the manifest is exactly what a legacy file holds. */
function dashboardManifest(input: CreateAutomationInput, withDerivedFlow = true): AutomationManifest {
  const created = createAutomation(contextRoot, input);
  if (withDerivedFlow) writeFlowSection(contextRoot, created.slug, deriveFlowFromManifest(created));
  return readAutomationFile(automationPath(contextRoot, created.slug));
}

/** Compose the target a legacy manifest splits into: the automation for a
 *  scheduled one, the agent's call target for an on-call one. */
function composedFromLegacy(m: AutomationManifest): AutomationManifest {
  const { agent, job } = legacyPair(m);
  return composeRun(agent, job);
}

const BASE: CreateAutomationInput = {
  slug: 'eod-digest',
  title: 'End of day digest',
  prompt: 'Summarise what changed today.\n\nKeep it to five lines.',
  days: 'daily',
  at: '18:00',
};

const FIXTURES: Array<[string, CreateAutomationInput, boolean]> = [
  ['scheduled, dashboard-style with a derived flow', BASE, true],
  ['scheduled, no flow (written before ## Flow existed)', { ...BASE, slug: 'old-digest' }, false],
  ['on-call, dashboard-style with a derived flow', { ...BASE, slug: 'helper', mode: 'call' }, true],
  ['on-call, no flow', { ...BASE, slug: 'helper-two', mode: 'call' }, false],
  ['learning off, effort null, model null', { ...BASE, slug: 'plain', learning: false, effort: null, model: null }, true],
  ['model + effort set', { ...BASE, slug: 'heavy', model: 'opus', effort: 'high' }, true],
  ['review: agent', { ...BASE, slug: 'reviewed', review: 'agent' }, true],
  ['review: output, on call', { ...BASE, slug: 'gated', review: 'output', mode: 'call' }, true],
  ['home board', { ...BASE, slug: 'board-pilot', whiteboard: 'northwind-ops' }, true],
  ['home board, on call', { ...BASE, slug: 'board-caller', whiteboard: 'northwind-ops', mode: 'call' }, true],
  ['outputDir + output instructions + timeout', {
    ...BASE, slug: 'reporter', outputDir: 'reports/weekly', outputInstructions: 'One heading per section.', timeoutMinutes: 30,
  }, true],
  ['on call with outputDir + output instructions + timeout', {
    ...BASE, slug: 'reporter-call', mode: 'call', outputDir: 'reports/adhoc', outputInstructions: 'Bullets only.', timeoutMinutes: 45,
  }, true],
  ['multi-slot schedule', {
    ...BASE, slug: 'multi', slots: [{ kind: 'weekly', days: ['mon', 'wed'], at: '09:00' }, { kind: 'weekly', days: ['fri'], at: '17:30' }],
  }, true],
];

describe('hash invariance: composeRun(legacyPair(m)) hashes exactly like m (A2)', () => {
  for (const [name, input, withFlow] of FIXTURES) {
    it(name, () => {
      const m = dashboardManifest(input, withFlow);
      const composed = composedFromLegacy(m);
      expect(canonicalApprovalPayload(composed)).toBe(canonicalApprovalPayload(m));
      expect(manifestHash(composed)).toBe(manifestHash(m));
    });
  }

  it('a legacy file with no id at all (hand-written) still hashes the same, and keeps its empty id', () => {
    mkdirSync(join(contextRoot, 'automations'), { recursive: true });
    const path = join(contextRoot, 'automations', 'hand-made.md');
    writeFileSync(path, '---\ntitle: Hand made\nmode: call\n---\n\n## Prompt\nAnswer when asked.\n');
    const m = readAutomationFile(path);
    expect(m.id).toBe('');
    const composed = composedFromLegacy(m);
    expect(manifestHash(composed)).toBe(manifestHash(m));
    expect(composed.id).toBe('');
  });

  it('mutation guard: a composition that drops the call flow WOULD change the hash', () => {
    // Proves the invariance tests above can fail: an on-call agent's derived flow
    // is hashed, so an agent-only split that did not carry it would block it.
    const m = dashboardManifest({ ...BASE, slug: 'helper', mode: 'call' }, true);
    expect(m.flow).not.toBeNull();
    const { agent } = legacyPair(m);
    const dropped = composeRun({ ...agent, call: { ...agent.call, flow: null } }, null);
    expect(manifestHash(dropped)).not.toBe(manifestHash(m));
  });
});

describe('the composed target is the legacy manifest, field by field', () => {
  it('scheduled: an automation run target equal to the legacy read on every field', () => {
    const m = dashboardManifest({ ...BASE, model: 'opus', effort: 'medium', learning: true, review: 'agent' });
    const composed = composedFromLegacy(m);
    expect(composed).toEqual(m);
    expect(composed.runKind).toBe('automation');
    expect(composed.bindings).toEqual([]);
    expect(composed.legacyKey).toBe(false);
  });

  it("on call: the agent's call target, equal to the legacy read except the never-due schedule fields", () => {
    const m = dashboardManifest({ ...BASE, slug: 'helper', mode: 'call', model: 'sonnet', outputDir: 'reports/adhoc' });
    const composed = composedFromLegacy(m);
    const { schedule: _s1, scheduleError: _e1, catchupHours: _c1, runKind: _k1, legacyKey: _l1, ...legacyRest } = m;
    const { schedule: s2, scheduleError: e2, catchupHours: _c2, runKind: k2, legacyKey: _l2, ...composedRest } = composed;
    expect(composedRest).toEqual(legacyRest);
    expect(k2).toBe('agent');
    expect(composed.mode).toBe('call');
    expect(s2).toBeNull();
    expect(e2).toBeNull();
  });
});

describe('legacyPair', () => {
  it('scheduled → an agent with default call settings + a job holding everything else', () => {
    const m = dashboardManifest({ ...BASE, outputDir: 'reports/daily', review: 'agent' });
    const { agent, job } = legacyPair(m);
    expect(agent.call).toEqual(DEFAULT_CALL_SETTINGS);
    expect(agent.implicit).toBe(true);
    expect(agent.migratedFrom).toBe(m.id);
    expect(job).not.toBeNull();
    expect(job?.agent).toBe(m.slug);
    expect(job?.outputDir).toBe('reports/daily');
    expect(job?.review).toBe('agent');
    expect(job?.job).toBe('');
  });

  it("on call → an agent only, carrying the old run settings as its call settings (O1)", () => {
    const m = dashboardManifest({
      ...BASE, slug: 'helper', mode: 'call', outputDir: 'reports/adhoc', outputInstructions: 'Bullets.', timeoutMinutes: 40, review: 'output',
    });
    const { agent, job } = legacyPair(m);
    expect(job).toBeNull();
    expect(agent.call).toMatchObject({
      timeoutMinutes: 40,
      outputDir: 'reports/adhoc',
      outputInstructions: 'Bullets.',
      review: 'output',
      flow: m.flow,
      enabled: m.enabled,
      notify: m.notify,
    });
  });
});

describe('composeRun', () => {
  it('without a job, job is ALWAYS empty, mode is call, and no schedule', () => {
    const m = dashboardManifest({ ...BASE, slug: 'helper', mode: 'call' });
    const { agent } = legacyPair(m);
    const target = composeRun(agent, null);
    expect(target.job).toBe('');
    expect(target.mode).toBe('call');
    expect(target.schedule).toBeNull();
    expect(target.runKind).toBe('agent');
  });

  it('carries the bindings and legacyKey it is given, defaulting to none and false (fail closed)', () => {
    const m = dashboardManifest({ ...BASE, slug: 'helper', mode: 'call' });
    const { agent } = legacyPair(m);
    expect(composeRun(agent, null).bindings).toEqual([]);
    expect(composeRun(agent, null).legacyKey).toBe(false);
    const bound = composeRun(agent, null, [{ slug: 'digest', sha256: 'abc' }], true);
    expect(bound.bindings).toEqual([{ slug: 'digest', sha256: 'abc' }]);
    expect(bound.legacyKey).toBe(true);
  });

  it('an automation never carries bindings or a legacy key, whatever it is given', () => {
    const m = dashboardManifest(BASE);
    const { agent, job } = legacyPair(m);
    const target = composeRun(agent, job, [{ slug: 'x', sha256: 'y' }], true);
    expect(target.bindings).toEqual([]);
    expect(target.legacyKey).toBe(false);
  });

  it("identity comes from the agent, the job from the automation (a job may run a different agent)", () => {
    const researcher = legacyPair(dashboardManifest({ ...BASE, slug: 'researcher', title: 'Researcher', mode: 'call', model: 'opus' })).agent;
    const digestJob = legacyPair(dashboardManifest({ ...BASE, slug: 'digest', title: 'Morning digest' })).job!;
    const target = composeRun(researcher, { ...digestJob, agent: 'researcher', job: 'Write the morning digest.' });
    expect(target.slug).toBe('digest');
    expect(target.title).toBe('Morning digest');
    expect(target.agent).toBe('researcher');
    expect(target.agentTitle).toBe('Researcher');
    expect(target.model).toBe('opus');
    expect(target.prompt).toBe(researcher.prompt);
    expect(target.job).toBe('Write the morning digest.');
  });
});

describe('identityOnly', () => {
  it('forces every call setting back to the defaults and keeps identity', () => {
    const m = dashboardManifest({
      ...BASE, slug: 'helper', mode: 'call', outputDir: 'reports/adhoc', outputInstructions: 'Bullets.', timeoutMinutes: 40, review: 'output',
    });
    const conversation = identityOnly(composedFromLegacy(m));
    expect(conversation.outputDir).toBeNull();
    expect(conversation.outputInstructions).toBe('');
    expect(conversation.flow).toBeNull();
    expect(conversation.review).toBe('off');
    expect(conversation.timeoutMinutes).toBe(DEFAULT_CALL_SETTINGS.timeoutMinutes);
    expect(conversation.job).toBe('');
    expect(conversation.prompt).toBe(m.prompt);
    expect(conversation.model).toBe(m.model);
    expect(conversation.whiteboard).toBe(m.whiteboard);
  });
});

describe('deriveAgentId — deterministic, so two machines write the same bytes', () => {
  it('auto_<x> → agt_<x>; another id → agt_<id>; no id → agt_ + 8 hex of sha256(slug)', () => {
    expect(deriveAgentId('auto_AbC12345', 'eod')).toBe('agt_AbC12345');
    expect(deriveAgentId('custom', 'eod')).toBe('agt_custom');
    const derived = deriveAgentId('', 'eod');
    expect(derived).toMatch(/^agt_[0-9a-f]{8}$/);
    expect(deriveAgentId('  ', 'eod')).toBe(derived);
    expect(deriveAgentId('', 'other')).not.toBe(derived);
  });
});
