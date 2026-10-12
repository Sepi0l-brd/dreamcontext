#!/usr/bin/env node
/**
 * Agents own entity, migration (M1 to M6), end to end through the REAL CLI.
 *
 *   npm run build && npm run verify:agents-migration
 *
 * The 0.31.0 code step `split-automation-agents` turns every legacy automation manifest (no
 * `agent:` key) into `agents/<slug>.md` plus, for a scheduled one, an automation bound to it.
 * The unit tests (`agents-split*.test.ts`, `automations-registry.test.ts`) prove the pieces;
 * this script proves the WHOLE path a user takes: `dreamcontext update` in a legacy vault,
 * with two machines' approval registries, a crash in the middle, a re-run, a teammate's
 * restore, and the Agents page reading the result.
 *
 * WHAT IT PROVES, one checkpoint per criterion (each says which mutation it guards):
 *   M1  every approval verdict is unchanged in BOTH homes, and neither registry is written.
 *   M2  a crash right after the agent file (`DREAMCONTEXT_SPLIT_FAIL_AFTER=agent`) leaves the
 *       legacy file in charge and setupVersion unstamped; the next `update` completes it; a
 *       re-run of the step is byte-identical; a second machine produces the same bytes.
 *   M4  a conflicting `agents/<slug>.md` leaves the legacy file untouched and is named in the
 *       migration summary and by `doctor`; neither it nor a symlink pins the vault.
 *   M6  a symlinked manifest is skipped (never split, never listed) and named by `doctor`; a
 *       never-migrated legacy manifest still shows on the Agents page.
 *   R3  re-stamp then restore: a local edit re-approves the agent directly and drops the legacy
 *       record in the same write, so a byte-for-byte restore of the old file is BLOCKED here.
 *   R6  revoke on delete: deleting an agent whose slot is unreadable revokes the legacy record,
 *       so a restored legacy file stays BLOCKED here.
 *   For R3 and R6 the second home (which edited nothing) still approves the restored file: the
 *   block is this machine's decision, not a broken fixture.
 *
 * WHAT IT DOES NOT TOUCH: your machine. Two fake HOMEs, scratch projects, no `claude` spawned.
 * Screenshots (Agents page after the migration, light and dark) land in tmp/verify-agents-migration/.
 *
 * FAILURE POLICY: collect, don't fail fast. Exit 0 iff every check passed.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import {
  cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { distIndex, scratchDir, setTheme, shotsDir } from './lib/measure.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST_INDEX = distIndex(REPO);
const VERSION = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf-8')).version;
const LEGACY_VERSION = '0.30.6';

const SCRATCH = scratchDir('dc-verify-agents-migration');
const HOME_A = join(SCRATCH, 'home-a');
const HOME_B = join(SCRATCH, 'home-b');
const PROJ = join(SCRATCH, 'proj');
const TWIN = join(SCRATCH, 'proj-twin');
const PRISTINE = join(SCRATCH, 'pristine');
const ctx = (p) => join(p, '_dream_context');
const autoFile = (p, slug) => join(ctx(p), 'automations', `${slug}.md`);
const agentFile = (p, slug) => join(ctx(p), 'agents', `${slug}.md`);
const SHOTS = shotsDir(REPO, 'agents-migration');

/** sched pair, two on-call agents, a conflict, a symlink. Sorted order matters for the crash:
 *  `clash` ends in a conflict (no write), so `digest` is the first slug the split writes. */
const SCHED = 'digest';
const CALL = 'helper';
const CALL2 = 'watcher';
const CLASH = 'clash';
const LINKY = 'linky';

const report = { pass: 0, fail: 0 };
function check(label, ok, ev = '') {
  if (ok) { report.pass++; console.log(`  PASS ${label}`); }
  else { report.fail++; console.log(`  FAIL ${label}${ev ? `\n      ${ev}` : ''}`); }
}

/** The env a CLI call runs in: the fake HOME, and NONE of the variables that make the CLI
 *  believe it runs inside a Claude session or an agent run (the orchestrator may be one, and
 *  `approve` refuses there by design). */
function cleanEnv(home, extra = {}) {
  const env = { ...process.env, HOME: home };
  for (const k of Object.keys(env)) {
    if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_') || k.startsWith('DREAMCONTEXT_')) delete env[k];
  }
  return { ...env, ...extra };
}

