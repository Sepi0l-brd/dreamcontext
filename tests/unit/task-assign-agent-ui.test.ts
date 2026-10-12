/**
 * Wave 4b, lane T10: the Tasks UI's "Assign to agent", driven without React. Everything the
 * composer decides lives in `dashboard/src/lib/assignToAgent.ts`: which agents are offered and
 * which one the picker starts on, what each refusal says (or that `agent_not_approved_to_run`
 * opens the review in place, T7), the success line (the status move, T2 display), and the
 * approve-then-assign sequence. `taskAgent` is what the card and the detail read for the face (T1).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../dashboard/src/context/VaultContext', () => ({ useApi: () => null }));

import { AssignAgentError, type AssignAgentResult, type Task } from '../../dashboard/src/hooks/useTasks';
import type { AgentSummary } from '../../dashboard/src/hooks/useAgents';
import {
  ASSIGN_NOTE_MAX_CHARS, approvalReasonText, approveThenAssign, assignedMessage, initialAgentSlug,
  noteTooLong, offeredAgents, refusalView, tr, type Translate,
} from '../../dashboard/src/lib/assignToAgent';
import { taskAgent, taskAssignees } from '../../dashboard/src/components/tasks/boardModel';

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

/** No locale: every key echoes, so every line is the fallback. */
const echo: Translate = (k) => k;
/** A locale carrying a few keys. */
const dict: Record<string, string> = {
  'tasks.assignDisabled': '{name} is turned off.',
  'tasks.assignBusy': '{name} is running right now. Assign the task when it finishes.',
  'tasks.assignNoteTooLong': 'The note is too long.',
  'tasks.assignFailed': "Couldn't assign the task. {reason}",
  'tasks.assigned': '{name} is working on this task.',
  'tasks.assignedMoved': '{name} is working on this task. Its status moved to In progress.',
  'agents.approval.reason.never-approved': 'Never approved on this Mac.',
};
const keyed: Translate = (k) => dict[k] ?? k;

const result = (statusMoved: boolean): AssignAgentResult => ({ jobId: 'j1', runId: '2026-10-12T09:00:00.000Z', statusMoved });

describe('tr', () => {
  it('uses the key when a locale carries it, the fallback otherwise, and fills every {var}', () => {
    expect(tr(keyed, 'tasks.assignDisabled', 'x', { name: 'Ada' })).toBe('Ada is turned off.');
    expect(tr(echo, 'tasks.missing', 'Hi {name}, {name}', { name: 'Ada' })).toBe('Hi Ada, Ada');
  });
});

describe('offeredAgents / initialAgentSlug', () => {
  const roster = [
    agent('zed', { title: 'Zed' }),
    agent('blocked', { title: 'Blocked', approvedToRun: false, approvalReason: 'never-approved' }),
    agent('ada', { title: 'Ada' }),
  ];

  it('offers every agent, runnable ones first, then by name', () => {
    expect(offeredAgents(roster).map((a) => a.slug)).toEqual(['ada', 'zed', 'blocked']);
    expect(offeredAgents(undefined)).toEqual([]);
  });

  it('ranks by approvedToRun, never by approvedForChat', () => {
    const chatOnly = agent('chatty', { title: 'Aaa', approvedForChat: true, approvedToRun: false });
    const runner = agent('runner', { title: 'Zzz', approvedForChat: false, approvedToRun: true });
    expect(offeredAgents([chatOnly, runner]).map((a) => a.slug)).toEqual(['runner', 'chatty']);
  });

  it('does not mutate the roster it was given', () => {
    const copy = [...roster];
    offeredAgents(roster);
    expect(roster).toEqual(copy);
  });

  it('starts on the current agent, else the first runnable, else the first, else none', () => {
    const offered = offeredAgents(roster);
    expect(initialAgentSlug(offered, 'zed')).toBe('zed');
    expect(initialAgentSlug(offered, 'gone')).toBe('ada');
    expect(initialAgentSlug(offered, null)).toBe('ada');
    expect(initialAgentSlug([agent('b', { approvedToRun: false })], null)).toBe('b');
    expect(initialAgentSlug([], 'zed')).toBeNull();
  });
});

describe('noteTooLong', () => {
  it('mirrors the server limit after the same trim', () => {
    expect(noteTooLong('x'.repeat(ASSIGN_NOTE_MAX_CHARS))).toBe(false);
    expect(noteTooLong(`  ${'x'.repeat(ASSIGN_NOTE_MAX_CHARS)}  `)).toBe(false);
    expect(noteTooLong('x'.repeat(ASSIGN_NOTE_MAX_CHARS + 1))).toBe(true);
  });
});

