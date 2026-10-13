// The 2026-10-12 field report (a separate vault + 3 linked repos, ~60 worktrees, a 2.4 GB trip):
// each test pins one defect from it. Every test injects its own HOME.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { oncePerUpload } from '../../src/server/routes/handsfree-cloud.js';
import { describeWork, largeTripWarning, LARGE_TRIP_BYTES, notHomeMessage, sweepTrips, type HandsfreeEnv } from '../../src/lib/handsfree/orchestrator.js';
import { liveChatMirrorDir, processTurnControl, readLiveChatMirrors } from '../../src/lib/handsfree/turns.js';
import { handsfreeSpawnRefusal, isHandsfreeCommand } from '../../src/lib/peer-delivery.js';
import { beginGoing } from '../../src/lib/handsfree/trip-state.js';
import { finishTail, redactSecrets } from '../../dashboard/src/components/sleepy/chat/runReport.js';
import { markTurnStarted, registerLiveChat, setLiveChatMirror, unregisterLiveChat, type LiveChatEntry } from '../../src/server/routes/agent-chat-live.js';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'hf-field-')); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('#7: a retried receive joins the first one instead of finding its upload consumed', () => {
  it('runs the work once per upload id, shares its result and its error, keys by route + root', async () => {
    let runs = 0;
    let release!: (v: Record<string, unknown>) => void;
    const work = () => { runs++; return new Promise<Record<string, unknown>>((r) => { release = r; }); };
    const first = oncePerUpload(['git', 't-1', 'r-a'], { uploadId: 'up-111111111' }, work);
    const retry = oncePerUpload(['git', 't-1', 'r-a'], { uploadId: 'up-111111111' }, work); // the forwarder timed out
    release({ ok: true, snapshotId: 'x' });
    expect(await first).toEqual({ ok: true, snapshotId: 'x' });
    expect(await retry).toEqual({ ok: true, snapshotId: 'x' });
    expect(await oncePerUpload(['git', 't-1', 'r-a'], { uploadId: 'up-111111111' }, work)).toEqual({ ok: true, snapshotId: 'x' });
    expect(runs).toBe(1);
    const failing = () => Promise.reject(new Error('git index-pack failed'));
    await expect(oncePerUpload(['files', 't-1', 'r-a'], { uploadId: 'up-222222222' }, failing)).rejects.toThrow('index-pack');
    await expect(oncePerUpload(['files', 't-1', 'r-a'], { uploadId: 'up-222222222' }, async () => ({ ok: true }))).rejects.toThrow('index-pack');
    // Another root, or no upload at all, is its own work.
    oncePerUpload(['git', 't-1', 'r-b'], { uploadId: 'up-111111111' }, async () => ({ ok: true }));
    expect(runs).toBe(1);
    let plain = 0;
    await oncePerUpload(['git', 't-1', 'r-a'], {}, async () => { plain++; return {}; });
    await oncePerUpload(['git', 't-1', 'r-a'], {}, async () => { plain++; return {}; });
    expect(plain).toBe(2);
  });

  it('a receive WITHOUT an upload is deduped by its request id; a bad id is never cached', async () => {
    let runs = 0;
    const work = async () => { runs++; return { ok: true }; };
    await oncePerUpload(['git', 't-2', 'r-a'], { requestId: 'rq-aaaaaaaaaaaa' }, work);
    await oncePerUpload(['git', 't-2', 'r-a'], { requestId: 'rq-aaaaaaaaaaaa' }, work); // the retry
    expect(runs).toBe(1);
    await oncePerUpload(['git', 't-2', 'r-a'], { requestId: '../../etc', uploadId: 'NOT VALID' }, work);
    await oncePerUpload(['git', 't-2', 'r-a'], { requestId: '../../etc', uploadId: 'NOT VALID' }, work);
    expect(runs).toBe(3);
  });

  it('keeps at most 256 receipts, dropping the oldest', async () => {
    let runs = 0;
    const work = async () => { runs++; return {}; };
    for (let i = 0; i < 300; i++) await oncePerUpload(['cap'], { requestId: `rq-cap-${String(i).padStart(4, '0')}` }, work);
    await oncePerUpload(['cap'], { requestId: 'rq-cap-0299' }, work); // newest: still kept
    expect(runs).toBe(300);
    await oncePerUpload(['cap'], { requestId: 'rq-cap-0000' }, work); // oldest: evicted, runs again
    expect(runs).toBe(301);
  });

  it('warns before a large trip and says how to continue', () => {
    expect(largeTripWarning(LARGE_TRIP_BYTES - 1)).toBeNull();
    expect(largeTripWarning(2.4 * 1024 ** 3)).toMatch(/about 2\.4 GB.*handsfree resume/);
  });
});

