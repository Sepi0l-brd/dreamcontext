import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import {
  BASE_TOKEN_CAP,
  BUILDER_DEFAULT_EFFORT,
  BUILDER_ENV_UNSET,
  builderArgv,
  builderEnv,
  callsSince,
  contextTokens,
  firstCallHit,
  normalizeOwns,
  ownsOverlap,
  readRegistry,
  registryPath,
  resolvedModel,
  sessionAlive,
  sessionStatus,
  STALL_MS,
  type SessionRecord,
} from '../../src/lib/builder-spawn.js';
import {
  BUILDER_CANARY_MISS_EXIT,
  BUILDER_WAIT_ATTENTION_EXIT,
  BUILDER_WAIT_RUNNING_EXIT,
  builderBase,
  builderLane,
  builderResume,
  builderTest,
  builderWait,
  type SessionDeps,
} from '../../src/cli/commands/builder-sessions.js';
import { ownerOf, parseTestReport, parseTscErrors, planChecks, testArgv } from '../../src/lib/builder-test.js';
import { HEAVY_LOCK_BUSY_EXIT } from '../../src/lib/builder-tools.js';

/**
 * The builder base, forks and fresh builders (task every-piece-of-work-gets-the-lightest-…,
 * probe0/). The argv tests pin the cache rule measured on 2026-10-11: a fork reads its parent
 * from the prompt cache only with the parent's exact model, effort and tool list.
 */

const SID = '11111111-1111-4111-8111-111111111111';
const SID2 = '22222222-2222-4222-8222-222222222222';
const ID = { model: 'claude-opus-5-5', effort: 'medium' };

describe('builderArgv: one shape for every builder session', () => {
  const fresh = builderArgv('PROMPT', { kind: 'new', sessionId: SID }, ID);
  const fork = builderArgv('PROMPT', { kind: 'fork', from: SID, sessionId: SID2 }, ID);
  const resume = builderArgv('PROMPT', { kind: 'resume', sessionId: SID }, ID);
  const tail = (a: string[]) => a.slice(a.indexOf('--model'));

  it('new, fork and resume differ only in the session flags', () => {
    expect(tail(fork)).toEqual(tail(fresh));
    expect(tail(resume)).toEqual(tail(fresh));
    expect(fresh.slice(0, 2)).toEqual(['--session-id', SID]);
    expect(fork.slice(0, 5)).toEqual(['--resume', SID, '--fork-session', '--session-id', SID2]);
    expect(resume.slice(0, 2)).toEqual(['--resume', SID]);
  });

  it('never changes the tool list (a changed tool list is a cache miss)', () => {
    for (const a of [fresh, fork, resume]) {
      expect(a).not.toContain('--tools');
      expect(a).not.toContain('--disallowedTools');
      expect(a.join(' ')).not.toMatch(/--disallowed|--tools\b/);
    }
  });

  it('pins model, effort, permissions and json output; the prompt comes last, after the session id', () => {
    expect(fresh).toEqual(expect.arrayContaining(['--model', 'claude-opus-5-5', '--effort', 'medium', '--permission-mode', 'acceptEdits', '--output-format', 'json']));
    const allowed = fresh[fresh.indexOf('--allowedTools') + 1].split(' ');
    for (const t of ['Write', 'Edit', 'Bash']) expect(allowed).toContain(t);
    expect(fresh.slice(-2)).toEqual(['-p', 'PROMPT']);
  });

  it('builders default to medium effort (8 min vs 19 at xhigh, best blind grade)', () => {
    expect(BUILDER_DEFAULT_EFFORT).toBe('medium');
  });
});

