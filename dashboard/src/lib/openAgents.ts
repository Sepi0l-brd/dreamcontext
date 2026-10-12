/**
 * "Open the Agents page": the one request every surface uses to land on an agent (its profile)
 * or on the create flow, from wherever it is (the Automations page's on-call starter, a task's
 * Assign to agent composer, a chat or whiteboard picker's "Manage agents").
 *
 * WHY A WINDOW EVENT AND NOT THE INSTANCE BUS. The callers are deep components and plain
 * helpers that hold no bus, and the contract (`requestOpenAgents(focus)`) takes none. The window
 * hears it in every mounted project, so the LISTENER does the scoping: `ProjectInstance` acts on
 * it only in the ACTIVE instance. That is exact, not a guess: a hidden instance is `inert`, so a
 * click can only ever come from the project the user is looking at.
 *
 * `nonce` is stamped by the listener, never by the caller, so two requests for the same agent
 * still read as two (the page re-opens the profile the second time too).
 */
export const OPEN_AGENTS_EVENT = 'dreamcontext-open-agents';

/** What the Agents page is asked to show: one agent's profile, the create flow, or the roster. */
export interface AgentsFocus {
  slug?: string;
  create?: boolean;
  /** With `create`: the board the new agent calls home, preset in the create dialog, so "New
   *  agent" on a board makes that board's agent in one step. Ignored without `create`. */
  whiteboard?: string;
  nonce: number;
}

/** The request as it travels on the window: the focus minus the listener's nonce. */
export type OpenAgentsDetail = Omit<AgentsFocus, 'nonce'>;

/** The agent slug shape the server accepts (`isSafeAutomationSlug`): lowercase words joined
 *  by single dashes. Anything else is dropped rather than handed to the page. */
const AGENT_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The board slug shape the server accepts (`isValidWhiteboardSlug` in `src/lib/whiteboards/validate.ts`). */
const BOARD_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Normalise one incoming request. Total: a malformed detail becomes the plain roster (`{}`), never
 * a throw, because an event payload is whatever the dispatcher put there.
 */
export function readOpenAgentsDetail(detail: unknown): OpenAgentsDetail {
  if (!detail || typeof detail !== 'object') return {};
  const { slug, create, whiteboard } = detail as { slug?: unknown; create?: unknown; whiteboard?: unknown };
  const out: OpenAgentsDetail = {};
  if (typeof slug === 'string' && slug.length <= 100 && AGENT_SLUG_RE.test(slug)) out.slug = slug;
  if (create === true) {
    out.create = true;
    if (typeof whiteboard === 'string' && BOARD_SLUG_RE.test(whiteboard)) out.whiteboard = whiteboard;
  }
  return out;
}

/** Ask the visible project to open the Agents page, on `focus`. */
export function requestOpenAgents(focus: Omit<AgentsFocus, 'nonce'>): void {
  if (typeof window === 'undefined') return;
  const detail: OpenAgentsDetail = readOpenAgentsDetail(focus);
  window.dispatchEvent(new CustomEvent<OpenAgentsDetail>(OPEN_AGENTS_EVENT, { detail }));
}
