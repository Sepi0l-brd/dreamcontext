import type { CorpusDoc } from '../recall.js';
import type { RecallTier } from '../recall-cloud-config.js';
import { chunkDoc, type Chunk } from './chunker.js';
import { EMBED_DIMS, EMBED_MODEL } from './embedder.js';

export type DenseProfileId = 'local-e5' | 'voyage-4';
export type CloudProfileId = 'voyage-4';

/** The Voyage model docs are embedded with (via OpenRouter) and the local nano model is a projection of. */
export const VOYAGE_4_MODEL = 'voyageai/voyage-4';
/** Matryoshka dimension used on both sides (API `dimensions` and nano's truncation). */
export const VOYAGE_PROFILE_DIMS = 1024;

/**
 * A dense profile: which model embeds the docs, at what width, and how a doc is cut into chunks.
 * Deliberately NOT where eligibility lives: what may leave the machine is decided in one place
 * (egress-rules.ts), never per profile.
 */
export interface DenseProfile {
  id: DenseProfileId;
  docModel: string;
  dims: number;
  chunk(doc: CorpusDoc): Chunk[];
}

const baseChunk = (doc: CorpusDoc): Chunk[] => chunkDoc(doc.title, doc.body, doc.description);

export const LOCAL_E5_PROFILE: DenseProfile = { id: 'local-e5', docModel: EMBED_MODEL, dims: EMBED_DIMS, chunk: baseChunk };
export const VOYAGE_4_PROFILE: DenseProfile = { id: 'voyage-4', docModel: VOYAGE_4_MODEL, dims: VOYAGE_PROFILE_DIMS, chunk: baseChunk };

export function profileForTier(tier: RecallTier): DenseProfile {
  return tier === 'local' ? LOCAL_E5_PROFILE : VOYAGE_4_PROFILE;
}
