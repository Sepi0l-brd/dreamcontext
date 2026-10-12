/**
 * "Talk to it": open a NEW Chat conversation with one agent, from anywhere (the Agents page's
 * profile, a roster card). Picking an agent in Chat has always opened a new conversation; this
 * is the same act started from outside the composer.
 *
 * TWO HOPS, TWO EVENT NAMES, on purpose:
 *  1. {@link requestTalkToAgent} rings {@link TALK_TO_AGENT_REQUEST_EVENT} on the WINDOW, because
 *     its callers hold no bus. Every mounted project hears that, so `ProjectInstance` answers it
 *     only in the ACTIVE instance (a hidden one is `inert`; the click came from the visible one).
 *  2. That instance re-emits {@link TALK_TO_AGENT_EVENT} on its own BUS, where its always-mounted
 *     `AgentSurface` listens (`useInstanceEvent(TALK_TO_AGENT_EVENT, …)`). On the bus, never the
 *     window: two surfaces that both heard it would both start a chat.
 *
 * The surface sets `accepted` synchronously once it has taken the request (it may still be
 * starting Claude), so the sender knows to stop asking. A surface that is switched off, or a
 * browser build with no Chat, never accepts, and the promise resolves `false` so the caller can
 * say so instead of a silent no-op.
 */
export const TALK_TO_AGENT_REQUEST_EVENT = 'dreamcontext-talk-to-agent-request';
export const TALK_TO_AGENT_EVENT = 'dreamcontext-talk-to-agent';

/** What travels on both hops. `accepted` is the surface's synchronous ACK. */
export interface TalkToAgentDetail {
  slug: string;
  accepted: boolean;
}

/** How long the request keeps asking: the surface subscribes a beat after a fresh mount. */
export const TALK_RETRY_MS = 250;
export const TALK_ATTEMPTS = 8;

const AGENT_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Ring the window once; true when some surface took it. */
function askOnce(slug: string): boolean {
  const detail: TalkToAgentDetail = { slug, accepted: false };
  window.dispatchEvent(new CustomEvent<TalkToAgentDetail>(TALK_TO_AGENT_REQUEST_EVENT, { detail }));
  return detail.accepted;
}

/**
 * Ask the visible project's Chat to open a new conversation with `slug`. Resolves `true` once a
 * surface ACKs, `false` for an invalid slug or when nothing took it within the bound.
 */
export function requestTalkToAgent(slug: string): Promise<boolean> {
  if (typeof window === 'undefined' || typeof slug !== 'string' || !AGENT_SLUG_RE.test(slug)) {
    return Promise.resolve(false);
  }
  return new Promise<boolean>((resolve) => {
    let attempts = 0;
    const ask = () => {
      attempts += 1;
      if (askOnce(slug)) { resolve(true); return; }
      if (attempts >= TALK_ATTEMPTS) { resolve(false); return; }
      window.setTimeout(ask, TALK_RETRY_MS);
    };
    ask();
  });
}

/**
 * The instance half of hop 2, kept here so the bridge in `ProjectInstance` stays a one-liner and
 * the ACK copy-back is testable: re-emit on `bus`, then hand the surface's answer back to the
 * window's detail.
 */
export function forwardTalkToAgent(bus: EventTarget, incoming: unknown): void {
  if (!incoming || typeof incoming !== 'object') return;
  const req = incoming as Partial<TalkToAgentDetail>;
  if (typeof req.slug !== 'string' || !AGENT_SLUG_RE.test(req.slug) || req.accepted === true) return;
  const detail: TalkToAgentDetail = { slug: req.slug, accepted: false };
  bus.dispatchEvent(new CustomEvent<TalkToAgentDetail>(TALK_TO_AGENT_EVENT, { detail }));
  if (detail.accepted) req.accepted = true;
}
