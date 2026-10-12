#!/usr/bin/env node
/**
 * The Agents page (S1, S7), end to end in the real dashboard.
 *
 *   npm run build && npm run verify:agents-page
 *
 * An agent is its own entity now (`_dream_context/agents/<slug>.md`) with its own rail page.
 * This drives that page against the REAL server, the REAL `/api/agents*` routes, the REAL
 * approval registry and the REAL Chat surface, in Chromium.
 *
 * THE FIXTURE (made by the real CLI): one legacy scheduled automation (`digest`: its implicit
 * agent may chat through the automation's approval but may NOT run), one legacy on-call agent
 * (`helper`, with call settings of its own), one explicit agent (`scout`) and an automation that
 * runs as it (`morning-scout`, so `scout` is in use).
 *
 * WHAT IT PROVES, each check naming the mutation it guards:
 *   1. the rail has one Agents row and it opens the page;
 *   2. the roster shows every agent as a chip-less portrait whose quiet state keeps the two verdicts
 *      apart (ready / cant-run / needs-approval, never one "approved");
 *   3. `page/agents/<slug>` opens that agent's profile (with its read-only call settings);
 *   4. the identity dialog creates an agent (file on disk, approved here) and edits its prompt;
 *   5. the in-place Approve shows the review, grants it, and flips the run chip;
 *   6. deleting an agent in use arms first, then is refused in place, naming the automation;
 *   7. "Talk to it" opens a NEW Chat conversation as that agent;
 *   8. both themes: roster, profile and review screenshots, and no em dash in the page's text.
 *
 * WHAT IT DOES NOT TOUCH: your machine. Fake HOME, scratch project, `claude` replaced by a
 * stand-in on that HOME's PATH that answers a chat turn with an echo and spends nothing.
 *
 * FAILURE POLICY: collect, don't fail fast. Exit 0 iff every check passed.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { chromeText, dashLines, distIndex, scratchDir, setTheme, shotsDir } from './lib/measure.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST_INDEX = distIndex(REPO);
const SCRATCH = scratchDir('dc-verify-agents-page');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const CONTEXT_ROOT = join(PROJ, '_dream_context');
const SHOTS = shotsDir(REPO, 'agents-page');

const SCHED = 'digest';
const CALL = 'helper';
const SCOUT = 'scout';
const NEW_TITLE = 'Researcher';
const NEW_SLUG = 'researcher';
const NEW_PROMPT = 'You research a topic in depth and always cite your sources.';
const EDITED_PROMPT = 'You research competitors, cite every source, and end with three open questions.';

/** A chat turn's stand-in: it answers with who it was briefed to be, so a real spawn is visible. */
const STANDIN = `#!${process.execPath}
import { readFileSync } from 'node:fs';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? null : (argv[i + 1] ?? null); };
let briefing = '';
const briefPath = flag('--append-system-prompt-file');
if (briefPath) { try { briefing = readFileSync(briefPath, 'utf-8'); } catch { briefing = ''; } }
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'user') continue;
    const who = briefing.match(/You are "([^"]+)"/);
    out({ type: 'system', subtype: 'init', session_id: 'verify-agents-page', model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'default', slash_commands: [] });
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'I am ' + (who ? who[1] : 'Claude') + '.' }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'DONE', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: 'verify-agents-page' });
  }
});
process.stdin.on('end', () => process.exit(0));
`;

