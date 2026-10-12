#!/usr/bin/env node
/**
 * Every agent gets a soul, a visible pattern, and a team-roster Agents page, end to end.
 *
 *   npm run build && npm run verify:agents-soul
 *
 * Drives the REAL dashboard against the REAL `/api/agents*` and `/api/automations*` routes, the
 * REAL approval registry and the REAL Chat spawn, in Chromium, in both themes.
 *
 * THE FIXTURE (made by the real CLI): the agents-page fixture (`digest` legacy scheduled, may chat
 * but not run; `helper` legacy on-call; `scout` explicit, with `morning-scout` running as it),
 * plus: scout gets a soul from `--soul-template careful-researcher` and two lessons; `quiet` has
 * learning on and no pattern; `helper` has learning off.
 *
 * WHAT IT PROVES, each check naming the mutation it guards:
 *   1. the roster: one portrait per agent (face, name, role line = first prompt line, soul
 *      excerpt or the no-soul line, "Works on" matching usedBy, the API's approval state), no chip;
 *   2. the "Add to team" seat is the last grid item and opens the create dialog;
 *   3. a template fills the soul with exactly its text, Undo after a second pick restores the
 *      edited text, Save writes `## Soul` = that text, no template id lands on disk, and it is ready;
 *   4. the profile: sections in order soul, job, pattern, usage, approval; two lessons newest
 *      first; the pattern-empty and learning-off sentences;
 *   5. a dialog soul edit keeps it ready (restamp); a synced `## Soul` edit makes it EXACTLY
 *      needs-approval, the review shows `soul:`, and a schedule-only save on the Automations
 *      side does not approve it (B1); 5b: a `## ` line disables Save with its sentence;
 *   6. Talk to it: the spawned session's briefing carries `--- HOW YOU WORK` and the soul;
 *   7. both themes, MEASURED: text contrast >= 4.5, the dot against its card >= 3, the soul
 *      excerpt's 2px left rule, strong fills 0 on the roster and 1 with a profile open, the
 *      12/14/16 px and 400/600 type scale on the grid (the avatar initials excluded), no em dash.
 *
 * WHAT IT DOES NOT TOUCH: your machine. Fake HOME, scratch project, `claude` replaced by a stand-in
 * that answers a chat turn with an echo, logs its argv and briefing, and spends nothing.
 *
 * FAILURE POLICY: collect, don't fail fast. Exit 0 iff every check passed.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import {
  chromeText, contrast, dashLines, distIndex, effectiveBg, scratchDir, setTheme, shotsDir, strongFills, textLadder,
} from './lib/measure.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST_INDEX = distIndex(REPO);
const SCRATCH = scratchDir('dc-verify-agents-soul');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const CONTEXT_ROOT = join(PROJ, '_dream_context');
const SHOTS = process.env.DC_VERIFY_SHOTS || shotsDir(REPO, 'agents-soul');
const ARGV_LOG = join(HOME, 'claude-argv.log');

const SCHED = 'digest';
const CALL = 'helper';
const SCOUT = 'scout';
const QUIET = 'quiet';
const NEW_TITLE = 'Reviewer';
const NEW_SLUG = 'reviewer';
const SCOUT_PROMPT = 'You read the project and report what changed, briefly.\nKeep it to the facts.';
const LESSON_OLD = 'The changelog is newest-first; read the top entries only.';
const LESSON_NEW = 'Name the file for every change, never just the topic.';

/** The template texts, read from their ONE owner (never retyped here). */
function templateText(id) {
  const src = readFileSync(join(REPO, 'src', 'lib', 'agents', 'soul-templates.ts'), 'utf-8');
  const at = src.indexOf(`id: '${id}'`);
  const open = src.indexOf('text: [', at) + 'text: '.length;
  const close = src.indexOf('].join(', open) + 1;
  // Our own source file, a plain array of string literals.
  return new Function(`return ${src.slice(open, close)}`)().join('\n');
}

