import type { RecallOptionId } from './recall-measurements.js';

/**
 * The personal line on top of Settings → Recall: which option fits THIS brain on THIS machine.
 * Everything here is pure; the route gathers the signals (corpus, memory, cores, key) and passes
 * them in. The result is structured (an option, a reason code, a note code) and the dashboard words
 * it in the person's language, so the sentence never lives in two places.
 *
 * The rules come from the 2026-10-11 held-out measurements: Turkish and mixed prompts are where
 * keyword search and Haiku fall behind and the cloud tiers do not; English alone is already served
 * by plain keyword search (88% there), at no cost and no egress. The default mode does not change
 * here — this is advice, never a switch.
 *
 * Two readings decide "English only" vs "multi-language": the documents AND the person's recent
 * prompts. Either one being Turkish or mixed is enough: an English brain asked in Turkish is exactly
 * the cross-language case keyword search fails (owner, 2026-10-11, on a brain written in English
 * and prompted in Turkish that was told keyword search was enough).
 */

export type LanguageMix = 'turkish' | 'mixed' | 'english' | 'unknown';
export type MachineClass = 'light' | 'standard';

export interface RecallSignals {
  /** Share of the brain's documents that read as Turkish, 0..1; `null` when there are none to read. */
  turkishShare: number | null;
  /** Share of the person's recent prompts that read as Turkish, 0..1; `null` when none are recorded. */
  promptTurkishShare: number | null;
  totalMemBytes: number;
  cpuCount: number;
  /** Marketing name when it is cheaply known ("MacBook Air"); the route passes `null` when it is not. */
  modelName: string | null;
  /** A recall (OpenRouter) key is already set on this machine. */
  keyPresent: boolean;
}

export type RecommendationReason =
  /** Turkish or mixed documents or prompts: the cloud tiers lift those from about half to about 96%. */
  | 'multi-language'
  /** English documents and English prompts: keyword search is already strong and costs nothing. */
  | 'english-only'
  /** Nothing to read the language from: keep the default. */
  | 'no-language-signal';

export type RecommendationNote =
  /** Prompts can stay on this computer: mention the private-query tier (machine is not light). */
  | 'private-query-available'
  /** Light machine: the local-embedding tiers would be slow here, so no mention of them. */
  | 'light-machine'
  | null;

export interface RecallRecommendation {
  option: RecallOptionId;
  reason: RecommendationReason;
  note: RecommendationNote;
  /** For a cloud recommendation: whether the key it needs is already here. */
  keyPresent: boolean;
  /** The combined reading the rule used: the more Turkish of {@link docsMix} and {@link promptsMix}. */
  languageMix: LanguageMix;
  docsMix: LanguageMix;
  promptsMix: LanguageMix;
  machineClass: MachineClass;
}

// ── language ─────────────────────────────────────────────────────────────────

/** Letters only Turkish uses; English text (names aside) has essentially none. */
const TURKISH_LETTERS = /[çğıöşüÇĞİÖŞÜ]/g;
const LETTERS = /\p{L}/gu;
/** A text counts as Turkish when at least this share of its letters are Turkish-specific (real Turkish runs 5-9%). */
const TURKISH_LETTER_RATIO = 0.015;
/** Too little text to judge a document. */
const MIN_LETTERS = 60;
/** A prompt is short; this many letters already carry the language. */
export const PROMPT_MIN_LETTERS = 20;
/** How much of a document is read: the start says what language it is written in. */
const SAMPLE_CHARS = 4000;

/** Does this text read as Turkish? `null` when there is too little to judge. */
export function looksTurkish(text: string, minLetters: number = MIN_LETTERS): boolean | null {
  const sample = text.length > SAMPLE_CHARS ? text.slice(0, SAMPLE_CHARS) : text;
  const letters = sample.match(LETTERS)?.length ?? 0;
  if (letters < minLetters) return null;
  const turkish = sample.match(TURKISH_LETTERS)?.length ?? 0;
  return turkish / letters >= TURKISH_LETTER_RATIO;
}

