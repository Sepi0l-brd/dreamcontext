import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { sep } from 'node:path';
import { isFederated, tokenize, type CorpusDoc, type CorpusType } from '../recall.js';
import type { Chunk } from './chunker.js';

/**
 * The rules for what may LEAVE the machine in a cloud recall tier. Pure functions only (the one
 * filesystem touch is `isDocUnderRoot`'s realpath/lstat; nothing here opens a socket), so the
 * egress choke point, the eval spikes and the tests all share one source of truth.
 *
 * Everything here fails CLOSED: an unreadable path, an unknown doc shape or a secret-looking
 * string means "withhold", never "send". The scan is best-effort and the user-facing disclosure
 * says so; it is a safety net under the type allow-list and the per-vault consent, not a
 * substitute for either.
 */

/**
 * Bump when the disclosure text or any rule below changes what is sent. `eligibleTypesHash`
 * covers the rules themselves; the version covers the wording the user consented to.
 */
export const CLOUD_DISCLOSURE_VERSION = 1;

/**
 * The only corpus types whose text may be sent. A literal allow-list on purpose: a new corpus
 * type is withheld until someone decides it here (and the consent hash changes with it).
 *  - changelog: pointer entries, already kept out of the dense channel.
 *  - insight: manifests carry source endpoints and identifiers of external systems.
 *  - automation: machine-private by product rule (run outputs are also `capture`).
 *  - skill: not vault content (never part of buildCorpus).
 */
export const CLOUD_ELIGIBLE_TYPES = [
  'knowledge', 'feature', 'task', 'objective', 'thesis', 'whiteboard', 'core', 'memory',
] as const satisfies readonly CorpusType[];

/** Characters of the prompt sent as a cloud query (the head), after the FULL prompt was scanned. */
export const QUERY_CHAR_CAP = 512;

/** Cap on one rerank candidate's text (≈ 450 tokens). */
export const RERANK_TEXT_CHAR_CAP = 1800;

export type SecretRule =
  | 'secret_pem' | 'secret_api_token' | 'secret_github' | 'secret_aws'
  | 'secret_slack' | 'secret_jwt' | 'secret_assignment';

export type WithheldRule =
  | 'tier_local' | 'not_consented' | 'outside_root' | 'type_not_allowed' | 'capture'
  | 'federated' | 'cloud_false' | SecretRule
  | 'spawned_session' | 'daily_cap' | 'rerank_not_consented' | 'empty';

/**
 * No `g` flag on any of these: a global regex keeps `lastIndex` between `.test()` calls and
 * would make the scan depend on what it scanned before.
 */
