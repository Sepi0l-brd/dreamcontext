#!/usr/bin/env node
/**
 * Agents step 1 — runtime proof that the member list is real.
 *
 *   npm run build && npm run verify:agents-members
 *
 * Every check below is driven against the REAL running dashboard server, the
 * REAL `/api/automations*` routes and the REAL React surface in Chromium.
 * Nothing here is asserted by reading source — this file exists precisely
 * because a component that typechecks and a component that renders are two
 * different claims.
 *
 * WHAT IT PROVES, one checkpoint per acceptance criterion:
 *   1. The sidebar reads "Automations" and the page's roster (the Automations
 *      tab) has one card per automation: the face of the agent it runs as,
 *      name, cadence, model, description, last-run line.
 *   2. The create dialog picks an agent: the starters still open it prefilled
 *      on the self-contained form, the on-call starter opens the Agents page in
 *      create mode instead, and a create with an agent picked sends `agent` +
 *      `job` (the manifest says `agent: <slug>`), the card then reading "Runs as
 *      <agent>". A 409 `agent_unapproved` is shown in place, and its link opens
 *      that agent on the Agents page.
 *   3. An on-call agent is created with NO schedule and shows NO pause switch,
 *      while a scheduled one does.
 *   4. Edit changes the prompt on disk; the button says "Save and re-approve
 *      on this Mac"; the manifest is approved again afterwards.
 *   5. Delete arms on the first click (the label changes) and commits on the
 *      second, taking the manifest and the cache with it.
 *   6. The photo round-trips: the bytes come back from the photo route, and a
 *      manifest pointed outside the brain is refused by the API.
 *   7. The Messages tab shows its one-sentence empty state.
 *
 * WHAT IT DOES NOT TOUCH — your machine. Isolated fake HOME, a scratch
 * project, no `claude` ever spawned: no model runs, no tokens, no auth.
 *
 * FAILURE POLICY — COLLECT, DON'T FAIL FAST (matching `automations.mjs`).
 * Exit 0 iff every check passed.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { chromeText, dashLines, dispatcherState, distIndex, effectiveBg, mockDispatcher, overlapArea, rect, scratchDir, shotsDir } from './lib/measure.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST_INDEX = distIndex(REPO);

const SCRATCH = scratchDir('dc-ui-agents-members');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const CONTEXT_ROOT = join(PROJ, '_dream_context');
const AUTOMATIONS_DIR = join(CONTEXT_ROOT, 'automations');
const SHOTS = shotsDir(REPO, 'agents-members');

const SCHED_DESC = "Her sabah 09:00'da dünkü insight'ları oku ve üç maddelik özet çıkar";
const CALL_DESC = 'Çağırdığımda verdiğim konuyu derinlemesine araştır';
/** The scheduled automation section 2 creates through the API. */
const SCHED_SLUG = 'daily-insight-digest';

const report = { pass: 0, fail: 0 };
function check(label, ok, ev = '') {
  if (ok) { report.pass++; console.log(`  ✓ ${label}${ev && /^\[(C\d+|guard)\]/.test(label) ? `\n      ${ev}` : ''}`); }
  else { report.fail++; console.log(`  ✗ ${label}${ev ? `\n      ${ev}` : ''}`); }
}

