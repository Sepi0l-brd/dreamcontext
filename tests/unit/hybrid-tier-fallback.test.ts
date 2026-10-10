import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { bm25Search, docKey, type CorpusDoc } from '../../src/lib/recall.js';
import {
  BREAKER_PAUSE_MS, breakerOpen, hybridSearch, tripBreaker, type RecallTiming,
} from '../../src/lib/embeddings/hybrid.js';
import { refreshEmbeddings } from '../../src/lib/embeddings/store.js';
import { setRecallCloudKey } from '../../src/lib/recall-cloud-config.js';
import {
  KEY, axisCorpus, axisVector, consentAndIndex, fakeOpenRouter, setupEnv, teardownEnv, type Env,
} from './_hybrid-fixture.js';

vi.mock('../../src/lib/embeddings/embedder.js', () => ({
  EMBED_MODEL: 'test-model',
  EMBED_DIMS: 4,
  embeddingsAvailable: vi.fn(async () => true),
  embedPassages: vi.fn(),
  embedQuery: vi.fn(),
  isEmbedModelDownloaded: vi.fn(() => false),
}));
import { embedQuery, isEmbedModelDownloaded } from '../../src/lib/embeddings/embedder.js';

let env: Env;
let corpus: CorpusDoc[];
const timing = (): RecallTiming => ({ tier: 'local', querySource: 'none', fallback: 'none' });
const search = (q: string, t: RecallTiming, over: Parameters<typeof hybridSearch>[4] = {}) =>
  hybridSearch(q, corpus, env.root, 5, { tier: 'cloud', home: env.home, timing: t, ...over });
const bm25Keys = (q: string): string[] => bm25Search(q, corpus, 5).map((h) => docKey(h.doc));

beforeEach(async () => {
  env = setupEnv('dc-hyb-fallback');
  corpus = axisCorpus(env.root);
  vi.mocked(isEmbedModelDownloaded).mockReturnValue(false);
  vi.mocked(embedQuery).mockReset();
  await consentAndIndex(env, corpus, 'cloud');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  teardownEnv(env);
});

