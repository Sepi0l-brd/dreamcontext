import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { docKey, type CorpusDoc } from '../recall.js';
import {
  RERANK_MODELS,
  evalFrozenDir,
  minTier,
  readRecallCloudConfig,
  todayQueryCount,
  readVaultConsent,
  readVaultTier,
  type RecallTier,
  type RerankModel,
} from '../recall-cloud-config.js';
import { spawnMarkerFromEnv } from '../session-origin.js';
import type { Chunk } from './chunker.js';
import {
  capQuery,
  isCloudEligibleChunk,
  isCloudEligibleDoc,
  rerankCandidateText,
  scanSecrets,
  type WithheldRule,
} from './egress-rules.js';
import { VOYAGE_DIMS } from './nano.js';
import { VOYAGE_4_MODEL, type CloudProfileId } from './profiles.js';

/**
 * THE choke point: the only code that builds an outbound payload. Everything that may leave the
 * machine (index chunks, a query, rerank candidates) passes through `buildEgressPayload`, which
 *
 *  - derives authorization from the vault itself (effective tier = min(requested, the vault's own
 *    consented tier)); callers can ask for a ceiling, never grant themselves a tier;
 *  - applies the eligibility rules of egress-rules.ts to every doc, chunk and query, failing closed;
 *  - holds the exact body string in a module-private WeakMap and hands back a FROZEN object with no
 *    body on it. `openrouter.ts` resolves the payload back through `resolveEgressPayload`, so an
 *    object that was not minted here (a hand-built literal, a clone) is rejected as forged.
 *
 * `evalConsent` is the single exception to the consent check, and only for roots inside the
 * eval-frozen directory (see `isUnderEvalFrozenDir`).
 */

export type EgressKind = 'index' | 'query' | 'rerank';

interface EgressBase {
  contextRoot: string;
  tier?: RecallTier;
  evalConsent?: boolean;
  home?: string;
}

export type EgressRequest =
  | (EgressBase & { kind: 'index'; profile: CloudProfileId; items: ReadonlyArray<{ doc: CorpusDoc; chunk: Chunk }> })
  | (EgressBase & { kind: 'query'; query: string })
  | (EgressBase & { kind: 'rerank'; model: RerankModel; query: string; candidates: ReadonlyArray<{ doc: CorpusDoc; bestChunk: Chunk | null }> });

export declare const egressBrand: unique symbol;

export interface EgressPayload<K extends EgressKind> {
  readonly [egressBrand]: K;
  readonly endpoint: K extends 'rerank' ? '/rerank' : '/embeddings';
  /**
   * What each sent item is, in order: chunk hashes for `index`, doc keys for `rerank` (so the
   * API's result index maps back to a doc), empty for `query`.
   */
  readonly itemKeys: readonly string[];
}

export interface EgressMeta {
  kind: EgressKind;
  endpoint: '/embeddings' | '/rerank';
  bodyJson: string;
  model: string;
  evalMinted: boolean;
  contextRoot: string;
  home?: string;
  estUsd: number;
}

export interface EgressResult<K extends EgressKind> {
  payload: EgressPayload<K> | null;
  effectiveTier: RecallTier;
  withheld: ReadonlyArray<{ docKey?: string; rule: WithheldRule }>;
}

const META = new WeakMap<object, Readonly<EgressMeta>>();

/** Look a payload up by identity. Only `openrouter.ts` calls this; null means it was not minted here. */
export function resolveEgressPayload(p: unknown): Readonly<EgressMeta> | null {
  return p !== null && typeof p === 'object' ? (META.get(p) ?? null) : null;
}

// ── eval-frozen roots ────────────────────────────────────────────────────────

/**
 * True only for a context root that really lives inside the eval-frozen directory: both paths are
 * resolved with `realpathSync.native`, the root must start with the frozen dir plus a separator
 * (so `eval-frozen-evil` and symlinked or `..` paths fail), and the snapshot directory above it
 * must carry `FINGERPRINT.json` and `now.txt`. Any resolution error → false.
 */
export function isUnderEvalFrozenDir(contextRoot: string, home: string = homedir()): boolean {
  try {
    const real = realpathSync.native(contextRoot);
    const frozen = realpathSync.native(evalFrozenDir(home));
    if (!real.startsWith(frozen.endsWith(sep) ? frozen : frozen + sep)) return false;
    const snapshot = dirname(real);
    return existsSync(join(snapshot, 'FINGERPRINT.json')) && existsSync(join(snapshot, 'now.txt'));
  } catch {
    return false;
  }
}

