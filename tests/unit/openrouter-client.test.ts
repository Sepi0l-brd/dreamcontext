import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { buildFields, type CorpusDoc } from '../../src/lib/recall.js';
import { buildEgressPayload, type EgressPayload } from '../../src/lib/embeddings/egress.js';
import { CloudRecallError, OPENROUTER_BASE, openRouterEmbed, openRouterRerank } from '../../src/lib/embeddings/openrouter.js';
import { VOYAGE_DIMS } from '../../src/lib/embeddings/nano.js';
import {
  grantVaultConsent, readRecallCloudUsage, setRecallCloudKey, type RerankModel,
} from '../../src/lib/recall-cloud-config.js';

const KEY = 'or-test-key-0123456789-SECRET';
let tmp: string;
let home: string;
let root: string;
const ENV_KEYS = ['DREAMCONTEXT_SPAWNED', 'DREAMCONTEXT_AUTOMATION_RUN', 'DREAMCONTEXT_AUTO_SLEEP', 'DREAMCONTEXT_RECALL_OPENROUTER_KEY', 'DREAMCONTEXT_EVAL_MAX_USD'];
const saved: Record<string, string | undefined> = {};
const lite: RerankModel = 'voyageai/rerank-2.5-lite';

function mkDoc(slug: string, body: string): CorpusDoc {
  const path = join(root, 'knowledge', `${slug}.md`);
  mkdirSync(join(root, 'knowledge'), { recursive: true });
  writeFileSync(path, body);
  const f = buildFields({ slug, title: slug, description: 'd', tags: [], body });
  return { type: 'knowledge', path, relPath: `knowledge/${slug}.md`, slug, title: slug, description: 'd', tags: [], body,
    tokens: f.tokens, tokenSet: new Set(f.tokens), termFreq: f.termFreq, fieldFreq: f.fieldFreq, fieldLen: f.fieldLen,
    links: f.links, identityTokens: f.identityTokens };
}
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const vec = (i: number): number[] => Array.from({ length: VOYAGE_DIMS }, (_, k) => (k === i ? 3 : 0));
const embedPayload = (n = 1): EgressPayload<'index'> => {
  const items = Array.from({ length: n }, (_, i) => ({ doc: mkDoc(`d${i}`, `body number ${i}`), chunk: { seq: 0, hash: `h${i}`, text: `body number ${i}` } }));
  return buildEgressPayload({ kind: 'index', contextRoot: root, tier: 'cloud', home, profile: 'voyage-4', items }).payload!;
};
function frozenRoot(): string {
  const snap = join(home, '.dreamcontext', 'eval-frozen', 'dc-t');
  mkdirSync(join(snap, '_dream_context'), { recursive: true });
  writeFileSync(join(snap, 'FINGERPRINT.json'), '{}');
  writeFileSync(join(snap, 'now.txt'), 'x');
  return join(snap, '_dream_context');
}

beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  tmp = mkdtempSync(join(tmpdir(), 'dc-or-client-'));
  home = join(tmp, 'home');
  root = join(tmp, 'vault', '_dream_context');
  mkdirSync(home, { recursive: true });
  mkdirSync(root, { recursive: true });
  setRecallCloudKey(KEY, 'manual', home);
  grantVaultConsent(root, { tier: 'cloud', rerankModel: lite, surface: 'cli-tty' }, home);
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(tmp, { recursive: true, force: true });
});

