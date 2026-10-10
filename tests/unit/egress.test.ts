import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFields, type CorpusDoc, type CorpusType } from '../../src/lib/recall.js';
import type { Chunk } from '../../src/lib/embeddings/chunker.js';
import {
  buildEgressPayload, effectiveTier, isUnderEvalFrozenDir, rerankScoresByKey, resolveEgressPayload,
} from '../../src/lib/embeddings/egress.js';
import {
  grantVaultConsent, recordCloudUsage, setRecallCloudKey, type CloudTier, type RerankModel,
} from '../../src/lib/recall-cloud-config.js';

let tmp: string;
let home: string;
let root: string;
const fetchSpy = vi.fn();
const ENV_KEYS = ['DREAMCONTEXT_SPAWNED', 'DREAMCONTEXT_AUTOMATION_RUN', 'DREAMCONTEXT_AUTO_SLEEP', 'DREAMCONTEXT_RECALL_OPENROUTER_KEY'];
const saved: Record<string, string | undefined> = {};
// Built by concatenation so this file never carries a secret-shaped literal itself.
const FAKE_AWS = `AKIA${'ABCDEFGHIJKLMNOP'}`;
const FAKE_PEM = `-----BEGIN ${'PRIVATE KEY'}-----`;

function mkDoc(slug: string, body: string, over: Partial<CorpusDoc> = {}, dir = root, type: CorpusType = 'knowledge'): CorpusDoc {
  const path = join(dir, type, `${slug}.md`);
  mkdirSync(join(dir, type), { recursive: true });
  writeFileSync(path, body);
  const f = buildFields({ slug, title: slug, description: 'desc', tags: [], body });
  return {
    type, path, relPath: `${type}/${slug}.md`, slug, title: slug, description: 'desc', tags: [], body,
    tokens: f.tokens, tokenSet: new Set(f.tokens), termFreq: f.termFreq, fieldFreq: f.fieldFreq, fieldLen: f.fieldLen,
    links: f.links, identityTokens: f.identityTokens, ...over,
  };
}
const chunk = (seq: number, text: string): Chunk => ({ seq, hash: `hash-${text.slice(0, 12)}-${seq}`, text });
const consent = (tier: CloudTier, rerank: RerankModel | null = null): void => {
  setRecallCloudKey('or-test-key-0123456789', 'manual', home);
  grantVaultConsent(root, { tier, rerankModel: rerank, surface: 'cli-tty' }, home);
};
const bodyOf = (p: unknown): { input?: string[]; documents?: string[]; query?: string; provider: { data_collection: string }; model: string } =>
  JSON.parse(resolveEgressPayload(p)!.bodyJson);

beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  tmp = mkdtempSync(join(tmpdir(), 'dc-egress-'));
  home = join(tmp, 'home');
  root = join(tmp, 'vault', '_dream_context');
  mkdirSync(home, { recursive: true });
  mkdirSync(root, { recursive: true });
  fetchSpy.mockReset();
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(tmp, { recursive: true, force: true });
});

