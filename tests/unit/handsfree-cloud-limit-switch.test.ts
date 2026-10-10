/**
 * AC17, last clause: on the hands-free CLOUD a limit rejection switches accounts.
 *
 * Drives the REAL `startChatSession` in cloud mode (DREAMCONTEXT_CLOUD=1) with a scripted
 * child, like chat-account-switch-hold.test.ts does on the laptop. What is real and what is
 * scripted:
 *   - the account register, `resolveConfigDir`, the chooser and the decision are real;
 *   - every account's health comes from its OWN sandbox's `claude auth status --json` (D13),
 *     answered by the scripted child per `CLAUDE_CONFIG_DIR`;
 *   - usage readings go through the worker op (in process here; dcuser in a codespace);
 *   - each sandbox is 0500 with no `.claude.json`: the D13 barrier (dcserver never writes into
 *     dcuser's 0700 sandbox), which is what made the laptop's probe path read every cloud
 *     account as unreadable.
 * The client half (respawn on the named account, resubmit the held turn) is pinned against the
 * source in chat-account-switch-restart.test.ts; here the respawn is the same
 * `startChatSession` call the client's new socket makes, with `account` set.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

class FakeChild extends EventEmitter {
  stdin = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
  pid = 4246;
}

const state = vi.hoisted(() => ({
  spawned: [] as Array<{ child: unknown; args: string[]; env: Record<string, string> }>,
  /** Sandbox dirs whose `claude auth status` answers signed in. */
  signedIn: new Set<string>(),
  rejections: {} as Record<string, { until: number; window: string }>,
  recorded: [] as string[],
}));

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return {
    ...real,
    spawn: vi.fn((_file: string, args: string[], opts: { env?: Record<string, string> }) => {
      const child = new FakeChild();
      const env = opts?.env ?? {};
      state.spawned.push({ child, args, env });
      const script = args[args.length - 1] ?? '';
      if (script === 'claude auth status --json') {
        setTimeout(() => {
          child.stdout.emit('data', Buffer.from(JSON.stringify({ loggedIn: state.signedIn.has(env.CLAUDE_CONFIG_DIR ?? '') })));
          child.emit('close', 0);
        }, 5);
      } else if (script.includes('/usage')) {
        // A usage probe that prints no report.
        setTimeout(() => child.emit('close', 0), 5);
      }
      return child as unknown as import('node:child_process').ChildProcess;
    }),
  };
});
vi.mock('../../src/lib/claude-limit-rejections.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/claude-limit-rejections.js')>();
  return {
    ...real,
    readAccountRejections: vi.fn(() => state.rejections),
    recordAccountRejection: vi.fn((id: string) => {
      state.recorded.push(id);
      const r = { until: Date.now() + 3_600_000, window: 'weekly' };
      state.rejections = { ...state.rejections, [id]: r };
      return { ...r, at: Date.now(), estimated: false };
    }),
  };
});

const { startChatSession } = await import('../../src/server/routes/agent-chat.js');
const { writeClaudeAccounts, sandboxDirFor } = await import('../../src/lib/claude-accounts.js');
const { resetClaudeAuthCache } = await import('../../src/lib/claude-auth.js');
const { setCloudPhaseSource, setCloudTripRootsSource, setSameUidWorkerForTests } = await import('../../src/server/cloud-mode.js');
const { setWorkerInProcessForTests } = await import('../../src/server/cloud-worker.js');
const { _resetChatRegistry } = await import('../../src/lib/assistant/chat-registry.js');

class FakeWs extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  send = vi.fn();
  close = vi.fn();
}

const saved: Record<string, string | undefined> = {};
let home: string;
let project: string;

/** A registered account. `laptopZero` = the laptop's account #0 (configDir null): the cloud
 *  still runs it on its own sandbox (D13). */
function account(id: string, preferred = false, laptopZero = false) {
  return {
    id, accountUuid: `uuid-${id}`, email: `${id}@example.invalid`, organizationUuid: 'org', organizationName: 'Acme',
    tier: 'max', configDir: laptopZero ? null : join(home, '.dreamcontext', 'claude-accounts', id), preferred,
  };
}

/** The cloud's register and sandboxes: `signedIn` ids answer `loggedIn: true`. */
function cloudAccounts(list: ReturnType<typeof account>[], signedIn: string[]): void {
  writeClaudeAccounts(list, home);
  for (const a of list) {
    const dir = sandboxDirFor(a.id, home);
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o500); // dcuser's: the server may not write into it
    if (signedIn.includes(a.id)) state.signedIn.add(dir);
  }
  process.env.DREAMCONTEXT_CLOUD = '1';
}

type Spawned = (typeof state.spawned)[number];

function open(account = '', initialPrompt = ''): { ws: FakeWs; chat: () => Spawned | undefined } {
  const ws = new FakeWs();
  const before = state.spawned.length;
  startChatSession(ws as unknown as import('ws').WebSocket, project, {
    bypass: false, sessionId: '', resumeId: '', model: '', effort: '', mode: 'basic', account, initialPrompt, deferPrompt: false,
  });
  return { ws, chat: () => state.spawned.slice(before).find((s) => s.args.some((a) => /(^|&& )exec claude /.test(a))) };
}

const emit = (s: Spawned, frame: unknown) =>
  (s.child as FakeChild).stdout.emit('data', Buffer.from(`${JSON.stringify(frame)}\n`));

