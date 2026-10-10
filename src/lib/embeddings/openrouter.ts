import {
  evalSpendCeilingUsd,
  readRecallCloudUsage,
  recallCloudApiKey,
  recordCloudUsage,
  type UsageKind,
} from '../recall-cloud-config.js';
import { resolveEgressPayload, type EgressPayload } from './egress.js';
import { scanSecrets } from './egress-rules.js';
import { VOYAGE_DIMS } from './nano.js';

/**
 * The ONLY module that talks to OpenRouter for recall, and the only reader of the recall key
 * (an architecture test pins both). It sends exactly the body the egress layer minted: a payload
 * it cannot resolve through `resolveEgressPayload` is `forged_payload`, refused BEFORE the key is
 * read. Errors carry a fixed message per kind and no request data, headers or cause.
 */
export const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

export type CloudFailureKind =
  | 'forged_payload' | 'eval_cap' | 'auth' | 'no_key' | 'timeout' | 'network' | 'rate_limit' | 'bad_response' | 'policy_unavailable';

const MESSAGES: Record<CloudFailureKind, string> = {
  forged_payload: 'Cloud recall refused: the request was not built by the egress layer.',
  eval_cap: 'Cloud recall refused: the eval spend ceiling would be exceeded.',
  auth: 'Cloud recall failed: the provider rejected the key.',
  no_key: 'Cloud recall failed: no recall key is configured.',
  timeout: 'Cloud recall failed: the request timed out.',
  network: 'Cloud recall failed: the network request failed.',
  rate_limit: 'Cloud recall failed: the provider rate-limited the request.',
  bad_response: 'Cloud recall failed: the provider response was not usable.',
  policy_unavailable: 'Cloud recall failed: no endpoint satisfies the data policy.',
};

export class CloudRecallError extends Error {
  readonly kind: CloudFailureKind;
  readonly status?: number;
  constructor(kind: CloudFailureKind, status?: number) {
    super(MESSAGES[kind]);
    this.name = 'CloudRecallError';
    this.kind = kind;
    if (status !== undefined) this.status = status;
  }
}

export interface CloudCallOpts {
  timeoutMs: number;
  signal?: AbortSignal;
  /** Tests only: ignored unless process.env.VITEST is set. */
  fetchImpl?: typeof fetch;
}

interface Called { json: Record<string, unknown>; costUsd: number }

async function post(p: unknown, accept: ReadonlyArray<'index' | 'query' | 'rerank'>, o: CloudCallOpts): Promise<Called & { meta: NonNullable<ReturnType<typeof resolveEgressPayload>> }> {
  const meta = resolveEgressPayload(p);
  if (meta === null || !accept.includes(meta.kind)) throw new CloudRecallError('forged_payload');
  if (meta.evalMinted) {
    const spent = readRecallCloudUsage(meta.home).evalSpentUsd;
    if (spent + meta.estUsd > evalSpendCeilingUsd(meta.home)) throw new CloudRecallError('eval_cap');
  }
  // Re-scanned right before the wire, so a body that somehow changed identity or content is never sent.
  if (scanSecrets(meta.bodyJson) !== null) throw new CloudRecallError('bad_response');
  const found = recallCloudApiKey(meta.home);
  if (found === null) throw new CloudRecallError('no_key');

  const send: typeof fetch = process.env.VITEST && o.fetchImpl ? o.fetchImpl : fetch;
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, o.timeoutMs);
  const onAbort = (): void => ctl.abort();
  o.signal?.addEventListener('abort', onAbort, { once: true });
  let res: Response;
  try {
    res = await send(`${OPENROUTER_BASE}${meta.endpoint}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${found.key}`, 'Content-Type': 'application/json' },
      body: meta.bodyJson,
      signal: ctl.signal,
    });
  } catch {
    throw new CloudRecallError(timedOut ? 'timeout' : 'network');
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener('abort', onAbort);
  }
  if (res.status === 401 || res.status === 403) throw new CloudRecallError('auth', res.status);
  if (res.status === 404) throw new CloudRecallError('policy_unavailable', res.status);
  if (res.status === 429) throw new CloudRecallError('rate_limit', res.status);
  if (!res.ok) throw new CloudRecallError('bad_response', res.status);
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new CloudRecallError('bad_response', res.status);
  }
  if (!json || typeof json !== 'object') throw new CloudRecallError('bad_response', res.status);
  const body = json as Record<string, unknown>;
  const usage = body.usage as { cost?: unknown } | undefined;
  // A response without a usable cost is charged at the estimate: metering can only over-count.
  const costUsd = typeof usage?.cost === 'number' && Number.isFinite(usage.cost) && usage.cost >= 0 ? usage.cost : meta.estUsd;
  const usageKind: UsageKind = meta.evalMinted ? 'eval' : meta.kind;
  recordCloudUsage(meta.contextRoot, usageKind, costUsd, {}, meta.home);
  return { json: body, costUsd, meta };
}

function unit(v: Float32Array): Float32Array {
  let s = 0;
  for (const x of v) s += x * x;
  s = Math.sqrt(s) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= s;
  return v;
}

/** Embed an `index` or `query` payload. Vectors come back L2-normalised, one per sent item, `VOYAGE_DIMS` wide. */
export async function openRouterEmbed(
  p: EgressPayload<'index' | 'query'>,
  o: CloudCallOpts,
): Promise<{ vectors: Float32Array[]; promptTokens: number; costUsd: number }> {
  const { json, costUsd, meta } = await post(p, ['index', 'query'], o);
  const data = json.data;
  const expected = meta.kind === 'index' ? p.itemKeys.length : 1;
  if (!Array.isArray(data) || data.length !== expected) throw new CloudRecallError('bad_response');
  const rows = [...(data as Array<{ index?: unknown; embedding?: unknown }>)].sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0));
  const vectors = rows.map((row) => {
    const e = row.embedding;
    if (!Array.isArray(e) || e.length !== VOYAGE_DIMS || !e.every((x) => typeof x === 'number' && Number.isFinite(x))) {
      throw new CloudRecallError('bad_response');
    }
    return unit(Float32Array.from(e as number[]));
  });
  const tokens = (json.usage as { prompt_tokens?: unknown } | undefined)?.prompt_tokens;
  return { vectors, promptTokens: typeof tokens === 'number' && Number.isFinite(tokens) ? tokens : 0, costUsd };
}

/** Rerank a `rerank` payload: relevance per sent document, by its index in the sent list. */
export async function openRouterRerank(
  p: EgressPayload<'rerank'>,
  o: CloudCallOpts,
): Promise<{ scores: Array<{ index: number; relevance: number }>; costUsd: number }> {
  const { json, costUsd } = await post(p, ['rerank'], o);
  const results = json.results;
  if (!Array.isArray(results)) throw new CloudRecallError('bad_response');
  const scores = (results as Array<{ index?: unknown; relevance_score?: unknown }>).map((r) => {
    const index = r.index;
    const relevance = r.relevance_score;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= p.itemKeys.length
      || typeof relevance !== 'number' || !Number.isFinite(relevance)) {
      throw new CloudRecallError('bad_response');
    }
    return { index, relevance };
  });
  return { scores, costUsd };
}
