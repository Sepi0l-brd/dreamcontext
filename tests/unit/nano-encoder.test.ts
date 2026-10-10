import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NANO_MODEL, VOYAGE_DIMS, VOYAGE_QUERY_PROMPT, getNanoStatus, isNanoDownloaded, nanoEmbedQuery, poolAndNormalize,
  setNanoLoader, startNanoDownload, type NanoLoader,
} from '../../src/lib/embeddings/nano.js';

let home: string;
const FILES = ['onnx/model_quantized.onnx', 'onnx/model_quantized.onnx_data', 'tokenizer.json', 'config.json'];
function installModel(): void {
  for (const f of FILES) {
    const p = join(home, '.dreamcontext', 'models', NANO_MODEL, f);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, 'x');
  }
}
const norm = (v: Float32Array): number => Math.sqrt([...v].reduce((s, x) => s + x * x, 0));

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'dc-nano-')); });
afterEach(() => { setNanoLoader(null); rmSync(home, { recursive: true, force: true }); });

describe('poolAndNormalize', () => {
  it('mean-pools only unmasked tokens, truncates, and renormalises to unit length', () => {
    // 3 tokens × width 4; the third is padding and would change the mean if it leaked in.
    const hidden = [1, 0, 0, 5, 0, 1, 0, 5, 9, 9, 9, 9];
    const out = poolAndNormalize(hidden, [1n, 1n, 0n], 3, 4, 2);
    expect(out).toHaveLength(2);
    expect(out[0]).toBeCloseTo(Math.SQRT1_2);
    expect(out[1]).toBeCloseTo(Math.SQRT1_2);
    expect(norm(out)).toBeCloseTo(1);
  });

  it('is safe on an all-padding input (no division by zero, no NaN)', () => {
    const out = poolAndNormalize([1, 2, 3, 4], [0, 0], 2, 2, 2);
    expect([...out].every(Number.isFinite)).toBe(true);
  });

  it('never exceeds the model width', () => {
    expect(poolAndNormalize([1, 2], [1], 1, 2, 1024)).toHaveLength(2);
  });
});

describe('availability', () => {
  it('needs all four files to count as downloaded', () => {
    expect(isNanoDownloaded(home)).toBe(false);
    installModel();
    expect(isNanoDownloaded(home)).toBe(true);
    rmSync(join(home, '.dreamcontext', 'models', NANO_MODEL, 'onnx', 'model_quantized.onnx_data'));
    expect(isNanoDownloaded(home)).toBe(false);
  });

  it('returns null WITHOUT touching the loader when the model is absent (never downloads)', async () => {
    const loader = vi.fn() as unknown as NanoLoader;
    setNanoLoader(loader);
    expect(await nanoEmbedQuery('hello', { home })).toBeNull();
    expect(loader).not.toHaveBeenCalled();
    expect(getNanoStatus(home).state).toBe('not_downloaded');
  });
});

describe('encoding', () => {
  it('prefixes the query prompt, pools to 1024 and loads without remote access', async () => {
    installModel();
    const seen: string[] = [];
    const loader: NanoLoader = vi.fn(async () => ({
      async run(prompt: string) {
        seen.push(prompt);
        const width = 2048;
        const hidden = new Float32Array(2 * width).fill(0.5);
        return { hidden, mask: [1n, 1n], tokens: 2, width };
      },
    }));
    setNanoLoader(loader);
    const v = await nanoEmbedQuery('uyku borcu nasıl hesaplanır', { home });
    expect(v).toHaveLength(VOYAGE_DIMS);
    expect(norm(v!)).toBeCloseTo(1);
    expect(seen[0]).toBe(`${VOYAGE_QUERY_PROMPT}uyku borcu nasıl hesaplanır`);
    expect((loader as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ allowRemote: false });
    // the loaded runner is reused
    await nanoEmbedQuery('second', { home });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('returns null and records the error when the model fails to load', async () => {
    installModel();
    setNanoLoader(async () => { throw new Error('Cannot find module @huggingface/transformers'); });
    expect(await nanoEmbedQuery('hello', { home })).toBeNull();
    const st = getNanoStatus(home);
    expect(st.state).toBe('error');
    expect(st.errorCode).toBe('package_missing');
  });
});

describe('the explicit download door', () => {
  it('is the only path that loads with remote access allowed', async () => {
    const loader = vi.fn(async () => ({ run: async () => ({ hidden: [1], mask: [1], tokens: 1, width: 1 }) })) as unknown as NanoLoader;
    setNanoLoader(loader);
    startNanoDownload(home);
    await vi.waitFor(() => expect(loader).toHaveBeenCalled());
    expect((loader as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ allowRemote: true });
  });
});