describe('#8: failed and finished trips do not keep their uploads', () => {
  it('removes a trip that never sent anything, and only the go/ folder of one that did; the current trip is untouched', () => {
    const trips = join(home, '.dreamcontext', 'handsfree', 'trips');
    const mk = (name: string, files: string[]) => {
      mkdirSync(join(trips, name), { recursive: true });
      for (const f of files) {
        mkdirSync(join(trips, name, f, '..'), { recursive: true });
        writeFileSync(join(trips, name, f), 'x'.repeat(1000));
      }
    };
    mk('t-20261012-7c86311a', []); // empty: interrupted before the snapshot
    mk('t-20261012-876953be', ['go-manifest.json', 'start/r.git.json', 'go/r.bundle']); // never got a journal
    mk('t-20261012-629ab077', ['go-journal.json', 'go/r-072ce68f3e70878e.bundle', 'go/global/x']); // failed mid-upload
    mk('t-20261010-c013ac2a', ['go-journal.json', 'receipt.json', 'backup/f']); // a finished trip, go/ already gone
    mk('t-20261013-aaaaaaaa', ['go-journal.json', 'go/r.bundle']); // the current trip
    mk('t-20261011-bbbbbbbb', ['start/x.json', 'conflicts/a.txt', 'go/r.pack']); // an entry the sweep does not know: never deleted whole
    const env = { home } as HandsfreeEnv;
    const r = sweepTrips(env, 't-20261013-aaaaaaaa');
    expect(r.removed.sort()).toEqual(['t-20261011-bbbbbbbb/go', 't-20261012-629ab077/go', 't-20261012-7c86311a', 't-20261012-876953be']);
    expect(existsSync(join(trips, 't-20261011-bbbbbbbb', 'conflicts', 'a.txt'))).toBe(true);
    expect(r.freedBytes).toBeGreaterThanOrEqual(4000);
    expect(readdirSync(join(trips, 't-20261012-629ab077')).sort()).toEqual(['go-journal.json']);
    expect(existsSync(join(trips, 't-20261010-c013ac2a', 'backup', 'f'))).toBe(true);
    expect(existsSync(join(trips, 't-20261013-aaaaaaaa', 'go', 'r.bundle'))).toBe(true);
  });
});

