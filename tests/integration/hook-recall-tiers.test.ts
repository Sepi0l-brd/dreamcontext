import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CorpusDoc, RecallHit } from '../../src/lib/recall.js';
import { buildCorpusCached } from '../../src/lib/recall-corpus-cache.js';
import { resolvePromptTier } from '../../src/lib/recall-cloud-config.js';
import { SPAWNED_ENV } from '../../src/lib/session-origin.js';
import type { RecallTiming } from '../../src/lib/embeddings/hybrid.js';
import {
  RECALL_FULL_RENDER_RANKS,
  RECALL_INJECT_TOP_K,
  recallGatePasses,
  recallTimingLine,
  renderRecallBlock,
  selectPromptRecall,
} from '../../src/cli/commands/hook.js';
import { cloudFallbackNote, hybridNotReadyNote } from '../../src/cli/commands/memory.js';
import { fullHeaderLabels, headerLabels, parseArgs } from '../../scripts/hook-latency.js';
import { FROZEN_DIR } from '../../eval/harness.js';
import {
  consentAndIndex, fakeOpenRouter, setupEnv, teardownEnv, type Env,
} from '../unit/_hybrid-fixture.js';

// The hook command itself is only reachable through a built dist, which this suite must not need. So it
// drives the pieces the command is made of, in process: the hit selection (`selectPromptRecall`, the very
// function the hook calls), the block renderer, the gate and the timing line. A temp home carries the key,
// the consent and the usage files; the real ~/.dreamcontext is never read or written.

vi.mock('../../src/lib/embeddings/embedder.js', () => ({
  EMBED_MODEL: 'test-model',
  EMBED_DIMS: 4,
  embeddingsAvailable: vi.fn(async () => true),
  embedPassages: vi.fn(),
  embedQuery: vi.fn(),
  isEmbedModelDownloaded: vi.fn(() => false),
}));

let env: Env;

/** Seven knowledge docs; doc i sits on dense axis i and every doc shares the words "recallshared tiers". */
function writeVault(root: string, count = 7): CorpusDoc[] {
  mkdirSync(join(root, 'knowledge'), { recursive: true });
  for (let i = 0; i < count; i++) {
    writeFileSync(
      join(root, 'knowledge', `e${i}.md`),
      `---\nname: e${i}\ndescription: doc number ${i}\ntags: []\n---\nzzw${i} recallshared tiers filler words about the number ${i}\nsecond line of body ${i}\n`,
    );
  }
  return buildCorpusCached(root);
}

const PROMPT = 'recallshared tiers zzw3 filler words about the number';

function hitFor(doc: CorpusDoc, score: number, snippet = ''): RecallHit {
  return { doc, score, rankScore: score, snippet };
}

beforeEach(() => { env = setupEnv('dc-hook-tiers'); });
afterEach(() => { vi.unstubAllGlobals(); teardownEnv(env); });

describe('K=5 rendering', () => {
  it('prints ranks 1-3 in full and ranks 4-5 as one line each', () => {
    const corpus = writeVault(env.root);
    const hits = corpus.slice(0, 5).map((d, i) => hitFor(d, 3 - i * 0.1, `why ${i}`));
    const lines = renderRecallBlock(hits, 'BM25');

    expect(lines[1]).toBe('— Memory recall (BM25, top 5) —');
    const body = lines.slice(2);
    // Ranks 1-3: path, Why and the excerpt (three lines each).
    for (let i = 0; i < RECALL_FULL_RENDER_RANKS; i++) {
      expect(body[i * 3]).toBe(`  [knowledge] ${hits[i].doc.relPath}`);
      expect(body[i * 3 + 1]).toBe(`    Why: why ${i}`);
      expect(body[i * 3 + 2]).toMatch(/^ {4}> zzw\d recallshared/);
    }
    // Ranks 4-5: exactly one line each, `[type] relPath — title`, no Why and no excerpt.
    expect(body).toHaveLength(RECALL_FULL_RENDER_RANKS * 3 + 2);
    expect(body[9]).toBe(`  [knowledge] ${hits[3].doc.relPath} — ${hits[3].doc.title}`);
    expect(body[10]).toBe(`  [knowledge] ${hits[4].doc.relPath} — ${hits[4].doc.title}`);
  });

  it('keeps the insight read directive at any rank, including a one-line rank', () => {
    const corpus = writeVault(env.root);
    const asInsight = (d: CorpusDoc): CorpusDoc => ({ ...d, type: 'insight', relPath: `lab/insights/${d.slug}.md` });
    const hits = [
      hitFor(asInsight(corpus[0]), 3), hitFor(corpus[1], 2.9), hitFor(corpus[2], 2.8), hitFor(corpus[3], 2.7), hitFor(asInsight(corpus[4]), 2.6),
    ];
    const text = renderRecallBlock(hits, 'BM25').join('\n');
    expect(text).toContain('→ ALREADY TRACKED as an insight: `dreamcontext lab show e0`');
    expect(text).toContain('→ ALREADY TRACKED as an insight: `dreamcontext lab show e4`');
    // the rank-5 insight is a one-line entry followed by its directive
    const lines = renderRecallBlock(hits, 'BM25');
    const at = lines.indexOf(`  [insight] lab/insights/e4.md — e4`);
    expect(at).toBeGreaterThan(0);
    expect(lines[at + 1]).toContain('lab show e4');
  });

  it('a block with fewer hits than K reports the real count', () => {
    const corpus = writeVault(env.root);
    expect(renderRecallBlock([hitFor(corpus[0], 3)], 'Haiku')[1]).toBe('— Memory recall (Haiku, top 1) —');
  });
});