describe('cloud tier', () => {
  it('embeds the query through the API and ranks by the voyage index', async () => {
    const fake = fakeOpenRouter();
    vi.stubGlobal('fetch', fake.fetch);
    const t = timing();
    const hits = await search('zzw3', t);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].body).toMatchObject({ input_type: 'query', provider: { data_collection: 'deny' } });
    // consent chose no rerank, so the only note is that rerank was not consented — fusion order stands
    expect(t).toMatchObject({ tier: 'cloud', querySource: 'api', fallback: 'rerank_not_consented' });
    expect(docKey(hits[0].doc)).toBe('knowledge/e3');
  });

  it.each([
    ['network', { reject: true }],
    ['auth', { embedStatus: 401 }],
    ['rate_limit', { embedStatus: 429 }],
    ['policy_unavailable', { embedStatus: 404 }],
    ['bad_response', { embedStatus: 500 }],
  ] as const)('falls back to BM25 on %s and says why', async (kind, failure) => {
    vi.stubGlobal('fetch', fakeOpenRouter(failure).fetch);
    const t = timing();
    const hits = await search('zzw3 filler', t);
    expect(t.fallback).toBe(kind);
    expect(hits.map((h) => docKey(h.doc))).toEqual(bm25Keys('zzw3 filler'));
  });

  it('falls back on a timeout inside the fixed budget', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.stubGlobal('fetch', fakeOpenRouter({ hang: true }).fetch);
    const t = timing();
    const pending = search('zzw3', t);
    await vi.advanceTimersByTimeAsync(1600);
    await pending;
    expect(t.fallback).toBe('timeout');
  });

  it('falls back to e5 only when e5 is READY (model on disk + usable cache)', async () => {
    vi.stubGlobal('fetch', fakeOpenRouter({ reject: true }).fetch);
    // not ready: BM25, and e5 is never asked to embed the query
    const none = timing();
    await search('zzw3', none);
    expect(embedQuery).not.toHaveBeenCalled();

    // ready: model "downloaded" and a usable cache for the corpus
    vi.mocked(isEmbedModelDownloaded).mockReturnValue(true);
    await refreshEmbeddings(env.root, corpus, async (texts) => texts.map(() => new Float32Array([1, 0, 0, 0])));
    vi.mocked(embedQuery).mockResolvedValue(new Float32Array([1, 0, 0, 0]));
    const t = timing();
    const hits = await search('zzw3', t);
    expect(embedQuery).toHaveBeenCalledTimes(1);
    expect(t.querySource).toBe('e5');
    expect(t.fallback).toBe('breaker_open'); // the first search tripped the breaker
    expect(hits.length).toBeGreaterThan(0);
  });

  it('skips the dense channel (and the network) when the gate says BM25 is sure', async () => {
    const fake = fakeOpenRouter();
    vi.stubGlobal('fetch', fake.fetch);
    const params = { rawCutoff: 18, rrfK: 60, rrfBm25Weight: 0.6, relativeLambda: 0.1, pinMargin: 1.35, aggregation: 'max' as const,
      secondWeight: 0, priorGamma: 0, changelogFactor: 0.85, denseGate: { rawSure: 0, rawLead: 0, leadRatio: 1 }, langWeights: null, rerank: null };
    const hits = await search('zzw3', timing(), { fusionParams: params });
    expect(fake.calls).toHaveLength(0);
    expect(hits.map((h) => docKey(h.doc))).toEqual(bm25Keys('zzw3'));
  });

  it('never exceeds the vault: a cloud-index vault asked for cloud runs cloud-index (no query-time fetch)', async () => {
    await consentAndIndex(env, corpus, 'cloud-index');
    const fake = fakeOpenRouter();
    vi.stubGlobal('fetch', fake.fetch);
    const t = timing();
    await search('zzw3', t); // nano is absent in the temp home
    expect(fake.calls).toHaveLength(0);
    expect(t).toMatchObject({ tier: 'cloud-index', fallback: 'no_local_model' });
  });

  it('cloud-index ranks with a supplied local query vector and still makes no call', async () => {
    await consentAndIndex(env, corpus, 'cloud-index');
    const fake = fakeOpenRouter();
    vi.stubGlobal('fetch', fake.fetch);
    const t = timing();
    const hits = await search('anything', t, { queryVec: Float32Array.from(axisVector('zzw4')) });
    expect(fake.calls).toHaveLength(0);
    expect(t).toMatchObject({ tier: 'cloud-index', querySource: 'nano', fallback: 'none' });
    expect(docKey(hits[0].doc)).toBe('knowledge/e4');
  });
});

describe('circuit breaker', () => {
  it('opens after a failure, makes no further call, and closes after the pause', async () => {
    const fake = fakeOpenRouter({ reject: true });
    vi.stubGlobal('fetch', fake.fetch);
    await search('zzw3', timing());
    expect(fake.calls).toHaveLength(1);
    expect(breakerOpen(env.home)).toBe(true);
    const t = timing();
    await search('zzw3', t);
    expect(fake.calls).toHaveLength(1);
    expect(t.fallback).toBe('breaker_open');
    expect(breakerOpen(env.home, Date.now() + BREAKER_PAUSE_MS + 1)).toBe(false);
  });

  it('writes its file 0600', async () => {
    tripBreaker('network', env.home);
    const path = join(env.home, '.dreamcontext', 'recall-cloud-health.json');
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('an auth failure stays open until the key is replaced', async () => {
    tripBreaker('auth', env.home);
    expect(breakerOpen(env.home, Date.now() + 10 * BREAKER_PAUSE_MS)).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    setRecallCloudKey(`${KEY}-rotated`, 'manual', env.home);
    expect(breakerOpen(env.home)).toBe(false);
  });

  it.each(['forged_payload', 'eval_cap', 'no_key'] as const)('%s never trips it', (kind) => {
    tripBreaker(kind, env.home);
    expect(breakerOpen(env.home)).toBe(false);
  });
});
