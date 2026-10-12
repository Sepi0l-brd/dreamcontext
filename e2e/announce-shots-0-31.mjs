/**
 * Capture the v0.31.0 announcement screenshots — the release where agents became a team.
 *
 * Run against a dashboard serving THIS CUT's own build over the fictional "orbit" demo
 * vault (fake HOME, nothing real on screen), with a stub `claude` first on PATH so opening
 * a chat spends no turn:
 *   npm run build
 *   ROOT=/tmp/dc-ann-031 ./marketing/build-demo-vault-v5.sh
 *   (then the four agents with soul templates, the two automations bound to them and three
 *    tasks carrying `agent:` — the commands are in the 0.31.0 pre-publish checklist task)
 *   (cd /tmp/dc-ann-031/proj && PATH=/tmp/dc-ann-031/bin:/usr/bin:/bin HOME=/tmp/dc-ann-031/home \
 *      DREAMCONTEXT_DESKTOP=1 node <repo>/dist/index.js dashboard --no-open -p 45931)
 *   BASE=http://127.0.0.1:45931 node e2e/announce-shots-0-31.mjs
 *
 * COLLECT-DON'T-FAIL-FAST: a scene that cannot be reached is reported and skipped, so
 * the story is built from what was actually captured.
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const BASE = process.env.BASE ?? 'http://127.0.0.1:45931';
const ROOT = process.env.SHOT_ROOT ?? 'dashboard/public/announcements/shots';
const ID = 'v0-31-0';
const VAULT = process.env.DEMO_VAULT ?? 'orbit';
const ONLY = (process.env.ONLY ?? 'all').split(',');
const on = (g) => ONLY.includes('all') || ONLY.includes(g);

const CLEAN = `[class*="minimized"],[class*="session-dock"],[class*="agent-dock"],[class*="sleep-debt"],[class*="debt-badge"],.agent-fab{display:none!important}`;

const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, colorScheme: 'dark' });
await page.addInitScript(() => localStorage.setItem('dreamcontext-theme', 'dark'));
page.setDefaultTimeout(15000);

const captured = [];
const failed = [];
const sleep = (ms) => page.waitForTimeout(ms);
const vis = (sel) => page.locator(`${sel}:visible`);

/** `clip` crops a region (for a `plain` frame); omit it for the whole window. */
async function shot(name, clip) {
  await page.addStyleTag({ content: CLEAN });
  await sleep(500);
  const path = join(ROOT, ID, `${name}.png`);
  mkdirSync(dirname(path), { recursive: true });
  await page.screenshot({ path, ...(clip ? { clip } : {}) });
  captured.push(name);
  console.log('  ✓', name);
}

async function scene(name, fn) {
  if (!on(name)) return;
  try { await fn(); } catch (e) { failed.push(name); console.log('  ✗', name, String(e).slice(0, 200)); }
}

async function home() {
  await page.goto(`${BASE}/?vault=${VAULT}`, { waitUntil: 'domcontentloaded' });
  await page.locator('.sidebar-item').first().waitFor({ timeout: 30000 });
  await sleep(1200);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await sleep(200); }
  await page.evaluate(() => document.querySelectorAll('.announcements-modal-scrim').forEach((e) => e.remove()));
}

async function nav(title) {
  await home();
  await page.locator(`.sidebar-item[title^="${title}"]`).first().click();
  await sleep(2500);
}

await scene('team', async () => {
  await nav('Agents');
  await page.getByText('Growth analyst').first().waitFor();
  await shot('team');
});

await scene('profile', async () => {
  await nav('Agents');
  await page.getByText('Growth analyst').first().click();
  const panel = page.locator('.agp-panel').first();
  await panel.waitFor();
  await sleep(1000);
  const box = await panel.boundingBox();
  await shot('profile', { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, 760) });
});

await scene('automations', async () => {
  await nav('Automations');
  await page.locator('button', { hasText: 'Automations' }).last().click();
  await page.getByText('Runs as Growth analyst').first().waitFor();
  await shot('automations', { x: 236, y: 56, width: 700, height: 290 });
});

await scene('tasks', async () => {
  await nav('Tasks');
  await page.getByText('Investigate trial-to-paid drop').first().waitFor();
  await shot('tasks');
});

await scene('memory', async () => {
  await nav('Settings');
  await page.getByText('dreamcontext Memory').first().click();
  await page.getByText('Recommended for you').first().waitFor();
  await sleep(1000);
  await shot('memory', { x: 492, y: 56, width: 1092, height: 470 });
});

// Last: opening a chat leaves a tab in the roster, which would float over later pages.
await scene('modes', async () => {
  await nav('Chat');
  await page.getByRole('button', { name: /Start chat/ }).click();
  await vis('.chat-cmp-input').first().waitFor({ timeout: 20000 });
  await sleep(1000);
  await vis('.chat-cmp-perm-wrap .chat-cmp-modeltrigger').first().click();
  const menu = vis('.chat-cmp-modemenu').first();
  await menu.waitFor();
  await sleep(1000);
  const box = await menu.boundingBox();
  await shot('modes', { x: box.x - 12, y: box.y - 12, width: box.width + 24, height: box.height + 24 });
});

await b.close();
console.log(`\ncaptured ${captured.length}: ${captured.join(', ')}`);
if (failed.length) console.log(`FAILED ${failed.length}: ${failed.join(', ')}`);
