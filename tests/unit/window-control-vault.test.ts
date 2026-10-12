/**
 * `dreamcontext window …` from a chat tab never needs a vault. The desktop server runs in
 * launcher mode (no vault pinned) and the CLI sends no vault header: the token alone names the
 * chat socket. A vault-bound gate on `/api/window` answered every verb `no_vault`, so this drives
 * the real router + vault gate + window handler with exactly a chat tab's env.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildRouter, apiVaultGate, isVaultAgnostic } from '../../src/server/index.js';
import { sendError } from '../../src/server/middleware.js';
import { WINDOW_VERBS } from '../../src/server/routes/window-control.js';
import { mintWindowToken, deliverWindowResult, setWindowControlBase, resetWindowControl } from '../../src/lib/window-control.js';
import { callWindow } from '../../src/cli/commands/window.js';

let server: Server;
let base: string;

beforeEach(async () => {
  resetWindowControl();
  const router = buildRouter();
  // The server's /api dispatch, launcher mode: no pinned context root.
  server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const match = router.match(req.method || 'GET', url.pathname);
    if (!match) { sendError(res, 404, 'not_found', url.pathname); return; }
    const gate = apiVaultGate(req, url.pathname, null);
    if (!gate.ok) { sendError(res, gate.status, gate.error, gate.message); return; }
    await match.handler(req, res, match.params, gate.root as string);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  setWindowControlBase(base);
});

afterEach(async () => {
  resetWindowControl();
  await new Promise<void>((r) => server.close(() => r()));
});

describe('window control from a chat tab, with no vault pinned or named', () => {
  it('`window state` reaches the window that shows the chat', async () => {
    const chat = mintWindowToken({
      send: (f) => {
        setImmediate(() => deliverWindowResult(chat.token, f.id, { ok: true, result: { panes: [{ pane: 1, tabs: [] }] } }));
        return true;
      },
    });
    // Exactly what a chat tab's agent carries; no vault anywhere.
    const env = { ...chat.env, DREAMCONTEXT_DESKTOP: '1', DREAMCONTEXT_CHAT_TAB: '1', DREAMCONTEXT_TAB_SESSION: 'tab-session-1' };
    const r = await callWindow('state', {}, env);
    expect(r.body.error).toBeUndefined();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, result: { panes: [{ pane: 1, tabs: [] }] } });
  });

  it('`window new --mode plan --prompt …` is sent down the chat socket, not refused for a vault', async () => {
    const frames: Array<Record<string, unknown>> = [];
    const chat = mintWindowToken({
      send: (f) => {
        frames.push(f);
        setImmediate(() => deliverWindowResult(chat.token, f.id, { ok: true, result: { tab: 'conv-new', placed: 'tab' } }));
        return true;
      },
    });
    const r = await callWindow('new', { mode: 'plan', prompt: 'Planı çıkar: ödeme akışı, şirket kuralları' }, chat.env);
    expect(r.status).toBe(200);
    expect(frames[0]).toMatchObject({ verb: 'new', args: { mode: 'plan', prompt: 'Planı çıkar: ödeme akışı, şirket kuralları' } });
  });

  it('every window verb is vault-agnostic', () => {
    for (const verb of WINDOW_VERBS) expect(isVaultAgnostic(`/api/window/${verb}`)).toBe(true);
  });

  it('a vault-bound route still refuses, and the refusal says what was missing', async () => {
    const res = await fetch(`${base}/api/tasks`);
    const body = await res.json() as { error: string; message: string };
    expect(res.status).toBe(400);
    expect(body.error).toBe('no_vault');
    expect(body.message).toContain('/api/tasks');
    expect(body.message).toContain('x-dreamcontext-vault');
  });
});
