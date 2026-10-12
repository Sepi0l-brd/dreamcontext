#!/usr/bin/env node
/**
 * Window control, end to end: a chat's OWN agent runs `dreamcontext window …` and the window
 * showing that chat does it.
 *
 *   npm run build && node scripts/verify/window-control.mjs
 *
 * WHAT IT DRIVES — the real dashboard server, the real dashboard in Chromium, the real chat
 * WebSocket, and the real CLI (`dist/index.js window …`) run from INSIDE the chat's spawned
 * process, with only the env the server gave it. The `claude` on PATH is a scripted stand-in
 * (scratch HOME, no tokens spent): on "GO-WINDOW" it runs a sequence of window verbs and
 * writes every exit code and output to a side file in the scratch dir (the transcript renders
 * prose, not JSON); on "GO-STATE" it runs `window state`.
 *
 * WHAT IT PROVES — the loop CLI → /api/window → the chat's socket → AgentSurface → result →
 * CLI, and that each verb changed what the user SEES: `new --split` paints a second pane, the
 * calling chat's own mode switch waits for the turn and then restarts it on the same
 * conversation (a later `state` from the respawned process reads `develop`), a chat cannot
 * close itself, and the CLI outside a chat refuses.
 *
 * Collect, don't fail fast: every check prints ✓/✗ and the run continues. Exit 0 iff all pass.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, createWriteStream, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-window-control');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const CLI = join(REPO, 'dist', 'index.js');

const STANDIN = `#!${process.execPath}
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const sid = 'verify-window-' + process.pid;
let inited = false;
const win = (...args) => {
  const r = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(CLI)}, 'window', ...args], { env: process.env, encoding: 'utf-8' });
  let json = null; try { json = JSON.parse(r.stdout || r.stderr); } catch {}
  return { args: args.join(' '), status: r.status, json, stdout: r.stdout, stderr: r.stderr };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Like the real CLI, a conversation that has had a turn has a transcript on disk. The server
// waits for a respawn's hand-off only for a conversation that exists, so without this a mode
// switch's resume races the old process and is refused.
const argv = process.argv.slice(2);
const convo = argv[argv.indexOf('--resume') + 1] && argv.includes('--resume') ? argv[argv.indexOf('--resume') + 1] : argv[argv.indexOf('--session-id') + 1];
function persist(text) {
  if (!convo || !/^[0-9a-f-]{36}$/.test(convo)) return;
  const dir = join(process.env.HOME, '.claude', 'projects', 'verify-window');
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, convo + '.jsonl'), JSON.stringify({ type: 'user', sessionId: convo, message: { role: 'user', content: text } }) + '\\n');
}
async function turn(text) {
  persist(text);
  if (!inited) { inited = true; out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] }); }
  let report = null;
  if (text.includes('GO-WINDOW')) {
    const steps = [];
    steps.push(win('state'));
    const self = steps[0].json?.panes?.flatMap((p) => p.tabs).find((t) => t.self)?.tab;
    steps.push(win('new', '--split', '--mode', 'plan', '--prompt', 'hello from window'));
    await sleep(1500);
    steps.push(win('state'));
    steps.push(win('model', 'sonnet'));
    steps.push(win('close', self || 'none'));
    steps.push(win('focus', self || 'none'));
    steps.push(win('mode', 'develop'));
    report = { self, steps, env: { url: !!process.env.DREAMCONTEXT_WINDOW_URL, token: !!process.env.DREAMCONTEXT_WINDOW_TOKEN } };
  } else if (text.includes('GO-STATE')) {
    report = { steps: [win('state')] };
  }
  if (report) appendFileSync(${JSON.stringify(join(SCRATCH, 'reports.ndjson'))}, JSON.stringify(report) + '\\n');
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: report ? 'reported ' + report.steps.length : 'ok' }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'DONE', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: sid });
}
let buf = '';
let chain = Promise.resolve();
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'user') continue;
    const text = ((o.message && o.message.content) || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    chain = chain.then(() => turn(text));
  }
});
process.stdin.on('end', () => chain.then(() => process.exit(0)));
`;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  mkdirSync(join(HOME, '.local', 'bin'), { recursive: true });
  mkdirSync(join(PROJ, '_dream_context', 'state'), { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: false, defaultAgent: 'claude', autoTitle: false,
    hotkey: 'Ctrl+A', renderer: 'dom', chatView: true, screenMigrated: true,
    chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '',
  }, null, 2)}\n`);
  spawnSync('git', ['init', '-q'], { cwd: PROJ });
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  const add = spawnSync(process.execPath, [CLI, 'vaults', 'add', 'proj', PROJ], { env: { ...process.env, HOME }, encoding: 'utf-8' });
  if (add.status !== 0) throw new Error(`vaults add failed: ${add.stderr || add.stdout}`);
}

async function startServer(port) {
  const PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ,
    env: { ...process.env, HOME, PATH, DREAMCONTEXT_DESKTOP: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Kept for a failed run: the server's own account of every spawn and exit.
  const log = createWriteStream(join(SCRATCH, 'server.log'));
  srv.stdout.pipe(log);
  srv.stderr.pipe(log);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return srv; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  srv.kill();
  throw new Error('dashboard server did not come up');
}

async function run(chromium, base, report) {
  const ok = (label, cond, detail) => report.check(label, cond, detail);

  console.log('\n── the CLI outside a chat');
  const outside = spawnSync(process.execPath, [CLI, 'window', 'state'], { env: { ...process.env, HOME, DREAMCONTEXT_WINDOW_URL: '', DREAMCONTEXT_WINDOW_TOKEN: '' }, encoding: 'utf-8' });
  ok('refuses with not_a_chat and exit 1', outside.status === 1 && outside.stderr.includes('not_a_chat'), outside.stderr);
  const forged = await fetch(`${base}/api/window/state`, { method: 'POST', headers: { 'x-dreamcontext-window-token': 'a'.repeat(48), 'content-type': 'application/json' }, body: '{}' });
  ok('a forged token is a 401 from the route', forged.status === 401, `HTTP ${forged.status}`);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, colorScheme: 'dark' });
  page.on('pageerror', (e) => report.note(`[page error] ${String(e).slice(0, 160)}`));
  const consoleLog = createWriteStream(join(SCRATCH, 'console.log'));
  page.on('console', (m) => consoleLog.write(`[${m.type()}] ${m.text()}\n`));
  page.on('websocket', (ws) => {
    const tag = ws.url().replace(/^.*\?/, '').slice(0, 120);
    consoleLog.write(`[ws open] ${tag}\n`);
    ws.on('framereceived', (f) => { const t = String(f.payload); if (t.includes('_meta')) consoleLog.write(`[ws ${tag.slice(0, 60)}] ${t.slice(0, 300)}\n`); });
    ws.on('close', () => consoleLog.write(`[ws close] ${tag}\n`));
  });
  const vis = (sel) => page.locator(`${sel}:visible`);
  const until = async (fn, ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(150); }
    return false;
  };
  // The stand-in writes each report to a side file: the transcript renders prose, not JSON.
  const echoes = async () => {
    try { return readFileSync(join(SCRATCH, 'reports.ndjson'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l)); }
    catch { return []; }
  };
  const say = async (text) => {
    const input = vis('.chat-cmp-input').first();
    await input.click();
    await input.fill(text);
    await page.keyboard.press('Enter');
  };

  await page.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(200); }
  if (!(await page.locator('.agent-surface.expanded').count())) {
    for (const sel of ['.agent-fab', '.agent-overlay-head', '.agent-surface']) {
      const el = page.locator(sel).first();
      if (await el.count()) { await el.click({ force: true }).catch(() => {}); await page.waitForTimeout(1200); }
      if (await page.locator('.agent-surface.expanded').count()) break;
    }
  }
  if (!(await vis('.chat-cmp-input').count())) await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
  ok('a chat opens against the real WS route', await until(async () => (await vis('.chat-cmp-input').count()) > 0));
  ok('one pane before', (await vis('.agent-pane').count()) === 1, `panes=${await vis('.agent-pane').count()}`);

  console.log('\n── the chat\'s own agent drives its window');
  await say('GO-WINDOW');
  const gotEcho = await until(async () => (await echoes()).some((e) => e?.steps?.length === 7), 40000);
  ok('the stand-in ran every verb and answered', gotEcho);
  const r = (await echoes()).find((e) => e?.steps?.length === 7);
  if (r) {
    const [state0, created, state1, model, closeSelf, focus, mode] = r.steps;
    ok('the spawn env carries the window URL and token', r.env.url && r.env.token, JSON.stringify(r.env));
    ok('state: one pane, the caller marked self', state0.status === 0 && state0.json?.panes?.length === 1 && !!r.self, state0.stdout || state0.stderr);
    ok('new --split returns the new tab id', created.status === 0 && typeof created.json?.tab === 'string' && created.json?.placed === 'new pane', created.stdout || created.stderr);
    const tabs1 = state1.json?.panes?.flatMap((p) => p.tabs) ?? [];
    const made = tabs1.find((t) => t.tab === created.json?.tab);
    ok('state after: two panes, the new chat in Plan', state1.json?.panes?.length === 2 && made?.mode === 'plan', state1.stdout || state1.stderr);
    ok('model switch answers from the next turn', model.status === 0 && model.json?.model === 'sonnet', model.stdout || model.stderr);
    ok('a chat cannot close itself (exit 1, named)', closeSelf.status === 1 && /cannot close itself/.test(closeSelf.stderr), closeSelf.stderr);
    ok('focus on its own tab works', focus.status === 0, focus.stdout || focus.stderr);
    ok('its own mode switch is deferred to the turn end', mode.status === 0 && /turn ends/.test(mode.json?.when ?? ''), mode.stdout || mode.stderr);
  }
  ok('the window PAINTS two panes side by side', await until(async () => (await vis('.agent-pane').count()) === 2), `panes=${await vis('.agent-pane').count()}`);
  ok('the panes row carries the split class', (await page.locator('.agent-panes.split').count()) === 1);

  console.log('\n── after the turn: the deferred mode switch landed');
  await page.waitForTimeout(2500);
  // Focus is on the new pane (split focuses it); send into the FIRST pane's composer.
  const firstInput = vis('.chat-cmp-input').first();
  await firstInput.click();
  await firstInput.fill('GO-STATE');
  await page.keyboard.press('Enter');
  ok('the respawned chat answers GO-STATE', await until(async () => (await echoes()).some((e) => e?.steps?.length === 1), 30000));
  const after = (await echoes()).filter((e) => e?.steps?.length === 1).pop();
  const selfAfter = after?.steps?.[0]?.json?.panes?.flatMap((p) => p.tabs).find((t) => t.self);
  ok('the calling chat is now in Develop, same conversation', selfAfter?.mode === 'develop' && selfAfter?.tab === r?.self, JSON.stringify(selfAfter));

  const shots = process.env.VERIFY_SHOTS;
  if (shots) await page.screenshot({ path: join(shots, 'window-control.png') });
  await browser.close();
}

const report = {
  pass: 0, fails: [], notes: [],
  check(label, cond, detail) {
    if (cond) { this.pass++; console.log(`  ✓ ${label}`); }
    else { this.fails.push(label); console.log(`  ✗ ${label}${detail ? `\n      ${String(detail).slice(0, 600)}` : ''}`); }
  },
  note(msg) { this.notes.push(msg); console.log(`  ${msg}`); },
};

let server = null;
try {
  const { chromium } = await import('@playwright/test');
  setupScratch();
  const port = await freePort();
  server = await startServer(port);
  await run(chromium, `http://127.0.0.1:${port}`, report);
} catch (err) {
  report.fails.push(`harness: ${err instanceof Error ? err.message : String(err)}`);
  console.error(err);
} finally {
  if (server) server.kill();
}
console.log(`\n${report.fails.length === 0 ? '✅' : '❌'} ${report.pass} passed, ${report.fails.length} failed`);
report.fails.forEach((f) => console.log('   ✗', f));
process.exit(report.fails.length ? 1 : 0);