describe('consent is enforced inside the egress layer', () => {
  it('mints nothing for tier:cloud on an unconsented, non-frozen root', () => {
    const doc = mkDoc('a', 'plain body text about recall');
    for (const r of [
      buildEgressPayload({ kind: 'query', contextRoot: root, tier: 'cloud', home, query: 'how does recall work' }),
      buildEgressPayload({ kind: 'index', contextRoot: root, tier: 'cloud', home, profile: 'voyage-4', items: [{ doc, chunk: chunk(0, 'plain body') }] }),
      buildEgressPayload({ kind: 'rerank', contextRoot: root, tier: 'cloud', home, model: 'voyageai/rerank-2.5-lite', query: 'q', candidates: [{ doc, bestChunk: null }] }),
    ]) {
      expect(r.payload).toBeNull();
      expect(r.effectiveTier).toBe('local');
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('treats an undefined tier as local even with cloud consent', () => {
    consent('cloud');
    const r = buildEgressPayload({ kind: 'query', contextRoot: root, home, query: 'hello recall' });
    expect(r.payload).toBeNull();
    expect(r.effectiveTier).toBe('local');
    expect(r.withheld[0].rule).toBe('tier_local');
  });

  it('caps the requested tier at the consented one', () => {
    consent('cloud-index');
    expect(effectiveTier(root, 'cloud', false, home)).toBe('cloud-index');
    expect(buildEgressPayload({ kind: 'query', contextRoot: root, tier: 'cloud', home, query: 'hello recall' }).payload).toBeNull();
  });

  it('lets a cloud-index root index but never query', () => {
    consent('cloud-index');
    const doc = mkDoc('a', 'plain body text');
    const r = buildEgressPayload({ kind: 'index', contextRoot: root, tier: 'cloud', home, profile: 'voyage-4', items: [{ doc, chunk: chunk(0, 'plain body text') }] });
    expect(r.payload).not.toBeNull();
    expect(r.effectiveTier).toBe('cloud-index');
    expect(buildEgressPayload({ kind: 'query', contextRoot: root, tier: 'cloud', home, query: 'hello' }).payload).toBeNull();
  });
});

describe('payload shape', () => {
  it('is frozen, carries no body, and is resolvable only through the egress WeakMap', () => {
    consent('cloud');
    const r = buildEgressPayload({ kind: 'query', contextRoot: root, tier: 'cloud', home, query: 'how does recall work' });
    const p = r.payload!;
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.itemKeys)).toBe(true);
    expect(Object.keys(p).sort()).toEqual(['endpoint', 'itemKeys']);
    expect(JSON.stringify(p)).not.toContain('recall');
    expect(resolveEgressPayload(p)).not.toBeNull();
    expect(resolveEgressPayload({ ...p })).toBeNull();
    expect(resolveEgressPayload(structuredClone({ endpoint: p.endpoint, itemKeys: [] }))).toBeNull();
    expect(resolveEgressPayload(null)).toBeNull();
  });

  it('always carries the data-collection deny preference', () => {
    consent('cloud', 'voyageai/rerank-2.5-lite');
    const doc = mkDoc('a', 'plain body');
    const q = buildEgressPayload({ kind: 'query', contextRoot: root, tier: 'cloud', home, query: 'hello recall' }).payload;
    const i = buildEgressPayload({ kind: 'index', contextRoot: root, tier: 'cloud', home, profile: 'voyage-4', items: [{ doc, chunk: chunk(0, 'plain body') }] }).payload;
    const rr = buildEgressPayload({ kind: 'rerank', contextRoot: root, tier: 'cloud', home, model: 'voyageai/rerank-2.5-lite', query: 'hello recall', candidates: [{ doc, bestChunk: null }] }).payload;
    for (const p of [q, i, rr]) expect(bodyOf(p).provider).toEqual({ data_collection: 'deny' });
  });
});

describe('queries', () => {
  beforeEach(() => consent('cloud'));

  it('sends the first 512 characters of a long prompt', () => {
    const r = buildEgressPayload({ kind: 'query', contextRoot: root, tier: 'cloud', home, query: 'x'.repeat(2000) });
    expect(bodyOf(r.payload).input![0]).toHaveLength(512);
  });

  it('sends nothing for a prompt with a secret, even past the cap', () => {
    const r = buildEgressPayload({ kind: 'query', contextRoot: root, tier: 'cloud', home, query: `${'x'.repeat(1500)} ${FAKE_AWS}` });
    expect(r.payload).toBeNull();
    expect(r.withheld[0].rule).toBe('secret_aws');
  });

  it('withholds in a spawned session', () => {
    process.env.DREAMCONTEXT_SPAWNED = 'develop';
    const r = buildEgressPayload({ kind: 'query', contextRoot: root, tier: 'cloud', home, query: 'hello recall' });
    expect(r.payload).toBeNull();
    expect(r.withheld[0].rule).toBe('spawned_session');
  });

  it('withholds once the daily cap is reached', () => {
    const cfgPath = join(home, '.dreamcontext', 'recall-cloud.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    cfg.spend = { maxQueriesPerDay: 1 };
    writeFileSync(cfgPath, JSON.stringify(cfg));
    recordCloudUsage(root, 'query', 0.001, {}, home);
    const r = buildEgressPayload({ kind: 'query', contextRoot: root, tier: 'cloud', home, query: 'hello recall' });
    expect(r.payload).toBeNull();
    expect(r.withheld[0].rule).toBe('daily_cap');
  });
});

describe('index eligibility', () => {
  beforeEach(() => consent('cloud-index'));

  it('sends only eligible docs and chunks, and never a planted secret', () => {
    const ok = mkDoc('ok', 'safe knowledge body');
    const task = mkDoc('t', 'a task body with a leaked key ' + FAKE_AWS, {}, root, 'task');
    const changelog = mkDoc('c', 'pointer entry', {}, root, 'changelog');
    const capture = mkDoc('cap', 'digest text', { capture: true });
    const fed = mkDoc('fed', 'peer text', { federated: true });
    const optOut = mkDoc('opt', 'private note', { cloudOptOut: true });
    const pem = mkDoc('pem', `intro\n${FAKE_PEM}\nMIIE`);
    const items = [ok, task, changelog, capture, fed, optOut, pem].map((doc, i) => ({ doc, chunk: chunk(i, doc.body) }));
    const r = buildEgressPayload({ kind: 'index', contextRoot: root, tier: 'cloud', home, profile: 'voyage-4', items });
    expect(bodyOf(r.payload).input).toEqual(['safe knowledge body']);
    expect(r.payload!.itemKeys).toEqual([items[0].chunk.hash]);
    expect(resolveEgressPayload(r.payload)!.bodyJson).not.toContain('AKIA');
    expect(resolveEgressPayload(r.payload)!.bodyJson).not.toContain('BEGIN');
    expect(Object.fromEntries(r.withheld.map((w) => [w.docKey, w.rule]))).toMatchObject({
      'task/t': 'secret_aws', 'changelog/c': 'type_not_allowed', 'knowledge/cap': 'capture',
      'knowledge/fed': 'federated', 'knowledge/opt': 'cloud_false', 'knowledge/pem': 'secret_pem',
    });
  });

  it('withholds docs from another root and symlinked children (outside_root)', () => {
    const elsewhere = join(tmp, 'other-vault');
    mkdirSync(elsewhere, { recursive: true });
    const foreign = mkDoc('foreign', 'text from another vault', {}, elsewhere);
    const real = join(tmp, 'outside.md');
    writeFileSync(real, 'outside text');
    mkdirSync(join(root, 'knowledge'), { recursive: true });
    const linkPath = join(root, 'knowledge', 'link.md');
    symlinkSync(real, linkPath);
    const linked = mkDoc('link', 'outside text', {}, root);
    writeFileSync(linkPath, 'x'); // no-op through the link; the doc's path IS the symlink below
    const linkDoc: CorpusDoc = { ...linked, path: linkPath };
    const r = buildEgressPayload({
      kind: 'index', contextRoot: root, tier: 'cloud', home, profile: 'voyage-4',
      items: [{ doc: foreign, chunk: chunk(0, 'text from another vault') }, { doc: linkDoc, chunk: chunk(1, 'outside text') }],
    });
    expect(r.payload).toBeNull();
    expect(r.withheld.map((w) => w.rule)).toEqual(['outside_root', 'outside_root']);
  });

  it('mints nothing for an empty batch', () => {
    expect(buildEgressPayload({ kind: 'index', contextRoot: root, tier: 'cloud', home, profile: 'voyage-4', items: [] }).payload).toBeNull();
  });
});

describe('rerank', () => {
  const lite: RerankModel = 'voyageai/rerank-2.5-lite';
  const full: RerankModel = 'voyageai/rerank-2.5';

  it('is refused unless the model equals the consented, non-null rerankModel', () => {
    consent('cloud', lite);
    const doc = mkDoc('a', 'plain body');
    const mk = (model: RerankModel) => buildEgressPayload({ kind: 'rerank', contextRoot: root, tier: 'cloud', home, model, query: 'hello recall', candidates: [{ doc, bestChunk: null }] });
    expect(mk(lite).payload).not.toBeNull();
    const refused = mk(full);
    expect(refused.payload).toBeNull();
    expect(refused.withheld[0].rule).toBe('rerank_not_consented');
  });

  it('is refused when consent chose no reranker, and for cloud-index', () => {
    consent('cloud', null);
    const doc = mkDoc('a', 'plain body');
    const mk = () => buildEgressPayload({ kind: 'rerank', contextRoot: root, tier: 'cloud', home, model: lite, query: 'hello recall', candidates: [{ doc, bestChunk: null }] });
    expect(mk().payload).toBeNull();
    grantVaultConsent(root, { tier: 'cloud-index', rerankModel: lite, surface: 'cli-tty' }, home);
    expect(mk().payload).toBeNull();
  });

  it('sends only eligible candidates and maps API indexes back to doc keys over the sent list', () => {
    consent('cloud', lite);
    const a = mkDoc('a', 'alpha body');
    const cl = mkDoc('cl', 'pointer', {}, root, 'changelog');
    const cap = mkDoc('cap', 'digest', { capture: true });
    const fed = mkDoc('fed', 'peer', { federated: true });
    const b = mkDoc('b', 'beta body');
    const r = buildEgressPayload({
      kind: 'rerank', contextRoot: root, tier: 'cloud', home, model: lite, query: 'hello recall',
      candidates: [a, cl, cap, fed, b].map((doc) => ({ doc, bestChunk: null })),
    });
    const sent = bodyOf(r.payload);
    expect(sent.documents).toHaveLength(2);
    expect(sent.documents!.join('\n')).not.toMatch(/pointer|digest|peer/);
    expect(r.payload!.itemKeys).toEqual(['knowledge/a', 'knowledge/b']);
    const byKey = rerankScoresByKey(r.payload!, [{ index: 1, relevance: 0.9 }, { index: 0, relevance: 0.2 }]);
    expect([...byKey]).toEqual([['knowledge/b', 0.9], ['knowledge/a', 0.2]]);
  });
});

describe('evalConsent', () => {
  const frozen = (): string => join(home, '.dreamcontext', 'eval-frozen');
  function snapshot(name: string, markers = true): string {
    const snap = join(frozen(), name);
    const r = join(snap, '_dream_context');
    mkdirSync(r, { recursive: true });
    if (markers) { writeFileSync(join(snap, 'FINGERPRINT.json'), '{}'); writeFileSync(join(snap, 'now.txt'), '2026-10-10T00:00:00Z'); }
    return r;
  }
  const query = (r: string, evalConsent = true) =>
    buildEgressPayload({ kind: 'query', contextRoot: r, tier: 'cloud', evalConsent, home, query: 'hello recall' });

  it('grants a real frozen snapshot without any consent or key', () => {
    const snap = snapshot('dc-test');
    expect(isUnderEvalFrozenDir(snap, home)).toBe(true);
    const r = query(snap);
    expect(r.payload).not.toBeNull();
    expect(resolveEgressPayload(r.payload)!.evalMinted).toBe(true);
  });

  it('is ignored without the flag, even on a frozen root', () => {
    expect(query(snapshot('dc-test'), false).payload).toBeNull();
  });

  it.each([
    ['a root missing FINGERPRINT.json / now.txt', () => snapshot('no-markers', false)],
    ['an engines/<sha>/_dream_context archive', () => { const r = join(frozen(), 'engines', '0ba4c25a', '_dream_context'); mkdirSync(r, { recursive: true }); return r; }],
    ['a sibling named eval-frozen-evil', () => {
      const snap = join(home, '.dreamcontext', 'eval-frozen-evil', 'dc-x');
      mkdirSync(join(snap, '_dream_context'), { recursive: true });
      writeFileSync(join(snap, 'FINGERPRINT.json'), '{}'); writeFileSync(join(snap, 'now.txt'), 'x');
      return join(snap, '_dream_context');
    }],
    ['a symlink under the frozen dir into a live vault', () => { snapshot('real'); const l = join(frozen(), 'dc-link'); mkdirSync(frozen(), { recursive: true }); symlinkSync(root, l); return l; }],
    ['a .. traversal out of the frozen dir', () => { snapshot('real'); return join(frozen(), 'real', '_dream_context', '..', '..', '..', '..', '..', 'vault', '_dream_context'); }],
    ['a path that does not exist', () => join(frozen(), 'ghost', '_dream_context')],
  ])('refuses %s: null payload and zero fetches', (_label, make) => {
    const r = make();
    expect(isUnderEvalFrozenDir(r, home)).toBe(false);
    expect(query(r).payload).toBeNull();
    expect(effectiveTier(r, 'cloud', true, home)).toBe('local');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('skips the spawn and daily gates (a spike can run under a builder session)', () => {
    process.env.DREAMCONTEXT_SPAWNED = 'develop';
    expect(query(snapshot('dc-test')).payload).not.toBeNull();
  });
});
