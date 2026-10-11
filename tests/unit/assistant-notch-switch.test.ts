/**
 * The notch's off switch BEFORE an assistant exists (owner, 2026-10-11: the notifications-only
 * notch is not for everyone). `enabled` in config.json is that switch until the assistant is
 * created; the shell reads it in `notch_wanted` (desktop/src-tauri/src/assistant.rs).
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { Readable } from 'node:stream';
import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';

const HOME = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os');
  const h = fs.mkdtempSync(`${os.tmpdir()}/assistant-notch-switch-home-`);
  process.env.HOME = h;
  return h;
});

const home = await import('../../src/lib/assistant/home.js');
const routes = await import('../../src/server/routes/assistant.js');

function makeRes() {
  let status = 0;
  let body: Record<string, unknown> = {};
  const res = {
    writableEnded: false,
    writeHead(code: number) { status = code; },
    setHeader() {},
    end(data?: string) { res.writableEnded = true; try { body = JSON.parse(String(data)); } catch { body = {}; } },
  };
  return { res: res as unknown as ServerResponse, status: () => status, body: () => body };
}

function ownerReq(method: string, url: string, body?: unknown): IncomingMessage {
  return Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), {
    method, url,
    headers: { host: '127.0.0.1:4173' },
    socket: { remoteAddress: '127.0.0.1' },
  }) as unknown as IncomingMessage;
}

async function status() {
  const r = makeRes();
  await routes.handleAssistantStatus(ownerReq('GET', '/api/assistant/status'), r.res);
  return r.body();
}

async function setProfile(patch: unknown) {
  const r = makeRes();
  await routes.handleAssistantProfileSet(ownerReq('POST', '/api/assistant/profile', patch), r.res);
  return { status: r.status(), body: r.body() };
}

describe('notchOnlyPatch', () => {
  it('accepts exactly { enabled }', () => {
    expect(home.notchOnlyPatch({ enabled: false })).toEqual({ enabled: false });
    expect(home.notchOnlyPatch({ enabled: true })).toEqual({ enabled: true });
  });
  it('refuses anything else or anything more', () => {
    expect(home.notchOnlyPatch({})).toBeNull();
    expect(home.notchOnlyPatch({ enabled: 'no' })).toBeNull();
    expect(home.notchOnlyPatch({ enabled: false, name: 'Nova' })).toBeNull();
    expect(home.notchOnlyPatch({ autonomy: 'bypass' })).toBeNull();
    expect(home.notchOnlyPatch(null)).toBeNull();
  });
});

describe('no assistant: the switch turns the notifications-only notch off and on', () => {
  beforeAll(() => { process.env.DREAMCONTEXT_DESKTOP = '1'; });

  it('is on by default', async () => {
    const st = await status();
    expect(st.exists).toBe(false);
    expect(st.notch).toBe(true);
  });

  it('switches off, and status says so — without creating the assistant', async () => {
    const r = await setProfile({ enabled: false });
    expect(r.status).toBe(200);
    expect(home.readAssistantConfig(HOME)?.enabled).toBe(false);
    expect(home.assistantExists(HOME)).toBe(false);
    expect(existsSync(home.assistantContextRoot(HOME))).toBe(false);
    const st = await status();
    expect(st.exists).toBe(false);
    expect(st.config).toBeNull();
    expect(st.notch).toBe(false);
  });

  it('still refuses every other setting until the assistant exists', async () => {
    const r = await setProfile({ autonomy: 'bypass' });
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('no_assistant');
    expect((await setProfile({ enabled: true, name: 'Nova' })).status).toBe(404);
  });

  it('a newly created assistant starts on, even after the notch was switched off', async () => {
    expect(home.readAssistantConfig(HOME)?.enabled).toBe(false);
    await routes.createAssistant({ name: 'Nova' }, async (_args, cwd) => {
      // The fake `init`: scaffold the hidden vault the real one would.
      const { mkdirSync } = await import('node:fs');
      mkdirSync(`${cwd}/_dream_context/core`, { recursive: true });
    }, HOME);
    expect(home.assistantExists(HOME)).toBe(true);
    expect(home.readAssistantConfig(HOME)?.enabled).toBe(true);
    expect((await status()).notch).toBe(true);
  });

  it('re-running create on an existing assistant keeps the owner\'s off switch', async () => {
    home.writeAssistantConfig({ enabled: false }, HOME);
    await routes.createAssistant({ name: 'Nova' }, async () => { throw new Error('must not re-init'); }, HOME);
    expect(home.readAssistantConfig(HOME)?.enabled).toBe(false);
  });
});
