import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { docKey, type CorpusDoc } from '../../src/lib/recall.js';
import { hybridSearch, type RecallTiming } from '../../src/lib/embeddings/hybrid.js';
import { FUSION_BY_TIER, type FusionParams } from '../../src/lib/embeddings/fusion-config.js';
import { breakerOpen } from '../../src/lib/embeddings/hybrid.js';
import { embedPassages } from '../../src/lib/embeddings/embedder.js';
import { buildCloudIndex } from '../../src/lib/embeddings/vector-store.js';
import { setRecallCloudKey } from '../../src/lib/recall-cloud-config.js';
import {
  KEY, axisCorpus, axisVector, consentAndIndex, fakeOpenRouter, linkedDoc, mkDoc, setupEnv, teardownEnv, type Env,
} from './_hybrid-fixture.js';

vi.mock('../../src/lib/embeddings/embedder.js', () => ({
  EMBED_MODEL: 'test-model',
  EMBED_DIMS: 4,
  embeddingsAvailable: vi.fn(async () => true),
  embedPassages: vi.fn(),
  embedQuery: vi.fn(),
  isEmbedModelDownloaded: vi.fn(() => false),
}));

let env: Env;
let eligible: CorpusDoc[];
let corpus: CorpusDoc[];
const FAKE_AWS = `AKIA${'ABCDEFGHIJKLMNOP'}`;
const MARKERS = ['CAPTUREMARK', 'CHANGELOGMARK', 'FEDERATEDMARK', 'OPTOUTMARK', 'OUTSIDEMARK', FAKE_AWS];
const timing = (): RecallTiming => ({ tier: 'local', querySource: 'none', fallback: 'none' });
const params = (over: Partial<NonNullable<FusionParams['rerank']>> = {}): FusionParams =>
  ({ ...FUSION_BY_TIER.cloud, rerank: { candidates: 10, blendAlpha: 1, pool: 'fused-top', ...over } });

beforeEach(async () => {
  env = setupEnv('dc-hyb-egress');
  eligible = axisCorpus(env.root);
  corpus = [
    ...eligible,
    mkDoc(env.root, 'cap', 'zzw3 CAPTUREMARK', 'task', { capture: true }),
    mkDoc(env.root, 'chg', 'zzw3 CHANGELOGMARK', 'changelog'),
    mkDoc(env.root, 'fed', 'zzw3 FEDERATEDMARK', 'knowledge', { federated: true }),
    mkDoc(env.root, 'opt', 'zzw3 OPTOUTMARK', 'knowledge', { cloudOptOut: true }),
    mkDoc(env.root, 'leak', `zzw3 task with ${FAKE_AWS} inside`, 'task'),
    linkedDoc(env.root, join(env.tmp, 'outside'), 'out', 'zzw3 OUTSIDEMARK'),
  ];
  await consentAndIndex(env, corpus, 'cloud', 'voyageai/rerank-2.5-lite');
});
afterEach(() => {
  vi.unstubAllGlobals();
  teardownEnv(env);
});

const rerankCalls = (calls: ReturnType<typeof fakeOpenRouter>['calls']) => calls.filter((c) => c.url.endsWith('/rerank'));

describe('what a rerank body may contain', () => {
  it('carries only eligible docs, even though BM25 ranked the ineligible ones', async () => {
    const fake = fakeOpenRouter();
    vi.stubGlobal('fetch', fake.fetch);
    const hits = await hybridSearch('zzw3', corpus, env.root, 10, { tier: 'cloud', home: env.home, fusionParams: params() });
    // the ineligible docs ARE in the result list (BM25 sees them) ...
    expect(hits.map((h) => h.doc.slug)).toEqual(expect.arrayContaining(['cap', 'chg', 'fed']));
    // ... but none of them is in any body that left the machine
    const sent = fake.calls.map((c) => JSON.stringify(c.body)).join('\n');
    for (const m of MARKERS) expect(sent).not.toContain(m);
    const rr = rerankCalls(fake.calls);
    expect(rr).toHaveLength(1);
    expect(rr[0].body.provider).toEqual({ data_collection: 'deny' });
    expect((rr[0].body.documents as string[]).every((d) => /^\[knowledge\] e\d/.test(d))).toBe(true);
  });

  it('keeps a withheld doc in its original slot', async () => {
    vi.stubGlobal('fetch', fakeOpenRouter().fetch);
    const baseline = await hybridSearch('zzw3 zzw5', corpus, env.root, 12, { tier: 'cloud', home: env.home, fusionParams: { ...FUSION_BY_TIER.cloud, rerank: null } });
    const reranked = await hybridSearch('zzw3 zzw5', corpus, env.root, 12, { tier: 'cloud', home: env.home, fusionParams: params() });
    const withheld = new Set(['cap', 'chg', 'fed', 'opt', 'leak', 'out-meta']);
    baseline.forEach((h, i) => { if (withheld.has(h.doc.slug)) expect(reranked[i].doc.slug).toBe(h.doc.slug); });
  });

  it('reranks the union pool: BM25 top half ∪ dense top half', async () => {
    const fake = fakeOpenRouter();
    vi.stubGlobal('fetch', fake.fetch);
    // dense axis 5 (first zzw token), BM25 matches e0 only
    const hits = await hybridSearch('zzw5 zzw0', eligible, env.root, 6, {
      tier: 'cloud', home: env.home, fusionParams: params({ candidates: 4, pool: 'bm25-dense-union' }), queryVec: Float32Array.from(axisVector('zzw5')),
    });
    const docs = rerankCalls(fake.calls)[0].body.documents as string[];
    expect(docs.length).toBeGreaterThan(0);
    expect(docs.length).toBeLessThanOrEqual(4);
    expect(docs.some((d) => d.includes('zzw0'))).toBe(true); // BM25 side
    expect(docs.some((d) => d.includes('zzw5'))).toBe(true); // dense side
    expect(hits).toHaveLength(6);
    expect(new Set(hits.map((h) => docKey(h.doc))).size).toBe(6); // nothing duplicated or lost
  });

  it('sends a query containing a secret to nobody', async () => {
    const fake = fakeOpenRouter();
    vi.stubGlobal('fetch', fake.fetch);
    const t = timing();
    await hybridSearch(`zzw3 ${FAKE_AWS}`, corpus, env.root, 5, { tier: 'cloud', home: env.home, timing: t });
    expect(fake.calls).toHaveLength(0);
    expect(t.fallback).toBe('withheld');
  });
});

