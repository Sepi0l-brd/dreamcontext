import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { EmbedModelStatus, EmbedModelFileProgress } from './embedder.js';

/**
 * voyage-4-nano: the LOCAL query encoder of the `cloud-index` tier. Documents are embedded in the
 * cloud with voyage-4; the two share an embedding space, so a 422 MB local model can encode the
 * query. It is loaded in-process only when it is already on disk — a prompt must never trigger the
 * download (that door is `startNanoDownload`, called explicitly), exactly like the e5 model.
 */
export const NANO_MODEL = 'onnx-community/voyage-4-nano-ONNX';
export const NANO_DTYPE = 'q8';
export const VOYAGE_DIMS = 1024;
export const VOYAGE_QUERY_PROMPT = 'Represent the query for retrieving supporting documents: ';
const MAX_QUERY_TOKENS = 512;

const nanoDir = (home: string): string => join(home, '.dreamcontext', 'models', NANO_MODEL);

/** The weights (graph + external data), tokenizer and config are all present: a finished download, not a partial. */
export function isNanoDownloaded(home: string = homedir()): boolean {
  const dir = nanoDir(home);
  return ['onnx/model_quantized.onnx', 'onnx/model_quantized.onnx_data', 'tokenizer.json', 'config.json']
    .every((f) => existsSync(join(dir, f)));
}

// ── pooling (pure) ───────────────────────────────────────────────────────────

/**
 * Masked mean-pool of one sequence's hidden states, Matryoshka-truncated to `outDims` and
 * re-normalised to unit length (the model card's recipe; what the parity spike measured).
 * `hidden` is row-major [tokens × width]; `mask[j]` is 0 for padding.
 */
export function poolAndNormalize(
  hidden: ArrayLike<number>,
  mask: ArrayLike<number | bigint>,
  tokens: number,
  width: number,
  outDims: number,
): Float32Array {
  const acc = new Float32Array(width);
  let n = 0;
  for (let j = 0; j < tokens; j++) {
    if (Number(mask[j]) === 0) continue;
    n++;
    const off = j * width;
    for (let k = 0; k < width; k++) acc[k] += hidden[off + k];
  }
  const out = new Float32Array(Math.min(outDims, width));
  let norm = 0;
  for (let k = 0; k < out.length; k++) {
    out[k] = acc[k] / Math.max(n, 1);
    norm += out[k] * out[k];
  }
  norm = Math.sqrt(norm) || 1;
  for (let k = 0; k < out.length; k++) out[k] /= norm;
  return out;
}

// ── loader (injectable) ──────────────────────────────────────────────────────

/** One forward pass: the hidden states of a single prompt, its attention mask and the shape. */
export interface NanoRunner {
  run(prompt: string): Promise<{ hidden: ArrayLike<number>; mask: ArrayLike<number | bigint>; tokens: number; width: number }>;
}
export type NanoLoader = (opts: { home: string; allowRemote: boolean; onProgress: (p: TfProgress) => void }) => Promise<NanoRunner>;
interface TfProgress { status: string; file?: string; progress?: number; loaded?: number; total?: number }

let loaderOverride: NanoLoader | null = null;
/** Test seam: replace the transformers.js loader (the real model is 422 MB). Pass null to restore. */
export function setNanoLoader(loader: NanoLoader | null): void {
  loaderOverride = loader;
  runnerPromise = null;
  status.state = 'not_downloaded';
}

const defaultLoader: NanoLoader = async ({ home, allowRemote, onProgress }) => {
  const tf = await import('@huggingface/transformers');
  tf.env.cacheDir = join(home, '.dreamcontext', 'models');
  tf.env.allowRemoteModels = allowRemote;
  const tokenizer = await tf.AutoTokenizer.from_pretrained(NANO_MODEL, { progress_callback: onProgress });
  const model = await tf.AutoModel.from_pretrained(NANO_MODEL, { dtype: NANO_DTYPE, progress_callback: onProgress });
  return {
    async run(prompt: string) {
      const inputs = tokenizer([prompt], { padding: true, truncation: true, max_length: MAX_QUERY_TOKENS });
      const out = await model(inputs);
      const [, tokens, width] = out.last_hidden_state.dims as number[];
      return { hidden: out.last_hidden_state.data as Float32Array, mask: inputs.attention_mask.data as BigInt64Array, tokens, width };
    },
  };
};

