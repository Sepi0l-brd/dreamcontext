/**
 * S7: `dreamcontext://project/<vault>/page/agents/<slug>` opens that agent's profile.
 *
 * Both halves of the grammar, because it is duplicated on purpose (`src/lib/app-link.ts` writes,
 * `dashboard/src/lib/appLink.ts` reads, neither trusts the other): the agents page takes an item
 * id, that id must be an agent SLUG (stricter than the generic id the other pages take), and the
 * two sides agree byte for byte.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  AppLinkError, buildAppLink as nodeBuild, parseAppLink as nodeParse,
} from '../../src/lib/app-link.js';

vi.mock('../../dashboard/src/lib/desktop', () => ({
  isDesktop: () => false,
  openInboxWindow: vi.fn(), openVaultWindow: vi.fn(), openViewerWindow: vi.fn(),
  vaultWindowLabel: (v: string) => `vault-${v}`,
}));
vi.mock('../../dashboard/src/lib/windowRegistry', () => ({ thisWindowLabel: async () => '', resolveLiveWindowForVault: async () => null }));
const { parseAppLink: dashParse, buildAppLink: dashBuild } = await import('../../dashboard/src/lib/appLink');

const VAULT = 'Kitap Ağacı';

describe('page/agents/<slug>', () => {
  it('the Node writer builds it and both readers land on the agent', () => {
    const raw = nodeBuild({ kind: 'page', vault: VAULT, page: 'agents', id: 'daily-researcher' });
    expect(raw).toBe('dreamcontext://project/Kitap%20A%C4%9Fac%C4%B1/page/agents/daily-researcher');
    expect(nodeParse(raw)).toEqual({ kind: 'page', vault: VAULT, page: 'agents', id: 'daily-researcher' });
    expect(dashParse(raw)).toEqual({ kind: 'page', vault: VAULT, page: 'agents', id: 'daily-researcher' });
    expect(dashBuild({ kind: 'page', vault: VAULT, page: 'agents', id: 'daily-researcher' })).toBe(raw);
  });

  it('the bare page is a destination of its own (the roster)', () => {
    const raw = nodeBuild({ kind: 'page', vault: VAULT, page: 'agents' });
    expect(raw).toBe('dreamcontext://project/Kitap%20A%C4%9Fac%C4%B1/page/agents');
    expect(dashParse(raw)).toEqual({ kind: 'page', vault: VAULT, page: 'agents', id: null });
  });

  it('refuses an id that is not an agent slug, on both sides', () => {
    // Each of these passes the generic item-id rule (`tasks`/`core` would take it).
    for (const id of ['Daily', 'daily_brief', '0.soul.md', 'a.b', '-lead']) {
      expect(() => nodeBuild({ kind: 'page', vault: VAULT, page: 'agents', id }), id).toThrow(AppLinkError);
      const raw = `dreamcontext://project/v/page/agents/${id}`;
      expect(nodeParse(raw), id).toBeNull();
      expect(dashParse(raw), id).toBeNull();
    }
  });

  it('the generic id rule still holds for the other pages', () => {
    expect(dashParse('dreamcontext://project/v/page/core/0.soul.md')).toEqual({ kind: 'page', vault: 'v', page: 'core', id: '0.soul.md' });
    expect(nodeParse('dreamcontext://project/v/page/sleep/x')).toBeNull();
  });

  it('refuses an extra segment and a query', () => {
    for (const raw of [
      'dreamcontext://project/v/page/agents/a/b',
      'dreamcontext://project/v/page/agents/a?x=1',
    ]) {
      expect(nodeParse(raw), raw).toBeNull();
      expect(dashParse(raw), raw).toBeNull();
    }
  });
});