/** A chat turn's stand-in: logs argv and briefing, answers with an echo. */
const STANDIN = `#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? null : (argv[i + 1] ?? null); };
let briefing = '';
const briefPath = flag('--append-system-prompt-file');
if (briefPath) { try { briefing = readFileSync(briefPath, 'utf-8'); } catch { briefing = ''; } }
try { appendFileSync(${JSON.stringify(ARGV_LOG)}, JSON.stringify({ argv, briefing }) + '\\n'); } catch {}
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'user') continue;
    out({ type: 'system', subtype: 'init', session_id: 'verify-agents-soul', model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'default', slash_commands: [] });
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello.' }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'DONE', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: 'verify-agents-soul' });
  }
});
process.stdin.on('end', () => process.exit(0));
`;

const report = { pass: 0, fail: 0 };
function check(label, ok, ev = '') {
  if (ok) { report.pass++; console.log(`  PASS ${label}`); }
  else { report.fail++; console.log(`  FAIL ${label}${ev ? `\n      ${ev}` : ''}`); }
}

/** The fake HOME, minus anything that makes the CLI think it runs inside a Claude session. */
function cleanEnv(extra = {}) {
  const env = { ...process.env, HOME };
  for (const k of Object.keys(env)) {
    if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_') || k.startsWith('DREAMCONTEXT_')) delete env[k];
  }
  return { ...env, ...extra };
}