export const SECRET_PATTERNS: Readonly<Record<SecretRule, RegExp>> = {
  secret_pem: /-----BEGIN [A-Z ]*-----/,
  secret_api_token: /\bsk-[A-Za-z0-9_-]{20,}/,
  secret_github: /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/,
  secret_aws: /\bAKIA[0-9A-Z]{16}\b/,
  secret_slack: /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  secret_jwt: /\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/,
  secret_assignment: /\b(password|passwd|secret|token|api[_-]?key)\b\s*[:=]\s*['"]?[^\s'"]{8,}/i,
};

const SECRET_RULE_ORDER = Object.keys(SECRET_PATTERNS) as SecretRule[];

/** The first secret rule `text` trips, or null. Never rewrites or redacts: callers drop. */
export function scanSecrets(text: string): SecretRule | null {
  for (const rule of SECRET_RULE_ORDER) {
    if (SECRET_PATTERNS[rule].test(text)) return rule;
  }
  return null;
}

/**
 * True only when the doc's file is a regular (non-symlink) file whose real path sits under the
 * real path of `contextRoot`. A doc built from another root, a symlinked child pointing out of
 * the vault, or any resolution error is NOT under the root. This is what keeps "consent for
 * vault A" from authorising the text of a file that merely appears in A's corpus.
 */
export function isDocUnderRoot(doc: CorpusDoc, contextRoot: string): boolean {
  try {
    if (lstatSync(doc.path).isSymbolicLink()) return false;
    const rootReal = realpathSync.native(contextRoot);
    const docReal = realpathSync.native(doc.path);
    return docReal.startsWith(rootReal.endsWith(sep) ? rootReal : rootReal + sep);
  } catch {
    return false;
  }
}

const ELIGIBLE_TYPE_SET: ReadonlySet<string> = new Set(CLOUD_ELIGIBLE_TYPES);

/**
 * Why a DOC may not be sent, or null when it may. Checked in a fixed order so the withheld
 * counts the disclosure prints are deterministic: outside the root, type, capture, federated,
 * `cloud: false`, then a PEM block anywhere in the doc (a key split across chunks must not
 * leak half of itself, so the whole doc goes).
 */
export function isCloudEligibleDoc(doc: CorpusDoc, contextRoot: string): WithheldRule | null {
  if (!isDocUnderRoot(doc, contextRoot)) return 'outside_root';
  if (!ELIGIBLE_TYPE_SET.has(doc.type)) return 'type_not_allowed';
  if (doc.capture === true) return 'capture';
  if (isFederated(doc)) return 'federated';
  if (doc.cloudOptOut === true) return 'cloud_false';
  const pem = SECRET_PATTERNS.secret_pem;
  if (pem.test(doc.title) || pem.test(doc.description) || pem.test(doc.body)) return 'secret_pem';
  return null;
}

/** Why a CHUNK (or any text unit) may not be sent: the first secret rule it trips, or null. */
export function isCloudEligibleChunk(text: string): SecretRule | null {
  return scanSecrets(text);
}

/**
 * The text of a cloud query. The FULL prompt is scanned first (a secret past the cap is still a
 * secret the user typed); a hit means nothing is sent. Otherwise the HEAD of the prompt is sent,
 * capped at QUERY_CHAR_CAP: the opening of a prompt carries its intent more often than its tail.
 */
export function capQuery(prompt: string): { text: string | null; rule: SecretRule | null } {
  const rule = scanSecrets(prompt);
  if (rule !== null) return { text: null, rule };
  return { text: prompt.slice(0, QUERY_CHAR_CAP), rule: null };
}

/**
 * The chunk that best matches `query` by distinct shared tokens. Ties go to the lowest `seq`;
 * no chunks → null. Used only when no vector is available to pick the chunk by similarity.
 */
export function pickBestChunkLexical(chunks: readonly Chunk[], query: string): Chunk | null {
  if (chunks.length === 0) return null;
  const queryTokens = new Set(tokenize(query));
  let best: Chunk | null = null;
  let bestScore = -1;
  for (const chunk of chunks) {
    const chunkTokens = new Set(tokenize(chunk.text));
    let score = 0;
    for (const t of queryTokens) if (chunkTokens.has(t)) score++;
    if (score > bestScore || (score === bestScore && best !== null && chunk.seq < best.seq)) {
      best = chunk;
      bestScore = score;
    }
  }
  return best;
}

/**
 * The text one rerank candidate is judged on: `[type] title`, then the best-matching chunk
 * (its own title line stripped, the chunker prepends it) or, without a chunk, description + body.
 * Cut to RERANK_TEXT_CHAR_CAP at the last whitespace so a word is never split mid-way.
 */
export function rerankCandidateText(doc: CorpusDoc, bestChunk: Chunk | null): string {
  let body: string;
  if (bestChunk) {
    const nl = bestChunk.text.indexOf('\n');
    const firstLine = nl === -1 ? bestChunk.text : bestChunk.text.slice(0, nl);
    body = firstLine === doc.title && nl !== -1 ? bestChunk.text.slice(nl + 1) : bestChunk.text;
  } else {
    body = `${doc.description}\n${doc.body}`.trim();
  }
  const header = `[${doc.type}] ${doc.title}\n`;
  const text = header + body;
  if (text.length <= RERANK_TEXT_CHAR_CAP) return text;
  if (/\s/.test(text[RERANK_TEXT_CHAR_CAP])) return text.slice(0, RERANK_TEXT_CHAR_CAP).trimEnd();
  const head = text.slice(0, RERANK_TEXT_CHAR_CAP);
  const lastWs = Math.max(head.lastIndexOf(' '), head.lastIndexOf('\n'), head.lastIndexOf('\t'));
  // Whitespace inside the header is not a word boundary of the BODY: cutting there would
  // leave only the header. Without a boundary in the body, cut hard.
  return lastWs >= header.length ? head.slice(0, lastWs).trimEnd() : head;
}

function minMax(values: number[]): (v: number) => number {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min;
  // A zero span (one candidate, or all equal) normalises to 1: it IS the best on that axis.
  return (v) => (span > 0 ? (v - min) / span : 1);
}

/**
 * Merge a reranker's relevance scores back into the fused order. `fused` is sorted descending.
 * Only the first `n` entries (the window) are reranked, and only those with a score: a window
 * key absent from `scores` (withheld from the request, or missing from the response) keeps its
 * original slot. The scored keys fill the remaining window slots in descending
 * `alpha·minmax(rel) + (1−alpha)·minmax(fused)` (alpha 1.0 = pure rerank order; ties keep fused
 * order). Everything below `n` keeps fused order. Returns every key.
 */
export function applyRerank(
  fused: Array<{ key: string; fused: number }>,
  scores: Map<string, number>,
  alpha: number,
  n: number,
): string[] {
  const windowSize = Math.max(0, Math.min(n, fused.length));
  const window = fused.slice(0, windowSize);
  const a = Math.min(1, Math.max(0, alpha));

  const scored = window
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => scores.has(entry.key));
  const relNorm = minMax(scored.map(({ entry }) => scores.get(entry.key) as number));
  const fusedNorm = minMax(scored.map(({ entry }) => entry.fused));
  const ranked = scored
    .map(({ entry, index }) => ({
      key: entry.key,
      index,
      blend: a * relNorm(scores.get(entry.key) as number) + (1 - a) * fusedNorm(entry.fused),
    }))
    .sort((x, y) => y.blend - x.blend || x.index - y.index);

  const out: string[] = window.map((entry) => (scores.has(entry.key) ? '' : entry.key));
  let next = 0;
  for (let slot = 0; slot < out.length; slot++) {
    if (!scores.has(window[slot].key)) continue;
    out[slot] = ranked[next++].key;
  }
  for (let i = windowSize; i < fused.length; i++) out.push(fused[i].key);
  return out;
}

/**
 * Hash of everything a user's consent was given against: the allow-list, every secret pattern
 * (source and flags), both caps and the disclosure version. Change any of them and an existing
 * consent no longer matches, so the vault falls back to `local` until the user consents again.
 */
export function eligibleTypesHash(): string {
  const payload = {
    disclosureVersion: CLOUD_DISCLOSURE_VERSION,
    types: [...CLOUD_ELIGIBLE_TYPES],
    secretPatterns: SECRET_RULE_ORDER.map((rule) => [rule, SECRET_PATTERNS[rule].source, SECRET_PATTERNS[rule].flags]),
    queryCharCap: QUERY_CHAR_CAP,
    rerankTextCharCap: RERANK_TEXT_CHAR_CAP,
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