describe('builderEnv', () => {
  const parent: NodeJS.ProcessEnv = Object.fromEntries([...BUILDER_ENV_UNSET.map((k) => [k, 'x']), ['PATH', '/bin'], ['CLAUDE_CONFIG_DIR', '/acct2']]);

  it('strips the lead pane\'s identity and the inherited effort, keeps the rest', () => {
    const env = builderEnv(parent, '-');
    for (const k of BUILDER_ENV_UNSET) expect(env[k]).toBeUndefined();
    expect(env.PATH).toBe('/bin');
    expect(env.DREAMCONTEXT_SPAWNED).toBe('develop');
    expect(env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe('1');
  });

  it('cfg "-" unsets CLAUDE_CONFIG_DIR (never $HOME/.claude); a recorded dir is set', () => {
    expect(builderEnv(parent, '-').CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(builderEnv({}, '/acct3').CLAUDE_CONFIG_DIR).toBe('/acct3');
  });
});

describe('owned paths', () => {
  it('normalizes to repo-relative, dedups, refuses paths outside the repo', () => {
    expect(normalizeOwns('/r', ['src/a.ts', './src/a.ts', '/r/src/b.ts', 'docs/,README.md'])).toEqual(['README.md', 'docs', 'src/a.ts', 'src/b.ts']);
    expect(() => normalizeOwns('/r', ['../x.ts'])).toThrow(/outside the repo/);
    expect(() => normalizeOwns('/r', ['/etc/passwd'])).toThrow(/outside the repo/);
  });

  it('a directory overlaps the files under it', () => {
    expect(ownsOverlap(['src/a.ts'], ['src/b.ts'])).toEqual([]);
    expect(ownsOverlap(['src/a.ts'], ['src/a.ts'])).toEqual(['src/a.ts']);
    expect(ownsOverlap(['src'], ['src/a.ts'])).toHaveLength(1);
    expect(ownsOverlap(['src/ab.ts'], ['src/a'])).toEqual([]);
  });
});

describe('liveness and transcripts', () => {
  it('a pid is alive only while its command line carries the session id', () => {
    const ps = `  101   1 01:00 claude --session-id ${SID} --model opus -p go\n  102   1 01:00 node other.js`;
    expect(sessionAlive(101, SID, ps)).toBe(true);
    expect(sessionAlive(102, SID, ps)).toBe(false);
    expect(sessionAlive(103, SID, ps)).toBe(false);
  });

  const line = (ts: string, id: string, u: Record<string, number>) =>
    JSON.stringify({ type: 'assistant', timestamp: ts, message: { id, usage: u } });

  it('counts only calls made since the session started (a fork\'s copied history is older), once per message id', () => {
    const t = [
      line('2026-10-11T08:00:00Z', 'old', { cache_read_input_tokens: 5, cache_creation_input_tokens: 90_000 }),
      line('2026-10-11T09:00:00Z', 'm1', { cache_read_input_tokens: 94_546, cache_creation_input_tokens: 2_422, input_tokens: 2 }),
      line('2026-10-11T09:00:01Z', 'm1', { cache_read_input_tokens: 94_546, cache_creation_input_tokens: 2_422, input_tokens: 2 }),
      line('2026-10-11T09:01:00Z', 'm2', { cache_read_input_tokens: 96_968, cache_creation_input_tokens: 500, input_tokens: 1 }),
    ].join('\n');
    const calls = callsSince(t, Date.parse('2026-10-11T08:59:59Z'));
    expect(calls).toHaveLength(2);
    expect(firstCallHit(calls)!.share).toBeCloseTo(0.975, 3);
    expect(contextTokens(calls)).toBe(97_469);
    expect(firstCallHit([])).toBeNull();
  });

  it('resolves the alias to the concrete model id the run used', () => {
    const log = JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', modelUsage: { 'claude-haiku-5-5': {}, 'claude-opus-5-5': {} } });
    expect(resolvedModel(log, 'opus')).toBe('claude-opus-5-5');
    expect(resolvedModel(null, 'opus')).toBe('opus');
  });
});

describe('sessionStatus', () => {
  const rec: SessionRecord = { sid: SID, pid: 1, cfg: '-', model: 'm', effort: 'medium', round: 1, logOffset: 0, startedAt: '2026-10-11T09:00:00Z' };
  const t0 = Date.parse(rec.startedAt);
  const res = (o: Record<string, unknown>) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, ...o });

  it('alive is running, or stalled after 20 min without transcript growth', () => {
    expect(sessionStatus('w1-A', rec, { alive: true, logText: null, transcriptMtimeMs: t0 + 60_000, nowMs: t0 + 120_000 }).state).toBe('running');
    expect(sessionStatus('w1-A', rec, { alive: true, logText: null, transcriptMtimeMs: t0, nowMs: t0 + STALL_MS + 1 }).state).toBe('stalled');
  });

  it('a lane reports only with its sentinel; a base with any success', () => {
    const w = { alive: false, transcriptMtimeMs: null, nowMs: t0 };
    expect(sessionStatus('w1-A', rec, { ...w, logText: res({ result: '## w1-A report\nfiles changed: a.ts' }) }).state).toBe('reported');
    expect(sessionStatus('w1-A', rec, { ...w, logText: res({ result: 'waiting for the tests' }) }).state).toBe('unfinished');
    expect(sessionStatus('base', rec, { ...w, logText: res({ result: 'BASE READY' }) }).state).toBe('reported');
    expect(sessionStatus('w1-A', rec, { ...w, logText: null }).state).toBe('crashed');
    expect(sessionStatus('w1-A', rec, { ...w, logText: res({ subtype: 'error_during_execution', is_error: true, result: 'Claude usage limit reached' }) }).state).toBe('paused');
  });
});

