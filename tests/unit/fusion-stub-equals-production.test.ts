import { describe, expect, it } from 'vitest';
import { CHANGELOG_RANK_FACTOR } from '../../src/lib/recall.js';
import {
  ADAPTIVE_PIN_MARGIN, ADAPTIVE_RAW_CUTOFF, ADAPTIVE_RELATIVE_LAMBDA, ADAPTIVE_RRF_BM25_WEIGHT, RRF_K,
} from '../../src/lib/embeddings/hybrid.js';
import { DEFAULT_RERANK_MODEL, FUSION_BY_TIER } from '../../src/lib/embeddings/fusion-config.js';
import { LOCAL_E5_PROFILE, VOYAGE_4_PROFILE, profileForTier } from '../../src/lib/embeddings/profiles.js';
import { EMBED_DIMS, EMBED_MODEL } from '../../src/lib/embeddings/embedder.js';
import { VOYAGE_DIMS } from '../../src/lib/embeddings/nano.js';

describe('the fusion stubs ARE today\'s production constants (nothing in a spike is tuned)', () => {
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
  };

  it('matches local and cloud-index exactly, with no rerank', () => {
    expect(FUSION_BY_TIER.local).toEqual({ ...production, rerank: null });
    expect(FUSION_BY_TIER['cloud-index']).toEqual({ ...production, rerank: null });
  });

  it('matches cloud plus the pinned spike rerank: N=20, alpha=1.0, rerank-2.5-lite', () => {
    expect(FUSION_BY_TIER.cloud).toEqual({ ...production, rerank: { candidates: 20, blendAlpha: 1.0 } });
    expect(DEFAULT_RERANK_MODEL).toBe('voyageai/rerank-2.5-lite');
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
