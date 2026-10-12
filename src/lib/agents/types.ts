/**
 * Agents — the entity that holds an agent's IDENTITY (name, photo, prompt,
 * model, effort, learned pattern, home board), separate from the automations
 * that run it on a schedule. An agent lives at `_dream_context/agents/<slug>.md`;
 * an automation at `automations/<slug>.md` names one with `agent: <slug>`.
 *
 * Pure: types and constants only, no I/O. The run-target vocabulary
 * (`RunKind`, `ApprovalUse`, `ApprovalBinding`, `AutomationSlot`) is declared in
 * the automations contract root and re-exported here, so the two modules cannot
 * drift apart.
 */
import {
  DEFAULT_TIMEOUT_MINUTES,
  type EffortLevel,
  type FlowGraph,
  type ReviewMode,
} from '../automations/types.js';

export type { ApprovalBinding, ApprovalUse, AutomationSlot, RunKind } from '../automations/types.js';

/** The agents folder, contextRoot-relative. */
export const AGENTS_DIR = 'agents';

/**
 * How a CALLED run of the agent behaves — an @mention or a task assignment of
 * an agent that has no automation of its own. Every field but `enabled` and
 * `notify` is approval-hashed in the agent's call target.
 *
 * Nothing edits these in this build: the migration writes them for an on-call
 * agent (its old run settings), and every other agent has the defaults.
 */
export interface AgentCallSettings {
  timeoutMinutes: number;
  outputDir: string | null;
  review: ReviewMode;
  /** The agent file's `## Output instructions`, `''` when absent. */
  outputInstructions: string;
  /** The agent file's `## Flow`, `null` (never `undefined`) when absent. */
  flow: FlowGraph | null;
  /** Unhashed: whether a call may run at all. */
  enabled: boolean;
  /** Unhashed: whether a finished call notifies. */
  notify: boolean;
}

/** The call settings of an agent with no `call:` block. A conversation with an
 *  agent is always built on these, whatever its file says (`identityOnly`). */
export const DEFAULT_CALL_SETTINGS: Readonly<AgentCallSettings> = Object.freeze({
  timeoutMinutes: DEFAULT_TIMEOUT_MINUTES,
  outputDir: null,
  review: 'off',
  outputInstructions: '',
  flow: null,
  enabled: true,
  notify: true,
});

export interface AgentManifest {
  slug: string;
  id: string;
  title: string;
  /** contextRoot-relative, under `automations/photos/`; resolved through the
   *  store's photo gate before any use. Unhashed. */
  photo: string | null;
  prompt: string;
  model: string | null;
  effort: EffortLevel | null;
  learning: boolean;
  /** The `## Pattern` section verbatim. Unhashed (it changes every run). */
  pattern: string;
  /** The agent's home board, or null. Hashed. */
  whiteboard: string | null;
  /** Private unless the literal `true`. Unhashed. */
  shared: boolean;
  call: AgentCallSettings;
  /** The id of the legacy automation file this agent came from, or null. On an
   *  agent synthesised from a not-yet-split legacy file it is that file's id, so
   *  the composed call target keeps the legacy id byte for byte. */
  migratedFrom: string | null;
  /** True when this agent was synthesised from a legacy automation file on read
   *  (no `agents/<slug>.md` exists for it yet). */
  implicit: boolean;
  path: string;
  body: string;
}

/** What a create or a full edit of an agent may set. */
export interface AgentInput {
  slug: string;
  title: string;
  prompt: string;
  model?: string | null;
  effort?: EffortLevel | null;
  learning?: boolean;
  whiteboard?: string | null;
  photo?: string | null;
  shared?: boolean;
}

/**
 * The fields a LOCAL edit of an agent may change. It deliberately has no call
 * settings: no verb edits those in this build, and `withRestamp` re-approves
 * only what this patch can express.
 */
export type AgentIdentityPatch = Partial<Pick<AgentInput, 'title' | 'prompt' | 'model' | 'effort' | 'learning' | 'whiteboard' | 'photo'>>;

/**
 * Private by default: an agent file holds a prompt, so it never reaches the team
 * brain unless shared. Its OWN block, never appended to the automations base
 * list, because a base wildcard appended below existing share negations makes
 * `negationIsEffective` report every one of them as broken.
 */
export const AGENTS_GITIGNORE_ENTRIES = ['agents/*.md'];
export const AGENTS_GITIGNORE_ENTRIES_ROOT = ['_dream_context/agents/*.md'];

/** The negation that shares ONE agent file (brain-relative `.gitignore`). */
export function sharedAgentNegations(slug: string): string[] {
  return [`!agents/${slug}.md`];
}

/** The negation that shares ONE agent file (project-root `.gitignore`). */
export function sharedAgentNegationsRoot(slug: string): string[] {
  return [`!_dream_context/agents/${slug}.md`];
}