const switchMetas = (ws: FakeWs): Array<Record<string, unknown>> => ws.send.mock.calls
  .map(([raw]) => { try { return JSON.parse(String(raw)); } catch { return null; } })
  .filter((f) => f?.type === '_meta' && f.subtype === 'account_switch');

/** The API's refusal as the CLI streams it (claude-limit-signal.ts), then the turn's end. */
const refusal = {
  type: 'assistant',
  message: { model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text: "You've hit your weekly limit · resets Oct 6 at 7am" }] },
  error: 'rate_limit', isApiErrorMessage: true, apiErrorStatus: 429,
  quotaLimits: { status: 'rejected', resetsAt: Math.floor(Date.now() / 1000) + 3600, rateLimitType: 'seven_day' },
};
const result = { type: 'result', subtype: 'success', is_error: false, result: '', session_id: 'conv-1' };

/** A turn on the session's account is refused; resolves with the settled switch frame. */
async function refuseTurn(): Promise<{ ws: FakeWs; first: Spawned; meta: Record<string, unknown> }> {
  const { ws, chat } = open('', 'build the thing');
  const first = chat();
  expect(first, 'the chat spawned').toBeDefined();
  emit(first!, refusal);
  emit(first!, result);
  await vi.waitFor(() => expect(switchMetas(ws).some((m) => m.turnInFlight === false || m.switched === false)).toBe(true), { timeout: 5000 });
  const metas = switchMetas(ws);
  return { ws, first: first!, meta: metas[metas.length - 1] };
}

beforeEach(() => {
  for (const k of ['HOME', 'DREAMCONTEXT_CLOUD', 'DREAMCONTEXT_DESKTOP']) saved[k] = process.env[k];
  home = mkdtempSync(join(tmpdir(), 'hf-limit-switch-'));
  process.env.HOME = home;
  delete process.env.DREAMCONTEXT_CLOUD;
  delete process.env.DREAMCONTEXT_DESKTOP;
  project = join(home, 'proj');
  mkdirSync(project, { recursive: true });
  state.spawned.length = 0;
  state.signedIn.clear();
  state.rejections = {};
  state.recorded = [];
  _resetChatRegistry();
  resetClaudeAuthCache();
  setCloudPhaseSource(() => 'active');
  setCloudTripRootsSource(() => [project]);
  setWorkerInProcessForTests(true);
  setSameUidWorkerForTests(false);
});

afterEach(() => {
  setWorkerInProcessForTests(false);
  setCloudPhaseSource(() => 'sealed');
  setCloudTripRootsSource(() => []);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetClaudeAuthCache();
  for (const id of ['alpha', 'beta', 'gamma']) { try { chmodSync(sandboxDirFor(id, home), 0o700); } catch { /* not made */ } }
  rmSync(home, { recursive: true, force: true });
});

describe('cloud: a limit rejection switches accounts (AC17)', () => {
  it('a refused turn on A continues on B: B is named, A is not reused, and the respawn runs on B\'s sandbox', async () => {
    cloudAccounts([account('alpha', true), account('beta')], ['alpha', 'beta']);
    const { first, meta } = await refuseTurn();
    // The session really ran on A's sandbox.
    expect(first.env.CLAUDE_CONFIG_DIR).toBe(sandboxDirFor('alpha', home));
    expect(meta).toMatchObject({ switched: true, reason: 'limit_hit', accountId: 'beta', fromAccountId: 'alpha' });
    expect(meta.pendingTexts).toEqual(['build the thing']);
    // The refusal is written down against A, so no later decision trusts it while limited.
    expect(state.recorded).toEqual(['alpha']);
    expect((meta.rejected as Array<{ id: string }>).map((r) => r.id)).toContain('alpha');

    // The client's respawn: a new socket naming B.
    const next = open('beta').chat();
    expect(next?.env.CLAUDE_CONFIG_DIR).toBe(sandboxDirFor('beta', home));
  });

  it('the laptop\'s account #0 is identified on the cloud too (its sandbox, not the real HOME)', async () => {
    cloudAccounts([account('alpha', true, true), account('beta')], ['alpha', 'beta']);
    const { first, meta } = await refuseTurn();
    expect(first.env.CLAUDE_CONFIG_DIR).toBe(sandboxDirFor('alpha', home));
    expect(state.recorded).toEqual(['alpha']);
    expect(meta).toMatchObject({ switched: true, accountId: 'beta', fromAccountId: 'alpha' });
  });

  it('a signed-out cloud account is never the target: the switch skips it for a signed-in one', async () => {
    cloudAccounts([account('alpha', true), account('beta'), account('gamma')], ['alpha', 'gamma']);
    const { meta } = await refuseTurn();
    expect(meta).toMatchObject({ switched: true, accountId: 'gamma' });
    expect(meta.rejected).toContainEqual({ id: 'beta', why: 'needs to sign in again' });
  });

  it('with only a signed-out account left, nothing switches', async () => {
    cloudAccounts([account('alpha', true), account('beta')], ['alpha']);
    const { ws } = await refuseTurn();
    expect(switchMetas(ws).some((m) => m.switched === true)).toBe(false);
    expect(switchMetas(ws).at(-1)).toMatchObject({ switched: false, reason: 'all_exhausted' });
  });
});
