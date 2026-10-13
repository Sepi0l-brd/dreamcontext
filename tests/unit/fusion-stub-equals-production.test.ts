import { describe, expect, it } from 'vitest';
import { CHANGELOG_RANK_FACTOR } from '../../src/lib/recall.js';
import {
  ADAPTIVE_PIN_MARGIN, ADAPTIVE_RAW_CUTOFF, ADAPTIVE_RELATIVE_LAMBDA, ADAPTIVE_RRF_BM25_WEIGHT, RRF_K,
} from '../../src/lib/embeddings/hybrid.js';
import { DEFAULT_RERANK_MODEL, FUSION_BY_TIER, LOCAL_DENSE_QUOTA, SPIKE_FUSION, SPIKE_RERANK_MODEL } from '../../src/lib/embeddings/fusion-config.js';
import { RERANK_MODELS } from '../../src/lib/recall-cloud-config.js';
import { LOCAL_E5_PROFILE, VOYAGE_4_PROFILE, profileForTier } from '../../src/lib/embeddings/profiles.js';
import { EMBED_DIMS, EMBED_MODEL } from '../../src/lib/embeddings/embedder.js';
import { VOYAGE_DIMS } from '../../src/lib/embeddings/nano.js';

describe('the SPIKE fusion constants ARE today\'s production constants (nothing in a spike is tuned)', () => {
  const production = {
    rawCutoff: ADAPTIVE_RAW_CUTOFF,
    rrfK: RRF_K,
    rrfBm25Weight: ADAPTIVE_RRF_BM25_WEIGHT,
    relativeLambda: ADAPTIVE_RELATIVE_LAMBDA,
    pinMargin: ADAPTIVE_PIN_MARGIN,
    aggregation: 'max',
    secondWeight: 0,
    priorGamma: 0,
    changelogFactor: CHANGELOG_RANK_FACTOR,
    denseGate: null,
    langWeights: null,
    denseQuota: null,
  };

  it('matches local and cloud-index exactly, with no rerank', () => {
    expect(SPIKE_FUSION.local).toEqual({ ...production, rerank: null });
    expect(SPIKE_FUSION['cloud-index']).toEqual({ ...production, rerank: null });
  });

  it('matches cloud plus the pinned spike rerank: N=20, alpha=1.0, rerank-2.5-lite', () => {
    expect(SPIKE_FUSION.cloud).toEqual({ ...production, rerank: { candidates: 20, blendAlpha: 1.0, pool: 'fused-top' } });
    expect(SPIKE_RERANK_MODEL).toBe('voyageai/rerank-2.5-lite');
  });
});

describe('the tuned FUSION_BY_TIER (T6b) keeps the tier contract', () => {
  it('keeps the local tier on the adaptive constants (e5 train tuning moved no axis; localSearch reads this entry)', () => {
    // The one local change is the cross-language dense slot (2026-10-12); every fusion constant is the spike's.
    expect(FUSION_BY_TIER.local).toEqual({ ...SPIKE_FUSION.local, denseQuota: LOCAL_DENSE_QUOTA });
    expect(LOCAL_DENSE_QUOTA).toEqual({ slots: 1, window: 1, topN: 5, crossLangOnly: true });
  });

  it('gives the dense slot to local and to an unreranked cloud answer, never to cloud-index', () => {
    expect(FUSION_BY_TIER['cloud-index'].denseQuota).toBeNull();
    expect(FUSION_BY_TIER.cloud.denseQuota).toEqual(LOCAL_DENSE_QUOTA);
  });

  it('reranks only on cloud, within the 40-candidate budget, with an explicit pool', () => {
    expect(FUSION_BY_TIER.local.rerank).toBeNull();
    expect(FUSION_BY_TIER['cloud-index'].rerank).toBeNull();
    const rr = FUSION_BY_TIER.cloud.rerank;
    expect(rr).not.toBeNull();
    expect(rr!.candidates).toBeLessThanOrEqual(40);
    expect(['fused-top', 'bm25-dense-union']).toContain(rr!.pool);
    expect(rr!.blendAlpha).toBeGreaterThanOrEqual(0);
    expect(rr!.blendAlpha).toBeLessThanOrEqual(1);
  });

  it('defaults to a known rerank model', () => {
    expect(DEFAULT_RERANK_MODEL === null || RERANK_MODELS.includes(DEFAULT_RERANK_MODEL)).toBe(true);
  });
});

describe('profiles', () => {
  it('describe the e5 and voyage-4 spaces', () => {
    expect(LOCAL_E5_PROFILE).toMatchObject({ id: 'local-e5', docModel: EMBED_MODEL, dims: EMBED_DIMS });
    expect(VOYAGE_4_PROFILE).toMatchObject({ id: 'voyage-4', docModel: 'voyageai/voyage-4', dims: VOYAGE_DIMS });
    expect(profileForTier('local')).toBe(LOCAL_E5_PROFILE);
    expect(profileForTier('cloud-index')).toBe(VOYAGE_4_PROFILE);
    expect(profileForTier('cloud')).toBe(VOYAGE_4_PROFILE);
  });

  it('chunks both profiles with the unchanged base chunker (hashes stay stable)', () => {
    const doc = { title: 'T', body: 'word '.repeat(150), description: 'd' } as never;
    expect(LOCAL_E5_PROFILE.chunk(doc).map((c) => c.hash)).toEqual(VOYAGE_4_PROFILE.chunk(doc).map((c) => c.hash));
  });
});
