/**
 * Wave 4b, lane T7: the Agents page (S1, S7, A12's "the page is where approval happens").
 *
 * TWO HALVES. The page's decisions live in pure helpers exported beside the components (the two
 * approval chips, the usage counts, the identity patch, the call settings read from the review,
 * the in-use refusal, the focus intent); those are driven directly. The render CONDITIONS (Approve
 * only inside the in-place review, no browser dialog, no Run now, Talk to it opens Chat) cannot be
 * mounted here (root vitest is plain Node, no DOM), so they are pinned by reading the source, the
 * way `agents-rail-routing.test.ts` does. What renders is `scripts/verify/agents-page.mjs`'s job.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('../../dashboard/src/context/VaultContext', () => ({
  useApi: () => null,
  useVault: () => ({ vault: null, instanceId: 'test', isActive: true, bus: new EventTarget() }),
  useInstanceEvent: () => undefined,
  emitInstance: () => undefined,
}));

import { RequestError } from '../../dashboard/src/api/client';
import type { AgentSummary } from '../../dashboard/src/hooks/useAgents';
import { renderApprovalReview } from '../../src/lib/automations/registry';
import type { ApprovalPayloadFields } from '../../src/lib/automations/types';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf-8');

const PAGE = 'dashboard/src/pages/AgentsPage.tsx';
const PAGE_CSS = 'dashboard/src/pages/AgentsPage.css';
const CARD = 'dashboard/src/components/agents/AgentRosterCard.tsx';
const PANEL = 'dashboard/src/components/agents/AgentProfilePanel.tsx';
const PANEL_CSS = 'dashboard/src/components/agents/AgentProfilePanel.css';
const DIALOG = 'dashboard/src/components/agents/AgentIdentityDialog.tsx';
const DIALOG_CSS = 'dashboard/src/components/agents/AgentIdentityDialog.css';
const TSX = [PAGE, CARD, PANEL, DIALOG];
const CSS = [PAGE_CSS, PANEL_CSS, DIALOG_CSS];

/** Source with comments removed, so prose explaining a rule never satisfies the rule. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

function agent(slug: string, over: Partial<AgentSummary> = {}): AgentSummary {
  return {
    slug,
    title: slug,
    hasPhoto: false,
    description: '',
    model: null,
    effort: null,
    whiteboard: null,
    shared: false,
    approvedForChat: true,
    approvedToRun: true,
    approvalReason: null,
    implicit: false,
    hasCallSettings: false,
    usedBy: { automations: [], boards: [], tasks: [] },
    ...over,
  };
}

function fields(over: Partial<ApprovalPayloadFields> = {}): ApprovalPayloadFields {
  return {
    prompt: 'You research.\nAnswer with sources.',
    outputInstructions: '',
    model: 'opus',
    effort: 'high',
    timeoutMinutes: 15,
    outputDir: null,
    learning: true,
    review: 'off',
    flow: null,
    whiteboard: null,
    job: '',
    ...over,
  };
}

describe('the roster card (S1)', () => {
  it('shows chat and run approval as two chips, chat first, never one', async () => {
    const { approvalChips } = await import('../../dashboard/src/components/agents/AgentRosterCard');
    const chips = approvalChips(agent('scout', { approvedForChat: true, approvedToRun: false }));
    expect(chips.map((c) => [c.kind, c.ok])).toEqual([['chat', true], ['run', false]]);
    expect(chips[0].labelKey).toBe('agents.approval.chatOk');
    expect(chips[1].labelKey).toBe('agents.approval.runNo');
    const none = approvalChips(agent('x', { approvedForChat: false, approvedToRun: false }));
    expect(none.map((c) => c.labelKey)).toEqual(['agents.approval.chatNo', 'agents.approval.runNo']);
  });

  it('counts usage per kind', async () => {
    const { usageCounts } = await import('../../dashboard/src/components/agents/AgentRosterCard');
    const a = agent('scout', {
      usedBy: {
        automations: [{ slug: 'digest', title: 'Digest', enabled: true, nextFireAt: null }],
        boards: ['plan', 'ops'],
        tasks: [{ slug: 't', name: 'T', status: 'todo' }],
      },
    });
    expect(usageCounts(a)).toEqual({ automations: 1, boards: 2, tasks: 1, total: 4 });
    expect(usageCounts(agent('idle')).total).toBe(0);
  });

  it('falls back to English copy only when a key has none', async () => {
    const { tx } = await import('../../dashboard/src/components/agents/AgentRosterCard');
    expect(tx((k) => k, 'agents.nope', 'Fallback')).toBe('Fallback');
    expect(tx(() => 'Translated', 'agents.yes', 'Fallback')).toBe('Translated');
  });

  it('draws face, title, model, both chips and usage', () => {
    const src = code(read(CARD));
    expect(src).toMatch(/<AgentAvatar of="agent"/);
    expect(src).toMatch(/agent\.title/);
    expect(src).toMatch(/agent\.model \?\? t\('agents\.profile\.modelDefault'\)/);
    expect(src).toMatch(/approvalChips\(agent\)\.map/);
    expect(src).toMatch(/usageCounts\(agent\)/);
  });
});

describe('the profile: call settings are read from the review, read-only', () => {
  it('parses the review the server renders, multi-line values included', async () => {
    const { parseReviewFields } = await import('../../dashboard/src/components/agents/AgentProfilePanel');
    const review = renderApprovalReview(fields({ outputDir: 'reports/scout', review: 'agent' }));
    const map = parseReviewFields(review);
    expect(map.get('prompt')).toBe('You research.\nAnswer with sources.');
    expect(map.get('timeoutMinutes')).toBe('15');
    expect(map.get('outputDir')).toBe('reports/scout');
    expect(map.get('review')).toBe('agent');
    expect(map.get('flow')).toBe('(none)');
  });

  it('names each call setting, and "(none)" reads as not set', async () => {
    const { callSettingRows } = await import('../../dashboard/src/components/agents/AgentProfilePanel');
    const rows = callSettingRows(renderApprovalReview(fields({ timeoutMinutes: 30 })));
    expect(rows).toEqual([
      { key: 'timeout', value: '30' },
      { key: 'outputDir', value: null },
      { key: 'review', value: 'off' },
      { key: 'flow', value: null },
    ]);
  });

  it('shows call settings only when the agent has them, and offers no editor for them', () => {
    const src = code(read(PANEL));
    expect(src).toMatch(/agent\.hasCallSettings && \(/);
    expect(src).toMatch(/callSettingRows\(detail\.data\.review\)/);
    const dialog = code(read(DIALOG));
    for (const field of ['timeoutMinutes', 'outputDir', 'outputInstructions', 'flow']) {
      expect(dialog).not.toMatch(new RegExp(`\\b${field}\\b`));
    }
  });
});

describe('the profile: approval is separate, and happens in place (S1, A12)', () => {
  it('maps a refusal reason to its key, or the plain "not approved to run"', async () => {
    const { approvalReasonKey } = await import('../../dashboard/src/components/agents/AgentProfilePanel');
    expect(approvalReasonKey('manifest-changed')).toBe('agents.approval.reason.manifest-changed');
    expect(approvalReasonKey(null)).toBe('agents.approval.runNo');
  });

  it('renders one row per verdict', () => {
    const src = code(read(PANEL));
    expect(src).toMatch(/approvalChips\(agent\)\.map\(\(chip\) => \(\s*<div key=\{chip\.kind\} className="agp-approval-row"/);
  });

  it('Approve exists only inside the review, which re-reads the agent before it opens', () => {
    const src = code(read(PANEL));
    expect(src.match(/approve\.mutate\(/g)).toHaveLength(1);
    const review = src.slice(src.indexOf('{reviewing && ('), src.indexOf('</section>', src.indexOf('{reviewing && (')));
    expect(review).toMatch(/detail\.data\?\.review/);
    expect(review).toMatch(/onClick=\{doApprove\}/);
    expect(src.match(/onClick=\{doApprove\}/g)).toHaveLength(1);
    expect(src).toMatch(/const openReview = \(\) => \{[\s\S]*?setReviewing\(true\);[\s\S]*?detail\.refetch\(\)/);
    expect(review).toMatch(/disabled=\{approve\.isPending \|\| detail\.isFetching \|\| !detail\.data\}/);
  });
});

describe('the profile: Talk to it and delete (S1)', () => {
  it('Talk to it asks Chat for a new conversation, then opens Chat; says so when nothing took it', () => {
    const src = code(read(PANEL));
    expect(src).toMatch(/requestTalkToAgent\(slug\)\.then\(\(accepted\) => \{[\s\S]*?if \(accepted\) openAgentSurface\(bus\);\s*else setTalkError\(t\('agents\.profile\.talkFailed'\)\)/);
    expect(src).toMatch(/disabled=\{!agent\.approvedForChat \|\| talking\}/);
  });

  it('recognises the 409 agent_in_use refusal and names what uses the agent', async () => {
    const { inUseNames, isAgentInUse } = await import('../../dashboard/src/components/agents/AgentProfilePanel');
    expect(isAgentInUse(new RequestError('in use', 409, 'agent_in_use'))).toBe(true);
    expect(isAgentInUse(new RequestError('nope', 404, 'not_found'))).toBe(false);
    expect(isAgentInUse(new Error('agent_in_use'))).toBe(false);
    const a = agent('scout', {
      usedBy: {
        automations: [
          { slug: 'digest', title: 'Morning digest', enabled: true, nextFireAt: null },
          { slug: 'weekly', title: 'Weekly report', enabled: false, nextFireAt: null },
        ],
        boards: [],
        tasks: [],
      },
    });
    expect(inUseNames(a)).toEqual(['Morning digest', 'Weekly report']);
    expect(inUseNames(a, ['weekly', 'gone'])).toEqual(['Weekly report', 'gone']);
  });

  it('delete is a two-click in-place confirm that surfaces the in-use list', () => {
    const src = code(read(PANEL));
    expect(src).toMatch(/deleteAction\(armed\) === 'arm'/);
    expect(src).toMatch(/isAgentInUse\(err\)[\s\S]*?t\('agents\.profile\.deleteInUse'\)[\s\S]*?inUseNames\(agent\)/);
    expect(src).toMatch(/t\('agents\.profile\.deleteConfirm'\)/);
  });
});

describe('the identity dialog: create and edit', () => {
  it('requires a name and a prompt', async () => {
    const { identityFormError, EMPTY_IDENTITY_FORM } = await import('../../dashboard/src/components/agents/AgentIdentityDialog');
    expect(identityFormError(EMPTY_IDENTITY_FORM)).toBe('agents.identity.nameRequired');
    expect(identityFormError({ ...EMPTY_IDENTITY_FORM, title: 'Scout' })).toBe('agents.identity.promptRequired');
    expect(identityFormError({ ...EMPTY_IDENTITY_FORM, title: 'Scout', prompt: 'You scout.' })).toBeNull();
  });

  it('an edit sends only what changed, and "default" clears to null', async () => {
    const { identityPatch, formFromAgent } = await import('../../dashboard/src/components/agents/AgentIdentityDialog');
    const before = formFromAgent(agent('scout', { title: 'Scout', model: 'opus', effort: 'high', whiteboard: 'plan' }), 'You scout.', true);
    expect(identityPatch(before, before)).toEqual({});
    expect(identityPatch(before, { ...before, title: '  Scout ' })).toEqual({});
    expect(identityPatch(before, { ...before, model: '', effort: '', whiteboard: '' }))
      .toEqual({ model: null, effort: null, whiteboard: null });
    expect(identityPatch(before, { ...before, prompt: 'You scout harder.', learning: false }))
      .toEqual({ prompt: 'You scout harder.', learning: false });
  });

  it('a truncation refusal gets its own sentence', async () => {
    const { identityErrorKey } = await import('../../dashboard/src/components/agents/AgentIdentityDialog');
    expect(identityErrorKey(new RequestError('cut', 409, 'prompt_truncated'))).toBe('agents.identity.truncated');
    expect(identityErrorKey(new Error('boom'))).toBe('agents.identity.failed');
  });

  it('an edit reads the agent fresh and allows no save until it has', () => {
    const src = code(read(DIALOG));
    expect(src).toMatch(/useAgent\(slug, \{ fresh: true \}\)/);
    expect(src).toMatch(/const ready = original !== null;/);
    expect(src).toMatch(/disabled=\{!ready \|\| busy \|\| !!blocker\}/);
    expect(src).toMatch(/useCreateAgentIdentity\(\)/);
    expect(src).toMatch(/useUpdateAgentIdentity\(\)/);
    expect(src).toMatch(/useUploadAgentIdentityPhoto\(\)/);
  });
});

describe('the page: focus and deep link (S7)', () => {
  it('reads a focus as select, create, or both', async () => {
    const { focusIntent, rosterCountKey } = await import('../../dashboard/src/pages/AgentsPage');
    expect(focusIntent(null)).toBeNull();
    expect(focusIntent({ slug: 'scout', nonce: 1 })).toEqual({ select: 'scout', create: false, whiteboard: null });
    expect(focusIntent({ create: true, nonce: 2 })).toEqual({ select: null, create: true, whiteboard: null });
    expect(focusIntent({ create: true, whiteboard: 'growth', nonce: 3 })).toEqual({ select: null, create: true, whiteboard: 'growth' });
    expect(focusIntent({ slug: 'scout', whiteboard: 'growth', nonce: 4 })).toEqual({ select: 'scout', create: false, whiteboard: null });
    expect(rosterCountKey(0)).toBe('agents.page.empty');
    expect(rosterCountKey(1)).toBe('agents.roster.count.one');
    expect(rosterCountKey(7)).toBe('agents.roster.count.many');
  });

  it('keeps the pinned props, opens the profile or the dialog, and hands the focus back once', () => {
    const src = code(read(PAGE));
    expect(src).toMatch(/export function AgentsPage\(\{ focus, onFocusDone \}: \{ focus: AgentsFocus \| null; onFocusDone: \(\) => void \}\)/);
    expect(src).toMatch(/useAgents\(\)/);
    const effect = src.slice(src.indexOf('const intent = focusIntent(focus);'), src.indexOf('}, [focus, onFocusDone]);'));
    expect(effect).toMatch(/if \(intent\.select\) setSelected\(intent\.select\);/);
    expect(effect).toMatch(/if \(intent\.create\) setDialog\(intent\.whiteboard \? \{ slug: null, whiteboard: intent\.whiteboard \} : \{ slug: null \}\);/);
    expect(effect).toMatch(/onFocusDone\(\);/);
    expect(src).toMatch(/<AgentProfilePanel\s+slug=\{selected\}/);
    expect(src).toMatch(/<AgentIdentityDialog slug=\{dialog\.slug\}/);
  });

  it('has no page headline (the rail names the page)', () => {
    expect(code(read(PAGE))).not.toMatch(/<h1\b/);
  });
});

describe('the UI rules', () => {
  it('no browser dialog anywhere on the page (silent no-ops in the desktop app)', () => {
    for (const f of TSX) {
      expect(code(read(f)), f).not.toMatch(/\b(?:window\.)?(?:confirm|alert|prompt)\s*\(/);
    }
  });

  it('no Run now and no Telegram on this page', () => {
    for (const f of TSX) {
      const src = code(read(f));
      expect(src, f).not.toMatch(/run ?now|runNow|useRunAutomation/i);
      expect(src, f).not.toMatch(/telegram/i);
    }
  });

  it('design tokens only: no hardcoded colours or fonts in the CSS', () => {
    for (const f of CSS) {
      const css = read(f).replace(/\/\*[\s\S]*?\*\//g, ' ');
      expect(css, f).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(css, f).not.toMatch(/\b(?:rgb|rgba|hsl|hsla|oklch)\(/);
      // The lookahead carries its own `\s*`: a bare `\s*` before it backtracks to zero and lets
      // ` var(` through as "not var(", failing every tokenised font-family.
      expect(css, f).not.toMatch(/font-family:(?!\s*var\()/);
      expect(css, f).not.toMatch(/font-size:\s*\d/);
    }
  });

  it('no em dash in any copy fallback', () => {
    for (const f of TSX) {
      for (const m of read(f).matchAll(/tx\(t, '[^']+', '([^']*)'\)/g)) {
        expect(m[1], f).not.toContain('—');
      }
    }
  });
});
