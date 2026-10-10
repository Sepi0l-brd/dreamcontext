import { vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildFields, type CorpusDoc, type CorpusType } from '../../src/lib/recall.js';
import { VOYAGE_DIMS } from '../../src/lib/embeddings/nano.js';
import { buildCloudIndex } from '../../src/lib/embeddings/vector-store.js';
import {
  grantVaultConsent, setRecallCloudKey, type CloudTier, type RerankModel,
} from '../../src/lib/recall-cloud-config.js';

/**
 * Shared fixture of the T6a tests: a temp home + vault, a corpus whose dense geometry is known
 * (a `zzwN` token puts a text on axis N), a fake OpenRouter, and a helper that builds a REAL voyage-4
 * index through the egress layer. Not a test file (no `.test.`), so vitest does not collect it.
 */
export const KEY = 'or-test-key-0123456789';
export const ENV_KEYS = [
  'DREAMCONTEXT_SPAWNED', 'DREAMCONTEXT_AUTOMATION_RUN', 'DREAMCONTEXT_AUTO_SLEEP',
  'DREAMCONTEXT_RECALL_OPENROUTER_KEY', 'DREAMCONTEXT_RECALL_TIER', 'DREAMCONTEXT_EVAL_MAX_USD',
];

export interface Env { tmp: string; home: string; root: string; saved: Record<string, string | undefined> }

export function setupEnv(prefix: string): Env {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  const tmp = mkdtempSync(join(tmpdir(), `${prefix}-`));
  const home = join(tmp, 'home');
  const root = join(tmp, 'vault', '_dream_context');
  mkdirSync(home, { recursive: true });
  mkdirSync(root, { recursive: true });
  return { tmp, home, root, saved };
}

export function teardownEnv(env: Env): void {
  for (const k of ENV_KEYS) { if (env.saved[k] === undefined) delete process.env[k]; else process.env[k] = env.saved[k]; }
  rmSync(env.tmp, { recursive: true, force: true });
}

export function mkDoc(root: string, slug: string, body: string, type: CorpusType = 'knowledge', over: Partial<CorpusDoc> = {}): CorpusDoc {
  const path = join(root, type, `${slug}.md`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  const f = buildFields({ slug, title: slug, description: 'd', tags: [], body });
  return {
    type, path, relPath: `${type}/${slug}.md`, slug, title: slug, description: 'd', tags: [], body,
    tokens: f.tokens, tokenSet: new Set(f.tokens), termFreq: f.termFreq, fieldFreq: f.fieldFreq, fieldLen: f.fieldLen,
    links: f.links, identityTokens: f.identityTokens, ...over,
  };
}

/** Docs `e0..e{n-1}`; doc i lives on axis i (token `zzw{i}`). */
export function axisCorpus(root: string, n = 6): CorpusDoc[] {
  return Array.from({ length: n }, (_, i) => mkDoc(root, `e${i}`, `zzw${i} filler words about the number ${i}`));
}

/** A symlink child pointing outside the vault: `outside_root`. */
export function linkedDoc(root: string, outsideDir: string, slug: string, body: string): CorpusDoc {
  mkdirSync(outsideDir, { recursive: true });
  const real = join(outsideDir, `${slug}.md`);
  writeFileSync(real, body);
  mkdirSync(join(root, 'knowledge'), { recursive: true });
  const link = join(root, 'knowledge', `${slug}.md`);
  symlinkSync(real, link);
  return mkDoc(root, `${slug}-meta`, body, 'knowledge', { path: link });
}

/** One-hot unit vector on the axis named by the first `zzwN` token (axis 1000 when none). */
export function axisVector(text: string): number[] {
  const m = /zzw(\d+)/.exec(text);
  const axis = m ? Number(m[1]) % VOYAGE_DIMS : 1000;
  return Array.from({ length: VOYAGE_DIMS }, (_x, k) => (k === axis ? 1 : 0));
}

export interface Call { url: string; body: Record<string, unknown> }

export interface FakeOptions {
  /** Relevance of a rerank document (default: documents mentioning zzw5 win). */
  relevance?: (doc: string, i: number) => number;
  /** Respond to `/embeddings` with this status instead of 200 (the index build is unaffected: it runs before). */
  embedStatus?: number;
  /** Respond to `/rerank` with this status. */
  rerankStatus?: number;
  /** Reject the fetch itself (network down). */
  reject?: boolean;
  /** Never settle until aborted (a timeout). */
  hang?: boolean;
}

/** A fake OpenRouter. `calls` records every request that reached it. */
export function fakeOpenRouter(o: FakeOptions = {}): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = async (url: unknown, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({ url: String(url), body });
    if (o.hang) {
      return new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
      });
    }
    if (o.reject) throw new TypeError('fetch failed');
    if (String(url).endsWith('/rerank')) {
      if (o.rerankStatus && o.rerankStatus !== 200) return new Response('{}', { status: o.rerankStatus });
      const docs = body.documents as string[];
      const rel = o.relevance ?? ((d: string) => (d.includes('zzw5') ? 0.9 : 0.1));
      const results = docs.map((d, index) => ({ index, relevance_score: rel(d, index) }));
      return new Response(JSON.stringify({ results, usage: { cost: 0.0001 } }), { status: 200 });
    }
    if (o.embedStatus && o.embedStatus !== 200) return new Response('{}', { status: o.embedStatus });
    const input = body.input as string[];
    const data = input.map((t, index) => ({ index, embedding: axisVector(t) }));
    return new Response(JSON.stringify({ data, usage: { cost: 0.00001, prompt_tokens: input.length } }), { status: 200 });
  };
  return { fetch: vi.fn(impl) as unknown as typeof fetch, calls };
}

/** Key + consent + a REAL voyage-4 index of `docs`, built through egress with an embed-only fake. */
export async function consentAndIndex(
  env: Env,
  docs: CorpusDoc[],
  tier: CloudTier,
  rerankModel: RerankModel | null = null,
): Promise<void> {
  setRecallCloudKey(KEY, 'manual', env.home);
  grantVaultConsent(env.root, { tier, rerankModel, surface: 'cli-tty' }, env.home);
  vi.stubGlobal('fetch', fakeOpenRouter().fetch);
  const r = await buildCloudIndex(env.root, 'voyage-4', docs, { trigger: 'explicit', home: env.home, retryDelayMs: 0 });
  if (r.aborted !== null) throw new Error(`fixture index build aborted: ${r.aborted}`);
}