describe('zero fetches', () => {
  it('for tier:cloud on an unconsented, non-frozen root (hybridSearch, buildCloudIndex, rerank)', async () => {
    const other = setupEnv('dc-hyb-unconsented');
    try {
      const docs = axisCorpus(other.root);
      const fake = fakeOpenRouter();
      vi.stubGlobal('fetch', fake.fetch);
      setRecallCloudKey(KEY, 'manual', other.home); // a key alone is no consent
      const rerankImpl = vi.fn();
      vi.mocked(embedPassages).mockResolvedValue(null); // the local path finds no model: BM25
      const t = timing();
      await hybridSearch('zzw3', docs, other.root, 5, { tier: 'cloud', home: other.home, timing: t, rerankImpl, evalConsent: true, rerankModel: 'voyageai/rerank-2.5-lite' });
      expect(t.tier).toBe('local');
      const built = await buildCloudIndex(other.root, 'voyage-4', docs, { trigger: 'explicit', home: other.home, evalConsent: true, retryDelayMs: 0 });
      expect(built.aborted).toBe('not_consented');
      expect(rerankImpl).not.toHaveBeenCalled();
      expect(fake.calls).toHaveLength(0);
    } finally {
      teardownEnv(other);
    }
  });

  it('for a cloud-index vault, at query time (and never a rerank)', async () => {
    await consentAndIndex(env, corpus, 'cloud-index');
    const fake = fakeOpenRouter();
    vi.stubGlobal('fetch', fake.fetch);
    const rerankImpl = vi.fn();
    await hybridSearch('zzw3', corpus, env.root, 5, { tier: 'cloud', home: env.home, rerankImpl, queryVec: Float32Array.from(axisVector('zzw3')), fusionParams: params() });
    expect(fake.calls).toHaveLength(0);
    expect(rerankImpl).not.toHaveBeenCalled();
  });

  it.each(['DREAMCONTEXT_SPAWNED', 'DREAMCONTEXT_AUTOMATION_RUN', 'DREAMCONTEXT_AUTO_SLEEP'] as const)('when %s marks a spawned session', async (envVar) => {
    process.env[envVar] = envVar === 'DREAMCONTEXT_AUTO_SLEEP' ? '1' : 'develop';
    const fake = fakeOpenRouter();
    vi.stubGlobal('fetch', fake.fetch);
    const t = timing();
    await hybridSearch('zzw3', corpus, env.root, 5, { tier: 'cloud', home: env.home, timing: t });
    expect(fake.calls).toHaveLength(0);
    expect(t.fallback).toBe('spawned_session');
  });

  it('for a rerank when the vault consented to no rerank model', async () => {
    await consentAndIndex(env, corpus, 'cloud', null);
    const fake = fakeOpenRouter();
    vi.stubGlobal('fetch', fake.fetch);
    const rerankImpl = vi.fn();
    const t = timing();
    await hybridSearch('zzw3', corpus, env.root, 5, { tier: 'cloud', home: env.home, timing: t, rerankImpl, fusionParams: params() });
    expect(rerankImpl).not.toHaveBeenCalled();
    expect(rerankCalls(fake.calls)).toHaveLength(0);
    expect(fake.calls).toHaveLength(1); // the query embedding only
    expect(t.fallback).toBe('rerank_not_consented');
  });

  it('ignores opts.rerankModel off the frozen dir: the consented model decides', async () => {
    await consentAndIndex(env, corpus, 'cloud', null);
    const fake = fakeOpenRouter();
    vi.stubGlobal('fetch', fake.fetch);
    await hybridSearch('zzw3', corpus, env.root, 5, { tier: 'cloud', home: env.home, rerankModel: 'voyageai/rerank-2.5', evalConsent: true, fusionParams: params() });
    expect(rerankCalls(fake.calls)).toHaveLength(0);
  });
});

describe('a rerank failure', () => {
  it('keeps the fused order, trips the breaker, and reports why', async () => {
    vi.stubGlobal('fetch', fakeOpenRouter().fetch);
    const unreranked = await hybridSearch('zzw3', corpus, env.root, 10, { tier: 'cloud', home: env.home, fusionParams: { ...FUSION_BY_TIER.cloud, rerank: null } });
    vi.stubGlobal('fetch', fakeOpenRouter({ rerankStatus: 429 }).fetch);
    const t = timing();
    const reranked = await hybridSearch('zzw3', corpus, env.root, 10, { tier: 'cloud', home: env.home, timing: t, fusionParams: params() });
    expect(t.fallback).toBe('rate_limit');
    expect(breakerOpen(env.home)).toBe(true);
    expect(reranked.map((h) => docKey(h.doc))).toEqual(unreranked.map((h) => docKey(h.doc)));
  });
});