/** Records every chat socket the page opens, so a NEW conversation is told apart from a resume. */
const WS_SPY = `
  window.__dcChatSockets = [];
  const Native = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    try { if (String(url).includes('/api/agent/chat')) window.__dcChatSockets.push(String(url)); } catch {}
    return protocols === undefined ? new Native(url) : new Native(url, protocols);
  };
  window.WebSocket.prototype = Native.prototype;
  Object.assign(window.WebSocket, Native);
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

/** This project's entry in the fake HOME's approval registry (keys may be `/private/var/…`). */
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
  // Chat on, so "Talk to it" has a surface to open the conversation in.
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
  // Legacy, self-contained files (no --agent), auto-approved here, as 0.30 made them.
  cli(['automations', 'create', SCHED, '--title', 'Daily digest', '--days', 'daily', '--at', '18:00', '--prompt-file', promptFile]);
  cli(['automations', 'create', CALL, '--title', 'Helper', '--mode', 'call', '--timeout', '20', '--prompt-file', promptFile]);
  // An explicit agent, and an automation that runs as it.
  cli(['agents', 'create', SCOUT, '--title', 'Scout', '--prompt', 'You read the project and report what changed, briefly.']);
  cli(['automations', 'create', 'morning-scout', '--title', 'Morning scout', '--agent', SCOUT,
    '--job', 'Every morning, list what changed in the brain yesterday.', '--days', 'daily', '--at', '08:00']);
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

/** A page in one theme, with the socket spy and the What's New popup out of the way. */
async function openPage(browser, theme, url) {
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, colorScheme: theme });
  await setTheme(context, theme);
  await context.addInitScript(WS_SPY);
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
  const agentsRow = () => page.locator('.sidebar-item').filter({ has: page.locator('.sidebar-label', { hasText: /^Agents$/ }) });
  return { context, page, errors, until, agentsRow };
}

/** A roster card's quiet approval state (`ready` / `cant-run` / `needs-approval`). */
const cardState = (page, slug) => page.locator(`[data-agent="${slug}"]`).first().getAttribute('data-approval-state').catch(() => null);
const chip = (page, scope, kind) => page.locator(`${scope} [data-approval="${kind}"]`).first();
/** The profile marks a verdict on its ROW (`data-approved`), with the chip inside it; both must agree. */
const rowApproved = async (page, scope, kind) => {
  const row = chip(page, scope, kind);
  return (await row.getAttribute('data-approved').catch(() => null)) === 'true'
    && /--ok\b/.test((await row.locator('.agr-chip').first().getAttribute('class').catch(() => '')) ?? '');
};

async function functional(browser, base) {
  const { context, page, errors, until, agentsRow } = await openPage(browser, 'light', `${base}/?vault=proj`);
  try {
    // ── 1: the rail ───────────────────────────────────────────────────────────────────────
    console.log('\n═══ 1. The Agents rail row ═══');
    // Guards the rail still reading only "Automations" (the ad04364c state this task reverses).
    check('the rail has exactly one "Agents" row', (await agentsRow().count()) === 1, `rows=${await agentsRow().count()}`);
    await agentsRow().first().click();
    check('…and it opens the Agents page', await until(async () => (await page.locator('.arp').count()) === 1));

    // ── 2: the roster ─────────────────────────────────────────────────────────────────────
    console.log('\n═══ 2. The roster ═══');
    await until(async () => (await page.locator('[data-agent]').count()) >= 3);
    const slugs = await page.locator('[data-agent]').evaluateAll((els) => els.map((e) => e.getAttribute('data-agent')));
    // Guards a roster read from automations only (the explicit agent would be missing) or from
    // agent files only (the legacy implicit agents would be missing).
    check('the roster shows the legacy scheduled, the legacy on-call and the explicit agent',
      [SCHED, CALL, SCOUT].every((s) => slugs.includes(s)), slugs.join(', '));
    // The cards are portraits now: no chip, one quiet state word per card (soul task, D8).
    check('…each card carries a state and no approval chip',
      (await Promise.all([SCHED, CALL, SCOUT].map(async (s) =>
        !!(await cardState(page, s)) && (await page.locator(`[data-agent="${s}"] .agr-chip`).count()) === 0))).every(Boolean));
    // Guards one merged "approved" verdict: the scheduled agent may chat but not run.
    check('the two verdicts stay apart: the scheduled agent reads cant-run ("Can\'t run yet")',
      (await cardState(page, SCHED)) === 'cant-run', `state=${await cardState(page, SCHED)}`);
    check('…while the on-call and explicit agents read ready',
      (await cardState(page, CALL)) === 'ready' && (await cardState(page, SCOUT)) === 'ready');
    await page.screenshot({ path: join(SHOTS, 'light-1-roster.png') });

    // ── 2b: the Automations page lists automations only ───────────────────────────────────
    console.log('\n═══ 2b. The Automations page shows only automations ═══');
    await page.locator('.sidebar-item').filter({ has: page.locator('.sidebar-label', { hasText: /^Automations$/ }) }).first().click();
    await until(async () => (await page.locator('.agents-switch').count()) === 1);
    await page.locator('.agents-switch-opt', { hasText: 'Automations' }).click();
    const autoCard = (title) => page.locator('.agent-card:not(.agent-card--new)', { hasText: title });
    await until(async () => (await autoCard('Morning scout').count()) === 1);
    // Guards on-call agents still listed as automation cards ("Helper — When you call it").
    check('a pure on-call agent is NOT an automation card, and the agent alone is not one either',
      (await autoCard('Helper').count()) === 0 && (await autoCard('Scout').filter({ hasNotText: 'Morning' }).count()) === 0,
      `cards=${(await page.locator('.agent-card:not(.agent-card--new)').allInnerTexts()).map((s) => s.split('\n')[0]).join(' | ')}`);
    check('…the scheduled automations are', (await autoCard('Daily digest').count()) === 1 && (await autoCard('Morning scout').count()) === 1);
    // Guards the header still counting agents ("3 agents · 2 on a schedule").
    const headCount = (await page.locator('.agents-channel-sub-count').innerText().catch(() => '')).trim();
    const tabCount = (await page.locator('.agents-switch-count').innerText().catch(() => '')).trim();
    check('the header says "2 automations" and the tab counts 2', headCount === '2 automations' && tabCount === '2',
      `head="${headCount}" tab="${tabCount}"`);
    await agentsRow().first().click();
    await until(async () => (await page.locator('.arp').count()) === 1);

    // ── 4: create through the identity dialog ─────────────────────────────────────────────
    console.log('\n═══ 4. Create and edit through the identity dialog ═══');
    await page.locator('.arp-new').click();
    check('"New agent" opens the identity dialog', await until(async () => (await page.locator('.aid-modal').count()) === 1));
    await page.locator('.aid-modal .aid-input').first().fill(NEW_TITLE);
    await page.locator('.aid-modal .aid-textarea').first().fill(NEW_PROMPT); // the Job; the soul is the second
    await page.screenshot({ path: join(SHOTS, 'light-4-create-dialog.png') });
    await page.locator('.aid-modal .aid-btn--primary').click();
    const created = await until(async () => read(agentFile(NEW_SLUG)).includes(NEW_PROMPT), 15000);
    // Guards a dialog that only updates client state, or writes the legacy automation shape.
    check('the new agent is written to agents/researcher.md with its prompt', created, read(agentFile(NEW_SLUG)).slice(0, 300));
    check('…approved directly on this machine (agentApprovals[researcher])', !!registryEntry()?.agentApprovals?.[NEW_SLUG],
      JSON.stringify(registryEntry()?.agentApprovals ?? {}));
    check('…its profile opens, and its card joins the roster',
      await until(async () => (await page.locator(`[data-agent-profile="${NEW_SLUG}"]`).count()) === 1
        && (await page.locator(`[data-agent="${NEW_SLUG}"]`).count()) === 1));

    const before = registryEntry()?.agentApprovals?.[NEW_SLUG]?.manifestSha256;
    await page.locator(`[data-agent-profile="${NEW_SLUG}"] .agp-actions .agp-btn`, { hasText: /^Edit$/ }).click();
    const loaded = await until(async () => (await page.locator('.aid-modal .aid-textarea').first().inputValue()) === NEW_PROMPT, 10000);
    check('Edit opens the dialog on the agent\'s full current prompt', loaded);
    await page.locator('.aid-modal .aid-textarea').first().fill(EDITED_PROMPT);
    await page.locator('.aid-modal .aid-btn--primary').click();
    const edited = await until(async () => read(agentFile(NEW_SLUG)).includes(EDITED_PROMPT), 15000);
    check('the edited prompt is on disk', edited && !read(agentFile(NEW_SLUG)).includes(NEW_PROMPT), read(agentFile(NEW_SLUG)).slice(0, 300));
    // Guards an edit that writes the file but drops the direct grant (the agent would stop running).
    const after = registryEntry()?.agentApprovals?.[NEW_SLUG]?.manifestSha256;
    check('…and the edit re-approved it here: a new hash, still approved to run',
      !!after && after !== before && await until(async () => rowApproved(page, `[data-agent-profile="${NEW_SLUG}"]`, 'run'), 8000),
      `before=${before?.slice(0, 12)} after=${after?.slice(0, 12)}`);

    // ── 5: the in-place Approve ───────────────────────────────────────────────────────────
    console.log('\n═══ 5. Approve in place ═══');
    await page.locator(`[data-agent="${SCHED}"]`).click();
    const prof = `[data-agent-profile="${SCHED}"]`;
    await until(async () => (await page.locator(prof).count()) === 1);
    check('the scheduled agent\'s profile shows "Not approved to run" in its own row',
      (await page.locator(`${prof} [data-approval="run"]`).getAttribute('data-approved')) === 'false'
        && (await page.locator(`${prof} [data-approval="chat"]`).getAttribute('data-approved')) === 'true');
    await page.locator(`${prof} [data-approval-section] .agp-btn`, { hasText: /^Review$/ }).click();
    const reviewShown = await until(async () => (await page.locator(`${prof} [data-approval-review] pre`).innerText()).includes('three-line summary'), 10000);
    // Guards an Approve that grants blind: the review must show what the grant covers.
    check('Review opens the review in place, showing what an approval grants (the prompt included)', reviewShown,
      (await page.locator(`${prof} [data-approval-review]`).innerText().catch(() => '(no review)')).slice(0, 300));
    check('…and nothing is granted yet', !registryEntry()?.agentApprovals?.[SCHED]);
    await page.screenshot({ path: join(SHOTS, 'light-5-review.png') });
    await page.locator(`${prof} [data-approval-review] .agp-btn--primary`).click();
    // Guards an Approve that only flips the chip in the browser (no registry write), or writes
    // but leaves the chip stale.
    check('Approve grants it on this machine (agentApprovals[digest])',
      await until(async () => !!registryEntry()?.agentApprovals?.[SCHED], 10000));
    check('…the run row flips to approved and the review closes',
      await until(async () => (await page.locator(`${prof} [data-approval="run"]`).getAttribute('data-approved')) === 'true'
        && (await page.locator(`${prof} [data-approval-review]`).count()) === 0, 10000));
    check('…and the roster card reads ready too', await until(async () => (await cardState(page, SCHED)) === 'ready', 10000));
    // A pair's own automation record is not the agent's grant, and must survive it (R4).
    check('…while the automation\'s own record approvals[digest] is kept', !!registryEntry()?.approvals?.[SCHED]);

    // ── 6: delete an agent in use ─────────────────────────────────────────────────────────
    console.log('\n═══ 6. Delete an agent in use ═══');
    await page.locator(`[data-agent="${SCOUT}"]`).click();
    const scoutProf = `[data-agent-profile="${SCOUT}"]`;
    await until(async () => (await page.locator(scoutProf).count()) === 1);
    const del = page.locator(`${scoutProf} [data-delete-armed]`);
    check('Delete starts unarmed', (await del.getAttribute('data-delete-armed')) === 'false');
    await del.click();
    // Guards a one-click delete (and a browser confirm(), which is a silent no-op in the app).
    check('the first click only arms it, in place', await until(async () => (await del.getAttribute('data-delete-armed')) === 'true', 4000)
      && existsSync(agentFile(SCOUT)));
    await page.screenshot({ path: join(SHOTS, 'light-6-delete-armed.png') });
    await del.click();
    const refusal = page.locator(`${scoutProf} .agp-error[role="alert"]`);
    const refused = await until(async () => (await refusal.count()) > 0, 10000);
    // Guards a delete that removes an agent an automation still runs as.
    check('the second click is refused in place, naming the automation that uses it',
      refused && (await refusal.innerText()).includes('Morning scout'), await refusal.innerText().catch(() => '(no refusal)'));
    check('…and the agent file is still there', existsSync(agentFile(SCOUT)));
    await page.screenshot({ path: join(SHOTS, 'light-6-delete-refused.png') });

    // ── 7: Talk to it ─────────────────────────────────────────────────────────────────────
    console.log('\n═══ 7. Talk to it ═══');
    const tabsBefore = await page.locator('.agent-tab').count();
    await page.evaluate(() => { window.__dcChatSockets = []; });
    await page.locator(`${scoutProf} .agp-actions .agp-btn--primary`).click();
    const sockets = () => page.evaluate(() => window.__dcChatSockets ?? []);
    // Guards Talk opening (or resuming) an existing conversation instead of a new one as the agent.
    check('"Talk to it" opens a NEW conversation as the agent (chatAgent=scout, a fresh session, no resume)',
      await until(async () => (await sockets()).some((u) => u.includes(`chatAgent=${SCOUT}`) && /[?&]sessionId=/.test(u) && !/[?&]resume=/.test(u)), 20000),
      (await sockets()).join('\n      ') || '(no chat socket opened)');
    check('…in a tab of its own', await until(async () => (await page.locator('.agent-tab').count()) === tabsBefore + 1, 15000),
      `${tabsBefore} -> ${await page.locator('.agent-tab').count()}`);
    check('…and no talk failure is shown on the profile', (await page.locator(`${scoutProf} .agp-error`, { hasText: /talk|chat/i }).count()) === 0);
    await page.screenshot({ path: join(SHOTS, 'light-7-talk.png') });

    check('[light] no uncaught page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await context.close();
  }
}

/** Deep link + the screenshots and copy sweep, in one theme. */
async function themed(browser, base, theme) {
  console.log(`\n═══ 3/8. ${theme}: deep link, screenshots, copy ═══`);
  const link = encodeURIComponent(`dreamcontext://project/proj/page/agents/${CALL}`);
  const { context, page, errors, until } = await openPage(browser, theme, `${base}/?vault=proj&open=${link}`);
  try {
    const prof = `[data-agent-profile="${CALL}"]`;
    // Guards the link landing on the Agents page without its focus (or on the Automations page).
    check(`[${theme}] page/agents/helper opens the Agents page with helper's profile`,
      await until(async () => (await page.locator(prof).count()) === 1 && (await page.locator('.arp').count()) === 1, 15000));
    const callSettings = await page.locator(`${prof} [data-call-settings]`).innerText().catch(() => '');
    // Guards a profile that hides a migrated on-call agent's run settings (or makes them editable).
    check(`[${theme}] …showing its call settings, read-only (timeout 20)`,
      /20/.test(callSettings) && (await page.locator(`${prof} [data-call-settings] input, ${prof} [data-call-settings] select`).count()) === 0,
      callSettings.slice(0, 200) || '(no call settings section)');
    await page.screenshot({ path: join(SHOTS, `${theme}-3-deep-link-profile.png`) });

    // Agent-authored words (names, prompts, the review's field values) are left out: the sweep
    // is about the page's own copy.
    const text = await chromeText(page, '.arp', ['.agp-prompt', '.agp-review-text', '.agr-name', '.agr-role', '.agr-soul', '.agp-name', '.agp-role', '.agp-soul', '.agp-playbook', '.agp-lesson-text', '.agp-list-name']);
    check(`[${theme}] no em dash in the Agents page's own text, titles or labels`, dashLines(text).length === 0, dashLines(text).join(' | '));

    // Another profile in this theme, for the screenshot set.
    const scoutProf = `[data-agent-profile="${SCOUT}"]`;
    await page.locator(`[data-agent="${SCOUT}"]`).click({ timeout: 5000 }).catch(() => {});
    await until(async () => (await page.locator(scoutProf).count()) === 1);
    await page.screenshot({ path: join(SHOTS, `${theme}-2-roster-profile.png`) });
    check(`[${theme}] no uncaught page errors`, errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await context.close();
  }
}

async function main() {
  console.log('· fixture: fake HOME, stand-in claude, a legacy scheduled + legacy on-call + explicit agent');
  seed();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const srv = await startServer(port);
  const browser = await chromium.launch();
  try {
    await functional(browser, base);
    for (const theme of ['light', 'dark']) {
      // The surface mirrors its tab roster to disk; the Talk tab would restore over the page.
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
