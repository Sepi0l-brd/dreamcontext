import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Window control: how a chat's own agent drives the chat surface it is drawn in — open a
 * chat, put two side by side, switch a tab's mode or model, focus or close a tab.
 *
 * NO NEW SOCKET, the Assistant relay's shape (`assistant/relay.ts`) scoped to ONE chat. Every
 * project chat spawn gets a token of its own in its env (`DREAMCONTEXT_WINDOW_TOKEN`); the CLI
 * (`dreamcontext window …`) posts a verb with it, and the server sends the verb DOWN that
 * chat's own WebSocket as a `_meta{subtype:'window_command'}` frame. The pane holding the chat
 * runs it against its own surface and answers UP the same socket. So a verb can only ever
 * reach the window that is showing the chat that asked: no window registry, no vault lookup,
 * and a token from another chat (or another project) names another socket, never this one.
 *
 * A token dies with its chat process. A socket that is gone (the window closed, the phone
 * slept) answers `no_window` at once; one that never answers, after {@link WINDOW_TIMEOUT_MS}.
 */

export const WINDOW_TIMEOUT_MS = 20_000;
export const WINDOW_TOKEN_HEADER = 'x-dreamcontext-window-token';

export type WindowResult = { ok: true; result: unknown } | { ok: false; error: string };

export interface WindowChannel {
  /** Send one `_meta` frame down the chat's CURRENT socket; false when none is open. */
  send: (frame: Record<string, unknown>) => boolean;
}

interface Pending {
  token: string;
  resolve: (r: WindowResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

const channels = new Map<string, WindowChannel>();
const pending = new Map<string, Pending>();
let baseUrl = '';

/** The loopback URL the CLI posts to, learned once the server is listening. */
export function setWindowControlBase(url: string): void {
  if (/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) baseUrl = url;
}

/**
 * Mint a token for one chat process. Returns its env (empty when the server's port is not
 * known yet, so a chat never gets a URL that points nowhere) and the release to run on exit.
 */
export function mintWindowToken(channel: WindowChannel): { env: Record<string, string>; token: string; release: () => void } {
  const token = randomBytes(24).toString('hex');
  channels.set(token, channel);
  const release = () => {
    channels.delete(token);
    for (const [id, p] of [...pending]) if (p.token === token) settle(id, { ok: false, error: 'no_window' });
  };
  const env: Record<string, string> = baseUrl ? { DREAMCONTEXT_WINDOW_URL: baseUrl, DREAMCONTEXT_WINDOW_TOKEN: token } : {};
  return { env, token, release };
}

/** The channel behind a token, compared in constant time; null for anything unknown. */
export function channelFor(token: unknown): string | null {
  if (typeof token !== 'string' || !/^[0-9a-f]{48}$/.test(token)) return null;
  const given = Buffer.from(token);
  for (const known of channels.keys()) {
    const k = Buffer.from(known);
    if (k.length === given.length && timingSafeEqual(k, given)) return known;
  }
  return null;
}

function settle(id: string, r: WindowResult): boolean {
  const p = pending.get(id);
  if (!p) return false;
  clearTimeout(p.timer);
  pending.delete(id);
  p.resolve(r);
  return true;
}

/** Send one verb down the token's chat socket and wait for the window's answer. */
export function sendWindowCommand(
  token: string,
  verb: string,
  args: Record<string, unknown>,
  opts: { timeoutMs?: number } = {},
): Promise<WindowResult> {
  const channel = channels.get(token);
  if (!channel) return Promise.resolve({ ok: false, error: 'no_window' });
  const id = randomBytes(16).toString('hex');
  return new Promise<WindowResult>((resolve) => {
    const timer = setTimeout(() => settle(id, { ok: false, error: 'no_window' }), opts.timeoutMs ?? WINDOW_TIMEOUT_MS);
    timer.unref?.();
    pending.set(id, { token, resolve, timer });
    if (!channel.send({ subtype: 'window_command', id, verb, args })) settle(id, { ok: false, error: 'no_window' });
  });
}

/** The window's answer, accepted only from the socket of the chat the command went to. */
export function deliverWindowResult(token: string, id: unknown, r: WindowResult): boolean {
  if (typeof id !== 'string') return false;
  const p = pending.get(id);
  if (!p || p.token !== token) return false;
  return settle(id, r);
}

/** Test seam. */
export function resetWindowControl(): void {
  for (const id of [...pending.keys()]) settle(id, { ok: false, error: 'no_window' });
  channels.clear();
  baseUrl = '';
}