describe('builder test planning and parsing', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dc-bt-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const put = (name: string, text: string) => { mkdirSync(join(root, name, '..'), { recursive: true }); writeFileSync(join(root, name), text); };

  it('type-checks each package once and runs tests in the nearest package that has a runner', () => {
    put('package.json', JSON.stringify({ devDependencies: { vitest: '4' } }));
    put('tsconfig.json', '{}');
    put('dashboard/package.json', JSON.stringify({ scripts: { build: 'vite build' } })); // no runner: the root's tests cover it
    put('dashboard/tsconfig.json', '{}');
    put('functions/package.json', JSON.stringify({ scripts: { test: 'jest' } }));
    put('functions/tsconfig.json', '{}');
    const plan = planChecks(root, ['src/a.ts', 'dashboard/src/b.tsx', 'functions/src/c.ts', 'README.md'], ['tests/x.test.ts']);
    expect(plan.tsc).toEqual(['.', 'dashboard', 'functions']); // README.md needs no type-check
    expect(plan.tests).toEqual(expect.arrayContaining([
      { pkg: '.', runner: 'vitest', related: ['src/a.ts', 'dashboard/src/b.tsx', 'README.md'], explicit: ['tests/x.test.ts'] },
      { pkg: 'functions', runner: 'jest', related: ['src/c.ts'], explicit: [] },
    ]));
    expect(plan.tests).toHaveLength(2);
  });

  it('runner argv: related vs named files, json report, never fails on "nothing matched"', () => {
    expect(testArgv('vitest', 'related', ['src/a.ts'], '/o.json')).toEqual(['vitest', 'related', '--run', '--maxWorkers=2', '--passWithNoTests', '--reporter=json', '--outputFile=/o.json', 'src/a.ts']);
    expect(testArgv('vitest', 'explicit', ['t/a.test.ts'], '/o.json').slice(0, 2)).toEqual(['vitest', 'run']);
    expect(testArgv('jest', 'related', ['src/a.ts'], '/o.json')).toEqual(['jest', '--findRelatedTests', 'src/a.ts', '--maxWorkers=2', '--passWithNoTests', '--json', '--outputFile=/o.json']);
    expect(testArgv('jest', 'explicit', ['t/a.test.ts'], '/o.json').at(-1)).toBe('t/a.test.ts');
  });

  it('tsc errors are keyed by code + repo-relative file + line, from any package', () => {
    const out = "src/x.tsx(12,3): error TS2322: Type 'string' is not assignable to type 'number'.\nFound 1 error.";
    expect(parseTscErrors(out, 'dashboard', root)).toEqual([
      { key: 'tsc TS2322 dashboard/src/x.tsx:12', file: 'dashboard/src/x.tsx', message: "Type 'string' is not assignable to type 'number'." },
    ]);
  });

  it('a test report gives every file that ran, failing assertions, and suites that failed to load', () => {
    const json = JSON.stringify({
      numTotalTests: 3,
      testResults: [
        { name: join(root, 'tests/a.test.ts'), status: 'failed', assertionResults: [
          { fullName: 'a works', status: 'passed' },
          { fullName: 'a handles empty', status: 'failed', failureMessages: ['\n  AssertionError: expected 1 to be 2\n    at x'] },
        ] },
        { name: join(root, 'tests/b.test.ts'), status: 'failed', message: 'Error: Cannot find module ./gone.js', assertionResults: [] },
        { name: join(root, 'tests/c.test.ts'), status: 'passed', assertionResults: [{ fullName: 'c', status: 'passed' }] },
      ],
    });
    const r = parseTestReport(json, root);
    expect(r.total).toBe(3);
    expect(r.files).toEqual(['tests/a.test.ts', 'tests/b.test.ts', 'tests/c.test.ts']);
    expect(r.failures.map((f) => f.key)).toEqual([
      'tests/a.test.ts > a handles empty :: AssertionError: expected 1 to be 2',
      'tests/b.test.ts :: suite failed: Error: Cannot find module ./gone.js',
    ]);
  });

  it('a failure belongs to the lane that owns its file or directory', () => {
    const lanes = [{ lane: 'w1-A', owns: ['src/a'] }, { lane: 'w1-B', owns: ['src/b.ts'] }];
    expect(ownerOf('src/a/x.ts', lanes)).toBe('w1-A');
    expect(ownerOf('src/b.ts', lanes)).toBe('w1-B');
    expect(ownerOf('src/ab.ts', lanes)).toBeNull();
  });
});