/** The tier a request actually gets: never above what this vault consented to (evalConsent under the frozen dir aside). */
export function effectiveTier(
  contextRoot: string,
  requested: RecallTier | undefined,
  evalConsent?: boolean,
  home: string = homedir(),
): RecallTier {
  const want = requested ?? 'local';
  if (evalConsent === true && isUnderEvalFrozenDir(contextRoot, home)) return want;
  return minTier(want, readVaultTier(contextRoot, home));
}

// ── cost estimates ───────────────────────────────────────────────────────────

const EMBED_USD_PER_M_TOKENS = 0.06;
const RERANK_USD_PER_M_TOKENS: Record<RerankModel, number> = { 'voyageai/rerank-2.5': 0.05, 'voyageai/rerank-2.5-lite': 0.02 };
const approxTokens = (chars: number): number => Math.ceil(chars / 4);

// ── minting ──────────────────────────────────────────────────────────────────

type Withheld = Array<{ docKey?: string; rule: WithheldRule }>;

function mint<K extends EgressKind>(
  meta: Omit<EgressMeta, 'kind'> & { kind: K },
  itemKeys: string[],
): EgressPayload<K> {
  const payload = Object.freeze({ endpoint: meta.endpoint, itemKeys: Object.freeze([...itemKeys]) });
  META.set(payload, Object.freeze({ ...meta }));
  return payload as unknown as EgressPayload<K>;
}

const DENY = { data_collection: 'deny' } as const;

/** The query-time gates shared by `query` and `rerank`: tier, spawned session, daily cap. */
function queryGate(r: EgressBase, eff: RecallTier, evalMinted: boolean): WithheldRule | null {
  if (eff !== 'cloud') return r.tier && r.tier !== 'local' ? 'not_consented' : 'tier_local';
  if (evalMinted) return null;
  if (spawnMarkerFromEnv(process.env) !== null) return 'spawned_session';
  const home = r.home ?? homedir();
  const cap = readRecallCloudConfig(home).spend.maxQueriesPerDay;
  return todayQueryCount(r.contextRoot, home) >= cap ? 'daily_cap' : null;
}

function buildIndex(r: Extract<EgressRequest, { kind: 'index' }>, eff: RecallTier, evalMinted: boolean, withheld: Withheld): EgressPayload<'index'> | null {
  if (eff === 'local') {
    withheld.push({ rule: r.tier && r.tier !== 'local' ? 'not_consented' : 'tier_local' });
    return null;
  }
  const texts: string[] = [];
  const keys: string[] = [];
  for (const { doc, chunk } of r.items) {
    const docRule = isCloudEligibleDoc(doc, r.contextRoot);
    if (docRule) { withheld.push({ docKey: docKey(doc), rule: docRule }); continue; }
    if (chunk.text.trim() === '') { withheld.push({ docKey: docKey(doc), rule: 'empty' }); continue; }
    const secret = isCloudEligibleChunk(chunk.text);
    if (secret) { withheld.push({ docKey: docKey(doc), rule: secret }); continue; }
    texts.push(chunk.text);
    keys.push(chunk.hash);
  }
  if (texts.length === 0) return null;
  const bodyJson = JSON.stringify({ model: VOYAGE_4_MODEL, input: texts, input_type: 'document', dimensions: VOYAGE_DIMS, provider: DENY });
  const estUsd = (approxTokens(texts.reduce((n, t) => n + t.length, 0)) * EMBED_USD_PER_M_TOKENS) / 1e6;
  return finish({ kind: 'index', endpoint: '/embeddings', bodyJson, model: VOYAGE_4_MODEL, evalMinted, contextRoot: r.contextRoot, home: r.home, estUsd }, keys, withheld);
}