/** Share (0..1) of documents that read as Turkish, over those with enough text; `null` when none do. */
export function turkishShareOf(docs: ReadonlyArray<{ title: string; description: string; body: string }>): number | null {
  let judged = 0;
  let turkish = 0;
  for (const doc of docs) {
    const verdict = looksTurkish(`${doc.title}\n${doc.description}\n${doc.body}`);
    if (verdict === null) continue;
    judged += 1;
    if (verdict) turkish += 1;
  }
  return judged === 0 ? null : turkish / judged;
}

/** Share (0..1) of prompts that read as Turkish, over those long enough to judge; `null` when none are. */
export function turkishShareOfPrompts(prompts: readonly string[]): number | null {
  let judged = 0;
  let turkish = 0;
  for (const p of prompts) {
    const verdict = looksTurkish(p, PROMPT_MIN_LETTERS);
    if (verdict === null) continue;
    judged += 1;
    if (verdict) turkish += 1;
  }
  return judged === 0 ? null : turkish / judged;
}

/** At or above: the brain is mostly Turkish. At or above (and below that): it is mixed. */
const TURKISH_BRAIN_SHARE = 0.6;
const MIXED_BRAIN_SHARE = 0.1;

export function languageMixOf(turkishShare: number | null): LanguageMix {
  if (turkishShare === null) return 'unknown';
  if (turkishShare >= TURKISH_BRAIN_SHARE) return 'turkish';
  if (turkishShare >= MIXED_BRAIN_SHARE) return 'mixed';
  return 'english';
}

const MIX_RANK: Record<LanguageMix, number> = { unknown: 0, english: 1, mixed: 2, turkish: 3 };

/** The more Turkish of two readings; `unknown` only when both are. */
export function combineMix(a: LanguageMix, b: LanguageMix): LanguageMix {
  return MIX_RANK[a] >= MIX_RANK[b] ? a : b;
}

// ── machine ──────────────────────────────────────────────────────────────────

const GIB = 1024 ** 3;
/** At or below this much memory, or this few cores, the machine is "light". */
const LIGHT_MEM_BYTES = 8 * GIB;
const LIGHT_CPU_COUNT = 4;

export function machineClassOf(s: Pick<RecallSignals, 'totalMemBytes' | 'cpuCount' | 'modelName'>): MachineClass {
  if (s.modelName !== null && /\bair\b/i.test(s.modelName)) return 'light';
  if (s.totalMemBytes <= LIGHT_MEM_BYTES || s.cpuCount <= LIGHT_CPU_COUNT) return 'light';
  return 'standard';
}

// ── the rules ────────────────────────────────────────────────────────────────

/**
 * Multi-language (Turkish or mixed documents OR prompts) → the best-accuracy cloud tier (with a note
 * that prompts can stay local on a machine that can carry it); English only → keyword search, which
 * already does well there; no signal → keep the default. A light machine is never pointed at the
 * local-embedding tiers.
 */
export function recommendRecall(signals: RecallSignals): RecallRecommendation {
  const docsMix = languageMixOf(signals.turkishShare);
  const promptsMix = languageMixOf(signals.promptTurkishShare);
  const languageMix = combineMix(docsMix, promptsMix);
  const machineClass = machineClassOf(signals);
  const base = { keyPresent: signals.keyPresent, languageMix, docsMix, promptsMix, machineClass };

  if (languageMix === 'turkish' || languageMix === 'mixed') {
    return {
      ...base,
      option: 'cloud',
      reason: 'multi-language',
      note: machineClass === 'light' ? 'light-machine' : 'private-query-available',
    };
  }
  if (languageMix === 'english') {
    return { ...base, option: 'raw', reason: 'english-only', note: null };
  }
  return { ...base, option: 'haiku', reason: 'no-language-signal', note: null };
}