// ─── commands, against a fake world ──────────────────────────────────────────

describe('builder base / fork / spawn / resume / wait', () => {
  let root: string;
  let home: string;
  let now: number;
  let alive: Map<number, string>;
  let launched: { argv: string[]; env: NodeJS.ProcessEnv; logFile: string }[];
  let out: string[];
  let nextPid: number;
  let uuids: string[];
  /** What each launched session will have written when it exits: by session id. */
  let finish: Map<string, string>;
  /** `builder test`: every check it ran, and what the next one does. */
  let checks: { argv: string[]; cwd: string }[];
  let check: (argv: string[], logFile: string) => number | null;

  const deps = (extraEnv: NodeJS.ProcessEnv = {}): SessionDeps => ({
    root: () => root,
    env: { PATH: '/bin', CLAUDE_CODE_SESSION_ID: 'lead', CLAUDE_EFFORT: 'xhigh', ...extraEnv },
    home,
    now: () => now,
    uuid: () => uuids.shift()!,
    ps: () => [...alive].map(([pid, sid]) => `${pid} 1 00:10 claude --session-id ${sid} -p x`).join('\n'),
    launch: (argv, o) => {
      launched.push({ argv, env: o.env, logFile: o.logFile });
      const pid = nextPid++;
      const sid = argv.includes('--session-id') ? argv[argv.indexOf('--session-id') + 1] : argv[argv.indexOf('--resume') + 1];
      alive.set(pid, sid);
      return pid;
    },
    logTask: async () => {},
    goalLive: () => {},
    sleep: async (ms) => {
      now += ms;
      // every tick, the sessions told to finish do so
      for (const [pid, sid] of [...alive]) {
        const text = finish.get(sid);
        if (text == null) continue;
        const last = launched.filter((l) => l.argv.includes(sid)).pop()!;
        appendFileSync(last.logFile, `${text}\n`);
        alive.delete(pid);
        finish.delete(sid);
      }
    },
    runCheck: async (argv, cwd, logFile) => {
      checks.push({ argv, cwd: relative(root, cwd) || '.' });
      return check(argv, logFile);
    },
    print: (l) => out.push(l),
    printErr: (l) => out.push(`ERR ${l}`),
  });
  const res = (result: string) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result, modelUsage: { 'claude-opus-5-5': {} } });
  const file = (name: string, text: string) => { const p = join(root, name); writeFileSync(p, text); return p; };
  const transcript = (sid: string, u: Record<string, number>) => {
    mkdirSync(join(home, '.claude', 'projects', 'p'), { recursive: true });
    writeFileSync(join(home, '.claude', 'projects', 'p', `${sid}.jsonl`), JSON.stringify({ type: 'assistant', timestamp: new Date(now + 1000).toISOString(), message: { id: sid, usage: u } }) + '\n');
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dc-bs-'));
    home = mkdtempSync(join(tmpdir(), 'dc-bs-home-'));
    now = Date.parse('2026-10-11T09:00:00Z');
    alive = new Map(); launched = []; out = []; nextPid = 500; finish = new Map();
    checks = []; check = () => 0;
    uuids = ['aaaaaaaa-0000-4000-8000-00000000000a', 'bbbbbbbb-0000-4000-8000-00000000000b', 'cccccccc-0000-4000-8000-00000000000c'];
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });

  async function mintBase(tokens = 90_000, effort?: string): Promise<string> {
    const sid = uuids[0];
    finish.set(sid, res('BASE READY'));
    transcript(sid, { cache_read_input_tokens: tokens - 1000, cache_creation_input_tokens: 1000 });
    expect(await builderBase(deps(), 'demo', { promptFile: file('base.md', 'read the task'), maxWait: '60', effort })).toBe(0);
    return sid;
  }

  it('mints a base: framed prompt, medium effort, lead env stripped, ready with its real size and model', async () => {
    const sid = await mintBase();
    const reg = readRegistry(registryPath(root, 'demo'), 'demo');
    expect(reg.base).toMatchObject({ sid, state: 'ready', tokens: 90_000, model: 'claude-opus-5-5', effort: 'medium' });
    const { argv, env } = launched[0];
    expect(argv.at(-1)).toMatch(/^You are the builder base for task demo\./);
    expect(argv).toEqual(expect.arrayContaining(['--effort', 'medium']));
    expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    expect(env.CLAUDE_EFFORT).toBeUndefined();
  });

  it('a fork reuses the base\'s resolved model, effort and account; its framing says it is not the lead', async () => {
    const base = await mintBase(90_000, 'low');
    expect(await builderLane(deps(), 'demo', 'w1-A', 'fork', { owns: ['src/a.ts'], promptFile: file('a.md', 'build a') })).toBe(0);
    const { argv } = launched[1];
    expect(argv.slice(0, 3)).toEqual(['--resume', base, '--fork-session']);
    expect(argv).toEqual(expect.arrayContaining(['--model', 'claude-opus-5-5', '--effort', 'low']));
    expect(argv.at(-1)).toMatch(/^You are builder w1-A of task demo, a fork of its builder base\. You are not the lead/);
    await expect(builderLane(deps(), 'demo', 'w1-B', 'fork', { owns: ['src/b.ts'], promptFile: file('b.md', 'b'), effort: 'high' })).rejects.toThrow(/base's effort/);
  });

  it('a fork runs under the base\'s account even after the lead switched accounts (cache and transcript live there)', async () => {
    const sid = uuids[0];
    finish.set(sid, res('BASE READY'));
    await builderBase(deps({ CLAUDE_CONFIG_DIR: '/acct2' }), 'demo', { promptFile: file('base.md', 'read'), maxWait: '60' });
    await builderLane(deps(), 'demo', 'w1-A', 'fork', { owns: ['a.ts'], promptFile: file('a.md', 'a') });
    expect(launched[0].env.CLAUDE_CONFIG_DIR).toBe('/acct2');
    expect(launched[1].env.CLAUDE_CONFIG_DIR).toBe('/acct2');
  });

  it('refuses a fork without a ready base, a second lane on the same files, and a re-run lane id', async () => {
    await expect(builderLane(deps(), 'demo', 'w1-A', 'fork', { owns: ['a.ts'], promptFile: file('a.md', 'a') })).rejects.toThrow(/no ready base/);
    await mintBase();
    await builderLane(deps(), 'demo', 'w1-A', 'fork', { owns: ['src'], promptFile: file('a.md', 'a') });
    await expect(builderLane(deps(), 'demo', 'w1-B', 'fork', { owns: ['src/b.ts'], promptFile: file('b.md', 'b') })).rejects.toThrow(/share files with w1-A/);
    // a later wave may own an earlier wave's files
    expect(await builderLane(deps(), 'demo', 'w2-A', 'fresh', { owns: ['src/b.ts'], promptFile: file('c.md', 'c') })).toBe(0);
    // the same command again while it runs is a no-op; after it ran, it must be resumed
    expect(await builderLane(deps(), 'demo', 'w1-A', 'fork', { owns: ['src'], promptFile: file('a.md', 'a') })).toBe(0);
    alive.clear();
    await expect(builderLane(deps(), 'demo', 'w1-A', 'fork', { owns: ['src'], promptFile: file('a.md', 'a') })).rejects.toThrow(/already ran/);
  });

  it('wait: 0 when every lane reported, 4 when the slice ends with one running, 5 when one needs attention; each result reported once', async () => {
    await builderLane(deps(), 'demo', 'w1-A', 'fresh', { owns: ['a.ts'], promptFile: file('a.md', 'a') });
    await builderLane(deps(), 'demo', 'w1-B', 'fresh', { owns: ['b.ts'], promptFile: file('b.md', 'b') });
    const [a, b] = Object.values(readRegistry(registryPath(root, 'demo'), 'demo').lanes).map((l) => l.sid);
    finish.set(a, res('## w1-A report\nfiles changed: a.ts'));
    expect(await builderWait(deps(), 'demo', { maxWait: '30' })).toBe(BUILDER_WAIT_RUNNING_EXIT);
    expect(out.join('\n')).toMatch(/w1-A reported/);
    expect(out.join('\n')).toMatch(/w1-B running/);
    out = [];
    finish.set(b, res('Waiting for the type-check to finish.'));
    expect(await builderWait(deps(), 'demo', { maxWait: '30' })).toBe(BUILDER_WAIT_ATTENTION_EXIT);
    expect(out.join('\n')).not.toMatch(/w1-A/); // already reported once
    expect(out.join('\n')).toMatch(/w1-B unfinished/);
    out = [];
    expect(await builderWait(deps(), 'demo', {})).toBe(0);
    expect(out.join('\n')).toMatch(/nothing to wait for/);
  });

  it('resume: refuses a live session, reuses the recorded identity, stops after 3 resumes', async () => {
    await builderLane(deps(), 'demo', 'w1-A', 'fresh', { owns: ['a.ts'], promptFile: file('a.md', 'a'), effort: 'high' });
    const fix = file('fix.md', 'Finding: a.ts throws on empty input.');
    await expect(builderResume(deps(), 'demo', 'w1-A', { messageFile: fix })).rejects.toThrow(/still running/);
    for (let i = 0; i < 3; i++) { alive.clear(); expect(await builderResume(deps(), 'demo', 'w1-A', { messageFile: fix })).toBe(0); }
    const last = launched.at(-1)!.argv;
    expect(last.slice(0, 2)[0]).toBe('--resume');
    expect(last).toEqual(expect.arrayContaining(['--effort', 'high']));
    expect(last.at(-1)).toBe('Finding: a.ts throws on empty input.');
    alive.clear();
    await expect(builderResume(deps(), 'demo', 'w1-A', { messageFile: fix })).rejects.toThrow(/owner/);
  });

  it('base --update: write-ahead delta, refused over the cap, absorbs the wave', async () => {
    const sid = await mintBase();
    finish.set(sid, res('OK'));
    expect(await builderBase(deps(), 'demo', { update: file('d.md', 'W1 landed a.ts'), wave: '1', maxWait: '60' })).toBe(0);
    expect(readFileSync(join(root, 'tmp/develop/demo/base-delta-r2.md'), 'utf-8')).toBe('W1 landed a.ts');
    expect(readRegistry(registryPath(root, 'demo'), 'demo').base).toMatchObject({ state: 'ready', absorbedWave: 1, round: 2 });

    const reg = JSON.parse(readFileSync(registryPath(root, 'demo'), 'utf-8'));
    reg.base.tokens = BASE_TOKEN_CAP + 1;
    writeFileSync(registryPath(root, 'demo'), JSON.stringify(reg));
    await expect(builderBase(deps(), 'demo', { update: file('d2.md', 'W2'), wave: '2' })).rejects.toThrow(/over the 150k cap/);
  });

  it('canary: reports the fork\'s first-call cache read and exits 6 on a miss', async () => {
    await mintBase();
    uuids.unshift('dddddddd-0000-4000-8000-00000000000d');
    transcript('dddddddd-0000-4000-8000-00000000000d', { cache_read_input_tokens: 2_000, cache_creation_input_tokens: 90_000 });
    expect(await builderLane(deps(), 'demo', 'w1-A', 'fork', { owns: ['a.ts'], promptFile: file('a.md', 'a'), canary: true })).toBe(BUILDER_CANARY_MISS_EXIT);
    expect(out.join('\n')).toMatch(/CACHE MISS/);
  });
  // ─── builder test ──────────────────────────────────────────────────────────

  const outFile = (argv: string[]) => argv.find((a) => a.startsWith('--outputFile='))!.slice('--outputFile='.length);
  /** A vitest json report: suites by repo-relative file, each with its failing test names. */
  const report = (suites: { file: string; failed?: string[]; passed?: number }[]) => JSON.stringify({
    numTotalTests: suites.reduce((n, s) => n + (s.failed?.length ?? 0) + (s.passed ?? 0), 0),
    testResults: suites.map((s) => ({
      name: join(root, s.file),
      status: s.failed?.length ? 'failed' : 'passed',
      assertionResults: [
        ...(s.failed ?? []).map((n) => ({ fullName: n, status: 'failed', failureMessages: ['expected 1 to be 2'] })),
        ...Array.from({ length: s.passed ?? 0 }, (_, i) => ({ fullName: `ok ${i}`, status: 'passed' })),
      ],
    })),
  });
  /** tsc and the test runner, scripted per call kind. */
  const script = (o: { tsc?: string; tests?: string | null; testExit?: number }) => (argv: string[], logFile: string) => {
    if (argv[0] === 'tsc') { writeFileSync(logFile, o.tsc ?? ''); return o.tsc ? 2 : 0; }
    if (o.tests === null) return null;
    writeFileSync(outFile(argv), o.tests ?? report([]));
    return o.testExit ?? (o.tests && JSON.parse(o.tests).testResults.some((t: { status: string }) => t.status === 'failed') ? 1 : 0);
  };
  const statefile = () => join(root, 'tmp/develop/demo/test-w1.json');
  const setupRepo = async () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ devDependencies: { vitest: '4' } }));
    writeFileSync(join(root, 'tsconfig.json'), '{}');
    await builderLane(deps(), 'demo', 'w1-A', 'fresh', { owns: ['src/a.ts', 'tests/a.test.ts'], promptFile: file('a.md', 'a') });
    await builderLane(deps(), 'demo', 'w1-B', 'fresh', { owns: ['src/b.ts'], promptFile: file('b.md', 'b') });
    out = [];
  };

  it('test: keys every failure to its owning lane, --failed re-runs only that, the same key twice goes to the owner, green clears the state', async () => {
    await setupRepo();
    check = script({
      tsc: "src/b.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.",
      tests: report([{ file: 'tests/a.test.ts', failed: ['a handles empty'], passed: 2 }, { file: 'tests/c.test.ts', passed: 4 }]),
    });
    expect(await builderTest(deps(), 'demo', { wave: '1', related: ['src/a.ts', 'src/b.ts'] })).toBe(1);
    expect(checks.map((c) => c.argv.slice(0, 2))).toEqual([['tsc', '--noEmit'], ['vitest', 'related']]);
    expect(checks[1].argv.slice(-2)).toEqual(['src/a.ts', 'src/b.ts']);
    const printed = out.join('\n');
    expect(printed).toMatch(/FAIL w1-B: tsc TS2322 src\/b\.ts:3/);
    expect(printed).toMatch(/FAIL w1-A: tests\/a\.test\.ts > a handles empty :: expected 1 to be 2/);
    expect(JSON.parse(readFileSync(statefile(), 'utf-8'))).toMatchObject({ tscFailed: ['.'], failedTests: { '.': ['tests/a.test.ts'] } });

    // after the resumes: tsc is clean now, a.test.ts still fails the same way
    checks = []; out = [];
    check = script({ tests: report([{ file: 'tests/a.test.ts', failed: ['a handles empty'], passed: 2 }]) });
    expect(await builderTest(deps(), 'demo', { wave: '1', failed: true })).toBe(1);
    expect(checks.map((c) => c.argv.slice(0, 2))).toEqual([['tsc', '--noEmit'], ['vitest', 'run']]);
    expect(checks[1].argv.at(-1)).toBe('tests/a.test.ts');
    expect(out.join('\n')).toMatch(/FAIL w1-A: tests\/a\.test\.ts > a handles empty .*FAILED 2x/);
    expect(JSON.parse(readFileSync(statefile(), 'utf-8'))).toMatchObject({ tscFailed: [], failedTests: { '.': ['tests/a.test.ts'] } });

    checks = []; out = [];
    check = script({ tests: report([{ file: 'tests/a.test.ts', passed: 3 }]) });
    expect(await builderTest(deps(), 'demo', { wave: '1', failed: true })).toBe(0);
    expect(checks.map((c) => c.argv[0])).toEqual(['vitest']); // the package that passed is not re-checked
    expect(out.at(-1)).toBe('wave 1: GREEN');
    expect(existsSync(statefile())).toBe(false);
  });

  it('test: a check that never ran is NOT RUN (exit 75), not a failure and not green', async () => {
    await setupRepo();
    check = script({ tests: null });
    expect(await builderTest(deps(), 'demo', { wave: '1', related: ['src/a.ts'] })).toBe(HEAVY_LOCK_BUSY_EXIT);
    expect(out.join('\n')).toMatch(/NOT RUN: vitest related \(\.\)/);
    expect(out.join('\n')).not.toMatch(/GREEN|FAIL/);
  });

  it('test: no test importing the change is reported as uncovered, never as GREEN', async () => {
    await setupRepo();
    check = script({ tests: report([]) });
    expect(await builderTest(deps(), 'demo', { wave: '1', related: ['src/b.ts'] })).toBe(0);
    expect(out.join('\n')).toMatch(/NO COVERAGE/);
    expect(out.at(-1)).toMatch(/NOT GREEN: no test covers src\/b\.ts/);
  });

  it('test: a runner exiting nonzero with every test passing (an unhandled error) is a failure', async () => {
    await setupRepo();
    check = script({ tests: report([{ file: 'tests/a.test.ts', passed: 2 }]), testExit: 1 });
    expect(await builderTest(deps(), 'demo', { wave: '1', related: ['src/a.ts'] })).toBe(1);
    expect(out.join('\n')).toMatch(/FAIL .*vitest related \(\.\) exit 1 with no failing test/);
  });

  it('test --failed: a failed test file the fix deleted leaves the failed set instead of pinning it red', async () => {
    await setupRepo();
    mkdirSync(join(root, 'tmp/develop/demo'), { recursive: true });
    writeFileSync(statefile(), JSON.stringify({ version: 1, wave: 1, runs: 1, failedTests: { '.': ['tests/gone.test.ts'] }, tscFailed: [], seen: {} }));
    check = script({ tests: report([]) });
    expect(await builderTest(deps(), 'demo', { wave: '1', failed: true })).toBe(0);
    expect(out.join('\n')).toMatch(/tests\/gone\.test\.ts ran no tests/);
    expect(existsSync(statefile())).toBe(false);
  });

  it('test --wave final: the run-end check keeps its own failure state; a bad wave is refused', async () => {
    await setupRepo();
    check = script({ tests: report([{ file: 'tests/a.test.ts', failed: ['a handles empty'] }]) });
    expect(await builderTest(deps(), 'demo', { wave: 'final', related: ['src/a.ts'] })).toBe(1);
    expect(existsSync(join(root, 'tmp/develop/demo/test-wfinal.json'))).toBe(true);
    expect(existsSync(statefile())).toBe(false);
    await expect(builderTest(deps(), 'demo', { wave: '0', related: ['src/a.ts'] })).rejects.toThrow(/--wave/);
  });
});