function cli(args) {
  const r = spawnSync(process.execPath, [DIST_INDEX, ...args], { cwd: PROJ, env: cleanEnv(), encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`cli ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf-8') : '');
const agentFile = (slug) => join(CONTEXT_ROOT, 'agents', `${slug}.md`);
/** The `## Soul` section of a file, verbatim between its heading and the next `## `. */
function soulSection(text) {
  const m = /(?:^|\n)## Soul\n\n([\s\S]*?)(?=\n## |\s*$)/.exec(text);
  return m ? m[1].trim() : null;
}

function registryEntry() {
  const p = join(HOME, '.dreamcontext', 'automations.json');
  if (!existsSync(p)) return null;
  const reg = JSON.parse(readFileSync(p, 'utf-8'));
  const key = Object.keys(reg.projects ?? {}).find((k) => k.endsWith(`${sep}proj`));
  return key ? reg.projects[key] : null;
}

function seed() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  mkdirSync(join(HOME, '.local', 'bin'), { recursive: true });
  mkdirSync(join(CONTEXT_ROOT, 'core'), { recursive: true });
  mkdirSync(join(CONTEXT_ROOT, 'state'), { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  writeFileSync(join(CONTEXT_ROOT, 'state', '.config.json'), JSON.stringify({
    platforms: [], packs: [], setupVersion: '1', brainRepo: { mode: 'in-tree', enabled: false },
  }));
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false,
    hotkey: 'Ctrl+A', renderer: 'dom', chatView: true, screenMigrated: true,
    chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '',
  }, null, 2)}\n`);
  spawnSync('git', ['init', '-q'], { cwd: PROJ });
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  cli(['vaults', 'add', 'proj', PROJ]);

  const promptFile = join(SCRATCH, 'prompt.md');
  writeFileSync(promptFile, 'Read yesterday\'s insights and write a three-line summary.\n');
  cli(['automations', 'create', SCHED, '--title', 'Daily digest', '--days', 'daily', '--at', '18:00', '--prompt-file', promptFile]);
  cli(['automations', 'create', CALL, '--title', 'Helper', '--mode', 'call', '--timeout', '20', '--prompt-file', promptFile]);
  cli(['agents', 'edit', CALL, '--no-learning']);
  cli(['agents', 'create', SCOUT, '--title', 'Scout', '--prompt', SCOUT_PROMPT, '--soul-template', 'careful-researcher']);
  cli(['automations', 'create', 'morning-scout', '--title', 'Morning scout', '--agent', SCOUT,
    '--job', 'Every morning, list what changed in the brain yesterday.', '--days', 'daily', '--at', '08:00']);
  cli(['automations', 'learn', SCOUT, '--lesson', LESSON_OLD]);
  cli(['automations', 'learn', SCOUT, '--lesson', LESSON_NEW]);
  cli(['agents', 'create', QUIET, '--title', 'Quiet helper', '--prompt', 'You answer quick questions about the roadmap.']);
}

const freePort = () => new Promise((res, rej) => {
  const s = createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

async function startServer(port) {
  const PATH = [join(HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [DIST_INDEX, 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ, env: { ...cleanEnv(), PATH, DREAMCONTEXT_DESKTOP: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return srv; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  srv.kill();
  throw new Error('server did not come up');
}

const api = async (base, path, body) => {
  const r = await fetch(`${base}/api${path}`, body === undefined
    ? { headers: { 'x-dreamcontext-vault': 'proj' } }
    : { method: 'POST', headers: { 'content-type': 'application/json', 'x-dreamcontext-vault': 'proj' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

/** Mirrors the dashboard's `approvalState`: three states from the two verdicts. */
const stateOf = (a) => (!a.approvedForChat ? 'needs-approval' : a.approvedToRun ? 'ready' : 'cant-run');

async function openPage(browser, theme, url) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, colorScheme: theme });
  await setTheme(context, theme);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  for (let i = 0; i < 4 && (await page.locator('.announcements-modal-scrim').count()); i++) {
    await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  }
  const until = async (fn, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(150); }
    return false;
  };
  const gotoAgents = async () => {
    await page.locator('.sidebar-item').filter({ has: page.locator('.sidebar-label', { hasText: /^Agents$/ }) }).first().click();
    await until(async () => (await page.locator('.agr-card').count()) > 0);
  };
  return { context, page, errors, until, gotoAgents };
}

const cardState = (page, slug) => page.locator(`[data-agent="${slug}"]`).first().getAttribute('data-approval-state').catch(() => null);

async function functional(browser, base) {
  const { context, page, errors, until, gotoAgents } = await openPage(browser, 'light', `${base}/?vault=proj`);
  try {
    await gotoAgents();

    // ── 1: the roster ─────────────────────────────────────────────────────────────────────
    console.log('\n═══ 1. The team roster ═══');
    const agents = (await api(base, '/agents')).body?.agents ?? [];
    await until(async () => (await page.locator('.agr-card').count()) === agents.length);
    // Guards a roster read from a different source than the API (a missing or extra card).
    check('one portrait card per agent the API lists', (await page.locator('.agr-card').count()) === agents.length && agents.length >= 4,
      `cards=${await page.locator('.agr-card').count()} api=${agents.length}`);
    for (const a of agents) {
      const card = page.locator(`[data-agent="${a.slug}"]`);
      const name = (await card.locator('.agr-name').innerText().catch(() => '')).trim();
      const role = (await card.locator('.agr-role').innerText().catch(() => '')).trim();
      const soul = card.locator('.agr-soul');
      const soulEmpty = (await soul.getAttribute('class').catch(() => '')).includes('agr-soul--empty');
      const works = (await card.locator('.agr-works').innerText().catch(() => '')).trim();
      const used = a.usedBy;
      const worksOk = used.automations.length + used.boards.length + used.tasks.length === 0
        ? /Not working anywhere yet/.test(works)
        : (!used.automations.length || works.includes(`Automations ${used.automations.length}`))
          && (!used.boards.length || works.includes(`Boards ${used.boards.length}`))
          && (!used.tasks.length || works.includes(`Tasks ${used.tasks.length}`));
      const state = await cardState(page, a.slug);
      // Guards: the role line read from anything but the prompt's first line; the soul excerpt
      // missing (or shown for an agent with none); usage counts drifting; the state folded.
      check(`[${a.slug}] face, name, role line, soul, works on, state, no chip`,
        (await card.locator('.agent-av').count()) === 1
          && name === a.title
          && role === a.roleLine && a.roleLine.length > 0
          && (a.soulExcerpt ? !soulEmpty && (await soul.innerText()).trim() === a.soulExcerpt : soulEmpty)
          && worksOk
          && state === stateOf(a)
          && (await card.locator('.agr-chip').count()) === 0,
        `name="${name}" role="${role}" api.role="${a.roleLine}" soulEmpty=${soulEmpty} works="${works}" state=${state} api=${stateOf(a)}`);
    }
    const scoutApi = agents.find((a) => a.slug === SCOUT);
    check('scout\'s role line is the FIRST line of its prompt', scoutApi?.roleLine === SCOUT_PROMPT.split('\n')[0], scoutApi?.roleLine);
    check('the legacy scheduled agent reads cant-run, never ready', (await cardState(page, SCHED)) === 'cant-run');

    // ── 2: the seat ───────────────────────────────────────────────────────────────────────
    console.log('\n═══ 2. The "Add to team" seat ═══');
    const lastIsSeat = await page.locator('.arp-grid > li').last().locator('[data-add-to-team]').count();
    check('the last grid item is the "Add to team" seat', lastIsSeat === 1);
    await page.locator('[data-add-to-team]').click();
    check('…and it opens the create dialog', await until(async () => (await page.locator('.aid-modal').count()) === 1));

    // ── 3: templates fill only the text ───────────────────────────────────────────────────
    console.log('\n═══ 3. A template fills the soul; Undo; nothing recorded ═══');
    const soulInput = page.locator('[data-soul-input]');
    check('the soul starts empty', (await soulInput.inputValue()) === '');
    await page.locator('[data-soul-template="harsh-reviewer"]').click();
    const harsh = templateText('harsh-reviewer');
    // Guards a pick that appends, trims or rewrites the template.
    check('"Harsh reviewer" fills the soul with exactly the template text', (await soulInput.inputValue()) === harsh,
      (await soulInput.inputValue()).slice(0, 80));
    const edited = `${harsh}\n- Keep every finding to two lines.`;
    await soulInput.fill(edited);
    await page.locator('[data-soul-template="calm-helper"]').click();
    check('a second pick replaces the edited text…', (await soulInput.inputValue()) === templateText('calm-helper'));
    await page.locator('[data-soul-undo]').click();
    // Guards an Undo that restores the first template instead of the owner's edit.
    check('…and Undo restores the edited text', (await soulInput.inputValue()) === edited);
    await page.locator('.aid-modal .aid-input').first().fill(NEW_TITLE);
    await page.locator('.aid-modal .aid-textarea').first().fill('You review pull requests before they merge.');
    await page.locator('.aid-modal .aid-btn--primary').click();
    const saved = await until(async () => soulSection(read(agentFile(NEW_SLUG))) === edited, 15000);
    check('Save writes `## Soul` equal to the edited text', saved, read(agentFile(NEW_SLUG)).slice(0, 400));
    const onDisk = read(agentFile(NEW_SLUG));
    // Guards anything recording the pick (a frontmatter key, a comment, the id in the body).
    check('…and no template id is on disk', !/harsh-reviewer|calm-helper|soulTemplate|template:/i.test(onDisk));
    check('…and the new agent is ready', await until(async () => (await cardState(page, NEW_SLUG)) === 'ready', 10000),
      `state=${await cardState(page, NEW_SLUG)}`);

    // ── 4: the profile ────────────────────────────────────────────────────────────────────
    console.log('\n═══ 4. The profile: soul, job, pattern ═══');
    await page.locator(`[data-agent="${SCOUT}"]`).click();
    const prof = `[data-agent-profile="${SCOUT}"]`;
    await until(async () => (await page.locator(`${prof} [data-lesson]`).count()) > 0);
    const order = await page.locator(`${prof} [data-section]`).evaluateAll((els) => els.map((e) => e.getAttribute('data-section')));
    // Guards the old order (approval first, the prompt under "Who it is", no soul or pattern).
    check('sections in DOM order soul, job, pattern, usage, approval',
      JSON.stringify(order) === JSON.stringify(['soul', 'job', 'pattern', 'usage', 'approval']), order.join(','));
    const scoutSoul = templateText('careful-researcher');
    const soulShown = await page.locator(`${prof} .agp-soul`).innerText().catch(() => '');
    check('the soul is shown, its bullets as a real list',
      soulShown.includes(scoutSoul.split('\n')[0]) && (await page.locator(`${prof} .agp-soul ul li`).count()) === scoutSoul.split('\n').filter((l) => l.startsWith('- ')).length,
      soulShown.slice(0, 120));
    const lessons = await page.locator(`${prof} [data-lesson] .agp-lesson-text`).allInnerTexts();
    // Guards lessons shown oldest first, or the pattern not read at all.
    check('two lessons, newest first', lessons.length === 2 && lessons[0] === LESSON_NEW && lessons[1] === LESSON_OLD, lessons.join(' | '));
    await page.locator(`[data-agent="${QUIET}"]`).click();
    check('learning on, nothing learned: the pattern-empty sentence',
      await until(async () => /Nothing learned yet/.test(await page.locator(`[data-agent-profile="${QUIET}"] [data-section="pattern"]`).innerText())));
    await page.locator(`[data-agent="${CALL}"]`).click();
    check('learning off: the learning-off sentence',
      await until(async () => /Learning is off/.test(await page.locator(`[data-agent-profile="${CALL}"] [data-section="pattern"]`).innerText())));

    // ── 6: Talk to it carries the soul ────────────────────────────────────────────────────
    console.log('\n═══ 6. Talk to it: the spawn is briefed with the soul ═══');
    rmSync(ARGV_LOG, { force: true });
    await page.locator(`[data-agent="${SCOUT}"]`).click();
    await until(async () => (await page.locator(prof).count()) === 1);
    await page.locator(`${prof} .agp-actions .agp-btn--primary`).click();
    const briefed = await until(async () => read(ARGV_LOG).split('\n').filter(Boolean).some((l) => {
      const { briefing } = JSON.parse(l);
      return briefing.includes('--- HOW YOU WORK') && briefing.includes(scoutSoul.split('\n')[0]);
    }), 25000);
    // Guards the soul missing from the Chat-tab briefing (site C).
    check('the spawned session\'s briefing has `--- HOW YOU WORK` and the soul\'s first sentence', briefed,
      read(ARGV_LOG).slice(0, 200) || '(no spawn logged)');
    rmSync(join(CONTEXT_ROOT, 'state', '.agent-sessions.json'), { force: true });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    await gotoAgents();

    // ── 5: approval follows the soul ──────────────────────────────────────────────────────
    console.log('\n═══ 5. A soul edit here re-approves; a synced one does not ═══');
    await page.locator(`[data-agent="${SCOUT}"]`).click();
    await until(async () => (await page.locator(prof).count()) === 1);
    await page.locator(`${prof} .agp-actions .agp-btn`, { hasText: /^Edit$/ }).click();
    await until(async () => (await page.locator('[data-soul-input]').inputValue()) === scoutSoul, 10000);
    const scoutEdited = `${scoutSoul}\n- Say which sources you skipped.`;
    await page.locator('[data-soul-input]').fill(scoutEdited);
    await page.locator('.aid-modal .aid-btn--primary').click();
    await until(async () => soulSection(read(agentFile(SCOUT))) === scoutEdited, 15000);
    // Guards a soul edit that drops the direct grant (restamp skipped).
    check('a dialog soul edit keeps scout ready (re-stamped)',
      soulSection(read(agentFile(SCOUT))) === scoutEdited && await until(async () => (await cardState(page, SCOUT)) === 'ready', 10000),
      `state=${await cardState(page, SCOUT)}`);

    const synced = read(agentFile(SCOUT)).replace('Say which sources you skipped.', 'Say which sources a teammate skipped.');
    writeFileSync(agentFile(SCOUT), synced);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    await gotoAgents();
    // Guards a soul left out of the hash (the card would still read ready), and a soul that
    // lends chat through the binding (it would read cant-run).
    check('a synced `## Soul` edit makes scout EXACTLY needs-approval',
      await until(async () => (await cardState(page, SCOUT)) === 'needs-approval', 10000), `state=${await cardState(page, SCOUT)}`);
    const review = (await api(base, `/agents/${SCOUT}`)).body?.review ?? '';
    check('…and its review shows the `soul:` line', /(^|\n)soul:/.test(review) && review.includes('a teammate skipped'), review.slice(-200));
    const upd = await api(base, '/automations/morning-scout/update', { days: 'daily', at: '09:30' });
    const auto = ((await api(base, '/automations')).body?.automations ?? []).find((a) => a.slug === 'morning-scout');
    // Guards B1: a schedule-only save on the Automations side approving a soul nobody here saw.
    check('a schedule-only save of morning-scout does not approve it (needsApproval, still unapproved)',
      upd.status === 200 && upd.body?.needsApproval === true && auto && auto.approved === false,
      `status=${upd.status} needsApproval=${upd.body?.needsApproval} approved=${auto?.approved}`);
    check('…and scout still needs approval', (await cardState(page, SCOUT)) === 'needs-approval'
      || (await page.reload(), await gotoAgents(), (await cardState(page, SCOUT)) === 'needs-approval'));

    // ── 5b: the `## ` refusal ─────────────────────────────────────────────────────────────
    console.log('\n═══ 5b. A "## " line is refused in the dialog ═══');
    await page.locator('[data-add-to-team]').click();
    await until(async () => (await page.locator('.aid-modal').count()) === 1);
    await page.locator('.aid-modal .aid-input').first().fill('Tone test');
    await page.locator('.aid-modal .aid-textarea').first().fill('You test tone.');
    await page.locator('[data-soul-input]').fill('Be brief.\n## Tone\nDry.');
    const err = await page.locator('[data-soul-error]').innerText().catch(() => '');
    // Guards a dialog that lets a heading line through (it would truncate the section on read).
    check('Save is disabled and the heading-line sentence shows',
      await page.locator('.aid-modal .aid-btn--primary').isDisabled() && err.includes('cannot contain a line that starts with "## "'), err);
    await page.locator('.aid-modal .aid-btn', { hasText: /^Cancel$/ }).click();

    check('[light] no uncaught page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await context.close();
  }
}

/** Dot against its card: WCAG contrast of the dot's fill over the card's painted background. */
async function dotVsCard(dot) {
  return dot.evaluate((el) => {
    const parse = (s) => (s.match(/-?[\d.]+/g) || []).map(Number);
    let card = el.closest('.agr-card, .agp-panel');
    let bg = [255, 255, 255];
    for (let n = card; n; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if ((c.length > 3 ? c[3] : 1) >= 1) { bg = c.slice(0, 3); break; }
    }
    const fill = parse(getComputedStyle(el).backgroundColor).slice(0, 3);
    const lum = (c) => {
      const [r, g, b] = c.map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const l1 = lum(fill); const l2 = lum(bg);
    return Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 100) / 100;
  });
}

async function themed(browser, base, theme) {
  console.log(`\n═══ 7. ${theme}: measured ═══`);
  const { context, page, errors, until, gotoAgents } = await openPage(browser, theme, `${base}/?vault=proj`);
  try {
    await gotoAgents();
    await page.waitForTimeout(500);
    const low = [];
    for (const sel of ['.agr-name', '.agr-role', '.agr-soul', '.agr-state', '.agr-works']) {
      const all = page.locator(`.arp-grid ${sel}`);
      for (let i = 0; i < await all.count(); i++) {
        const c = await contrast(all.nth(i));
        if (c < 4.5) low.push(`${sel}#${i}=${c}`);
      }
    }
    // Guards a tertiary-on-tinted or secondary-on-filled pairing that falls under AA.
    check(`[${theme}] every card's name, role, soul, state and works line has contrast >= 4.5`, low.length === 0, low.join(' '));
    const dots = page.locator('.arp-grid .agr-dot');
    const dotLow = [];
    for (let i = 0; i < await dots.count(); i++) { const c = await dotVsCard(dots.nth(i)); if (c < 3) dotLow.push(c); }
    check(`[${theme}] every attention dot reads against its card (>= 3), and there are some`, (await dots.count()) > 0 && dotLow.length === 0,
      `dots=${await dots.count()} low=${dotLow.join(',')}`);
    const readyDots = await page.locator('[data-approval-state="ready"] .agr-dot').count();
    check(`[${theme}] a ready card has no dot`, readyDots === 0, `dots on ready=${readyDots}`);
    const excerpt = page.locator('.agr-soul:not(.agr-soul--empty)').first();
    const rule = await excerpt.evaluate((el) => ({ w: getComputedStyle(el).borderLeftWidth, c: getComputedStyle(el).borderLeftColor, bg: getComputedStyle(el).backgroundColor }));
    const cardBg = await effectiveBg(excerpt);
    // Guards U1: an excerpt told apart by a fill that equals the card colour (invisible).
    check(`[${theme}] the soul excerpt has a 2px left rule unlike the card, and no fill of its own`,
      rule.w === '2px' && rule.c !== cardBg && /rgba\(0, 0, 0, 0\)|transparent/.test(rule.bg), JSON.stringify({ ...rule, cardBg }));
    const fills0 = await strongFills(page, '.arp');
    check(`[${theme}] no strong accent fill on the roster`, fills0.length === 0, fills0.join(' | '));
    const ladder = await textLadder(page, '.arp-grid', ['.agent-av'], ['12px', '14px', '16px'], ['400', '600']);
    check(`[${theme}] the grid keeps to 12/14/16 px and 400/600 (avatar initials excluded)`, ladder.offenders.length === 0,
      `${ladder.sizes.join(',')} / ${ladder.weights.join(',')} ${ladder.offenders.join(' | ')}`);
    await page.screenshot({ path: join(SHOTS, `01-team-roster-${theme}.png`) });

    await page.locator(`[data-agent="${SCOUT}"]`).click();
    const prof = `[data-agent-profile="${SCOUT}"]`;
    await until(async () => (await page.locator(`${prof} [data-lesson]`).count()) > 0);
    await page.waitForTimeout(500);
    const profLow = [];
    for (const sel of ['.agp-soul .agp-para', '.agp-soul li', '.agp-lesson-text', '.agp-lesson-date']) {
      const all = page.locator(`${prof} ${sel}`);
      for (let i = 0; i < await all.count(); i++) { const c = await contrast(all.nth(i)); if (c < 4.5) profLow.push(`${sel}#${i}=${c}`); }
    }
    check(`[${theme}] the profile's soul and lesson rows have contrast >= 4.5`, profLow.length === 0, profLow.join(' '));
    const fills1 = await strongFills(page, '.arp');
    // Guards a second filled button next to Talk to it (or Talk losing its fill).
    check(`[${theme}] exactly one strong fill with the profile open (Talk to it)`, fills1.length === 1 && /Talk to it/.test(fills1[0]), fills1.join(' | '));
    const text = await chromeText(page, '.arp', ['.agr-name', '.agr-role', '.agr-soul', '.agp-name', '.agp-role', '.agp-soul', '.agp-prompt', '.agp-playbook', '.agp-lesson-text', '.agp-list-name', '.agp-review-text']);
    check(`[${theme}] no em dash in the page's own text`, dashLines(text).length === 0, dashLines(text).join(' | '));
    await page.screenshot({ path: join(SHOTS, `02-profile-soul-pattern-${theme}.png`) });

    await page.locator('[data-add-to-team]').click();
    await until(async () => (await page.locator('[data-soul-input]').count()) === 1);
    await page.locator('[data-soul-input]').fill('My own words about how it works.');
    await page.locator('[data-soul-template="harsh-reviewer"]').click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS, `03-dialog-soul-templates-${theme}.png`) });
    await page.keyboard.press('Escape');
    check(`[${theme}] no uncaught page errors`, errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await context.close();
  }
}

async function main() {
  console.log('· fixture: fake HOME, stand-in claude, digest + helper + scout (soul, 2 lessons) + quiet');
  seed();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const srv = await startServer(port);
  const browser = await chromium.launch();
  try {
    await functional(browser, base);
    for (const theme of ['light', 'dark']) {
      rmSync(join(CONTEXT_ROOT, 'state', '.agent-sessions.json'), { force: true });
      await themed(browser, base, theme);
    }
  } finally {
    await browser.close();
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
