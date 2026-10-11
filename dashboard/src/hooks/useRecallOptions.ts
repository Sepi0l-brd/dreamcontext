import { useQuery } from '@tanstack/react-query';
import { useApi } from '../context/VaultContext';

/**
 * Mirrors `GET /api/recall/options` (src/server/routes/recall-options.ts). The numbers come from the
 * server's single source, `src/lib/recall-measurements.ts`; the page carries none of its own.
 */

export type RecallOptionId = 'haiku' | 'cloud' | 'cloud-index' | 'raw' | 'off' | 'hybrid';
export type RecallLanguage = 'tr' | 'en' | 'mixed';
export type RecallEgress =
  | 'nothing'
  | 'anthropic-prompt-and-index'
  | 'chunks-once-then-local'
  | 'chunks-once-and-each-prompt';

export interface RecallMeasurement {
  id: RecallOptionId;
  accuracyR5Pct: Record<RecallLanguage, number> | null;
  overheadP90Ms: { min: number; max: number };
  overheadIsEstimate: boolean;
  cost: { indexOnceUsd: number; per1000QueriesUsd: number };
  egress: RecallEgress;
}

export interface RecallMeasurements {
  source: string;
  measuredOn: string;
  queries: { total: number } & Record<RecallLanguage, number>;
  options: RecallMeasurement[];
}

export type RecommendationReason = 'multi-language' | 'english-only' | 'no-language-signal';
export type LanguageMix = 'turkish' | 'mixed' | 'english' | 'unknown';
export type RecommendationNote = 'private-query-available' | 'light-machine' | null;

export interface RecallRecommendation {
  option: RecallOptionId;
  reason: RecommendationReason;
  note: RecommendationNote;
  keyPresent: boolean;
  /** The more Turkish of the documents' and the prompts' readings: what the advice used. */
  languageMix: LanguageMix;
  docsMix: LanguageMix;
  promptsMix: LanguageMix;
  machineClass: 'light' | 'standard';
}

export interface RecallOptions {
  measurements: RecallMeasurements;
  recommendation: RecallRecommendation;
}

/** Never retried: a 403 means "not the dashboard on this computer" and is final. */
export function useRecallOptions() {
  const api = useApi();
  return useQuery({
    queryKey: ['recall-options'],
    queryFn: () => api.get<RecallOptions>('/recall/options'),
    retry: false,
    staleTime: 5 * 60_000,
  });
}
