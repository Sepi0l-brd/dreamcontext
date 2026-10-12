/**
 * Wave 4a, lane T6: the Agents page is reachable (rail row, page route, the open-agents request,
 * the `page/agents/<slug>` link), the reversal of ad04364c is RECORDED where the decision lives
 * (S6), and every string the four W4b lanes read already exists in English and Turkish.
 *
 * WHY A SOURCE SCAN. `Sidebar.tsx`, `ProjectInstance.tsx` and `I18nContext.tsx` are dashboard
 * TSX; root vitest runs plain Node without a DOM, so they cannot be mounted here (the same split
 * `sidebar-nav.test.ts` documents). What renders is `scripts/verify/sidebar-rail.mjs`'s job.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf-8');

const SIDEBAR = 'dashboard/src/components/layout/Sidebar.tsx';
const INSTANCE = 'dashboard/src/ProjectInstance.tsx';
const I18N = 'dashboard/src/context/I18nContext.tsx';
const STUB = 'dashboard/src/pages/AgentsPage.tsx';

/** Source with comments removed, so prose explaining a rule never satisfies the rule. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/** The English table and the Turkish partial, as key → value. */
function locales(): { en: Map<string, string>; tr: Map<string, string> } {
  const src = read(I18N);
  const block = (from: number) => src.slice(from, src.indexOf('\n};', from));
  const pairs = (text: string) => new Map(
    [...text.matchAll(/^\s+'([^']+)':\s*(?:'((?:[^'\\]|\\.)*)'|"([^"]*)")/gm)].map((m) => [m[1], m[2] ?? m[3] ?? '']),
  );
  return {
    en: pairs(block(src.indexOf('  en: {'))),
    tr: pairs(block(src.indexOf('const TR_PARTIAL'))),
  };
}

describe('the rail has an Agents row again (S6)', () => {
  it('Page includes agents, and the row sits right after Automations, at Beta, not a hero', () => {
    const src = code(read(SIDEBAR));
    expect(src).toMatch(/export type Page = [^;]*'agents'/);
    const row = /\{\s*page:\s*'agents',\s*labelKey:\s*'nav\.agents'([^}]*)\}/.exec(src);
    expect(row, 'no Agents rail row').toBeTruthy();
    expect(row![1]).toMatch(/maturity:\s*'beta'/);
    expect(row![1]).not.toMatch(/hero/);
    const automations = src.indexOf("page: 'automations'");
    const agents = src.indexOf("page: 'agents'");
    const between = src.slice(automations, agents);
    expect(automations).toBeGreaterThan(-1);
    expect(agents).toBeGreaterThan(automations);
    expect([...between.matchAll(/page:\s*'/g)]).toHaveLength(1);
  });

  it('records the reversal of ad04364c at the rail item AND at the label', () => {
    const sidebar = read(SIDEBAR);
    const at = sidebar.indexOf("{ page: 'agents'");
    const comment = sidebar.slice(Math.max(0, at - 1200), at);
    expect(comment).toMatch(/REVERSED[\s\S]*ad04364c/);
    const i18n = read(I18N);
    const label = i18n.indexOf("'nav.agents': 'Agents'");
    expect(label).toBeGreaterThan(-1);
    expect(i18n.slice(Math.max(0, label - 600), label)).toMatch(/REVERSED[\s\S]*ad04364c/);
  });
});

describe('routing (S7, requestOpenAgents)', () => {
  it('the page router renders AgentsPage with the pinned props', () => {
    const src = code(read(INSTANCE));
    expect(src).toMatch(/case 'agents':\s*return <AgentsPage focus=\{agentsFocus\} onFocusDone=\{onAgentsFocusDone\} \/>/);
  });

  it('a page/agents link lands on the page with the slug as the page\'s own focus', () => {
    const src = code(read(INSTANCE));
    expect(src).toMatch(/parsed\.page === 'agents'\)\s*\{\s*nav\.navigate\('agents', null\);\s*onAgentsFocus\(parsed\.id \? \{ slug: parsed\.id \} : \{\}\);/);
  });

  it('the open-agents and talk-to-agent bridges act only in the ACTIVE instance', () => {
    const src = code(read(INSTANCE));
    for (const name of ['OpenAgentsBridge', 'TalkToAgentBridge']) {
      const at = src.indexOf(`function ${name}`);
      expect(at, name).toBeGreaterThan(-1);
      const body = src.slice(at, src.indexOf('\n}\n', at));
      expect(body, name).toMatch(/if \(!isActive\) return;/);
      expect(body, name).toMatch(/window\.addEventListener\(/);
      expect(body, name).toMatch(/window\.removeEventListener\(/);
      expect(src, `${name} is not mounted`).toMatch(new RegExp(`<${name}[ />]`));
    }
  });

  it('a plain navigate(\'agents\', slug) (an agent recall hit) becomes the page\'s own focus, once per nonce', () => {
    const src = code(read(INSTANCE));
    const at = src.indexOf('function NavFocusAgentsBridge');
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf('\n}\n', at));
    expect(body).toMatch(/page !== 'agents' \|\| !focusId \|\| nonce === landed\.current/);
    expect(body).toMatch(/readOpenAgentsDetail\(\{ slug: focusId \}\)/);
    expect(src).toMatch(/<NavFocusAgentsBridge nav=\{nav\} onAgentsFocus=\{focusAgents\} \/>/);
  });

  it('the stub keeps the pinned props and reads the roster from useAgents', () => {
    const src = code(read(STUB));
    expect(src).toMatch(/export function AgentsPage\(\{ focus, onFocusDone \}: \{ focus: AgentsFocus \| null; onFocusDone: \(\) => void \}\)/);
    expect(src).toMatch(/useAgents\(\)/);
  });
});

describe('every W4b string exists in English and Turkish', () => {
  /** The keys the plan names for the four lanes, plus the page's own. */
  const REQUIRED = [
    'nav.agents',
    'agents.page.title', 'agents.page.empty', 'agents.page.new',
    'agents.profile.talk', 'agents.profile.talkFailed', 'agents.profile.usage', 'agents.profile.callSettings',
    'agents.approval.chatOk', 'agents.approval.chatNo', 'agents.approval.runOk', 'agents.approval.runNo',
    'agents.approval.review', 'agents.approval.approve',
    'agents.identity.createTitle', 'agents.identity.create', 'agents.identity.save',
    'agents.picker.manage',
    'automations.pickAgent', 'automations.job',
    'tasks.assignToAgent', 'tasks.assignDisclosure', 'tasks.approveAndAssign',
  ];

  it('each required key is in both', () => {
    const { en, tr } = locales();
    for (const key of REQUIRED) {
      expect(en.has(key), `en is missing ${key}`).toBe(true);
      expect(tr.has(key), `tr is missing ${key}`).toBe(true);
    }
  });

  it('every new English key has a Turkish twin that is not just the English', () => {
    const { en, tr } = locales();
    const fresh = [...en.keys()].filter((k) => /^(agents\.(page|roster|profile|approval|identity|picker)\.|automations\.(pickAgent|newAgent|agentUnapproved|job|runsAs|openAgent)|tasks\.(assign|approveAndAssign|agent|unassignAgent)|nav\.agents$)/.test(k));
    expect(fresh.length).toBeGreaterThan(100);
    // Same words are fine where Turkish uses them too ("Model").
    const sameOk = new Set(['agents.profile.model', 'agents.identity.model']);
    for (const key of fresh) {
      expect(tr.has(key), `tr is missing ${key}`).toBe(true);
      if (!sameOk.has(key)) expect(tr.get(key), key).not.toBe(en.get(key));
    }
  });

  it('no new copy uses an em dash', () => {
    const { en, tr } = locales();
    for (const [locale, map] of Object.entries({ en, tr })) {
      for (const [key, value] of map) {
        if (!/^(agents\.(page|roster|profile|approval|identity|picker)\.|automations\.(pickAgent|job)|tasks\.assign|nav\.agents$)/.test(key)) continue;
        expect(value, `${locale} ${key}`).not.toContain('—');
      }
    }
  });
});