function run(args, { home = HOME_A, cwd = PROJ, env = {} } = {}) {
  const r = spawnSync(process.execPath, [DIST_INDEX, ...args], { cwd, env: cleanEnv(home, env), encoding: 'utf-8' });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, stdout: r.stdout ?? '' };
}

function cli(args, opts) {
  const r = run(args, opts);
  if (r.status !== 0) throw new Error(`cli ${args.join(' ')} failed: ${r.out.slice(0, 600)}`);
  return r.stdout;
}

function json(args, opts) {
  const text = cli([...args, '--json'], opts);
  return JSON.parse(text.slice(text.search(/[[{]/)));
}

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf-8') : null);

/** Every verdict a home holds for this vault: each automation's run approval and each agent's
 *  chat and run approval, as the CLI reports them. */
function verdicts(home, cwd = PROJ) {
  const out = {};
  for (const m of json(['automations', 'list'], { home, cwd })) out[`automation:${m.slug}`] = m.approved;
  for (const a of json(['agents', 'list'], { home, cwd }).agents) out[`agent:${a.slug}`] = { chat: a.approvedForChat, run: a.approvedToRun };
  return out;
}

/** This vault's entry in a home's approval registry (keys may be `/private/var/…`, so match the tail). */
function registryEntry(home, proj = PROJ) {
  const p = join(home, '.dreamcontext', 'automations.json');
  if (!existsSync(p)) return null;
  const reg = JSON.parse(readFileSync(p, 'utf-8'));
  const key = Object.keys(reg.projects ?? {}).find((k) => k.endsWith(`${sep}${basename(proj)}`));
  return key ? reg.projects[key] : null;
}

const approvalsOf = (home) => {
  const e = registryEntry(home);
  return JSON.stringify({ approvals: e?.approvals ?? {}, agentApprovals: e?.agentApprovals ?? {} });
};

function setupVersion(proj = PROJ) {
  return JSON.parse(readFileSync(join(ctx(proj), 'state', '.config.json'), 'utf-8')).setupVersion;
}

function setSetupVersion(v, proj = PROJ) {
  const p = join(ctx(proj), 'state', '.config.json');
  const cfg = JSON.parse(readFileSync(p, 'utf-8'));
  cfg.setupVersion = v;
  writeFileSync(p, `${JSON.stringify(cfg, null, 2)}\n`);
}

/** Every agent and automation file of a vault, as relative path → bytes (symlinks by target). */
function treeBytes(proj) {
  const out = {};
  for (const dir of ['agents', 'automations']) {
    const abs = join(ctx(proj), dir);
    if (!existsSync(abs)) continue;
    for (const f of readdirSync(abs).filter((n) => n.endsWith('.md')).sort()) {
      const p = join(abs, f);
      out[`${dir}/${f}`] = lstatSync(p).isSymbolicLink() ? `symlink` : readFileSync(p, 'utf-8');
    }
  }
  return out;
}

function ledgerSummary() {
  const p = join(ctx(PROJ), 'state', '.migrations.json');
  if (!existsSync(p)) return '';
  const raw = JSON.parse(readFileSync(p, 'utf-8'));
  const entries = Array.isArray(raw) ? raw : (raw.entries ?? []);
  return entries.filter((e) => e.version === '0.31.0' && e.step === 'split-automation-agents').map((e) => e.summary).join(' | ');
}

function seed() {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const h of [HOME_A, HOME_B]) mkdirSync(join(h, '.dreamcontext'), { recursive: true });
  mkdirSync(join(ctx(PROJ), 'core'), { recursive: true });
  mkdirSync(join(ctx(PROJ), 'state'), { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: PROJ });
  // A vault set up by 0.30.6: `update` detects the platform by its SKILL.md and migrates over
  // (0.30.6, VERSION], which selects exactly the 0.31.0 step.
  mkdirSync(join(PROJ, '.claude', 'skills', 'dreamcontext'), { recursive: true });
  writeFileSync(join(PROJ, '.claude', 'skills', 'dreamcontext', 'SKILL.md'), '---\nname: dreamcontext\n---\n\nOld skill.\n');
  writeFileSync(join(ctx(PROJ), 'state', '.config.json'), `${JSON.stringify({
    platforms: ['claude'], packs: [], setupVersion: LEGACY_VERSION, brainRepo: { mode: 'in-tree', enabled: false },
  }, null, 2)}\n`);
  cli(['vaults', 'add', 'proj', PROJ]);

  // The legacy manifests, written by the REAL `automations create` (no --agent ⇒ the legacy
  // self-contained format, auto-approved on home A, its derived `## Flow` included: the hash
  // invariance has to hold for files the product itself makes, not hand-rolled ones).
  const promptFile = join(SCRATCH, 'prompt.md');
  writeFileSync(promptFile, 'Read yesterday\'s insights and write a three-line summary.\n');
  cli(['automations', 'create', SCHED, '--title', 'Daily digest', '--days', 'daily', '--at', '18:00', '--prompt-file', promptFile, '--model', 'opus']);
  cli(['automations', 'create', CALL, '--title', 'Helper', '--mode', 'call', '--timeout', '20', '--prompt-file', promptFile]);
  cli(['automations', 'create', CALL2, '--title', 'Funnel watcher', '--mode', 'call', '--prompt-file', promptFile]);
  cli(['automations', 'create', CLASH, '--title', 'Clash', '--days', 'daily', '--at', '07:00', '--prompt-file', promptFile]);
  cli(['automations', 'create', LINKY, '--title', 'Linky', '--mode', 'call', '--prompt-file', promptFile]);

  // The conflict: a foreign agent file the split must not overwrite.
  mkdirSync(join(ctx(PROJ), 'agents'), { recursive: true });
  writeFileSync(agentFile(PROJ, CLASH),
    '---\nid: agt_foreign\ntitle: Someone else\nmigrated_from: auto_somewhere_else\nshared: false\n---\n## Prompt\n\nNot ours.\n');
  // The symlink: the manifest moved out of the brain and linked back in.
  const outside = join(PROJ, 'outside-linky.md');
  renameSync(autoFile(PROJ, LINKY), outside);
  symlinkSync(outside, autoFile(PROJ, LINKY));

  // The second machine approves the same legacy files on its own registry.
  for (const slug of [SCHED, CALL, CALL2, CLASH]) cli(['automations', 'approve', slug, '-y'], { home: HOME_B });

  // A pristine copy of the legacy vault for the second-machine byte check (M2).
  cpSync(PROJ, PRISTINE, { recursive: true, verbatimSymlinks: true });
}

const freePort = () => new Promise((res, rej) => {
  const s = createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

async function startServer(port) {
  const PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [DIST_INDEX, 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ, env: { ...cleanEnv(HOME_A), PATH, DREAMCONTEXT_DESKTOP: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return srv; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  srv.kill();
  throw new Error('server did not come up');
}

async function main() {
  console.log('· fixture: two fake HOMEs, a 0.30.6 vault with five legacy manifests');
  seed();
  const legacy = Object.fromEntries([SCHED, CALL, CALL2, CLASH].map((s) => [s, read(autoFile(PROJ, s))]));
  const foreignClash = read(agentFile(PROJ, CLASH));
  const beforeA = verdicts(HOME_A);
  const beforeB = verdicts(HOME_B);
  const regA = approvalsOf(HOME_A);
  const regB = approvalsOf(HOME_B);
  check('[setup] every legacy manifest is approved to run on BOTH homes before the migration',
    [SCHED, CALL, CALL2, CLASH].every((s) => beforeA[`automation:${s}`] === true && beforeB[`automation:${s}`] === true),
    JSON.stringify({ beforeA, beforeB }));
  check('[setup] the two on-call agents may run, the scheduled one may only chat (its approval is the automation\'s)',
    beforeA[`agent:${CALL}`]?.run === true && beforeA[`agent:${CALL2}`]?.run === true
      && beforeA[`agent:${SCHED}`]?.chat === true && beforeA[`agent:${SCHED}`]?.run === false,
    JSON.stringify(beforeA));

  // ── M2: a crash right after the agent file ──────────────────────────────────────────────
  console.log('\n═══ M2. A crash mid-split, then the next update ═══');
  const crash = run(['update', '--yes'], { env: { DREAMCONTEXT_SPLIT_FAIL_AFTER: 'agent' } });
  console.log(`      (crash run exited ${crash.status})`);
  const half = readdirSync(join(ctx(PROJ), 'agents')).filter((f) => f.endsWith('.md') && f !== `${CLASH}.md`);
  check('the crash left exactly one new agent file behind (the split died after writing it)',
    half.length === 1 && half[0] === `${SCHED}.md`, `agents/: ${half.join(', ')}`);
  // Guards "the split writes the automation before the agent" and "a crash leaves a half-rewritten file".
  check('…and that slot\'s legacy automation file is byte-identical, still in charge',
    read(autoFile(PROJ, SCHED)) === legacy[SCHED]);
  const backupRoot = join(HOME_A, '.dreamcontext', 'backups', 'agents-split');
  const backups = existsSync(backupRoot) ? readdirSync(backupRoot).map((d) => join(backupRoot, d, `${SCHED}.md`)).filter(existsSync) : [];
  check('…a machine-local backup of the legacy file exists, byte for byte (the restorable state)',
    backups.length === 1 && read(backups[0]) === legacy[SCHED], `backups: ${backups.join(', ') || '(none)'}`);
  // Guards a migrate-then-stamp that stamps even when a step died: the next update would never retry.
  check('…setupVersion is NOT stamped, so the next update retries', setupVersion() === LEGACY_VERSION, `setupVersion=${setupVersion()}`);
  check('…and no verdict moved while half-split (the legacy file wins on read)',
    JSON.stringify(verdicts(HOME_A)) === JSON.stringify(beforeA), JSON.stringify(verdicts(HOME_A)));

  const done = run(['update', '--yes']);
  check('the next `dreamcontext update` exits 0', done.status === 0, done.out.slice(-600));

  // ── what the split wrote ────────────────────────────────────────────────────────────────
  console.log('\n═══ The split ═══');
  check('agents/<slug>.md is written for the scheduled and both on-call manifests',
    [SCHED, CALL, CALL2].every((s) => existsSync(agentFile(PROJ, s))));
  const job = read(autoFile(PROJ, SCHED)) ?? '';
  // Guards a split that writes the agent file but leaves the automation self-contained.
  check('the scheduled automation is rewritten with `agent: digest` and loses its ## Prompt',
    /^agent: ['"]?digest['"]?$/m.test(job) && !/^## Prompt/m.test(job), job.slice(0, 400));
  check('the on-call manifests are gone from automations/ (the agent IS the file now)',
    !existsSync(autoFile(PROJ, CALL)) && !existsSync(autoFile(PROJ, CALL2)));
  check('the agent file carries the prompt and the on-call agent its call settings',
    (read(agentFile(PROJ, SCHED)) ?? '').includes('three-line summary')
      && /timeout_minutes: 20/.test(read(agentFile(PROJ, CALL)) ?? ''), read(agentFile(PROJ, CALL))?.slice(0, 400));
  check('setupVersion is stamped to this version: a conflict and a symlink never pin the vault (M4)',
    setupVersion() === VERSION, `setupVersion=${setupVersion()} version=${VERSION}`);

  // ── M1: every verdict unchanged, both homes, no registry write ──────────────────────────
  console.log('\n═══ M1. Verdicts ═══');
  const afterA = verdicts(HOME_A);
  const afterB = verdicts(HOME_B);
  // Guards a split whose composed hash drifts from the legacy hash (every approval would drop).
  check('every verdict on home A is unchanged', JSON.stringify(afterA) === JSON.stringify(beforeA),
    `before=${JSON.stringify(beforeA)}\n      after =${JSON.stringify(afterA)}`);
  check('every verdict on home B (which never ran the migration) is unchanged',
    JSON.stringify(afterB) === JSON.stringify(beforeB), `before=${JSON.stringify(beforeB)}\n      after =${JSON.stringify(afterB)}`);
  // Guards a migration that "keeps" approvals by re-approving (it would mask a hash drift).
  check('the migration wrote nothing to either approval registry',
    approvalsOf(HOME_A) === regA && approvalsOf(HOME_B) === regB);

  // ── M4: the conflict and the symlink ────────────────────────────────────────────────────
  console.log('\n═══ M4 / M6. Conflict and symlink ═══');
  const summary = ledgerSummary();
  check('the conflicting legacy file is untouched and the foreign agent file is not overwritten',
    read(autoFile(PROJ, CLASH)) === legacy[CLASH] && read(agentFile(PROJ, CLASH)) === foreignClash);
  check('…and the migration summary names it as a conflict', /conflict:[^;|]*\bclash\b/.test(summary), `summary: ${summary}`);
  check('the symlinked manifest is skipped: still a symlink, no agent file, named in the summary',
    lstatSync(autoFile(PROJ, LINKY)).isSymbolicLink() && !existsSync(agentFile(PROJ, LINKY)) && /\blinky\b/.test(summary),
    `summary: ${summary}`);
  // Guards the reader following a symlink (a manifest outside the brain would read and run).
  check('…and it never reads: neither automations nor agents list it',
    !(`automation:${LINKY}` in afterA) && !(`agent:${LINKY}` in afterA), JSON.stringify(Object.keys(afterA)));
  const doctor = run(['doctor']).out;
  check('`doctor` names the symlinked manifest', /symlinked manifest\(s\) skipped[^\n]*automations\/linky\.md/.test(doctor),
    doctor.split('\n').filter((l) => /Agents split/.test(l)).join(' | ') || doctor.slice(-400));
  check('`doctor` names the conflict', /conflicts with a legacy automation \([^)]*\bclash\b/.test(doctor),
    doctor.split('\n').filter((l) => /Agents split/.test(l)).join(' | '));

  // ── M2: idempotent byte for byte ────────────────────────────────────────────────────────
  console.log('\n═══ M2. Idempotent, and two machines agree ═══');
  const settled = treeBytes(PROJ);
  // Re-open the range so the step really runs again (a stamped vault would skip it, which
  // proves nothing about the step itself).
  setSetupVersion(LEGACY_VERSION);
  const again = run(['update', '--yes']);
  check('a second run of the step exits 0', again.status === 0, again.out.slice(-400));
  const resettled = treeBytes(PROJ);
  const changed = Object.keys({ ...settled, ...resettled }).filter((k) => settled[k] !== resettled[k]);
  check('…and leaves every agent and automation file byte-identical', changed.length === 0, `changed: ${changed.join(', ')}`);

  // The same legacy vault on a second machine, migrated there: identical bytes.
  cpSync(PRISTINE, TWIN, { recursive: true, verbatimSymlinks: true });
  const twin = run(['update', '--yes'], { home: HOME_B, cwd: TWIN });
  const twinTree = treeBytes(TWIN);
  const differ = Object.keys({ ...settled, ...twinTree }).filter((k) => settled[k] !== twinTree[k]);
  // Guards a split that writes a timestamp, a machine path or a random id into the files.
  check('a second machine migrating the same vault writes the same bytes', twin.status === 0 && differ.length === 0,
    `exit=${twin.status} differ: ${differ.join(', ')}`);

  // ── R3: re-stamp, then a teammate restores the old file ─────────────────────────────────
  console.log('\n═══ R3. Re-stamp, then restore ═══');
  cli(['agents', 'edit', CALL2, '--prompt', 'Watch the funnel and cite every number.']);
  const r3 = registryEntry(HOME_A);
  check('a local edit re-approves the agent directly here (agentApprovals[watcher])',
    !!r3?.agentApprovals?.[CALL2] && json(['agents', 'show', CALL2]).agent.approvedToRun === true, JSON.stringify(r3));
  // Guards the Invariant-2 delete: without it the old record would approve the restored file below.
  check('…and drops the legacy record approvals[watcher] in the same write', !r3?.approvals?.[CALL2], JSON.stringify(r3?.approvals));
  writeFileSync(autoFile(PROJ, CALL2), legacy[CALL2]);
  const restoredR3 = json(['agents', 'show', CALL2]).agent;
  const autoR3 = json(['automations', 'list']).find((m) => m.slug === CALL2);
  check('the byte-for-byte restored legacy file is BLOCKED here: not approved to run, not for chat',
    restoredR3.approvedToRun === false && restoredR3.approvedForChat === false, JSON.stringify(restoredR3));
  check('…and the run path, which reads it as an automation, is blocked too', autoR3?.approved === false, JSON.stringify(autoR3));
  check('…while home B, which edited nothing, still approves the restored file (the block is this machine\'s)',
    json(['agents', 'show', CALL2], { home: HOME_B }).agent.approvedToRun === true);

  // ── R6: delete with an unreadable slot, then restore ────────────────────────────────────
  console.log('\n═══ R6. Revoke on delete ═══');
  writeFileSync(autoFile(PROJ, CALL), '---\ntitle: [unclosed\n---\n');
  const removed = run(['agents', 'remove', CALL, '-y']);
  check('`agents remove helper` succeeds while its slot is unreadable', removed.status === 0 && !existsSync(agentFile(PROJ, CALL)), removed.out.slice(-300));
  const r6 = registryEntry(HOME_A);
  // Guards a delete that only drops agentApprovals and leaves approvals[x] (the legacy record).
  check('…and revokes the legacy record approvals[helper]', !r6?.approvals?.[CALL] && !r6?.agentApprovals?.[CALL], JSON.stringify(r6));
  writeFileSync(autoFile(PROJ, CALL), legacy[CALL]);
  const restoredR6 = json(['agents', 'show', CALL]).agent;
  const autoR6 = json(['automations', 'list']).find((m) => m.slug === CALL);
  check('the restored legacy file stays BLOCKED here, as an agent and as an automation',
    restoredR6.approvedToRun === false && autoR6?.approved === false, JSON.stringify({ restoredR6, autoR6 }));
  check('…while home B still approves it (its registry was never touched)',
    json(['agents', 'show', CALL], { home: HOME_B }).agent.approvedToRun === true);

  // ── M6 on the Agents page, both themes ──────────────────────────────────────────────────
  console.log('\n═══ M6. The Agents page reads the result ═══');
  const port = await freePort();
  const srv = await startServer(port);
  try {
    for (const theme of ['light', 'dark']) {
      const browser = await chromium.launch();
      const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, colorScheme: theme });
      await setTheme(context, theme);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(`http://127.0.0.1:${port}/?vault=proj`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      for (let i = 0; i < 4 && (await page.locator('.announcements-modal-scrim').count()); i++) {
        await page.keyboard.press('Escape'); await page.waitForTimeout(300);
      }
      await page.locator('.sidebar-item').filter({ has: page.locator('.sidebar-label', { hasText: /^Agents$/ }) }).first().click();
      await page.locator('[data-agent]').first().waitFor({ timeout: 15000 }).catch(() => {});
      const slugs = await page.locator('[data-agent]').evaluateAll((els) => els.map((e) => e.getAttribute('data-agent')));
      check(`[${theme}] the roster shows the migrated agents and the never-migrated legacy one`,
        [SCHED, CALL2, CLASH].every((s) => slugs.includes(s)), slugs.join(', '));
      check(`[${theme}] …and never the symlinked manifest`, !slugs.includes(LINKY), slugs.join(', '));
      const runChip = await page.locator(`[data-agent="${SCHED}"] [data-approval="run"]`).getAttribute('class').catch(() => '');
      const chatChip = await page.locator(`[data-agent="${SCHED}"] [data-approval="chat"]`).getAttribute('class').catch(() => '');
      check(`[${theme}] the migrated scheduled agent reads approved for chat, not to run (unchanged)`,
        /--ok/.test(chatChip ?? '') && /--no/.test(runChip ?? ''), `chat=${chatChip} run=${runChip}`);
      await page.screenshot({ path: join(SHOTS, `agents-page-${theme}.png`) });
      check(`[${theme}] no uncaught page errors`, errors.length === 0, errors.slice(0, 2).join(' | '));
      await browser.close();
    }
  } finally {
    srv.kill();
  }
}

main()
  .catch((err) => { report.fail++; console.log(`\n  FAIL run crashed: ${err && err.stack ? err.stack : err}`); })
  .finally(() => {
    console.log(`\n${report.fail === 0 ? 'PASS' : 'FAIL'}: ${report.pass} passed, ${report.fail} failed`);
    console.log(`  screenshots: ${SHOTS}`);
    process.exit(report.fail === 0 ? 0 : 1);
  });