describe('the gate', () => {
  it('threshold is unchanged: raw score >= 2.0 over the printed hits', () => {
    const corpus = writeVault(env.root);
    const at = (score: number): RecallHit[] => [hitFor(corpus[0], score)];
    expect(recallGatePasses(at(1.99), false)).toBe(false);
    expect(recallGatePasses(at(2.0), false)).toBe(true);
    expect(recallGatePasses([], false)).toBe(false);
    expect(recallGatePasses([], true)).toBe(false);
  });

  it('the window is the printed hits: a strong raw hit at rank 5 injects, which K=3 never saw', () => {
    const corpus = writeVault(env.root);
    const hits = corpus.slice(0, RECALL_INJECT_TOP_K).map((d, i) => hitFor(d, i === 4 ? 2.4 : 0.4));
    expect(recallGatePasses(hits, false)).toBe(true);
    expect(recallGatePasses(hits.slice(0, 3), false)).toBe(false);
  });

  it('Haiku hits inject regardless of the raw score', () => {
    const corpus = writeVault(env.root);
    expect(recallGatePasses([hitFor(corpus[0], 0)], true)).toBe(true);
  });
});

describe('hit selection by mode', () => {
  it('raw mode asks for the top 5 and labels it BM25', async () => {
    writeVault(env.root);
    const fake = fakeOpenRouter();
    vi.stubGlobal('fetch', fake.fetch);
    const r = await selectPromptRecall(PROMPT, env.root, 'raw', { env: {}, home: env.home });
    expect(r.label).toBe('BM25');
    expect(r.haiku).toBe(false);
    expect(r.timing).toBeNull();
    expect(r.hits).toHaveLength(RECALL_INJECT_TOP_K);
    expect(fake.calls).toHaveLength(0);
  });

  it('Haiku mode stays at 3, and its BM25 fallback stays at 3', async () => {
    const corpus = writeVault(env.root);
    const picked = corpus.slice(0, 3).map((d) => hitFor(d, 0, 'reason'));
    const ok = await selectPromptRecall(PROMPT, env.root, 'haiku', { env: {}, home: env.home, haiku: () => picked });
    expect(ok).toMatchObject({ label: 'Haiku', haiku: true });
    expect(ok.hits).toHaveLength(3);

    const failed = await selectPromptRecall(PROMPT, env.root, 'haiku', { env: {}, home: env.home, haiku: () => null });
    expect(failed.label).toBe('BM25');
    expect(failed.hits).toHaveLength(3);

    const skipped = await selectPromptRecall(PROMPT, env.root, 'haiku', { env: {}, home: env.home, haiku: () => 'skip' });
    expect(skipped.hits).toEqual([]);
  });
});