function buildQuery(r: Extract<EgressRequest, { kind: 'query' }>, eff: RecallTier, evalMinted: boolean, withheld: Withheld): EgressPayload<'query'> | null {
  const gate = queryGate(r, eff, evalMinted);
  if (gate) { withheld.push({ rule: gate }); return null; }
  const { text, rule } = capQuery(r.query);
  if (text === null) { withheld.push({ rule: rule ?? 'empty' }); return null; }
  if (text.trim() === '') { withheld.push({ rule: 'empty' }); return null; }
  const bodyJson = JSON.stringify({ model: VOYAGE_4_MODEL, input: [text], input_type: 'query', dimensions: VOYAGE_DIMS, provider: DENY });
  const estUsd = (approxTokens(text.length) * EMBED_USD_PER_M_TOKENS) / 1e6;
  return finish({ kind: 'query', endpoint: '/embeddings', bodyJson, model: VOYAGE_4_MODEL, evalMinted, contextRoot: r.contextRoot, home: r.home, estUsd }, [], withheld);
}

function buildRerank(r: Extract<EgressRequest, { kind: 'rerank' }>, eff: RecallTier, evalMinted: boolean, withheld: Withheld): EgressPayload<'rerank'> | null {
  const gate = queryGate(r, eff, evalMinted);
  if (gate) { withheld.push({ rule: gate }); return null; }
  const home = r.home ?? homedir();
  const knownModel = RERANK_MODELS.includes(r.model);
  const consented = evalMinted ? r.model : readVaultConsent(r.contextRoot, home)?.rerankModel ?? null;
  if (!knownModel || consented === null || consented !== r.model) { withheld.push({ rule: 'rerank_not_consented' }); return null; }
  const { text: query, rule } = capQuery(r.query);
  if (query === null || query.trim() === '') { withheld.push({ rule: rule ?? 'empty' }); return null; }
  const documents: string[] = [];
  const keys: string[] = [];
  for (const { doc, bestChunk } of r.candidates) {
    const docRule = isCloudEligibleDoc(doc, r.contextRoot);
    if (docRule) { withheld.push({ docKey: docKey(doc), rule: docRule }); continue; }
    const text = rerankCandidateText(doc, bestChunk);
    const secret = scanSecrets(text);
    if (secret) { withheld.push({ docKey: docKey(doc), rule: secret }); continue; }
    documents.push(text);
    keys.push(docKey(doc));
  }
  if (documents.length === 0) return null;
  const bodyJson = JSON.stringify({ model: r.model, query, documents, top_n: documents.length, provider: DENY });
  const chars = query.length + documents.reduce((n, t) => n + t.length, 0);
  const estUsd = (approxTokens(chars) * RERANK_USD_PER_M_TOKENS[r.model]) / 1e6;
  return finish({ kind: 'rerank', endpoint: '/rerank', bodyJson, model: r.model, evalMinted, contextRoot: r.contextRoot, home: r.home, estUsd }, keys, withheld);
}

/** Last line of defence: the exact serialized body is scanned once more. A hit means nothing is minted. */
function finish<K extends EgressKind>(meta: Omit<EgressMeta, 'kind'> & { kind: K }, keys: string[], withheld: Withheld): EgressPayload<K> | null {
  const secret = scanSecrets(meta.bodyJson);
  if (secret) { withheld.push({ rule: secret }); return null; }
  return mint(meta, keys);
}

/**
 * Build (or refuse to build) one outbound payload. A null payload means nothing may be sent for
 * this request; `withheld` says why, per doc where it is per doc.
 */
export function buildEgressPayload<R extends EgressRequest>(r: R): EgressResult<R['kind']> {
  const home = r.home ?? homedir();
  const evalMinted = r.evalConsent === true && isUnderEvalFrozenDir(r.contextRoot, home);
  const eff = effectiveTier(r.contextRoot, r.tier, r.evalConsent, home);
  const withheld: Withheld = [];
  let payload: EgressPayload<EgressKind> | null;
  switch (r.kind) {
    case 'index': payload = buildIndex(r, eff, evalMinted, withheld); break;
    case 'query': payload = buildQuery(r, eff, evalMinted, withheld); break;
    default: payload = buildRerank(r, eff, evalMinted, withheld);
  }
  return { payload: payload as EgressPayload<R['kind']> | null, effectiveTier: eff, withheld };
}

/**
 * Map the API's rerank results (`index` into the sent documents) back to doc keys. The one shared
 * helper, so every caller indexes the POST-withheld candidate list the same way.
 */
export function rerankScoresByKey(p: EgressPayload<'rerank'>, scores: ReadonlyArray<{ index: number; relevance: number }>): Map<string, number> {
  const out = new Map<string, number>();
  for (const { index, relevance } of scores) {
    const key = p.itemKeys[index];
    if (key !== undefined) out.set(key, relevance);
  }
  return out;
}
