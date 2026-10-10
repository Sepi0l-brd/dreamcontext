import type { RecallTier, RerankModel } from '../recall-cloud-config.js';

/** Skip the dense channel when BM25 is already sure: top raw ≥ rawSure, or ≥ rawLead with a top1/top2 lead ≥ leadRatio. */
export interface DenseGate {
  rawSure: number;
  rawLead: number;
  leadRatio: number;
}

export interface FusionParams {
  rawCutoff: number;
  rrfK: number;
  rrfBm25Weight: number;
  relativeLambda: number;
  /** 0 = pin guard off. */
  pinMargin: number;
  aggregation: 'max' | 'max+second';
  secondWeight: number;
  priorGamma: number;
  changelogFactor: number;
  denseGate: DenseGate | null;
  langWeights: Partial<Record<'tr' | 'mixed', { rrfBm25Weight: number }>> | null;
  /** Rerank runs iff this is non-null AND a consented (or eval) model exists; the merge is `applyRerank`. */
  rerank: { candidates: number; blendAlpha: number } | null;
}

/**
 * Today's production adaptive constants, as literals (hybrid.ts imports this module in T6a, so it
 * cannot be imported from here). The `fusion-stub-equals-production` test pins them equal to
 * hybrid.ts's ADAPTIVE_* / RRF_K and recall.ts's CHANGELOG_RANK_FACTOR. Nothing in a spike is tuned:
 * T6b replaces these with the train-tuned values.
 */
const PRODUCTION: FusionParams = {
  rawCutoff: 18,
  rrfK: 60,
  rrfBm25Weight: 0.6,
  relativeLambda: 0.1,
  pinMargin: 1.35,
  aggregation: 'max',
  secondWeight: 0,
  priorGamma: 0,
  changelogFactor: 0.85,
  denseGate: null,
  langWeights: null,
  rerank: null,
};

export const FUSION_BY_TIER: Record<RecallTier, FusionParams> = {
  local: { ...PRODUCTION },
  'cloud-index': { ...PRODUCTION },
  cloud: { ...PRODUCTION, rerank: { candidates: 20, blendAlpha: 1.0 } },
};

/** The reranker `enable` defaults to. Stub = the model G1's spike runs; T6b sets the stage-2 winner (or null). */
export const DEFAULT_RERANK_MODEL: RerankModel | null = 'voyageai/rerank-2.5-lite';