describe('tier resolution', () => {
  it('resolves the vault tier and the cloud hybrid answers: header names the effective tier, timing is filled', async () => {
    const corpus = writeVault(env.root);
    await consentAndIndex(env, corpus, 'cloud');
    expect(resolvePromptTier(env.root, {}, env.home)).toEqual({ tier: 'cloud', downgraded: null });

    const fake = fakeOpenRouter();
    vi.stubGlobal('fetch', fake.fetch);
    const r = await selectPromptRecall(PROMPT, env.root, 'hybrid', { env: {}, home: env.home });

    expect(r.label).toBe('Hybrid · cloud');
    expect(r.timing).toMatchObject({ tier: 'cloud', querySource: 'api' });
    expect(typeof r.timing?.corpusMs).toBe('number');
    expect(r.hits).toHaveLength(RECALL_INJECT_TOP_K);
    expect(fake.calls.filter((c) => c.url.endsWith('/embeddings'))).toHaveLength(1);
    // the injected block carries the effective tier in its header
    expect(renderRecallBlock(r.hits, r.label)[1]).toBe('— Memory recall (Hybrid · cloud, top 5) —');
  });

  it('a consented rerank model reaches the rerank call', async () => {
    const corpus = writeVault(env.root);
    await consentAndIndex(env, corpus, 'cloud', 'voyageai/rerank-2.5-lite');
    const fake = fakeOpenRouter();
    vi.stubGlobal('fetch', fake.fetch);
    const r = await selectPromptRecall(PROMPT, env.root, 'hybrid', { env: {}, home: env.home });
    expect(r.label).toBe('Hybrid · cloud');
    const rerank = fake.calls.filter((c) => c.url.endsWith('/rerank'));
    expect(rerank).toHaveLength(1);
    expect(rerank[0].body).toMatchObject({ model: 'voyageai/rerank-2.5-lite', provider: { data_collection: 'deny' } });
  });

  it('DREAMCONTEXT_RECALL_TIER=local forces local: BM25 and zero fetches while local hybrid is not ready', async () => {
    const corpus = writeVault(env.root);
    await consentAndIndex(env, corpus, 'cloud');
    const fake = fakeOpenRouter();
    vi.stubGlobal('fetch', fake.fetch);
    const r = await selectPromptRecall(PROMPT, env.root, 'hybrid', { env: { DREAMCONTEXT_RECALL_TIER: 'local' }, home: env.home });
    expect(r.label).toBe('BM25');
    expect(fake.calls).toHaveLength(0);
  });

  it('a spawned session never reaches the cloud', async () => {
    const corpus = writeVault(env.root);
    await consentAndIndex(env, corpus, 'cloud');
    const fake = fakeOpenRouter();
    vi.stubGlobal('fetch', fake.fetch);
    const spawned = { [SPAWNED_ENV]: 'goal-skill' };
    expect(resolvePromptTier(env.root, spawned, env.home)).toEqual({ tier: 'local', downgraded: 'spawned_session' });
    const r = await selectPromptRecall(PROMPT, env.root, 'hybrid', { env: spawned, home: env.home });
    expect(r.label).toBe('BM25');
    expect(fake.calls).toHaveLength(0);
  });

  it('cloud-index without the nano model on disk is not ready: BM25, zero fetches', async () => {
    const corpus = writeVault(env.root);
    await consentAndIndex(env, corpus, 'cloud-index');
    const fake = fakeOpenRouter();
    vi.stubGlobal('fetch', fake.fetch);
    const r = await selectPromptRecall(PROMPT, env.root, 'hybrid', { env: {}, home: env.home });
    expect(r.label).toBe('BM25');
    expect(fake.calls).toHaveLength(0);
  });
});

describe('a vault without consent', () => {
  it('makes zero fetches in every mode, even with a recall key on the machine', async () => {
    writeVault(env.root);
    const { setRecallCloudKey } = await import('../../src/lib/recall-cloud-config.js');
    setRecallCloudKey('or-test-key-0123456789', 'manual', env.home);
    const fake = fakeOpenRouter();
    vi.stubGlobal('fetch', fake.fetch);

    for (const mode of ['raw', 'hybrid'] as const) {
      const r = await selectPromptRecall(PROMPT, env.root, mode, { env: {}, home: env.home });
      expect(r.label).toBe('BM25');
      expect(r.hits.length).toBeGreaterThan(0);
    }
    const noHaiku = await selectPromptRecall(PROMPT, env.root, 'haiku', { env: {}, home: env.home, haiku: () => null });
    expect(noHaiku.label).toBe('BM25');
    expect(fake.calls).toHaveLength(0);
    expect(fake.fetch).not.toHaveBeenCalled();
  });
});