describe('payload gate', () => {
  it('rejects an object egress did not mint BEFORE reading the key', async () => {
    rmSync(join(home, '.dreamcontext', 'recall-cloud.json')); // no key: a key read would say no_key
    const fetchImpl = vi.fn();
    const forged = Object.freeze({ endpoint: '/embeddings', itemKeys: ['x'] }) as unknown as EgressPayload<'query'>;
    await expect(openRouterEmbed(forged, { timeoutMs: 100, fetchImpl })).rejects.toMatchObject({ kind: 'forged_payload' });
    const real = embedPayload();
    await expect(openRouterEmbed({ ...real } as EgressPayload<'index'>, { timeoutMs: 100, fetchImpl })).rejects.toMatchObject({ kind: 'forged_payload' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a payload of the wrong kind for the function', async () => {
    const rerank = buildEgressPayload({ kind: 'rerank', contextRoot: root, tier: 'cloud', home, model: lite, query: 'hello', candidates: [{ doc: mkDoc('a', 'alpha'), bestChunk: null }] }).payload!;
    await expect(openRouterEmbed(rerank as unknown as EgressPayload<'query'>, { timeoutMs: 100, fetchImpl: vi.fn() })).rejects.toMatchObject({ kind: 'forged_payload' });
  });

  it('reports no_key when the minted payload has no key to send', async () => {
    const p = embedPayload();
    setRecallCloudKey(null, 'manual', home);
    const fetchImpl = vi.fn();
    await expect(openRouterEmbed(p, { timeoutMs: 100, fetchImpl })).rejects.toMatchObject({ kind: 'no_key' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('embedding', () => {
  it('posts exactly the minted body with the key, returns normalised vectors in order, and meters the cost', async () => {
    const p = embedPayload(2);
    const fetchImpl = vi.fn(async () => json({ data: [{ index: 1, embedding: vec(5) }, { index: 0, embedding: vec(2) }], usage: { prompt_tokens: 12, cost: 0.0004 } }));
    const out = await openRouterEmbed(p, { timeoutMs: 1000, fetchImpl: fetchImpl as unknown as typeof fetch });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${OPENROUTER_BASE}/embeddings`);
    expect(JSON.parse(String(init.body)).provider).toEqual({ data_collection: 'deny' });
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(out.vectors).toHaveLength(2);
    expect(out.vectors[0][2]).toBeCloseTo(1); // index 0 → vec(2), unit length
    expect(out.vectors[1][5]).toBeCloseTo(1);
    expect(out.promptTokens).toBe(12);
    expect(readRecallCloudUsage(home).lifetimeUsd).toBeCloseTo(0.0004);
  });

  it('charges the estimate when the response has no usable cost', async () => {
    const p = embedPayload();
    const fetchImpl = vi.fn(async () => json({ data: [{ index: 0, embedding: vec(0) }] }));
    const out = await openRouterEmbed(p, { timeoutMs: 1000, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out.costUsd).toBeGreaterThan(0);
    expect(readRecallCloudUsage(home).lifetimeUsd).toBeCloseTo(out.costUsd);
  });

  it.each([
    [401, 'auth'], [403, 'auth'], [404, 'policy_unavailable'], [429, 'rate_limit'], [500, 'bad_response'],
  ])('maps HTTP %s to %s', async (status, kind) => {
    const fetchImpl = vi.fn(async () => json({ error: 'nope' }, status));
    await expect(openRouterEmbed(embedPayload(), { timeoutMs: 1000, fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toMatchObject({ kind });
  });

  it('rejects wrong counts, wrong widths and non-finite numbers as bad_response', async () => {
    for (const body of [
      { data: [] },
      { data: [{ index: 0, embedding: [1, 2, 3] }] },
      { data: [{ index: 0, embedding: Array.from({ length: VOYAGE_DIMS }, () => 'x') }] },
      { nodata: true },
    ]) {
      const fetchImpl = vi.fn(async () => json(body));
      await expect(openRouterEmbed(embedPayload(), { timeoutMs: 1000, fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toMatchObject({ kind: 'bad_response' });
    }
  });

  it('times out an unanswered request and reports a plain network failure', async () => {
    const hang = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_res, rej) => {
      init.signal!.addEventListener('abort', () => rej(new Error('aborted')));
    }));
    await expect(openRouterEmbed(embedPayload(), { timeoutMs: 20, fetchImpl: hang as unknown as typeof fetch })).rejects.toMatchObject({ kind: 'timeout' });
    const down = vi.fn(async () => { throw new TypeError('fetch failed'); });
    await expect(openRouterEmbed(embedPayload(), { timeoutMs: 1000, fetchImpl: down as unknown as typeof fetch })).rejects.toMatchObject({ kind: 'network' });
  });

  it('never leaks the key or the request through an error', async () => {
    const fetchImpl = vi.fn(async () => json({ error: KEY }, 401));
    const err = await openRouterEmbed(embedPayload(), { timeoutMs: 1000, fetchImpl: fetchImpl as unknown as typeof fetch }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloudRecallError);
    const shown = inspect(err, { depth: 6 }) + String((err as Error).message);
    expect(shown).not.toContain(KEY);
    expect(shown).not.toContain('body number');
    expect((err as Error & { cause?: unknown }).cause).toBeUndefined();
    expect((err as CloudRecallError).message).toBe('Cloud recall failed: the provider rejected the key.');
  });

  it('ignores fetchImpl outside a test run and uses the global fetch', async () => {
    const globalFetch = vi.fn(async () => json({ data: [{ index: 0, embedding: vec(0) }], usage: { cost: 0 } }));
    vi.stubGlobal('fetch', globalFetch);
    const injected = vi.fn();
    const vitestFlag = process.env.VITEST;
    delete process.env.VITEST;
    try {
      await openRouterEmbed(embedPayload(), { timeoutMs: 1000, fetchImpl: injected });
    } finally {
      process.env.VITEST = vitestFlag;
    }
    expect(globalFetch).toHaveBeenCalledTimes(1);
    expect(injected).not.toHaveBeenCalled();
  });
});

describe('rerank', () => {
  const rerankPayload = (): EgressPayload<'rerank'> =>
    buildEgressPayload({ kind: 'rerank', contextRoot: root, tier: 'cloud', home, model: lite, query: 'hello recall', candidates: [{ doc: mkDoc('a', 'alpha'), bestChunk: null }, { doc: mkDoc('b', 'beta'), bestChunk: null }] }).payload!;

  it('returns relevance by sent index and meters the cost', async () => {
    const fetchImpl = vi.fn(async () => json({ results: [{ index: 1, relevance_score: 0.8 }, { index: 0, relevance_score: 0.1 }], usage: { cost: 0.0002 } }));
    const out = await openRouterRerank(rerankPayload(), { timeoutMs: 1000, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out.scores).toEqual([{ index: 1, relevance: 0.8 }, { index: 0, relevance: 0.1 }]);
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe(`${OPENROUTER_BASE}/rerank`);
    expect(readRecallCloudUsage(home).lifetimeUsd).toBeCloseTo(0.0002);
  });

  it('rejects an index outside the sent list as bad_response', async () => {
    const fetchImpl = vi.fn(async () => json({ results: [{ index: 7, relevance_score: 0.8 }] }));
    await expect(openRouterRerank(rerankPayload(), { timeoutMs: 1000, fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toMatchObject({ kind: 'bad_response' });
  });
});

describe('eval spend ceiling', () => {
  const evalIndex = (r: string): EgressPayload<'index'> =>
    buildEgressPayload({ kind: 'index', contextRoot: r, tier: 'cloud', evalConsent: true, home, profile: 'voyage-4', items: (() => {
      const path = join(r, 'knowledge', 'e.md'); mkdirSync(join(r, 'knowledge'), { recursive: true }); writeFileSync(path, 'eval body text');
      const f = buildFields({ slug: 'e', title: 'e', description: 'd', tags: [], body: 'eval body text' });
      const doc = { type: 'knowledge', path, relPath: 'knowledge/e.md', slug: 'e', title: 'e', description: 'd', tags: [], body: 'eval body text',
        tokens: f.tokens, tokenSet: new Set(f.tokens), termFreq: f.termFreq, fieldFreq: f.fieldFreq, fieldLen: f.fieldLen, links: f.links, identityTokens: f.identityTokens } as CorpusDoc;
      return [{ doc, chunk: { seq: 0, hash: 'eh', text: 'eval body text' } }];
    })() }).payload!;
  const ok = (): typeof fetch => vi.fn(async () => json({ data: [{ index: 0, embedding: vec(0) }], usage: { cost: 0.5 } })) as unknown as typeof fetch;

  it('charges eval-minted calls to the eval ledger, not to the product ledger', async () => {
    const r = frozenRoot();
    await openRouterEmbed(evalIndex(r), { timeoutMs: 1000, fetchImpl: ok() });
    const u = readRecallCloudUsage(home);
    expect(u.evalSpentUsd).toBeCloseTo(0.5);
    expect(u.indexSpend).toEqual([]);
  });

  it('refuses with eval_cap when spent + estimate would pass the ceiling, before any fetch', async () => {
    const r = frozenRoot();
    const fetchImpl = ok();
    const p = evalIndex(r);
    process.env.DREAMCONTEXT_EVAL_MAX_USD = '0';
    await expect(openRouterEmbed(p, { timeoutMs: 1000, fetchImpl })).rejects.toMatchObject({ kind: 'eval_cap' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('cannot be raised by the env var', async () => {
    const r = frozenRoot();
    process.env.DREAMCONTEXT_EVAL_MAX_USD = '1000';
    const cfgPath = join(home, '.dreamcontext', 'recall-cloud.json');
    writeFileSync(cfgPath, JSON.stringify({ spend: { maxEvalUsd: 0 }, openRouterKey: KEY, vaults: {} }));
    await expect(openRouterEmbed(evalIndex(r), { timeoutMs: 1000, fetchImpl: ok() })).rejects.toMatchObject({ kind: 'eval_cap' });
  });

  it('treats a corrupt usage file as at-ceiling', async () => {
    const r = frozenRoot();
    const p = evalIndex(r);
    writeFileSync(join(home, '.dreamcontext', 'recall-cloud-usage.json'), '{oops');
    await expect(openRouterEmbed(p, { timeoutMs: 1000, fetchImpl: ok() })).rejects.toMatchObject({ kind: 'eval_cap' });
  });
});