describe('#4: idle app chats and their MCP servers are not running turns', () => {
  // 500 an idle app chat child (its own group) with MCP servers 510 (npm exec) -> 511 (node);
  // 600 a busy app chat; 700 a claude in a terminal the app does not know (fails closed: running).
  const lsof = ['p500', 'n/v', 'p510', 'n/v', 'p511', 'n/v', 'p600', 'n/v', 'p700', 'n/v/src', ''].join('\n');
  const ps = [
    '  10     1   10 node dreamcontext handsfree go',
    ' 500    20  500 claude -p --input-format stream-json --output-format stream-json',
    ' 510   500  500 npm exec slack-mcp-server',
    ' 511   510  500 node /x/slack-mcp-server/index.js',
    ' 600    20  600 claude -p --input-format stream-json',
    ' 700     1  700 claude',
    '',
  ].join('\n');
  const run = (async (cmd: string) => ({ code: 0, signal: null, stdout: Buffer.from(cmd === 'lsof' ? lsof : ps), stderr: Buffer.alloc(0) })) as never;
  // 700's entry is stale: server 99 wrote it, but pid 700 now belongs to a terminal claude (ppid 1).
  const chats = () => new Map([
    [500, { busy: false, conversationId: 'c-idle', serverPid: 20 }],
    [600, { busy: true, conversationId: 'c-busy', serverPid: 20 }],
    [700, { busy: false, conversationId: 'c-stale', serverPid: 99 }],
  ]);

  it('lists 3 items with their commands, the idle chat not busy, a stale mirror entry (reused pid) ignored', async () => {
    const work = await processTurnControl(run, { self: 10, kill: () => {}, liveChats: chats }).list(['/v']);
    expect(work.map((w) => [w.kind, w.id, w.busy, w.members])).toEqual([
      ['chat', 'c-idle', false, 3], ['chat', 'c-busy', true, 1], ['process', '700', true, 1],
    ]);
    expect(describeWork(work[0])).toBe('pid 500 claude -p --input-format stream-json --output-format stream-json (in /v) + 2 child process(es)');
  });

  it('the idle cut stops only the idle chat group (MCP children included); a full cut stops everything', async () => {
    const sent: number[] = [];
    const kill = (pid: number, sig: NodeJS.Signals | 0) => { if (sig === 0) throw new Error('ESRCH'); sent.push(pid); };
    const scan = processTurnControl(run, { self: 10, kill, sleep: async () => {}, graceMs: 0, liveChats: chats });
    expect(await scan.cut(['/v'], { all: false })).toBe(1);
    expect([...new Set(sent)]).toEqual([-500]);
    sent.length = 0;
    expect(await scan.cut(['/v'], { all: true })).toBe(3);
    expect([...new Set(sent)].sort()).toEqual([-700, -600, -500].sort());
  });

  it('reads only mirrors of a live server whose file name matches', () => {
    const dir = liveChatMirrorDir(home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '111.json'), JSON.stringify({ serverPid: 111, chats: [{ pid: 500, conversationId: 'c', projectRoot: '/v', busy: false }] }));
    writeFileSync(join(dir, '222.json'), JSON.stringify({ serverPid: 222, chats: [{ pid: 600, conversationId: 'd', projectRoot: '/v', busy: false }] }));
    writeFileSync(join(dir, '333.json'), JSON.stringify({ serverPid: 999, chats: [{ pid: 700, conversationId: 'e', projectRoot: '/v', busy: false }] }));
    writeFileSync(join(dir, '444.json'), '{torn');
    const m = readLiveChatMirrors(home, (pid) => pid === 111 || pid === 999);
    expect([...m.keys()]).toEqual([500]);
  });
});

describe('#5: an interrupted go is not a dead end', () => {
  it('names the right next step per phase, never Return for a go', async () => {
    expect(notHomeMessage('going', 't-1')).toMatch(/resume.*abandon/);
    expect(notHomeMessage('going', 't-1')).not.toMatch(/return/i);
    expect(notHomeMessage('away', 't-1')).toMatch(/handsfree return/);
    mkdirSync(join(home, 'v'));
    await beginGoing('t-20261012-629ab077', [{ rootId: 'r-072ce68f3e70878e', path: join(home, 'v') }], home);
    const refusal = handsfreeSpawnRefusal(join(home, 'v'), home)!;
    expect(refusal).toMatch(/going\); a go is in progress or was interrupted: `dreamcontext handsfree resume`/);
    expect(refusal).not.toMatch(/Return first/);
  });

  it('a run card may run exactly one plain `dreamcontext handsfree` command in a locked project', () => {
    expect(isHandsfreeCommand('dreamcontext handsfree go --cut-running')).toBe(true);
    expect(isHandsfreeCommand('dreamcontext handsfree abandon')).toBe(true);
    expect(isHandsfreeCommand('npx dreamcontext handsfree status --json')).toBe(true);
    expect(isHandsfreeCommand('dreamcontext handsfree go; rm -rf ~')).toBe(false);
    expect(isHandsfreeCommand('dreamcontext handsfree go && claude')).toBe(false);
    expect(isHandsfreeCommand('dreamcontext tasks sync')).toBe(false);
    expect(isHandsfreeCommand('dreamcontext handsfree $(id)')).toBe(false);
  });
});