describe('DREAMCONTEXT_RECALL_TIMING', () => {
  const timing: RecallTiming = { tier: 'cloud', querySource: 'api', fallback: 'none', corpusMs: 12, bm25Ms: 34, queryMs: 56 };

  it('prints the timing object as ONE JSON line when the flag is 1', () => {
    const line = recallTimingLine(timing, { DREAMCONTEXT_RECALL_TIMING: '1' });
    expect(line).not.toBeNull();
    expect(line).not.toContain('\n');
    expect(JSON.parse(line!)).toEqual(timing);
  });

  it('prints nothing without the flag, or without a hybrid timing', () => {
    expect(recallTimingLine(timing, {})).toBeNull();
    expect(recallTimingLine(timing, { DREAMCONTEXT_RECALL_TIMING: '0' })).toBeNull();
    expect(recallTimingLine(null, { DREAMCONTEXT_RECALL_TIMING: '1' })).toBeNull();
  });
});

describe('memory recall notes', () => {
  it('no cloud consent: the local warm-up hint only', () => {
    writeVault(env.root);
    const resolved = resolvePromptTier(env.root, {}, env.home);
    expect(hybridNotReadyNote(env.root, resolved, env.home)).toContain('dreamcontext embed refresh');
    expect(hybridNotReadyNote(env.root, resolved, env.home)).not.toContain('cloud');
  });

  it('a cloud tier with no index says so, and a spawned session says why it went local', async () => {
    const { grantVaultConsent, setRecallCloudKey } = await import('../../src/lib/recall-cloud-config.js');
    writeVault(env.root);
    setRecallCloudKey('or-test-key-0123456789', 'manual', env.home);
    grantVaultConsent(env.root, { tier: 'cloud', rerankModel: null, surface: 'cli-tty' }, env.home);

    const resolved = resolvePromptTier(env.root, {}, env.home);
    expect(resolved.tier).toBe('cloud');
    expect(hybridNotReadyNote(env.root, resolved, env.home)).toContain('index is not built yet');

    const spawned = resolvePromptTier(env.root, { [SPAWNED_ENV]: 'peer' }, env.home);
    expect(hybridNotReadyNote(env.root, spawned, env.home)).toContain('spawned session');
  });

  it('names the cloud fallback only when a cloud tier fell back', () => {
    expect(cloudFallbackNote({ tier: 'local', querySource: 'none', fallback: 'no_local_model' })).toBeNull();
    expect(cloudFallbackNote({ tier: 'cloud', querySource: 'api', fallback: 'none' })).toBeNull();
    expect(cloudFallbackNote({ tier: 'cloud', querySource: 'e5', fallback: 'breaker_open' })).toBe('cloud recall: breaker open — served by local e5.');
  });
});

describe('hook-latency --tier', () => {
  const root = join(FROZEN_DIR, 'dc-test-snapshot', '_dream_context');
  const base = ['--root', root, '--prompts', 'g.jsonl'];

  it('defaults to local and accepts the three tiers in hybrid mode', () => {
    expect(parseArgs([...base]).tier).toBe('local');
    expect(parseArgs([...base, '--mode', 'hybrid', '--tier', 'cloud-index']).tier).toBe('cloud-index');
    expect(parseArgs([...base, '--mode', 'hybrid', '--tier', 'cloud']).tier).toBe('cloud');
  });

  it('refuses a bad tier, a cloud tier outside hybrid mode, and a cloud tier with an empty HOME', () => {
    expect(() => parseArgs([...base, '--mode', 'hybrid', '--tier', 'galaxy'])).toThrow(/--tier/);
    expect(() => parseArgs([...base, '--mode', 'raw', '--tier', 'cloud'])).toThrow(/--mode hybrid/);
    expect(() => parseArgs([...base, '--tier', 'cloud', '--no-model'])).toThrow(/--no-model/);
  });

  it('reads the full tiered header label as well as the short one', () => {
    const out = '— Memory recall (Hybrid · cloud-index, top 5) —\nx';
    expect(fullHeaderLabels(out)).toEqual(['Hybrid · cloud-index']);
    expect(headerLabels(out)).toEqual(['Hybrid']);
  });
});