// ── status ───────────────────────────────────────────────────────────────────

interface InternalStatus {
  state: EmbedModelStatus['state'];
  files: Map<string, EmbedModelFileProgress>;
  error?: string;
  errorCode?: EmbedModelStatus['errorCode'];
}
const status: InternalStatus = { state: 'not_downloaded', files: new Map() };
let runnerPromise: Promise<NanoRunner | null> | null = null;

function recordProgress(p: TfProgress): void {
  if (!p.file) return;
  const prev = status.files.get(p.file);
  status.files.set(p.file, {
    file: p.file,
    status: p.status,
    loaded: p.loaded ?? prev?.loaded ?? 0,
    total: p.total ?? prev?.total ?? 0,
    progress: p.status === 'done' ? 100 : (p.progress ?? prev?.progress ?? 0),
  });
}

function loadRunner(home: string, allowRemote: boolean): Promise<NanoRunner | null> {
  if (runnerPromise === null) {
    status.state = 'downloading';
    runnerPromise = (async () => {
      try {
        const runner = await (loaderOverride ?? defaultLoader)({ home, allowRemote, onProgress: recordProgress });
        status.state = 'ready';
        return runner;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        status.state = 'error';
        status.error = msg;
        status.errorCode = /cannot find (module|package)|ERR_MODULE_NOT_FOUND/i.test(msg) ? 'package_missing' : 'download_failed';
        return null;
      }
    })();
  }
  return runnerPromise;
}

export function getNanoStatus(home: string = homedir()): EmbedModelStatus {
  const downloaded = isNanoDownloaded(home);
  const files = [...status.files.values()];
  const totalBytes = files.reduce((s, f) => s + (f.total || 0), 0);
  const loadedBytes = files.reduce((s, f) => s + (f.loaded || 0), 0);
  const state: EmbedModelStatus['state'] = status.state === 'error' ? 'error' : downloaded ? 'ready' : status.state === 'downloading' ? 'downloading' : 'not_downloaded';
  return {
    model: NANO_MODEL,
    state,
    downloaded,
    packageInstalled: true,
    progress: state === 'ready' ? 100 : totalBytes > 0 ? Math.min(99, Math.round((loadedBytes / totalBytes) * 100)) : 0,
    loadedBytes,
    totalBytes,
    files,
    error: status.error ?? null,
    errorCode: status.errorCode ?? null,
  };
}

/** The explicit download door (a Settings button or `recall cloud` command). The only path allowed to fetch the model. */
export function startNanoDownload(home: string = homedir()): EmbedModelStatus {
  if (status.state === 'error' || status.state === 'not_downloaded') {
    runnerPromise = null;
    status.files.clear();
    status.error = undefined;
    status.errorCode = undefined;
  }
  void loadRunner(home, true);
  return getNanoStatus(home);
}

/**
 * Encode a query for the cloud-index tier: the model prompt, one forward pass, masked mean-pool,
 * truncate to 1024, renormalise. NEVER downloads: with the model absent (or failing to load) it
 * returns null and the caller falls back to e5/BM25.
 */
export async function nanoEmbedQuery(text: string, opts: { home?: string } = {}): Promise<Float32Array | null> {
  const home = opts.home ?? homedir();
  if (!isNanoDownloaded(home)) return null;
  const runner = await loadRunner(home, false);
  if (runner === null) return null;
  const { hidden, mask, tokens, width } = await runner.run(VOYAGE_QUERY_PROMPT + text);
  return poolAndNormalize(hidden, mask, tokens, width, VOYAGE_DIMS);
}