const freePort = () => new Promise((res, rej) => {
  const s = createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

function cli(args) {
  const r = spawnSync(process.execPath, [DIST_INDEX, ...args], {
    cwd: PROJ, env: { ...process.env, HOME }, encoding: 'utf-8',
  });
  if (r.status !== 0) throw new Error(`cli ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

function seed() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  mkdirSync(AUTOMATIONS_DIR, { recursive: true });
  mkdirSync(join(CONTEXT_ROOT, 'core'), { recursive: true });
  mkdirSync(join(CONTEXT_ROOT, 'state'), { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: PROJ });
  // The vault must be REGISTERED by name: state-changing requests resolve
  // `X-Dreamcontext-Vault` through the strict resolver, which accepts an exact
  // registered name and nothing path-shaped.
  cli(['vaults', 'add', 'proj', PROJ]);
}

async function startServer(port) {
  const PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [DIST_INDEX, 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ, env: { ...process.env, HOME, PATH, DREAMCONTEXT_DESKTOP: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return srv; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  srv.kill();
  throw new Error('server did not come up');
}

/** Read this machine's approval registry — the proof that create/edit really
 *  approved here, rather than merely writing a manifest that would block. */
function approvalFor(slug) {
  const p = join(HOME, '.dreamcontext', 'automations.json');
  if (!existsSync(p)) return null;
  // `{ projects: { <projectRoot>: { approvals: { <slug>: … } } } }` — the real
  // shape from `registry.ts`. Scanned across projects rather than keyed on one
  // path string, because macOS resolves tmpdir through a `/var → /private/var`
  // symlink and the two spellings are not the same key.
  const reg = JSON.parse(readFileSync(p, 'utf-8'));
  for (const project of Object.values(reg.projects ?? {})) {
    const a = project?.approvals?.[slug];
    if (a) return a;
  }
  return null;
}

function manifestText(slug) {
  const p = join(AUTOMATIONS_DIR, `${slug}.md`);
  return existsSync(p) ? readFileSync(p, 'utf-8') : '';
}

async function main() {
  seed();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const srv = await startServer(port);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  /** Show the roster if it is not already showing. The members pill is a
   *  TOGGLE, so clicking it blind closes the very view it was meant to open. */
  const showRoster = async () => {
    if ((await page.locator('.agent-card').count()) > 0) return;
    await page.locator('.agents-switch-opt', { hasText: 'Automations' }).click();
    await page.waitForTimeout(400);
  };

  const until = async (fn, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { try { if (await fn()) return true; } catch { /* retry */ } await page.waitForTimeout(150); }
    return false;
  };

  /** Dismiss the What's New popup, which covers the whole shell on a fresh
   *  HOME and swallows every click aimed at the sidebar. */
  const dismissOverlays = async () => {
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(250);
      if (await page.locator('.announcements-modal-scrim').count() === 0) break;
    }
  };

  try {
    await page.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    await dismissOverlays();

    // ── 1: the sidebar names the page ─────────────────────────────────────
    // "Agentic Automations" since 2026-09-24 (owner's call). The item must be the ONLY
    // one that says so — a second "Automations" entry would be the old page resurfacing.
    console.log('\n═══ 1. Sidebar and page ═══');
    const agentsNav = page.locator('.sidebar-item', { hasText: 'Automations' }).first();
    check('the sidebar reads "Automations"', await agentsNav.count() > 0);
    const navCount = await page.locator('.sidebar-item', { hasText: 'Automations' }).count();
    check('…and it is the only Automations entry', navCount === 1, `found ${navCount} Automations item(s)`);
    await agentsNav.click();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: join(SHOTS, '1-empty-state.png') });

    // ── 2: create a SCHEDULED agent through the dialog ────────────────────
    console.log('\n═══ 2. New agent (scheduled, with a preset photo) ═══');
    // The zero-state must be able to make the FIRST agent — with no grid there
    // is no dashed "New agent" card, so without its own button the only path
    // would be the CLI and the dialog this page exists to show would be
    // unreachable on a fresh vault. Asserted before anything is seeded.
    check('the zero-state offers a start-from-scratch button', await page.locator('.auto-intro-new-btn').count() === 1);
    await page.locator('.auto-intro-new-btn').click();
    const zeroDialog = await until(async () => (await page.locator('.agent-modal').count()) > 0, 8000);
    check('…which opens the New automation dialog on an empty vault', zeroDialog);
    // [S2] With no agent in the vault there is nothing to pick, so the dialog lands on the
    // self-contained form by itself (a prompt field to describe the new one).
    const zeroOwn = await until(async () =>
      (await page.locator('.automation-agent-select').inputValue().catch(() => '')) === '__own__', 8000);
    check('[S2] an empty vault\'s create picks "a new agent, described here" by itself', zeroOwn);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);

    // C9: the first run speaks outcome words and starts something. Swept as the app's own
    // text: painted text plus every title, aria-label and placeholder under the zero-state.
    const introText = await chromeText(page, '.auto-intro', []);
    const introDashes = dashLines(introText);
    const introLab = introText.split('\n').filter((l) => /\bLab\b/.test(l)).map((l) => l.trim()).slice(0, 4);
    check('[C9] the first-run screen carries no em dash and no "Lab" in its text, titles or labels (was "Lab · Automations" twice and two em dashes)',
      introDashes.length === 0 && introLab.length === 0, JSON.stringify({ introDashes, introLab }));
    const starters = page.locator('.auto-intro-starter');
    const starterCount = await starters.count();
    let prefill = null;
    if (starterCount > 0) {
      const title = (await starters.first().locator('.auto-intro-starter-title').innerText()).trim();
      await starters.first().click();
      await until(async () => (await page.locator('.agent-modal').count()) > 0, 8000);
      prefill = {
        title,
        desc: await page.locator('.agent-modal .agent-textarea').inputValue().catch(() => ''),
        name: await page.locator('.agent-modal .agent-input').first().inputValue().catch(() => ''),
      };
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
    }
    check('[C9] three starter cards, and the first opens the dialog prefilled: a description and its own name (absent pre-fix)',
      starterCount === 3 && !!prefill && prefill.desc.length > 20 && prefill.name === prefill.title, JSON.stringify({ starterCount, prefill }));
    // [S2] The on-call starter is an AGENT (nothing schedules it), so it opens the Agents page
    // in create mode rather than this page's dialog. Then back to Automations for the rest.
    if (starterCount === 3) {
      await starters.nth(2).click();
      const onAgents = await until(async () => {
        const active = await page.locator('.sidebar-item[aria-current="page"]').first().innerText().catch(() => '');
        return /Agents/.test(active) && !/Automations/.test(active);
      }, 8000);
      check('[S2] the on-call starter opens the Agents page (was the New agent dialog in call mode)',
        onAgents && (await page.locator('.agent-modal').count()) === 0);
      // …in create mode: the Agents page's own identity dialog, not this page's. Closed the way a
      // user does it (Cancel); left open, its scrim swallows the next rail click.
      const identity = page.locator('.aid-modal');
      check('[S2] …in create mode: the New agent identity dialog is open',
        await until(async () => (await identity.count()) === 1 && /New agent/.test(await identity.locator('.aid-title').innerText()), 8000));
      await identity.locator('.aid-foot .aid-btn:not(.aid-btn--primary)').first().click().catch(() => {});
      check('[S2] …and Cancel closes it', await until(async () => (await page.locator('.aid-scrim').count()) === 0, 5000));
      await page.locator('.sidebar-item', { hasText: 'Automations' }).first().click();
      await page.waitForTimeout(800);
    }
    const jargon = await page.evaluate(() => {
      const first = document.querySelector('.auto-intro-starter');
      const line = first ? first.getBoundingClientRect().top : Infinity;
      const hits = [];
      const walker = document.createTreeWalker(document.querySelector('.auto-intro'), NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!/claude -p|bypassPermissions/.test(n.textContent)) continue;
        const r = document.createRange(); r.selectNodeContents(n);
        for (const q of r.getClientRects()) if (q.width > 1 && q.top < line) hits.push(`${n.textContent.trim().slice(0, 30)}@${Math.round(q.top)}`);
      }
      return { starterTop: Number.isFinite(line) ? Math.round(line) : null, hits };
    });
    check('[C9] "claude -p" and "bypassPermissions" paint nowhere above the first starter card (was in the lead, with no starter at all)',
      jargon.starterTop !== null && jargon.hits.length === 0, JSON.stringify(jargon));

    // The first agent is then seeded through the API so the checks below start
    // from a known manifest; every SUBSEQUENT create goes through the dialog.
    const created = await page.evaluate(async ({ b, desc }) => {
      const r = await fetch(`${b}/api/automations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Dreamcontext-Vault': 'proj' },
        body: JSON.stringify({
          title: 'Daily insight digest', prompt: desc, mode: 'sched',
          days: ['mon', 'tue', 'wed', 'thu', 'fri'], at: '09:00', model: 'opus', effort: 'medium',
        }),
      });
      return { status: r.status, body: await r.json() };
    }, { b: base, desc: SCHED_DESC });
    check('POST /api/automations created the agent', created.status === 200, JSON.stringify(created.body).slice(0, 200));
    check('…with mode sched and a real schedule', created.body?.automation?.mode === 'sched' && !!created.body?.automation?.schedule);
    check('…and approved it on THIS machine', approvalFor('daily-insight-digest') !== null);
    check('…writing the prompt the owner typed', manifestText('daily-insight-digest').includes(SCHED_DESC));

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    await dismissOverlays();
    await page.locator('.sidebar-item', { hasText: 'Automations' }).first().click();
    // The page OPENS on the channel now, not the roster — the owner's own
    // correction after the first pass ("Slack mesaj alanı gibi açılacak").
    check('the page opens on the channel, not the roster',
      (await page.locator('.agents-channel-body').count()) === 1
      && (await page.locator('.agent-card').count()) === 0);
    // The empty channel moved from a placeholder into the real feed's own zero
    // state in step 2 — same sentence, now rendered by the thing that will
    // also render the messages.
    await until(async () => (await page.locator('.agents-feed-zero-lede').count()) > 0, 10000);
    check('…and the channel says why it is empty',
      (await page.locator('.agents-feed-zero-lede').innerText()).includes('Nothing has been posted here yet'));
    // F17: the empty channel used to promise "the next scheduled run opens the first
    // thread" right under a pill reading "Scheduler off", never mentioned the @-ask, and
    // showed five filter chips all reading 0 above it. With the scheduler reported OFF, the
    // note has to lead with the ask and the chips have to be gone.
    await mockDispatcher(page, dispatcherState({ installed: false }));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    await dismissOverlays();
    await page.locator('.sidebar-item', { hasText: 'Automations' }).first().click();
    await until(async () => (await page.locator('.agents-feed-zero-note').count()) > 0, 10000);
    const zeroNote = await page.locator('.agents-feed-zero-note').innerText().catch(() => '');
    check('[F17] with the scheduler off, the empty channel leads with the @-ask, not "the next scheduled run" (was the scheduled-run promise)',
      zeroNote.includes('@') && !/next scheduled run/i.test(zeroNote), `note="${zeroNote}"`);
    const zeroChips = await page.locator('.agents-chip').count();
    check('[F17] …and no filter chips sit over an empty channel (was 5 chips reading 0)', zeroChips === 0, `chips=${zeroChips}`);
    await page.screenshot({ path: join(SHOTS, '1b-empty-channel-scheduler-off.png') });
    await page.unroute(/\/api\/automations\/dispatcher(\?|$)/);

    await showRoster();
    const cardShown = await until(async () => (await page.locator('.agent-card:not(.agent-card--new)').count()) > 0);
    check('the labelled Automations switch opens the roster and the card is there', cardShown);
    // The control has to SAY where it goes — the first version was a face-stack
    // plus a bare count, which rendered as "AI MI SM 3".
    const switchText = (await page.locator('.agents-switch').innerText()).replace(/\s+/g, ' ');
    check('…and both views are NAMED on the switch',
      switchText.includes('Messages') && switchText.includes('Automations'), `switch="${switchText}"`);

    const card = page.locator('.agent-card:not(.agent-card--new)').first();
    const cardText = cardShown ? await card.innerText() : '';
    check('…showing its name', cardText.includes('Daily insight digest'), cardText.slice(0, 200));
    check('…its cadence', /mon–fri 09:00/.test(cardText), cardText.slice(0, 200));
    check('…its model', cardText.includes('opus'), cardText.slice(0, 200));
    check('…its description', cardText.includes('insight'), cardText.slice(0, 200));
    check('…and a last-run line', /has not run yet/i.test(cardText), cardText.slice(0, 200));
    // The description is the agent's `## Prompt`, which is markdown. The card
    // must show PROSE — the owner's report was a card reading `> **BOLD**`.
    check('the description is prose, with no markdown syntax left in it',
      !/[*_`]|^>|\|/.test(cardText.split('\n').slice(2).join(' ')), cardText.slice(0, 300));
    check('initials render when there is no photo', (await page.locator('.agent-av').first().innerText()).trim() === 'DI');
    // REWRITE (C13): was "a dashed New agent card is present". C13 removes that card on
    // purpose (the header button is the one way in, and an empty roster has its own state),
    // so the check now asserts the opposite fact: exactly one "New agent" on the screen.
    const newAgents = await page.locator('.agents-page').getByText('New automation', { exact: true }).count();
    check('[C13] exactly one "New automation" in the members view (was 2: the header button and the dashed card)', newAgents === 1, `found ${newAgents}`);
    const foot = page.locator('.agent-card:not(.agent-card--new) .agent-card-foot').first();
    const footBg = await effectiveBg(foot).catch(() => null);
    const cardBg = await effectiveBg(page.locator('.agent-card:not(.agent-card--new)').first()).catch(() => null);
    check('[C13] the card footer is the card\'s own surface, not a grey slab (was rgb(233, 235, 240) on white)',
      !!footBg && footBg === cardBg, `foot=${footBg} card=${cardBg}`);
    const neverRan = await page.locator('.agent-card-status-word', { hasText: 'has not run yet' }).first().evaluate((el) => ({
      weight: getComputedStyle(el).fontWeight, color: getComputedStyle(el).color,
      secondary: (() => { const p = document.createElement('span'); p.style.color = 'var(--color-text-secondary)'; el.appendChild(p); const c = getComputedStyle(p).color; p.remove(); return c; })(),
    })).catch(() => null);
    check('[C13] "has not run yet" reads as a fact: regular weight, secondary ink (was 600 in full ink)',
      !!neverRan && neverRan.weight === '400' && neverRan.color === neverRan.secondary, JSON.stringify(neverRan));
    const rosterDashes = dashLines(await chromeText(page, '.agents-page', ['.agent-card-desc']));
    check('[C13] no em dash in the members view\'s own text, titles or labels (was "Daily insight digest — scheduled")',
      rosterDashes.length === 0, rosterDashes.join(' | '));
    // An unanswered question is a MESSAGE for the channel, not something
    // stapled to an identity card (owner, 2026-09-20).
    check('no approval/verdict block is stapled to a card',
      await page.locator('.agent-card .auto-ask').count() === 0);
    check('a scheduled agent shows a pause switch', await card.locator('.agent-switch').count() === 1);

    // ── 3: create an ON-CALL agent through the real dialog ────────────────
    console.log('\n═══ 3. A self-contained (legacy) on-call create, through the dialog ═══');
    await page.locator('.agents-new-btn').click();
    await until(async () => (await page.locator('.agent-modal').count()) > 0);
    check('the New automation dialog opens', await page.locator('.agent-modal').count() === 1);
    check('[S2] …and it opens on an agent picker', await page.locator('.agent-modal .automation-agent-select').count() === 1);
    // The legacy self-contained shape stays reachable: the picker's last choice.
    await page.locator('.automation-agent-select').selectOption('__own__');
    await page.waitForTimeout(300);
    check('its primary button says it approves on this Mac',
      (await page.locator('.agent-btn--primary').innerText()).includes('Create and approve on this Mac'));

    await page.locator('.agent-textarea').fill(CALL_DESC);
    await page.waitForTimeout(300);
    const prefilled = await page.locator('.agent-input').first().inputValue();
    check('Name prefilled itself from the description', prefilled.length > 0, `name="${prefilled}"`);
    await page.locator('.agent-input').first().fill('Researcher');
    // Typing in Name must STOP the prefill — the criterion that protects an edit.
    await page.locator('.agent-textarea').fill(`${CALL_DESC} ve kaynak ver`);
    await page.waitForTimeout(300);
    check('…and stopped once the owner typed in it',
      (await page.locator('.agent-input').first().inputValue()) === 'Researcher',
      `name="${await page.locator('.agent-input').first().inputValue()}"`);

    await page.locator('.agent-chip', { hasText: 'Only when I call it' }).click();
    await page.waitForTimeout(400);
    // The collapsed pane must be hidden from the accessibility tree and taken
    // out of the tab order, not merely clipped — a keyboard user tabbing into
    // a schedule that is not on screen is the failure this asserts against.
    const dayChipsReachable = await page.evaluate(() =>
      [...document.querySelectorAll('.agent-chip--day')].filter((el) => el.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) !== false
        && !el.closest('[aria-hidden="true"]')).length);
    check('picking on-call takes the day chips out of the page', dayChipsReachable === 0, `reachable=${dayChipsReachable}`);
    // A generated preset photo — the same upload path a picked file takes.
    await page.locator('.agent-preset').first().click();
    await page.waitForTimeout(400);
    check('the preset photo previews at 56px', await page.locator('.agent-photo-preview img').count() === 1);
    await page.screenshot({ path: join(SHOTS, '2-new-agent-dialog.png') });

    await page.locator('.agent-btn--primary').click();
    // C1: the page toast lands clear of the floating Agent button (it used to sit on it).
    const toastEl = page.locator('.agents-toast').first();
    const toastUp = await until(async () => (await toastEl.count()) > 0, 10000);
    const floaterEl = page.locator('.agent-fab, .agent-dock:not(.agent-dock--floating)').first();
    const toastR = toastUp ? await rect(toastEl).catch(() => null) : null;
    const floaterR = (await floaterEl.count()) ? await rect(floaterEl) : null;
    check('[C1] the page toast clears the floating Agent button (was overlapping it)',
      !!toastR && !!floaterR && overlapArea(toastR, floaterR) === 0, `toast=${JSON.stringify(toastR)} floater=${JSON.stringify(floaterR)}`);
    // Wait for the LAST write of the create sequence (manifest, then the photo
    // upload that patches `photo:` into it), not the first.
    const callCard = await until(async () => /^photo: automations\/photos\//m.test(manifestText('researcher')), 25000);
    check('the on-call agent is created and its card appears', callCard,
      callCard ? '' : `manifest=${manifestText('researcher').slice(0, 200)}`);
    const callManifest = manifestText('researcher');
    check('…written with mode: call', /^mode: call$/m.test(callManifest), callManifest.slice(0, 300));
    check('…and NO schedule', /^schedule: null$/m.test(callManifest), callManifest.slice(0, 300));
    check('…approved on this machine', approvalFor('researcher') !== null);
    check('…with a photo under automations/photos', /^photo: automations\/photos\/researcher\.png$/m.test(callManifest), callManifest.slice(0, 300));
    check('…and the file is on disk', existsSync(join(AUTOMATIONS_DIR, 'photos', 'researcher.png')));

    // An on-call agent is not an automation: it lives on the Agents page now, so its card,
    // face and on-call reading are checked there, and the popover, Edit and Delete checks below
    // run on the scheduled automation, the card they still belong to.
    await showRoster();
    await until(async () => (await page.locator('.agent-card', { hasText: 'Daily insight digest' }).count()) > 0, 10000);
    check('the on-call agent is NOT an automation card',
      await page.locator('.agent-card:not(.agent-card--new)', { hasText: 'Researcher' }).count() === 0);
    const agentsRow = page.locator('.sidebar-item').filter({ has: page.locator('.sidebar-label', { hasText: /^Agents$/ }) }).first();
    await agentsRow.click();
    const callCardEl = page.locator('[data-agent="researcher"]').first();
    check('…it is a card on the Agents page instead', await until(async () => (await callCardEl.count()) > 0, 10000));
    check('an on-call agent shows NO pause switch', await callCardEl.locator('.agent-switch').count() === 0);
    check('its photo renders from the photo route', await until(async () => (await callCardEl.locator('.agent-av img').count()) === 1, 8000));
    const photoRes = await page.evaluate(async (b) => {
      const r = await fetch(`${b}/api/automations/researcher/photo?vault=proj`);
      return { status: r.status, type: r.headers.get('content-type'), bytes: (await r.arrayBuffer()).byteLength };
    }, base);
    check('GET …/photo returns real PNG bytes', photoRes.status === 200 && photoRes.type === 'image/png' && photoRes.bytes > 100, JSON.stringify(photoRes));
    await page.screenshot({ path: join(SHOTS, '3-members.png') });

    // ── 4: the profile: the on-call agent's on the Agents page, the popover on an automation ──
    console.log('\n═══ 4. Profile popover ═══');
    await callCardEl.click();
    const profileEl = page.locator('[data-agent-profile="researcher"]');
    const profiled = await until(async () => (await profileEl.count()) > 0);
    check('clicking its Agents card opens its profile', profiled);
    const profileText = profiled ? await profileEl.innerText() : '';
    // The Agents page's "When you call it": the profile shows how a CALL to it runs.
    check('…and reads as on-call: its profile shows its call settings',
      (await profileEl.locator('[data-call-settings]').count()) === 1 && profileText.includes('How a call to this agent runs'),
      profileText.replace(/\s+/g, ' ').slice(0, 600));
    check('…with its model and effort', /fable|opus|sonnet|haiku/.test(profileText) && /effort|low|medium|high/i.test(profileText), profileText.slice(0, 200));
    check('…Edit, and NO Run now', profileText.includes('Edit') && !profileText.includes('Run now'), profileText.slice(0, 200));
    check('…and NO Pause for an on-call agent', !/Pause|Resume/.test(profileText), profileText.slice(0, 200));
    await page.screenshot({ path: join(SHOTS, '4-agents-profile.png') });

    await page.locator('.sidebar-item', { hasText: 'Automations' }).first().click();
    await page.waitForTimeout(800);
    await showRoster();
    const schedCardEl = page.locator('.agent-card:not(.agent-card--new)', { hasText: 'Daily insight digest' }).first();
    await schedCardEl.locator('.agent-card-name').click();
    const popped = await until(async () => (await page.locator('.agent-pop').count()) > 0);
    check('clicking the name opens the profile popover', popped);
    const popText = popped ? await page.locator('.agent-pop').innerText() : '';
    check('…with the cadence, model and effort', /Runs /.test(popText) && /fable|opus|sonnet|haiku/.test(popText) && /effort/.test(popText), popText.slice(0, 200));
    // The popover is the surface with room to BE a document, so the markdown
    // is rendered here rather than dumped as raw syntax.
    check('…and the description rendered as real markdown, not raw syntax',
      (await page.locator('.agent-pop-desc').count()) === 1
      && !(await page.locator('.agent-pop-desc').innerText()).includes('**'));
    check('…Edit, and NO Run now', popText.includes('Edit') && !popText.includes('Run now'), popText.slice(0, 200));
    await page.screenshot({ path: join(SHOTS, '4-profile-popover.png') });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // ── 5: edit re-approves, and the next run uses the new prompt ─────────
    console.log('\n═══ 5. Edit ═══');
    const approvedBefore = approvalFor(SCHED_SLUG);
    await page.locator('.agent-card:not(.agent-card--new)', { hasText: 'Daily insight digest' }).first()
      .locator('.agent-card-btn', { hasText: 'Edit' }).click();
    await until(async () => (await page.locator('.agent-modal').count()) > 0);
    check('the Edit dialog says "Save and re-approve on this Mac"',
      (await page.locator('.agent-btn--primary').innerText()).includes('Save and re-approve on this Mac'));
    check('…and offers Delete', await page.locator('.agent-btn--danger').count() === 1);
    await page.locator('.agent-textarea').fill('Yeni görev: rakipleri tara ve kaynaklı brief yaz.');
    await page.locator('.agent-btn--primary').click();
    const edited = await until(async () => manifestText(SCHED_SLUG).includes('Yeni görev'), 15000);
    check('the edited prompt is on disk — the next run uses it', edited, manifestText(SCHED_SLUG).slice(0, 300));
    // `updateAutomation` writes the manifest, THEN `approveHere` rewrites the
    // registry — so a read taken the instant the prompt lands is a coin flip.
    const reApproved = await until(async () => {
      const a = approvalFor(SCHED_SLUG);
      return a !== null && a.manifestSha256 !== approvedBefore?.manifestSha256;
    }, 10000);
    const approvedAfter = approvalFor(SCHED_SLUG);
    check('…and the changed manifest was re-approved here', reApproved,
      `before=${approvedBefore?.manifestSha256?.slice(0, 12)} after=${approvedAfter?.manifestSha256?.slice(0, 12)}`);

    // ── 5a: a long prompt survives an edit ────────────────────────────────
    // 2026-09-30: the dialog seeded its field from the list's 600-character preview, so a
    // "Save and re-approve" cut a 6,700-character prompt mid-word and approved the stump.
    console.log('\n═══ 5a. A long prompt survives an edit ═══');
    const LONG = `Uzun görev. ${'Her adım ayrı bir satırda anlatılır ve hiçbiri kaybolmaz. '.repeat(25)}SON SATIR BURADA.`;
    const schedPath = join(AUTOMATIONS_DIR, `${SCHED_SLUG}.md`);
    writeFileSync(schedPath, readFileSync(schedPath, 'utf-8')
      .replace('Yeni görev: rakipleri tara ve kaynaklı brief yaz.', LONG));
    check('[setup] the manifest now holds a prompt longer than the 600-character preview',
      manifestText(SCHED_SLUG).includes('SON SATIR BURADA.') && LONG.length > 600);
    await showRoster();
    await page.locator('.agent-card:not(.agent-card--new)', { hasText: 'Daily insight digest' }).first()
      .locator('.agent-card-btn', { hasText: 'Edit' }).click();
    const fullLoaded = await until(async () =>
      (await page.locator('.agent-modal .agent-textarea').inputValue()).includes('SON SATIR BURADA.'), 10000);
    check('the Edit dialog loads the FULL prompt, not the preview (was cut at 600 characters)', fullLoaded,
      `len=${(await page.locator('.agent-modal .agent-textarea').inputValue()).length} placeholder=${await page.locator('.agent-modal .agent-textarea').getAttribute('placeholder')} modal=${await page.locator('.agent-modal').count()}`);
    await page.locator('.agent-btn--primary').click();
    await until(async () => (await page.locator('.agent-modal').count()) === 0, 10000);
    check('…and saving it unchanged keeps the whole prompt on disk',
      manifestText(SCHED_SLUG).includes('SON SATIR BURADA.'), manifestText(SCHED_SLUG).slice(-300));

    // ── 5b: the details screen ────────────────────────────────────────────
    console.log('\n═══ 5b. Details screen ═══');
    await showRoster();
    await page.locator('.agent-card-btn', { hasText: 'Runs' }).first().click();
    const panelOpen = await until(async () => (await page.locator('.adp-panel').count()) > 0, 10000);
    check('Runs opens the details screen', panelOpen);
    check('…with no Run now button — an agent is called from its thread',
      await page.locator('.adp-run').count() === 0);
    check('…and no Telegram section',
      await page.locator('[class*="telegram"], [class*="Telegram"]').count() === 0);
    check('…no uppercase ornament labels left on it (K15)',
      await page.evaluate(() => [...document.querySelectorAll('.adp-panel *')]
        .filter((el) => getComputedStyle(el).textTransform === 'uppercase').length) === 0);
    check('…and an Edit button that opens the Edit dialog',
      await page.locator('.adp-edit', { hasText: /^Edit$/ }).count() === 1);
    await page.locator('.adp-edit', { hasText: /^Edit$/ }).click();
    const fromDetail = await until(async () => (await page.locator('.agent-modal').count()) > 0, 8000);
    check('Edit from the details screen opens the dialog', fromDetail);
    check('…and closes the details screen behind it', await page.locator('.adp-panel').count() === 0);
    await page.keyboard.press('Escape');
    await until(async () => (await page.locator('.agent-modal').count()) === 0, 8000);

    // ── 6: a photo path outside the brain is refused ──────────────────────
    console.log('\n═══ 6. Photo containment ═══');
    const escaped = await page.evaluate(async (b) => {
      const r = await fetch(`${b}/api/automations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Dreamcontext-Vault': 'proj' },
        body: JSON.stringify({ title: 'Escaper', prompt: 'x', photo: '/etc/passwd', days: 'daily', at: '09:00' }),
      });
      return { status: r.status, body: await r.json() };
    }, base);
    // The route never takes `photo` on create at all (it is uploaded after the
    // slug settles) — so the correct proof is that the key is IGNORED, never
    // written, rather than honoured.
    check('a create carrying an outside photo path never writes that path',
      !manifestText('escaper').includes('/etc/passwd'),
      `status=${escaped.status} manifest=${manifestText('escaper').slice(0, 200)}`);

    // ── 7: two-click delete ───────────────────────────────────────────────
    console.log('\n═══ 7. Two-click delete ═══');
    await showRoster();
    await page.locator('.agent-card:not(.agent-card--new)', { hasText: 'Daily insight digest' }).first()
      .locator('.agent-card-btn', { hasText: 'Edit' }).click();
    await until(async () => (await page.locator('.agent-modal').count()) > 0);
    const del = page.locator('.agent-btn--danger');
    check('Delete starts unarmed', (await del.innerText()).trim() === 'Delete automation');
    await del.click();
    await page.waitForTimeout(400);
    check('the FIRST click only arms it (label changes)', (await del.innerText()).includes('Click again to delete'));
    check('…and deletes nothing', existsSync(join(AUTOMATIONS_DIR, `${SCHED_SLUG}.md`)));
    await page.screenshot({ path: join(SHOTS, '5-delete-armed.png') });
    await del.click();
    const gone = await until(async () => !existsSync(join(AUTOMATIONS_DIR, `${SCHED_SLUG}.md`)), 15000);
    check('the SECOND click commits: the manifest is gone', gone);
    check('…and its cache', !existsSync(join(AUTOMATIONS_DIR, 'cache', `${SCHED_SLUG}.json`)));
    await until(async () => (await page.locator('.agent-modal').count()) === 0, 8000);

    // The on-call agent, which owns the photo, is deleted where it lives: its Agents profile,
    // with the same two-click arming.
    await agentsRow.click();
    await until(async () => (await callCardEl.count()) > 0, 10000);
    await callCardEl.click();
    const agentDel = page.locator('[data-agent-profile="researcher"] .agp-btn--danger');
    await until(async () => (await agentDel.count()) > 0, 8000);
    await agentDel.click();
    await page.waitForTimeout(400);
    check('deleting the on-call agent from its profile: the first click only arms it',
      (await agentDel.getAttribute('data-delete-armed')) === 'true' && existsSync(join(AUTOMATIONS_DIR, 'researcher.md')));
    await agentDel.click();
    const callGone = await until(async () => !existsSync(join(AUTOMATIONS_DIR, 'researcher.md')), 15000);
    check('…the second commits: its file is gone', callGone);
    const photoGone = await until(async () => !existsSync(join(AUTOMATIONS_DIR, 'photos', 'researcher.png')), 10000);
    check('…and so is its photo', photoGone,
      photoGone ? '' : `photos dir still holds: ${existsSync(join(AUTOMATIONS_DIR, 'photos')) ? readdirSync(join(AUTOMATIONS_DIR, 'photos')).join(', ') : '(no dir)'}`);
    check('…and its cache', !existsSync(join(AUTOMATIONS_DIR, 'cache', 'researcher.json')));
    await page.locator('.sidebar-item', { hasText: 'Automations' }).first().click();
    await page.waitForTimeout(800);

    // ── 7b: a create that PICKS AN AGENT (S2) ─────────────────────────────
    console.log('\n═══ 7b. A create picks an agent ═══');
    await until(async () => (await page.locator('.agent-modal').count()) === 0, 8000);
    const scout = await page.evaluate(async (b) => {
      const r = await fetch(`${b}/api/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Dreamcontext-Vault': 'proj' },
        body: JSON.stringify({ title: 'Scout', prompt: 'You read the project and report what changed, briefly.' }),
      });
      return { status: r.status, body: await r.json() };
    }, base);
    check('[setup] POST /api/agents made the agent "scout"', scout.status === 200 && scout.body?.agent?.slug === 'scout', JSON.stringify(scout.body).slice(0, 200));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    await dismissOverlays();
    await page.locator('.sidebar-item', { hasText: 'Automations' }).first().click();
    await page.waitForTimeout(800);
    await page.locator('.agents-new-btn').click();
    await until(async () => (await page.locator('.agent-modal .automation-agent-select option[value="scout"]').count()) > 0, 10000);
    await page.locator('.automation-agent-select').selectOption('scout');
    await page.waitForTimeout(300);
    check('[S2] picking an agent shows its face beside the picker',
      await page.locator('.agent-modal .automation-agent-row .agent-av').count() === 1);
    check('[S2] …and hides the identity fields (no photo presets, no model, no on-call chip)',
      await page.locator('.agent-modal .agent-preset').count() === 0
      && await page.locator('.agent-modal .agent-row3').count() === 0
      && await page.locator('.agent-modal .agent-chip', { hasText: 'Only when I call it' }).count() === 0);
    const jobLabel = await page.locator('.agent-modal .agent-label', { hasText: 'Job' }).count();
    check('[S2] …and asks for a Job', jobLabel === 1);
    await page.locator('.agent-modal .agent-input').first().fill('Morning scout');
    await page.locator('.agent-modal .agent-textarea').first().fill('Every morning, list what changed in the brain yesterday.');

    // The 409 first, through a mocked refusal: the notice must appear IN the dialog, with a
    // link that opens that agent on the Agents page.
    await page.route(/\/api\/automations(\?|$)/, (route) => (route.request().method() === 'POST'
      ? route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'agent_unapproved', message: 'Scout is not approved on this machine.' }) })
      : route.continue()));
    await page.locator('.agent-btn--primary').click();
    const refused = await until(async () => (await page.locator('.agent-modal .automation-agent-refused').count()) > 0, 8000);
    check('[S2] a 409 agent_unapproved is shown in place, in the dialog', refused
      && (await page.locator('.agent-modal .automation-agent-refused').innerText()).includes('Scout'));
    await page.screenshot({ path: join(SHOTS, '7b-agent-unapproved.png') });
    await page.unroute(/\/api\/automations(\?|$)/);
    // Re-picking clears the refusal; the real save follows.
    await page.locator('.automation-agent-select').selectOption('__own__');
    await page.locator('.automation-agent-select').selectOption('scout');
    await page.waitForTimeout(300);
    await page.locator('.agent-modal .agent-input').first().fill('Morning scout');
    await page.locator('.agent-modal .agent-textarea').first().fill('Every morning, list what changed in the brain yesterday.');
    await page.screenshot({ path: join(SHOTS, '7b-agent-picked.png') });
    await page.locator('.agent-btn--primary').click();
    const bound = await until(async () => /^agent: ['"]?scout['"]?$/m.test(manifestText('morning-scout')), 15000);
    check('[S2] the create sends agent + job: the automation file says agent: scout', bound, manifestText('morning-scout').slice(0, 300));
    check('[S2] …and carries the job', manifestText('morning-scout').includes('list what changed in the brain yesterday'));
    await showRoster();
    const scoutCard = page.locator('.agent-card', { hasText: 'Morning scout' }).first();
    const scoutCardShown = await until(async () => (await scoutCard.count()) > 0, 10000);
    check('[S2] the card names the agent it runs as', scoutCardShown && (await scoutCard.innerText()).includes('Runs as Scout'));
    check('[S2] …and wears the agent\'s face (initials of Scout, not of Morning scout)',
      scoutCardShown && (await scoutCard.locator('.agent-av').first().innerText()).trim() === 'S');

    // The refusal's link: an agent the roster reports as not approved for chat (the roster
    // answer rewritten in flight, before the dialog's own read) shows the notice before saving,
    // and the link opens that agent on the Agents page.
    await page.route(/\/api\/agents(\?|$)/, async (route) => {
      const res = await route.fetch();
      const json = await res.json();
      for (const a of json.agents ?? []) if (a.slug === 'scout') a.approvedForChat = false;
      await route.fulfill({ response: res, json });
    });
    // A fresh load, so the roster is really READ through the rewrite: the copy cached a moment
    // ago (the bound create above) is inside the query client's 5 s staleTime and would be
    // served without a request, leaving the mock unread.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    await dismissOverlays();
    await page.locator('.sidebar-item', { hasText: 'Automations' }).first().click();
    await page.waitForTimeout(800);
    await page.locator('.agents-new-btn').click();
    await until(async () => (await page.locator('.agent-modal .automation-agent-select option[value="scout"]').count()) > 0, 10000);
    await page.locator('.automation-agent-select').selectOption('scout');
    const notice = await until(async () => (await page.locator('.agent-modal .automation-agent-refused').count()) > 0, 8000);
    check('[S2] an agent not approved for chat shows the notice before saving, and Save waits',
      notice && await page.locator('.agent-btn--primary').isDisabled());
    if (notice) {
      await page.locator('.automation-agent-link').first().click();
      const toAgent = await until(async () => {
        const active = await page.locator('.sidebar-item[aria-current="page"]').first().innerText().catch(() => '');
        return /Agents/.test(active) && !/Automations/.test(active);
      }, 8000);
      check('[S2] …and its link opens that agent on the Agents page', toAgent && (await page.locator('.agent-modal').count()) === 0);
    }
    await page.unroute(/\/api\/agents(\?|$)/);
    await page.locator('.sidebar-item', { hasText: 'Automations' }).first().click();
    await page.waitForTimeout(800);

    // ── 8: the Messages tab ───────────────────────────────────────────────
    // Step 2 replaced this tab's placeholder with the real feed. What step 1
    // still owns here is only that the tab EXISTS and opens something
    // coherent; what the feed itself says is `verify:agents-feed`'s business.
    console.log('\n═══ 8. Messages tab ═══');
    await until(async () => (await page.locator('.agent-modal').count()) === 0, 8000);
    await page.locator('.agents-switch-opt', { hasText: 'Messages' }).click();
    await page.waitForTimeout(600);
    const feedShown = await until(async () => (await page.locator('.agents-feed').count()) > 0, 10000);
    check('the Messages tab opens the channel feed', feedShown);
    // This fixture deleted its only agent in check 5, so the channel is empty
    // and has to say so in its own words rather than showing a blank panel.
    const zeroText = await page.locator('.agents-feed-zero').innerText().catch(() => '');
    check('…and an empty channel explains itself',
      zeroText.includes('Nothing has been posted here yet'), `text="${zeroText}"`);
    await page.screenshot({ path: join(SHOTS, '6-messages-tab.png') });

    check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
    srv.kill();
  }

  console.log(`\n${report.fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${report.pass} passed, ${report.fail} failed`);
  console.log(`  screenshots: ${SHOTS}`);
  process.exit(report.fail === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
