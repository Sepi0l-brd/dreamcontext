import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bm25Search, docKey, type CorpusDoc, type RecallHit } from '../../src/lib/recall.js';
import { hybridSearch } from '../../src/lib/embeddings/hybrid.js';
import { FUSION_BY_TIER, type FusionParams } from '../../src/lib/embeddings/fusion-config.js';
import {
  axisCorpus, axisVector, consentAndIndex, fakeOpenRouter, mkDoc, setupEnv, teardownEnv, type Env,
} from './_hybrid-fixture.js';

vi.mock('../../src/lib/embeddings/embedder.js', () => ({
  EMBED_MODEL: 'test-model',
  EMBED_DIMS: 4,
  embeddingsAvailable: vi.fn(async () => true),
  embedPassages: vi.fn(),
  embedQuery: vi.fn(),
  isEmbedModelDownloaded: vi.fn(() => false),
}));

/** The decoupling invariant: `score` is raw flat BM25 (0 for a dense-only hit) in EVERY tier and fallback. */
let env: Env;
let corpus: CorpusDoc[];
const QUERY = 'zzw3 filler';

function expectDecoupled(hits: RecallHit[], query: string): void {
  const raw = new Map(bm25Search(query, corpus, 50).map((h) => [docKey(h.doc), h.score]));
  expect(hits.length).toBeGreaterThan(0);
  for (const h of hits) expect(h.score).toBe(raw.get(docKey(h.doc)) ?? 0);
  for (let i = 1; i < hits.length; i++) expect(hits[i - 1].rankScore).toBeGreaterThanOrEqual(hits[i].rankScore);
}

beforeEach(async () => {
  env = setupEnv('dc-hyb-decouple');
  corpus = [...axisCorpus(env.root), mkDoc(env.root, 'noise', 'completely unrelated words here')];
  await consentAndIndex(env, corpus, 'cloud', 'voyageai/rerank-2.5-lite');
});
afterEach(() => {
  vi.unstubAllGlobals();
  teardownEnv(env);
});

describe('hit.score never changes with the tier', () => {
  it('cloud, fused order', async () => {
    vi.stubGlobal('fetch', fakeOpenRouter().fetch);
    expectDecoupled(await hybridSearch(QUERY, corpus, env.root, 8, { tier: 'cloud', home: env.home, fusionParams: { ...FUSION_BY_TIER.cloud, rerank: null } }), QUERY);
  });

  it('cloud, reranked (fused-top and union pools)', async () => {
    for (const pool of ['fused-top', 'bm25-dense-union'] as const) {
      vi.stubGlobal('fetch', fakeOpenRouter().fetch);
      const params: FusionParams = { ...FUSION_BY_TIER.cloud, rerank: { candidates: 6, blendAlpha: 1, pool } };
      // BM25 finds e3 and e5; dense (axis 3) prefers e3; the fake reranker prefers e5.
      const q = 'zzw3 zzw5 filler';
      const hits = await hybridSearch(q, corpus, env.root, 8, { tier: 'cloud', home: env.home, fusionParams: params });
      expectDecoupled(hits, q);
      expect(docKey(hits[0].doc)).toBe('knowledge/e5'); // the fake reranker's favourite moved up, score untouched
    }
  });

  it('cloud-index', async () => {
    await consentAndIndex(env, corpus, 'cloud-index');
    expectDecoupled(await hybridSearch(QUERY, corpus, env.root, 8, { tier: 'cloud', home: env.home, queryVec: Float32Array.from(axisVector('zzw3')) }), QUERY);
  });

  it('a dense-only hit has score 0', async () => {
    vi.stubGlobal('fetch', fakeOpenRouter().fetch);
    const hits = await hybridSearch('zzw4', corpus, env.root, 8, { tier: 'cloud', home: env.home, fusionParams: { ...FUSION_BY_TIER.cloud, rerank: null }, queryVec: Float32Array.from(axisVector('zzw0')) });
    const bm25Keys = new Set(bm25Search('zzw4', corpus, 50).map((h) => docKey(h.doc)));
    const denseOnly = hits.filter((h) => !bm25Keys.has(docKey(h.doc)));
    expect(denseOnly.length).toBeGreaterThan(0);
    for (const h of denseOnly) expect(h.score).toBe(0);
  });

  it('every fallback (network down, no index) returns the BM25 hits unchanged', async () => {
    vi.stubGlobal('fetch', fakeOpenRouter({ reject: true }).fetch);
    expectDecoupled(await hybridSearch(QUERY, corpus, env.root, 8, { tier: 'cloud', home: env.home }), QUERY);
  });
});
