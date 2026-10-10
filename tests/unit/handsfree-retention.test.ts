// AC22 (retention + automatic D12 recovery), the laptop side.
//
//   1. retentionWarning: GitHub deletes an unused codespace at day 30; from day 20 (10 days or
//      less left) the laptop warns, for an abandoned OR still-away trip, never for a sealed or
//      already-recovered one.
//   2. status(): the warning reaches `warnings` (which the CLI `handsfree status` prints with
//      warn() and the status route sends to the dashboard banner as a quiet line).
//   3. D12: after an abandoned trip, a go that CANNOT reach GitHub recovers nothing and keeps the
//      duty (the warning stays); the next go that can reach GitHub recovers the abandoned trip
//      first, without being asked: its refs land in refs/handsfree/<old>/* and its files in
//      trips/<old>/orphaned/. (The happy path is also in handsfree-orchestrator.test.ts
//      'abandon and recovery (D12)'; this adds the unreachable-first case and the warning's end.)
// Scratch HOMEs only, never the real ~/.dreamcontext.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSpawnRunner, type ProcessRunner } from '../../src/lib/handsfree/git-snapshot.js';
import { rootIdFor } from '../../src/lib/handsfree/manifest.js';
import { FakeCloudProvider, ProviderError, type MachineInfo } from '../../src/lib/handsfree/provider.js';
import { abandonTrip, go, retentionWarning, setup, status, type HandsfreeEnv } from '../../src/lib/handsfree/orchestrator.js';
import { readConfig, updateConfig, type HandsfreeConfig } from '../../src/lib/handsfree/local-store.js';
import { readTripState } from '../../src/lib/handsfree/trip-state.js';
import { tripDir } from '../../src/lib/handsfree/journal.js';
import { NO_TURNS } from '../../src/lib/handsfree/turns.js';
import { readRosterSurface, writeMergedRosterSurface } from '../../src/server/routes/agent-sessions.js';
import { createFakeCloud, FAKE_CLOUD_VERSION, fakeRegistry, type FakeCloud } from '../helpers/handsfree-fake-cloud.js';

vi.setConfig({ testTimeout: 240_000 });

const DAY = 24 * 60 * 60_000;
const NOW = Date.parse('2026-10-10T12:00:00.000Z');
/** The deletion date of a codespace last used `day` days ago (GitHub deletes it at day 30). */
const expiresOnDay = (day: number) => new Date(NOW + (30 - day) * DAY).toISOString();
type LastTrip = NonNullable<HandsfreeConfig['lastTrip']>;
const trip = (status: LastTrip['status'], extra: Partial<LastTrip> = {}): LastTrip => ({ tripId: 't-20260920-0a0b0c0d', status, at: '2026-09-20T10:00:00.000Z', ...extra });

describe('AC22 retentionWarning: from day 20 of 30, for an abandoned or still-away trip', () => {
  it('day 19 (11 days left): no warning; day 20 (10 days left) and day 29: a warning naming the date and the days left', () => {
    expect(retentionWarning({ retentionExpiresAt: expiresOnDay(19) }, trip('away'), NOW)).toBeNull();
    const d20 = retentionWarning({ retentionExpiresAt: expiresOnDay(20) }, trip('away'), NOW);
    expect(d20).toContain(`GitHub deletes the cloud machine on ${expiresOnDay(20).slice(0, 10)} (10 days)`);
    const d29 = retentionWarning({ retentionExpiresAt: expiresOnDay(29) }, trip('away'), NOW);
    expect(d29).toContain('(1 days)');
  });

  it('just past the boundary (10 days and a minute left): still no warning', () => {
    expect(retentionWarning({ retentionExpiresAt: new Date(NOW + 10 * DAY + 60_000).toISOString() }, trip('away'), NOW)).toBeNull();
  });

  it('past the deletion date: 0 days, never a negative count', () => {
    expect(retentionWarning({ retentionExpiresAt: expiresOnDay(31) }, trip('abandoned', { recovered: false }), NOW)).toContain('(0 days)');
  });

  it('a still-away trip is told to return; an abandoned one that its work is recovered automatically', () => {
    expect(retentionWarning({ retentionExpiresAt: expiresOnDay(25) }, trip('away'), NOW)).toMatch(/return the trip before then\.$/);
    expect(retentionWarning({ retentionExpiresAt: expiresOnDay(25) }, trip('abandoned', { recovered: false }), NOW))
      .toMatch(/its abandoned work is recovered automatically the next time it can be reached before then\.$/);
  });

  it('no warning for a sealed trip, an already-recovered one, an unknown deletion date, or no trip at all', () => {
    const near = { retentionExpiresAt: expiresOnDay(25) };
    expect(retentionWarning(near, trip('sealed'), NOW)).toBeNull();
    expect(retentionWarning(near, trip('abandoned', { recovered: true }), NOW)).toBeNull();
    expect(retentionWarning(near, trip('lost', { recovered: true }), NOW)).toBeNull();
    expect(retentionWarning({ retentionExpiresAt: null }, trip('away'), NOW)).toBeNull();
    expect(retentionWarning(null, trip('away'), NOW)).toBeNull();
    expect(retentionWarning(near, null, NOW)).toBeNull();
    expect(retentionWarning(near, undefined, NOW)).toBeNull();
  });
});

