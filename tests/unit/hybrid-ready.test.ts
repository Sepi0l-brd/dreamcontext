import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cloudTierReady, hybridReady, localReady } from '../../src/lib/embeddings/hybrid.js';
import { getNanoStatus, NANO_MODEL } from '../../src/lib/embeddings/nano.js';
import { refreshEmbeddings } from '../../src/lib/embeddings/store.js';
import { setRecallCloudKey } from '../../src/lib/recall-cloud-config.js';
import { axisCorpus, consentAndIndex, fakeOpenRouter, setupEnv, teardownEnv, type Env } from './_hybrid-fixture.js';

vi.mock('../../src/lib/embeddings/embedder.js', () => ({
  EMBED_MODEL: 'test-model',
  EMBED_DIMS: 4,
  embeddingsAvailable: vi.fn(async () => true),
  embedPassages: vi.fn(),
  embedQuery: vi.fn(),
  isEmbedModelDownloaded: vi.fn(() => false),
}));
import { isEmbedModelDownloaded } from '../../src/lib/embeddings/embedder.js';

let env: Env;

/** Put a complete nano model on disk (what `isNanoDownloaded` checks), without running it. */
function installNano(home: string): void {
  const dir = join(home, '.dreamcontext', 'models', NANO_MODEL);
  for (const f of ['onnx/model_quantized.onnx', 'onnx/model_quantized.onnx_data', 'tokenizer.json', 'config.json']) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), 'x');
  }
}

beforeEach(() => {
  env = setupEnv('dc-hyb-ready');
  vi.mocked(isEmbedModelDownloaded).mockReturnValue(false);
});
afterEach(() => {
  vi.unstubAllGlobals();
  teardownEnv(env);
});

describe('hybridReady = hybrid mode AND (a ready cloud tier OR a ready e5)', () => {
  it('is false for any other mode, and for a bare vault', () => {
    expect(hybridReady(env.root, 'hybrid', undefined, env.home)).toBe(false);
    expect(hybridReady(env.root, 'raw', 'cloud', env.home)).toBe(false);
  });

  it('is true for the local tier when e5 is ready (unchanged semantics, two-argument form too)', async () => {
    const docs = axisCorpus(env.root, 3);
    vi.mocked(isEmbedModelDownloaded).mockReturnValue(true);
    await refreshEmbeddings(env.root, docs, async (t) => t.map(() => new Float32Array([1, 0, 0, 0])));
    expect(localReady(env.root)).toBe(true);
    expect(hybridReady(env.root, 'hybrid')).toBe(true);
    expect(hybridReady(env.root, 'hybrid', 'local', env.home)).toBe(true);
  });

  it('cloud tier: ready with a consented vault, a covering index and a key', async () => {
    await consentAndIndex(env, axisCorpus(env.root), 'cloud');
    expect(cloudTierReady('cloud', env.root, false, env.home)).toBe(true);
    expect(hybridReady(env.root, 'hybrid', 'cloud', env.home)).toBe(true);
  });

  it('cloud tier: not ready after the key is removed', async () => {
    await consentAndIndex(env, axisCorpus(env.root), 'cloud');
    setRecallCloudKey(null, 'manual', env.home);
    expect(cloudTierReady('cloud', env.root, false, env.home)).toBe(false);
  });

  it('cloud-index with the nano model ABSENT is not ready, and nothing is downloaded', async () => {
    await consentAndIndex(env, axisCorpus(env.root), 'cloud-index');
    const fake = fakeOpenRouter();
    vi.stubGlobal('fetch', fake.fetch);
    expect(cloudTierReady('cloud-index', env.root, false, env.home)).toBe(false);
    expect(hybridReady(env.root, 'hybrid', 'cloud-index', env.home)).toBe(false);
    expect(getNanoStatus(env.home).state).toBe('not_downloaded');
    expect(fake.calls).toHaveLength(0);
  });

  it('cloud-index becomes ready once nano is on disk', async () => {
    await consentAndIndex(env, axisCorpus(env.root), 'cloud-index');
    installNano(env.home);
    expect(cloudTierReady('cloud-index', env.root, false, env.home)).toBe(true);
  });

  it('a requested tier above the vault consent does not make a cloud tier ready', async () => {
    await consentAndIndex(env, axisCorpus(env.root), 'cloud-index');
    expect(cloudTierReady('cloud', env.root, false, env.home)).toBe(false); // effective = cloud-index, nano absent
  });

  it('an unconsented vault is never cloud-ready, whatever the index files say', async () => {
    await consentAndIndex(env, axisCorpus(env.root), 'cloud');
    const other = setupEnv('dc-hyb-ready-other');
    try {
      expect(cloudTierReady('cloud', other.root, false, other.home)).toBe(false);
    } finally {
      teardownEnv(other);
    }
  });
});
