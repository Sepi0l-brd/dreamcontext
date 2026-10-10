import { CLOUD_ELIGIBLE_TYPES, CLOUD_DISCLOSURE_VERSION, QUERY_CHAR_CAP, type WithheldRule } from './embeddings/egress-rules.js';
import type { CloudTier, RecallCloudStatus, RerankModel } from './recall-cloud-config.js';

/** What a build would send: counts the user sees BEFORE consenting. */
export interface CloudIndexPlan {
  toEmbed: number;
  total: number;
  estTokens: number;
  estUsd: number;
  byType: Record<string, number>;
  withheld: Partial<Record<WithheldRule, number>>;
}

const usd = (n: number): string => `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;

/**
 * The disclosure shown before consent, by the CLI and by Settings alike. Any change to its meaning
 * must bump CLOUD_DISCLOSURE_VERSION (a test pins the rendered text to the version), which makes
 * every existing consent stale until the user reads and accepts the new wording.
 */
export function renderDisclosure(
  tier: CloudTier,
  plan: CloudIndexPlan,
  status: RecallCloudStatus,
  rerankModel: RerankModel | null,
): string[] {
  const lines: string[] = [];
  lines.push(`Cloud recall (${tier}) — what leaves this machine`);
  lines.push('Processor chain: OpenRouter → Voyage AI (by MongoDB).');
  lines.push('Every request asks OpenRouter to route only to endpoints that do not collect data (data_collection: "deny"). That is OpenRouter\'s routing filter, not a guarantee from Voyage.');
  lines.push('This is NOT zero-data-retention: Voyage may retain inputs according to its own policy.');
  lines.push(`Sent: text of ${CLOUD_ELIGIBLE_TYPES.join(', ')} docs only. Never sent: changelog, insight, automation and skill docs, captured session digests and bookmarks, peer-vault docs, docs marked "cloud: false".`);
  const byType = Object.entries(plan.byType).sort(([a], [b]) => a.localeCompare(b)).map(([t, n]) => `${t} ${n}`).join(', ');
  lines.push(`This vault: ${plan.total} indexable chunks (${plan.toEmbed} to embed now)${byType ? `; docs by type: ${byType}` : ''}.`);
  const withheld = Object.entries(plan.withheld).sort(([a], [b]) => a.localeCompare(b)).map(([r, n]) => `${r} ${n}`).join(', ');
  lines.push(`Withheld by rule: ${withheld || 'none'}.`);
  lines.push('Secret filtering (private keys, API tokens, passwords, JWTs) is best-effort: matching chunks are dropped whole, but a pattern list cannot catch everything.');
  if (tier === 'cloud-index') {
    lines.push('Content leaves only at index time; there is no query-time egress. Queries run locally, which is expected to be slower than 1.5 s.');
  } else {
    lines.push(`Each recalled prompt is also sent (secret-scanned first; only its first ${QUERY_CHAR_CAP} characters), plus the text of the top candidate docs for reranking${rerankModel ? ` (${rerankModel})` : ' (no reranker chosen)'}.`);
  }
  lines.push(`Estimated cost: ${usd(plan.estUsd)} for ${plan.estTokens} tokens now; caps: ${usd(status.spend.maxIndexUsd)} per build, ${usd(status.spend.maxIndexUsd24h)} per 24 h for automatic builds, ${status.spend.maxQueriesPerDay} cloud queries per day.`);
  lines.push(`Key: ${status.key ? `present (source ${status.keySource}, origin ${status.keyOrigin ?? 'environment'})` : 'not set'}.`);
  lines.push(`Disclosure version ${CLOUD_DISCLOSURE_VERSION}. Consent is per vault, stays on this machine, and can be revoked with \`dreamcontext recall cloud disable\`.`);
  return lines;
}