describe('#1: a passphrase printed into a run card never reaches the conversation', () => {
  it('keeps the label and drops the value', () => {
    const tail = '✓ created the codespace\n\n  Phone passphrase (shown ONCE): amber-falcon-lattice-91\n  Change it any time with `dreamcontext handsfree password`.';
    expect(finishTail(tail)).toContain('Phone passphrase (shown ONCE): [redacted by the run card]');
    expect(finishTail(tail)).not.toContain('amber-falcon');
    expect(redactSecrets('New phone passphrase (shown ONCE): x y z')).toBe('New phone passphrase (shown ONCE): [redacted by the run card]');
    expect(redactSecrets('build ok: 3 files')).toBe('build ok: 3 files');
  });

  it('catches the usual ways a secret is printed', () => {
    const R = '[redacted by the run card]';
    expect(redactSecrets('GITHUB_TOKEN: ghp_abcdefghijklmnopqrstuvwx')).toBe(`GITHUB_TOKEN: ${R}`);
    expect(redactSecrets('export GH_TOKEN=abc123')).toBe(`export GH_TOKEN=${R}`);
    expect(redactSecrets('passphrase=hunter2 more')).toBe(`passphrase=${R}`);
    expect(redactSecrets('  "password": "x"')).toBe(`  "password": ${R}`);
    expect(redactSecrets('X-Api-Key: k-123')).toBe(`X-Api-Key: ${R}`);
    expect(redactSecrets('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.x.y')).toBe(`Authorization: Bearer ${R}`);
    expect(redactSecrets('Created token ghp_abcdefghijklmnopqrstuvwx (expires: never)')).toBe(`Created token ${R} (expires: never)`);
  });

  it('keeps the error text the agent needs, and never touches the next line', () => {
    for (const line of [
      'INFO token refresh failed: 401 Unauthorized',
      'Error: invalid token: expected 40 chars',
      'Secret scanning: enabled',
      'Tokens: 1234 used',
      'see https://x.io/token?x=1: foo',
    ]) expect(redactSecrets(line)).toBe(line);
    expect(redactSecrets('Enter password:\nBuild ok in 3s')).toBe('Enter password:\nBuild ok in 3s');
    expect(redactSecrets('token:\n\nERROR boom')).toBe('token:\n\nERROR boom');
  });
});

describe('#4: the app mirror never leaves a stale "idle" behind', () => {
  const entry = (): LiveChatEntry => ({
    conversationId: 'c-mirror', projectRoot: '/v', busy: false, turnStartedAt: null, lastTurnEndedAt: null,
    adopt: () => true, supersede: () => () => {}, pid: 4242,
  });

  it('a failed write removes the old file (the CLI then counts every chat as running); dead servers\' files are pruned at start', () => {
    const dir = liveChatMirrorDir(home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '2147483646.json'), '{}'); // a server that died without its shutdown
    const path = join(dir, `${process.pid}.json`);
    const e = entry();
    try {
      setLiveChatMirror(path);
      expect(existsSync(join(dir, '2147483646.json'))).toBe(false);
      registerLiveChat(e);
      expect(JSON.parse(readFileSync(path, 'utf8')).chats).toEqual([{ pid: 4242, conversationId: 'c-mirror', projectRoot: '/v', busy: false }]);
      mkdirSync(`${path}.tmp`); // the next write cannot land
      markTurnStarted(e);
      expect(existsSync(path)).toBe(false);
    } finally {
      unregisterLiveChat(e);
      setLiveChatMirror(null);
    }
  });
});
