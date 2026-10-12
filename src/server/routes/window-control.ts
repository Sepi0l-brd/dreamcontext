import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseJsonBody, sendError, sendJson } from '../middleware.js';
import { isLoopback } from './agent-spawn-shared.js';
import { sanitizeModel } from '../../lib/claude-args.js';
import { WINDOW_TOKEN_HEADER, channelFor, sendWindowCommand } from '../../lib/window-control.js';

/**
 * `/api/window/:verb` — a project chat's agent drives the chat surface it is drawn in
 * (`dreamcontext window …`, lib/window-control.ts). Loopback only, and only with the token
 * the chat's own spawn env carries; the verb then travels down THAT chat's socket, so it can
 * only act on the window showing the chat that asked.
 *
 * The server validates every argument; the window resolves tabs and refuses what its own
 * state forbids (an unknown tab, closing a busy chat without --force).
 */

type Params = Record<string, string>;

export const WINDOW_VERBS = ['state', 'new', 'split', 'join', 'focus', 'mode', 'model', 'effort', 'send', 'close'] as const;
export type WindowVerb = typeof WINDOW_VERBS[number];

const TAB_RE = /^[A-Za-z0-9_-]{1,80}$/;
const MODES = ['basic', 'plan', 'develop'] as const;
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const MAX_TEXT = 100_000;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** A tab id, when given: the conversation id `state` lists. Omitted = the calling chat. */
function tabArg(b: Record<string, unknown>, key = 'tab'): string | undefined | null {
  const v = str(b[key]);
  if (v === undefined) return undefined;
  return TAB_RE.test(v) ? v : null;
}

/** The verb's arguments, or the refusal to print. Exported for tests. */
export function pickWindowArgs(verb: WindowVerb, b: Record<string, unknown>): Record<string, unknown> | string {
  const tab = tabArg(b);
  if (tab === null) return 'tab must be a tab id from `dreamcontext window state`';
  switch (verb) {
    case 'state':
      return {};
    case 'new': {
      const mode = str(b.mode) ?? 'basic';
      if (!(MODES as readonly string[]).includes(mode)) return `mode must be one of ${MODES.join(' | ')}`;
      const model = str(b.model);
      if (model && !sanitizeModel(model)) return 'model is not a model id';
      const effort = str(b.effort);
      if (effort && !(EFFORTS as readonly string[]).includes(effort)) return `effort must be one of ${EFFORTS.join(' | ')}`;
      const prompt = typeof b.prompt === 'string' ? b.prompt : '';
      if (prompt.length > MAX_TEXT) return 'prompt is too long';
      const terminal = b.terminal === true;
      if (terminal && (prompt || model || effort || mode !== 'basic')) return 'a terminal tab takes no prompt, mode, model or effort';
      return { mode, model: model ?? '', effort: effort ?? '', prompt, split: b.split === true, terminal };
    }
    case 'split':
      return { tab };
    case 'join': {
      const into = tabArg(b, 'into');
      if (!into) return 'name the tab to join with --into <tab>';
      return { tab, into };
    }
    case 'focus':
      if (!tab) return 'name the tab to focus';
      return { tab };
    case 'mode': {
      const mode = str(b.mode);
      if (!mode || !(MODES as readonly string[]).includes(mode)) return `mode must be one of ${MODES.join(' | ')}`;
      return { tab, mode };
    }
    case 'model': {
      const model = str(b.model);
      if (!model || !sanitizeModel(model)) return 'model is not a model id';
      return { tab, model };
    }
    case 'effort': {
      const level = str(b.level);
      if (!level || !(EFFORTS as readonly string[]).includes(level)) return `effort must be one of ${EFFORTS.join(' | ')}`;
      return { tab, level };
    }
    case 'send': {
      const text = typeof b.text === 'string' ? b.text : '';
      if (!tab) return 'name the tab to send to';
      if (!text.trim()) return 'text is required';
      if (text.length > MAX_TEXT) return 'text is too long';
      return { tab, text };
    }
    case 'close':
      if (!tab) return 'name the tab to close';
      return { tab, force: b.force === true };
  }
}

/** POST /api/window/:verb */
export async function handleWindowCommand(req: IncomingMessage, res: ServerResponse, params: Params): Promise<void> {
  if (!isLoopback(req)) { sendError(res, 403, 'window_local_only', 'Window control is only reachable from this machine.'); return; }
  const token = channelFor(req.headers[WINDOW_TOKEN_HEADER]);
  if (!token) { sendError(res, 401, 'not_a_chat', 'only an agent running in a dreamcontext chat can drive its window (or that chat has ended)'); return; }
  const verb = params.verb as WindowVerb;
  if (!(WINDOW_VERBS as readonly string[]).includes(verb)) { sendError(res, 404, 'unknown_verb', `No window verb "${params.verb}". Verbs: ${WINDOW_VERBS.join(', ')}.`); return; }
  const args = pickWindowArgs(verb, (await parseJsonBody(req)) ?? {});
  if (typeof args === 'string') { sendError(res, 400, 'invalid_args', args); return; }
  const r = await sendWindowCommand(token, verb, args);
  if (r.ok) { sendJson(res, 200, { ok: true, result: r.result }); return; }
  sendJson(res, r.error === 'no_window' ? 409 : 200, {
    ok: false,
    error: r.error,
    ...(r.error === 'no_window' ? { message: 'no window is showing this chat right now (it is closed, or the app is in the background on a phone)' } : {}),
  });
}