describe('AC22 through status(): the warning is in the report the CLI and the dashboard show', () => {
  let home: string;
  let provider: FakeCloudProvider;
  const NAME = 'fake-hf-retention';
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hf-retention-'));
    provider = new FakeCloudProvider({ url: 'http://127.0.0.1:9' });
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const machine = (retentionExpiresAt: string | null): MachineInfo => ({
    name: NAME, state: 'stopped', rawState: 'Shutdown', machine: 'basicLinux32gb', url: 'http://127.0.0.1:9', webUrl: `https://example.invalid/${NAME}`,
    retentionExpiresAt, lastUsedAt: null, updatedAt: null,
  });
  const configure = (lastTrip: LastTrip | null, stored: string | null = null) => updateConfig(home, (c) => ({
    ...c, codespace: { name: NAME, machine: 'basicLinux32gb', url: 'http://127.0.0.1:9', webUrl: `https://example.invalid/${NAME}`, retentionExpiresAt: stored }, lastTrip,
  }), NOW);
  const env = () => ({ home, provider, repo: provider, now: () => NOW, turns: NO_TURNS } as unknown as HandsfreeEnv);
  const warns = async (o: { probe?: boolean } = {}) => (await status(env(), o)).warnings.filter((w) => w.startsWith('GitHub deletes'));

  it('an abandoned trip near expiry (GitHub reachable: the live deletion date): warned, with the automatic-recovery text', async () => {
    await configure(trip('abandoned', { recovered: false }));
    provider.machines.set(NAME, machine(expiresOnDay(22)));
    const w = await warns();
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/\(8 days\): its abandoned work is recovered automatically/);
  });

  it('a still-away trip near expiry: warned to return', async () => {
    await configure(trip('away'));
    provider.machines.set(NAME, machine(expiresOnDay(21)));
    expect(await warns()).toEqual([expect.stringMatching(/\(9 days\): return the trip before then\.$/)]);
  });

  it('GitHub not asked (probe off): the last known deletion date in the config still warns', async () => {
    await configure(trip('away'), expiresOnDay(24));
    expect(await warns({ probe: false })).toHaveLength(1);
  });

  it('the deletion date GitHub reported is kept: a later status with GitHub unreachable (or not asked) still warns', async () => {
    await configure(trip('abandoned', { recovered: false })); // nothing stored yet
    provider.machines.set(NAME, machine(expiresOnDay(23)));
    expect(await warns()).toHaveLength(1);
    expect(readConfig(home, NOW)!.codespace!.retentionExpiresAt).toBe(expiresOnDay(23));
    provider.get = async () => { throw new ProviderError('GitHub is unreachable (injected)'); };
    expect(await warns()).toHaveLength(1);
    expect(await warns({ probe: false })).toHaveLength(1);
  });

  it('not near expiry, sealed, or already recovered: no retention warning', async () => {
    await configure(trip('away'));
    provider.machines.set(NAME, machine(expiresOnDay(10)));
    expect(await warns()).toEqual([]);
    await configure(trip('sealed'));
    provider.machines.set(NAME, machine(expiresOnDay(25)));
    expect(await warns()).toEqual([]);
    await configure(trip('abandoned', { recovered: true }));
    expect(await warns()).toEqual([]);
  });
});

// ---------------------------------------------------------------- D12, end to end

