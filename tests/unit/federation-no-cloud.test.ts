import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { crossVaultRecall } from '../../src/lib/federation-recall.js';
import { axisCorpus, consentAndIndex, fakeOpenRouter, setupEnv, teardownEnv, type Env } from './_hybrid-fixture.js';

/** Hybrid and cloud recall never run over peer corpora: federation is BM25 and imports no dense or cloud module. */
let env: Env;
beforeEach(() => { env = setupEnv('dc-fed-nocloud'); });
afterEach(() => { vi.unstubAllGlobals(); teardownEnv(env); });

describe('federated recall', () => {
  it('imports nothing from the embeddings layer', () => {
    const src = readFileSync(join(__dirname, '../../src/lib/federation-recall.ts'), 'utf-8');
    expect(src).not.toMatch(/embeddings\//);
    expect(src).not.toMatch(/openrouter|hybridSearch|egress|recall-cloud/i);
  });

  it('makes zero fetches even when the searched vault consented to the cloud tier', async () => {
    const docs = axisCorpus(env.root);
    await consentAndIndex(env, docs, 'cloud', 'voyageai/rerank-2.5-lite');
    const fake = fakeOpenRouter();
    vi.stubGlobal('fetch', fake.fetch);
    const res = crossVaultRecall('zzw3', { vaults: [{ name: join(env.root, '..'), label: 'self', current: true }], home: env.home, topK: 5 });
    expect(res.hits.length).toBeGreaterThan(0);
    expect(fake.calls).toHaveLength(0);
  });
});