describe('refusalView (T7 and the other refusals, in place)', () => {
  const err = (code: AssignAgentError['code'], status = 409, message = 'server words') =>
    new AssignAgentError(message, code, status);

  it('agent_not_approved_to_run opens the review instead of a line', () => {
    expect(refusalView(err('agent_not_approved_to_run'), 'Ada', keyed)).toEqual({ kind: 'review' });
  });

  it('says the other refusals in plain words, with the agent named', () => {
    expect(refusalView(err('agent_disabled'), 'Ada', keyed)).toEqual({ kind: 'message', text: 'Ada is turned off.' });
    expect(refusalView(err('agent_busy'), 'Ada', keyed)).toEqual({
      kind: 'message', text: 'Ada is running right now. Assign the task when it finishes.',
    });
    expect(refusalView(err('note_too_long', 400), 'Ada', keyed)).toEqual({ kind: 'message', text: 'The note is too long.' });
  });

  it('answers both 404s (unknown task, unknown agent) with their own line', () => {
    const agentGone = refusalView(err('unknown_agent', 404), 'Ada', echo);
    const taskGone = refusalView(err('unknown_task', 404), 'Ada', echo);
    expect(agentGone.kind === 'message' && agentGone.text).toContain('Ada is no longer here');
    expect(taskGone.kind === 'message' && taskGone.text).toContain('This task is no longer here');
  });

  it('never leaks a code, a status or the raw server message', () => {
    for (const code of ['assign_failed', 'unknown', 'invalid_path', 'invalid_note'] as const) {
      const v = refusalView(err(code, 500, 'ECONNRESET at /api/tasks/x/assign-agent'), 'Ada', keyed);
      expect(v.kind).toBe('message');
      const text = v.kind === 'message' ? v.text : '';
      expect(text).toMatch(/^Couldn't assign the task\. /);
      expect(text).not.toMatch(/ECONNRESET|\/api\/|500|assign_failed|\{reason\}/);
    }
  });

  it('every line is filled even with no locale at all (fallbacks, no raw keys)', () => {
    for (const code of ['agent_disabled', 'agent_busy', 'note_too_long', 'unknown_agent', 'unknown_task', 'missing_agent', 'assign_failed'] as const) {
      const v = refusalView(err(code), 'Ada', echo);
      expect(v.kind === 'message' && v.text).not.toMatch(/^tasks\./);
    }
  });
});

describe('assignedMessage (T2 display)', () => {
  it('says the status moved only when the server moved it', () => {
    expect(assignedMessage(result(true), 'Ada', keyed)).toBe('Ada is working on this task. Its status moved to In progress.');
    expect(assignedMessage(result(false), 'Ada', keyed)).toBe('Ada is working on this task.');
  });
});

describe('approvalReasonText', () => {
  it('reads the reason slug through the locale, empty when there is none or it is unknown', () => {
    expect(approvalReasonText('never-approved', keyed)).toBe('Never approved on this Mac.');
    expect(approvalReasonText(null, keyed)).toBe('');
    expect(approvalReasonText('something-new', keyed)).toBe('');
  });
});

describe('approveThenAssign (T7: Approve and assign)', () => {
  it('approves, checks the fresh verdict, then assigns once', async () => {
    const calls: string[] = [];
    const out = await approveThenAssign({
      approve: async () => { calls.push('approve'); return agent('ada'); },
      assign: async () => { calls.push('assign'); return result(true); },
    });
    expect(calls).toEqual(['approve', 'assign']);
    expect(out).toEqual({ ok: true, result: result(true) });
  });

  it('never assigns after a failed approve', async () => {
    const assign = vi.fn(async () => result(false));
    const boom = new Error('nope');
    const out = await approveThenAssign({ approve: async () => { throw boom; }, assign });
    expect(assign).not.toHaveBeenCalled();
    expect(out).toEqual({ ok: false, stage: 'approve', error: boom });
  });

  it('never assigns when the fresh summary still may not run (chat approval is not enough)', async () => {
    const assign = vi.fn(async () => result(false));
    const out = await approveThenAssign({
      approve: async () => agent('ada', { approvedForChat: true, approvedToRun: false, approvalReason: 'manifest-changed' }),
      assign,
    });
    expect(assign).not.toHaveBeenCalled();
    expect(out).toEqual({ ok: false, stage: 'still-unapproved', reason: 'manifest-changed' });
  });

  it('returns a typed refusal when the assignment itself is refused', async () => {
    const out = await approveThenAssign({
      approve: async () => agent('ada'),
      assign: async () => { throw new AssignAgentError('busy', 'agent_busy', 409); },
    });
    expect(out.ok).toBe(false);
    if (!out.ok && out.stage === 'assign') {
      expect(out.error).toBeInstanceOf(AssignAgentError);
      expect(out.error.code).toBe('agent_busy');
    } else {
      throw new Error(`expected an assign-stage refusal, got ${JSON.stringify(out)}`);
    }
  });

  it('types an untyped assign failure too', async () => {
    const out = await approveThenAssign({
      approve: async () => agent('ada'),
      assign: async () => { throw { message: 'x', code: 'note_too_long', status: 400 }; },
    });
    expect(!out.ok && out.stage === 'assign' && out.error.code).toBe('note_too_long');
  });
});

describe('taskAgent (the face on the card and the detail, T1)', () => {
  const task = (over: Partial<Task>): Task => ({
    slug: 't', id: 't', name: 'T', description: '', priority: 'medium', urgency: 'medium', status: 'todo',
    created_at: '', updated_at: '', tags: [], parent_task: null, related_feature: null, version: null,
    rice: null, why: '', user_stories: '', acceptance_criteria: '', constraints: '', technical_details: '',
    notes: '', changelog: '', sections: [], body: '', ...over,
  });

  it('reads the agent slug, null when absent, blank or cleared', () => {
    expect(taskAgent(task({ agent: 'ada' }))).toBe('ada');
    expect(taskAgent(task({ agent: '  ada ' }))).toBe('ada');
    expect(taskAgent(task({}))).toBeNull();
    expect(taskAgent(task({ agent: null }))).toBeNull();
    expect(taskAgent(task({ agent: '   ' }))).toBeNull();
  });

  it('keeps the agent out of the assignees (an agent is never a person)', () => {
    expect(taskAssignees(task({ agent: 'ada', tags: ['person:bo'] }))).toEqual(['bo']);
  });
});