describe('AC22 / D12: the next go that can reach GitHub recovers the abandoned trip first, unasked', () => {
  let root: string;
  let laptopHome: string;
  let cloudHome: string;
  let gitenv: Record<string, string>;
  let run: ProcessRunner;
  let fake: FakeCloud;
  let provider: FakeCloudProvider;
  let vault: string;
  let ctx: string;
  let githubDown = false;

  const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: gitenv, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const put = (base: string, rel: string, data: string) => { mkdirSync(join(base, rel, '..'), { recursive: true }); writeFileSync(join(base, rel), data); };
  const C = () => cloudHome + vault.slice(laptopHome.length);
  const tripDirOf = (t: string) => tripDir(join(laptopHome, '.dreamcontext', 'handsfree'), t);
  const makeEnv = (): HandsfreeEnv => ({
    home: laptopHome, run, provider, repo: provider, connect: () => fake, turns: NO_TURNS,
    roster: { read: readRosterSurface, write: writeMergedRosterSurface },
    templateFiles: () => ({ '.devcontainer/devcontainer.json': Buffer.from('{"name":"hf"}\n') }),
    localVersion: () => FAKE_CLOUD_VERSION, registryFetch: fakeRegistry().fetchImpl,
    claudeProjectsDir: join(laptopHome, '.claude', 'projects'), sleep: async () => {}, healthTimeoutMs: 1000,
  });

  beforeEach(async () => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'hf-retention-d12-')));
    laptopHome = join(root, 'laptop');
    cloudHome = join(root, 'cloud');
    mkdirSync(laptopHome);
    mkdirSync(cloudHome);
    const cfg = join(root, '.gitconfig');
    writeFileSync(cfg, '[user]\n\tname = T\n\temail = t@example.com\n[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n');
    gitenv = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('GIT_')) gitenv[k] = v;
    Object.assign(gitenv, { HOME: root, GIT_CONFIG_GLOBAL: cfg, GIT_CONFIG_NOSYSTEM: '1' });
    run = createSpawnRunner({ baseEnv: gitenv });
    fake = createFakeCloud({ run, laptopHome, cloudHome, gitenv, scratch: join(root, 'fake') });
    provider = new FakeCloudProvider({ url: fake.origin });
    // GitHub unreachable: every provider call fails the way the real one does (ProviderError).
    githubDown = false;
    for (const m of ['get', 'start', 'stop', 'create', 'remainingQuotaCoreMinutes', 'blobShas', 'writeFiles', 'ensure'] as const) {
      const orig = (provider as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[m].bind(provider);
      (provider as unknown as Record<string, unknown>)[m] = (...a: unknown[]) => (githubDown ? Promise.reject(new ProviderError('GitHub is unreachable (injected)')) : orig(...a));
    }
    vault = join(laptopHome, 'projects', 'app');
    ctx = join(vault, '_dream_context');
    mkdirSync(vault, { recursive: true });
    sh(vault, 'init', '-q');
    put(vault, '.gitignore', '_dream_context/state/\n');
    put(vault, '_dream_context/core/0.soul.md', 'soul\n');
    put(vault, 'a.txt', 'a1\n');
    sh(vault, 'add', '.');
    sh(vault, 'commit', '-qm', 'c1');
    await setup(makeEnv(), { token: 'gho_test', login: 'owner' });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('GitHub down: the go recovers nothing and the duty (and the day-20 warning) stays; GitHub back: the go recovers it first, then the warning ends', async () => {
    const env = makeEnv();
    const g1 = await go(env, { contextRoot: ctx });
    // The phone's work: a branch and an ignored brain file.
    sh(C(), 'checkout', '-q', '-b', 'phone-branch');
    put(C(), 'a.txt', 'from the phone\n');
    sh(C(), 'commit', '-qam', 'phone');
    put(C(), '_dream_context/state/phone.md', 'phone note\n');
    const phoneTip = sh(C(), 'rev-parse', 'phone-branch').trim();
    provider.machines.forEach((m) => { m.state = 'available'; });
    await abandonTrip(env);
    expect(readConfig(laptopHome)!.lastTrip).toMatchObject({ tripId: g1.tripId, status: 'abandoned', recovered: false });
    // Day 22 of the codespace's 30: the laptop warns.
    const name = readConfig(laptopHome)!.codespace!.name;
    provider.machines.get(name)!.retentionExpiresAt = new Date(Date.now() + 8 * DAY).toISOString();
    expect((await status(env)).warnings.some((w) => /its abandoned work is recovered automatically/.test(w))).toBe(true);

    // The next go while GitHub is unreachable: refused, nothing recovered, nothing lost.
    githubDown = true;
    await expect(go(env, { contextRoot: ctx })).rejects.toThrow();
    expect(readTripState(laptopHome).phase).toBe('home');
    expect(readConfig(laptopHome)!.lastTrip).toMatchObject({ tripId: g1.tripId, status: 'abandoned', recovered: false });
    expect(() => sh(vault, 'rev-parse', '--verify', '-q', `refs/handsfree/${g1.tripId}/heads/phone-branch`)).toThrow();
    expect(existsSync(join(tripDirOf(g1.tripId), 'orphaned'))).toBe(false);
    expect((await status(env, { probe: false })).warnings.some((w) => /recovered automatically/.test(w))).toBe(true);

    // GitHub reachable again: the go recovers the abandoned trip FIRST, unasked.
    githubDown = false;
    const g2 = await go(env, { contextRoot: ctx });
    expect(g2.recovery?.oldTrip).toBe(g1.tripId);
    expect(g2.tripId).not.toBe(g1.tripId);
    expect(sh(vault, 'rev-parse', `refs/handsfree/${g1.tripId}/heads/phone-branch`).trim()).toBe(phoneTip);
    expect(readFileSync(join(tripDirOf(g1.tripId), 'orphaned', rootIdFor(vault), '_dream_context/state/phone.md'), 'utf8')).toBe('phone note\n');
    expect(readFileSync(join(vault, 'a.txt'), 'utf8')).toBe('a1\n'); // recovery parks, never overwrites
    // The abandoned trip no longer warns (the new trip is the one GitHub's clock now tracks).
    expect(readConfig(laptopHome)!.lastTrip).toMatchObject({ tripId: g2.tripId, status: 'away' });
    expect((await status(env, { probe: false })).warnings.some((w) => /recovered automatically/.test(w))).toBe(false);
  });
});
