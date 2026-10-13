import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { docKey, type CorpusDoc } from '../../src/lib/recall.js';
import {
  BREAKER_PAUSE_MS, BREAKER_STEPS_MS, RERANK_TIMEOUT_MS, STRIKE_WINDOW_MS,
  applyDenseQuota, breakerOpen, cloudWarmAt, hybridSearch, markCloudWarm, rerankBackoffOpen, tripBreaker, tripRerankBackoff,
  type RecallTiming,
} from '../../src/lib/embeddings/hybrid.js';
import { FUSION_BY_TIER } from '../../src/lib/embeddings/fusion-config.js';
import { VOYAGE_DIMS } from '../../src/lib/embeddings/nano.js';
import { buildCloudIndex } from '../../src/lib/embeddings/vector-store.js';
import { refreshEmbeddings } from '../../src/lib/embeddings/store.js';
import { grantVaultConsent, setRecallCloudKey, todayQueryCount } from '../../src/lib/recall-cloud-config.js';
import { detectTextLang } from '../../src/lib/text-lang.js';
import { WARM_CLAIM_MS, WARM_TTL_MS, cloudWarmSkipReason, spawnCloudWarmup, warmCloudRecall } from '../../src/lib/recall-cloud-warmup.js';
import { writeSleepState, readSleepState } from '../../src/cli/commands/sleep.js';
import { searchCurrentVault } from '../../src/cli/commands/memory.js';
import { hybridHeaderLabel } from '../../src/cli/commands/hook.js';
import { KEY, mkDoc, setupEnv, teardownEnv, type Env } from './_hybrid-fixture.js';

const E5_DIMS = 64;
vi.mock('../../src/lib/embeddings/embedder.js', () => ({
  EMBED_MODEL: 'test-model',
  EMBED_DIMS: 64,
  embeddingsAvailable: vi.fn(async () => true),
  embedPassages: vi.fn(),
  embedQuery: vi.fn(),
  isEmbedModelDownloaded: vi.fn(() => false),
}));
import { embedQuery, isEmbedModelDownloaded } from '../../src/lib/embeddings/embedder.js';

/**
 * Cross-lingual recall, end to end over a synthetic vault (fictional docs, per the synthetic-fixtures rule).
 * The fake embedder knows CONCEPTS, not words: a Turkish and an English phrase for the same concept land on
 * the same axis, everything else on an axis of its own. Each target doc is written in one language and its
 * query in the other, and five same-language distractors per query share every query word except the
 * concept: BM25 ranks the distractors first, only the dense channel can find the target.
 */
const CONCEPTS: Array<{ axis: number; phrases: string[] }> = [
  { axis: 11, phrases: ['lookup key', 'arama anahtar'] },
  { axis: 12, phrases: ['circuit breaker', 'devre kesici'] },
  { axis: 13, phrases: ['dark mode', 'karanlık tema'] },
  { axis: 14, phrases: ['backup', 'yedekleme'] },
  { axis: 15, phrases: ['notification chime', 'bildirim sesi'] },
  { axis: 16, phrases: ['date format', 'tarih biçim'] },
  { axis: 17, phrases: ['onboarding quiz', 'karşılama test'] },
  { axis: 18, phrases: ['voice key', 'ses anahtar'] },
  { axis: 19, phrases: ['weekly summary', 'haftalık özet'] },
  { axis: 20, phrases: ['payment receipt', 'ödeme makbuz'] },
];

function conceptAxis(text: string): number | null {
  const t = text.toLowerCase();
  return CONCEPTS.find((c) => c.phrases.some((p) => t.includes(p)))?.axis ?? null;
}

let noiseAxis = 100;
const noise = new Map<string, number>();
/** One-hot on the text's concept axis; a concept-free text gets its own stable axis (orthogonal to every query). */
function conceptVector(text: string, dims: number): Float32Array {
  const stripped = text.replace(/^(query|passage): /, '');
  let axis = conceptAxis(stripped);
  if (axis === null) {
    if (!noise.has(stripped)) noise.set(stripped, noiseAxis++);
    axis = noise.get(stripped)!;
  }
  const v = new Float32Array(dims);
  v[axis % dims] = 1;
  return v;
}

interface Pair { slug: string; doc: string; query: string; conceptInQuery: string; dir: 'tr→en' | 'en→tr' }

const PAIRS: Pair[] = [
  // Turkish query → English doc
  { dir: 'tr→en', slug: 'stripe-lookup-key-trap', conceptInQuery: 'arama anahtarı',
    doc: '# Stripe lookup key trap\nWhen you create a price, the lookup key is not filled in automatically. Set it yourself or the checkout cannot find the price.',
    query: 'Stripe fiyat oluştururken arama anahtarı otomatik dolmuyor tuzağı' },
  { dir: 'tr→en', slug: 'breaker-pause', conceptInQuery: 'devre kesici',
    doc: '# Why the circuit breaker pauses\nAfter a cloud failure the circuit breaker pauses calls, so a dead provider does not slow down every prompt.',
    query: 'bulut hatasından sonra devre kesici neden beş dakika kilitliyor' },
  { dir: 'tr→en', slug: 'dark-mode-persistence', conceptInQuery: 'karanlık tema',
    doc: '# Dark mode persistence\nThe dark mode preference was lost when the app restarted, because it was kept in memory only.',
    query: 'karanlık tema ayarı uygulama yeniden açılınca kayboluyor' },
  { dir: 'tr→en', slug: 'backup-retention', conceptInQuery: 'yedekleme',
    doc: '# Backup retention\nEvery backup is written to the backups folder and pruned after thirty days.',
    query: 'yedekleme dosyaları nerede tutuluyor ve ne zaman siliniyor' },
  { dir: 'tr→en', slug: 'quiet-hours-chime', conceptInQuery: 'bildirim sesi',
    doc: '# The notification chime during quiet hours\nThe notification chime still played in quiet hours because the mute flag was read before the schedule.',
    query: 'bildirim sesi gece modunda neden hâlâ çalıyor' },
  // English query → Turkish doc
  { dir: 'en→tr', slug: 'fatura-tarih-bicimi', conceptInQuery: 'date format',
    doc: '# Fatura dışa aktarımında tarih biçimi\nFatura dışa aktarımı gün ve ayı ters yazıyor, çünkü tarih biçimi sistem dilinden okunuyor.',
    query: 'why does the invoice export use the wrong date format' },
  { dir: 'en→tr', slug: 'karsilama-testi-puanlama', conceptInQuery: 'onboarding quiz',
    doc: '# Karşılama testinin puanlaması\nKarşılama testi her cevaba bir ağırlık veriyor ve toplamı yüzdeye çeviriyor.',
    query: 'how is the onboarding quiz scored for a new user' },
  { dir: 'en→tr', slug: 'ses-anahtari-kopyalama', conceptInQuery: 'voice key',
    doc: '# Ses anahtarının kopyalanması\nSes anahtarı kopyalanınca geri çağırma için ayrı bir kayıt açılıyor, eski anahtar silinmiyor.',
    query: 'what happens to the voice key when it is copied' },
  { dir: 'en→tr', slug: 'haftalik-ozet-epostasi', conceptInQuery: 'weekly summary',
    doc: '# Haftalık özet e-postası\nHaftalık özet iki kez gidiyor, çünkü zamanlayıcı iki ayrı süreçte çalışıyor.',
    query: 'why is the weekly summary email sent twice' },
  { dir: 'en→tr', slug: 'odeme-makbuzlari', conceptInQuery: 'payment receipt',
    doc: '# Ödeme makbuzları\nÖdeme makbuzları her ay ayrı bir klasörde tutuluyor ve muhasebeye gönderiliyor.',
    query: 'where are the payment receipts stored and when are they deleted' },
];

const NEUTRAL: Record<'tr' | 'en', string[]> = {
  tr: ['kupon kodu', 'para birimi', 'vergi oranı', 'indirim alanı', 'fatura notu'],
  en: ['coupon code', 'currency column', 'tax rate', 'discount field', 'invoice note'],
};

/**
 * Five same-language distractors per query: each shares half of the query's other words (alternating), plus
 * a neutral phrase. Enough lexical overlap that BM25 ranks them all above the target, which shares none.
 */
function buildCorpus(root: string): CorpusDoc[] {
  const docs: CorpusDoc[] = [];
  PAIRS.forEach((p, pi) => {
    docs.push(mkDoc(root, p.slug, p.doc));
    const qLang = p.dir === 'tr→en' ? 'tr' : 'en';
    const rest = p.query.replace(p.conceptInQuery, ' ').split(/\s+/).filter(Boolean);
    NEUTRAL[qLang].forEach((n, i) => {
      const half = rest.filter((_w, j) => (j + i) % 2 === 0).join(' ');
      // (the slug reaches the reranker, so it must not carry the concept)
      docs.push(mkDoc(root, `noise-${pi}-${i}`, `# ${n} ${half}\n${half} ${n}.`));
    });
  });
  return docs;
}

/** A fake OpenRouter that embeds by concept and reranks by concept match; `rerankHang` never answers a rerank. */
function conceptOpenRouter(o: { rerankHang?: boolean; embedReject?: boolean } = {}): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const impl = async (url: unknown, init?: RequestInit): Promise<Response> => {
    urls.push(String(url));
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    if (String(url).endsWith('/rerank')) {
      if (o.rerankHang) {
        return new Promise<Response>((_res, rej) => { init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))); });
      }
      const q = conceptAxis(String(body.query));
      const results = (body.documents as string[]).map((d, index) => ({ index, relevance_score: q !== null && conceptAxis(d) === q ? 0.95 : 0.05 }));
      return new Response(JSON.stringify({ results, usage: { cost: 0.0001 } }), { status: 200 });
    }
    if (o.embedReject && body.input_type === 'query') throw new TypeError('fetch failed');
    const input = body.input as string[];
    const data = input.map((t, index) => ({ index, embedding: Array.from(conceptVector(t, VOYAGE_DIMS)) }));
    return new Response(JSON.stringify({ data, usage: { cost: 0.00001, prompt_tokens: input.length } }), { status: 200 });
  };
  return { fetch: vi.fn(impl) as unknown as typeof fetch, urls };
}

let env: Env;
let corpus: CorpusDoc[];
const timing = (): RecallTiming => ({ tier: 'local', querySource: 'none', fallback: 'none' });
const keys = (hits: Array<{ doc: CorpusDoc }>): string[] => hits.map((h) => docKey(h.doc));
const healthPath = (): string => join(env.home, '.dreamcontext', 'recall-cloud-health.json');

async function consentCloud(): Promise<void> {
  setRecallCloudKey(KEY, 'manual', env.home);
  grantVaultConsent(env.root, { tier: 'cloud', rerankModel: 'voyageai/rerank-2.5-lite', surface: 'cli-tty' }, env.home);
  vi.stubGlobal('fetch', conceptOpenRouter().fetch);
  const r = await buildCloudIndex(env.root, 'voyage-4', corpus, { trigger: 'explicit', home: env.home, retryDelayMs: 0 });
  if (r.aborted !== null) throw new Error(`index build aborted: ${r.aborted}`);
}

beforeEach(async () => {
  env = setupEnv('dc-xling');
  corpus = buildCorpus(env.root);
  vi.mocked(isEmbedModelDownloaded).mockReturnValue(false);
  vi.mocked(embedQuery).mockReset();
  await consentCloud();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  teardownEnv(env);
});

describe('the fixture is what it claims', () => {
  it('every query is in the other language than its target, and BM25 alone misses every target', async () => {
    const { bm25Search } = await import('../../src/lib/recall.js');
    for (const p of PAIRS) {
      const [q, d] = p.dir === 'tr→en' ? ['tr', 'en'] : ['en', 'tr'];
      expect(detectTextLang(p.query), p.query).toBe(q);
      expect(detectTextLang(p.doc), p.slug).toBe(d);
      if (p.slug !== 'stripe-lookup-key-trap') {
        // ("Stripe" is the one word a query shares with its target, as in the field report)
        expect(keys(bm25Search(p.query, corpus, 5)), p.slug).not.toContain(`knowledge/${p.slug}`);
      }
    }
  });
});

describe('detectTextLang', () => {
  it.each([
    ['her account settings are lost after an update', 'en'],
    ['what happens once the breaker trips', 'en'],
    ['var x = 1; the value is never read', 'en'],
    ['bu ayar her açılışta neden sıfırlanıyor', 'tr'],
    ['nasil calisiyor bu ozellik', 'tr'],
    ['upsertSection', 'unknown'],
  ])('%s → %s', (text, lang) => {
    expect(detectTextLang(text)).toBe(lang);
  });
});

describe('cloud tier, warm provider: 5 TR→EN and 5 EN→TR pairs', () => {
  it.each(PAIRS.map((p) => [p.dir, p.slug, p] as const))('%s %s: the target is in the top 5, reranked', async (_d, slug, p) => {
    vi.stubGlobal('fetch', conceptOpenRouter().fetch);
    const t = timing();
    const hits = await hybridSearch(p.query, corpus, env.root, 5, { tier: 'cloud', home: env.home, timing: t });
    expect(t).toMatchObject({ tier: 'cloud', querySource: 'api', fallback: 'none' });
    expect(keys(hits)).toContain(`knowledge/${slug}`);
    expect(hybridHeaderLabel(t)).toBe('Hybrid · cloud');
  });
});

describe('cloud tier, cold provider: the rerank misses its budget', () => {
  it.each(PAIRS.map((p) => [p.dir, p.slug, p] as const))('%s %s: the cloud vector order serves, no breaker is written', async (_d, slug, p) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fake = conceptOpenRouter({ rerankHang: true });
    vi.stubGlobal('fetch', fake.fetch);
    const t = timing();
    const pending = hybridSearch(p.query, corpus, env.root, 5, { tier: 'cloud', home: env.home, timing: t });
    await vi.advanceTimersByTimeAsync(RERANK_TIMEOUT_MS + 100);
    const hits = await pending;
    expect(t).toMatchObject({ tier: 'cloud', querySource: 'api', fallback: 'rerank_timeout' });
    expect(keys(hits)).toContain(`knowledge/${slug}`);
    expect(existsSync(healthPath())).toBe(false);
    expect(breakerOpen(env.home)).toBe(false);
    expect(hybridHeaderLabel(t)).toBe('Hybrid · cloud · rerank skipped: timeout');
  });

  it('the next prompt goes to the cloud again, rerank included (one cold rerank pauses nothing)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.stubGlobal('fetch', conceptOpenRouter({ rerankHang: true }).fetch);
    const pending = hybridSearch(PAIRS[0].query, corpus, env.root, 5, { tier: 'cloud', home: env.home, timing: timing() });
    await vi.advanceTimersByTimeAsync(RERANK_TIMEOUT_MS + 100);
    await pending;
    vi.useRealTimers();

    const warm = conceptOpenRouter();
    vi.stubGlobal('fetch', warm.fetch);
    const t = timing();
    const hits = await hybridSearch(PAIRS[0].query, corpus, env.root, 5, { tier: 'cloud', home: env.home, timing: t });
    expect(warm.urls.some((u) => u.endsWith('/embeddings'))).toBe(true);
    expect(warm.urls.some((u) => u.endsWith('/rerank'))).toBe(true);
    expect(t).toMatchObject({ querySource: 'api', fallback: 'none' });
    expect(keys(hits)[0]).toBe(`knowledge/${PAIRS[0].slug}`);
  });

  it('a rerank that keeps failing is skipped for a while, then retried; a success clears it', async () => {
    tripRerankBackoff(env.home);
    expect(rerankBackoffOpen(env.home)).toBe(false); // first strike: no pause
    tripRerankBackoff(env.home);
    expect(rerankBackoffOpen(env.home)).toBe(true); // second consecutive: 30 s
    const fake = conceptOpenRouter();
    vi.stubGlobal('fetch', fake.fetch);
    const t = timing();
    const hits = await hybridSearch(PAIRS[5].query, corpus, env.root, 5, { tier: 'cloud', home: env.home, timing: t });
    expect(fake.urls.some((u) => u.endsWith('/rerank'))).toBe(false);
    expect(t).toMatchObject({ querySource: 'api', fallback: 'rerank_backoff' });
    expect(keys(hits)).toContain(`knowledge/${PAIRS[5].slug}`);
    expect(rerankBackoffOpen(env.home, Date.now() + 30_001)).toBe(false);
  });
});

describe('the query breaker backs off step by step', () => {
  it('one failure pauses 30 s, consecutive ones 60 s, 120 s, then the 5 min cap', () => {
    const t0 = 1_000_000_000_000;
    const pauses: number[] = [];
    let now = t0;
    for (let i = 0; i < 5; i++) {
      tripBreaker('timeout', env.home, now);
      let lo = 0;
      while (breakerOpen(env.home, now + lo + 1000)) lo += 1000;
      pauses.push(lo + 1000);
      now += lo + 1000; // the next failure comes right after the pause ends
    }
    expect(pauses).toEqual([...BREAKER_STEPS_MS, BREAKER_PAUSE_MS]);
  });

  it('failures further apart than the strike window start over at 30 s', () => {
    const t0 = 1_000_000_000_000;
    tripBreaker('timeout', env.home, t0);
    tripBreaker('timeout', env.home, t0 + 31_000);
    tripBreaker('timeout', env.home, t0 + 31_000 + STRIKE_WINDOW_MS + 1);
    const at = t0 + 31_000 + STRIKE_WINDOW_MS + 1;
    expect(breakerOpen(env.home, at + 29_000)).toBe(true);
    expect(breakerOpen(env.home, at + 31_000)).toBe(false);
  });

  it('a single query timeout locks cloud for 30 s, not 5 min, and the next success clears the strikes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.stubGlobal('fetch', vi.fn((_u: unknown, init?: RequestInit) => new Promise<Response>((_r, rej) => {
      init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
    })) as unknown as typeof fetch);
    const t = timing();
    const pending = hybridSearch(PAIRS[0].query, corpus, env.root, 5, { tier: 'cloud', home: env.home, timing: t });
    await vi.advanceTimersByTimeAsync(2000);
    await pending;
    vi.useRealTimers();
    expect(t.fallback).toBe('timeout');
    expect(breakerOpen(env.home)).toBe(true);
    expect(breakerOpen(env.home, Date.now() + 31_000)).toBe(false);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 31_000);
    vi.stubGlobal('fetch', conceptOpenRouter().fetch);
    const later = timing();
    await hybridSearch(PAIRS[0].query, corpus, env.root, 5, { tier: 'cloud', home: env.home, timing: later });
    expect(later.querySource).toBe('api');
    expect(existsSync(healthPath())).toBe(false);
  });
});

describe('local fallback (cloud unavailable): the cross-language dense slot', () => {
  async function warmE5(): Promise<void> {
    vi.mocked(isEmbedModelDownloaded).mockReturnValue(true);
    await refreshEmbeddings(env.root, corpus, async (texts) => texts.map((t) => conceptVector(t, E5_DIMS)));
    vi.mocked(embedQuery).mockImplementation(async (q: string) => conceptVector(q, E5_DIMS));
  }

  it.each(PAIRS.map((p) => [p.dir, p.slug, p] as const))('%s %s: the target reaches the top 5 with the breaker open', async (_d, slug, p) => {
    await warmE5();
    tripBreaker('timeout', env.home);
    const t = timing();
    const hits = await hybridSearch(p.query, corpus, env.root, 5, { tier: 'cloud', home: env.home, timing: t });
    expect(t).toMatchObject({ tier: 'cloud', querySource: 'e5', fallback: 'breaker_open' });
    expect(keys(hits)).toContain(`knowledge/${slug}`);
  });

  it('without the slot the same fusion loses the targets (the slot is what finds them)', async () => {
    await warmE5();
    tripBreaker('timeout', env.home);
    let found = 0;
    for (const p of PAIRS) {
      const hits = await hybridSearch(p.query, corpus, env.root, 5, {
        tier: 'cloud', home: env.home, timing: timing(), fusionParams: { ...FUSION_BY_TIER.local, denseQuota: null },
      });
      if (keys(hits).includes(`knowledge/${p.slug}`)) found++;
    }
    expect(found).toBeLessThan(PAIRS.length);
  });

  it('applyDenseQuota leaves a same-language query alone', () => {
    const byKey = new Map(corpus.map((d) => [docKey(d), d]));
    const order = corpus.map((d) => docKey(d));
    const quota = FUSION_BY_TIER.local.denseQuota;
    // a Turkish distractor gets no slot for a Turkish query; the English target of a Turkish query does
    const trNoise = 'knowledge/noise-4-0'; // a distractor of the Turkish chime query
    expect(applyDenseQuota(order, [{ docKey: trNoise, sim: 1 }], 5, quota, { byKey, query: 'bildirim sesi gece modunda neden çalıyor' })).toBe(order);
    const promoted = applyDenseQuota(order, [{ docKey: 'knowledge/quiet-hours-chime', sim: 1 }], 5, quota, { byKey, query: 'bildirim sesi gece modunda neden çalıyor' });
    expect(promoted.slice(0, 5)).toContain('knowledge/quiet-hours-chime');
    expect(promoted).toHaveLength(order.length);
  });
});

describe('warm-up', () => {
  function hybridMode(): void {
    mkdirSync(join(env.root, 'state'), { recursive: true });
    const s = readSleepState(env.root);
    s.recall_mode = 'hybrid';
    writeSleepState(env.root, s);
  }

  it('runs one query and one rerank off the prompt path, and records the provider as warm', async () => {
    const fake = conceptOpenRouter();
    vi.stubGlobal('fetch', fake.fetch);
    const r = await warmCloudRecall(env.root, { home: env.home, env: {} });
    expect(r.skipped).toBeNull();
    expect(r.timing).toMatchObject({ querySource: 'api', fallback: 'none' });
    expect(fake.urls.filter((u) => u.endsWith('/embeddings'))).toHaveLength(1);
    expect(fake.urls.filter((u) => u.endsWith('/rerank'))).toHaveLength(1);
    expect(cloudWarmAt(env.home)).not.toBeNull();
    // warm now: a second warm-up within the TTL is skipped without a call
    const again = await warmCloudRecall(env.root, { home: env.home, env: {} });
    expect(again.skipped).toBe('warm');
    expect(fake.urls).toHaveLength(2);
  });

  it('a failed warm-up never trips the breaker or the rerank backoff', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.stubGlobal('fetch', conceptOpenRouter({ rerankHang: true }).fetch);
    const pending = warmCloudRecall(env.root, { home: env.home, env: {} });
    await vi.advanceTimersByTimeAsync(20_000);
    const r = await pending;
    expect(r.timing).toMatchObject({ querySource: 'api', fallback: 'rerank_timeout' });
    expect(breakerOpen(env.home)).toBe(false);
    tripRerankBackoff(env.home); // had the warm-up counted, this would be the second strike
    expect(rerankBackoffOpen(env.home)).toBe(false);
  });

  it('a warm-up whose query failed holds the slot for 30 s only, so the next session warms again', async () => {
    vi.stubGlobal('fetch', conceptOpenRouter({ embedReject: true }).fetch);
    const r = await warmCloudRecall(env.root, { home: env.home, env: {} });
    expect(r.timing?.querySource).not.toBe('api');
    expect(breakerOpen(env.home)).toBe(false);
    expect(cloudWarmSkipReason(env.root, { mode: 'hybrid', env: {}, home: env.home })).toBe('warm'); // in-flight claim
    expect(cloudWarmSkipReason(env.root, { mode: 'hybrid', env: {}, home: env.home, now: Date.now() + WARM_CLAIM_MS + 1 })).toBeNull();
  });

  it('spawns a detached child only when a prompt would reach the cloud', () => {
    hybridMode();
    const launched: string[] = [];
    const launch = (_entry: string, cwd: string): void => { launched.push(cwd); };
    expect(spawnCloudWarmup(env.root, 'hybrid', { home: env.home, env: {}, launch, cliEntry: 'cli.js' })).toEqual({ spawned: true, reason: null });
    expect(launched).toEqual([join(env.root, '..')]);
    // the gates
    expect(spawnCloudWarmup(env.root, 'raw', { home: env.home, env: {}, launch, cliEntry: 'cli.js' }).reason).toBe('not_hybrid');
    expect(spawnCloudWarmup(env.root, 'hybrid', { home: env.home, env: { DREAMCONTEXT_SPAWNED: 'develop' }, launch, cliEntry: 'cli.js' }).reason).toBe('not_cloud');
    markCloudWarm(env.home);
    expect(spawnCloudWarmup(env.root, 'hybrid', { home: env.home, env: {}, launch, cliEntry: 'cli.js' }).reason).toBe('warm');
    expect(cloudWarmSkipReason(env.root, { mode: 'hybrid', env: {}, home: env.home, now: Date.now() + WARM_TTL_MS + 1 })).toBeNull();
    tripBreaker('timeout', env.home);
    expect(spawnCloudWarmup(env.root, 'hybrid', { home: env.home, env: {}, launch, cliEntry: 'cli.js' }).reason).toBe('breaker_open');
    expect(launched).toHaveLength(1);
  });
});

describe('`memory recall` serves the current vault on its tier', () => {
  function hybridMode(): void {
    mkdirSync(join(env.root, 'state'), { recursive: true });
    const s = readSleepState(env.root);
    s.recall_mode = 'hybrid';
    writeSleepState(env.root, s);
  }

  it('uses the cloud tier, counts the query, and names the tier', async () => {
    hybridMode();
    vi.stubGlobal('fetch', conceptOpenRouter().fetch);
    const before = todayQueryCount(env.root, env.home);
    const r = await searchCurrentVault(env.root, PAIRS[0].query, corpus, 5, { home: env.home, env: {} });
    expect(r.label).toBe('Hybrid · cloud');
    expect(r.timing).toMatchObject({ tier: 'cloud', querySource: 'api' });
    expect(keys(r.hits)[0]).toBe(`knowledge/${PAIRS[0].slug}`);
    expect(todayQueryCount(env.root, env.home)).toBe(before + 1);
  });

  it('--raw forces BM25: no network, no count', async () => {
    hybridMode();
    const fake = conceptOpenRouter();
    vi.stubGlobal('fetch', fake.fetch);
    const before = todayQueryCount(env.root, env.home);
    const r = await searchCurrentVault(env.root, PAIRS[0].query, corpus, 5, { raw: true, home: env.home, env: {} });
    expect(r.label).toBe('BM25 · raw');
    expect(r.timing).toBeNull();
    expect(fake.urls).toHaveLength(0);
    expect(todayQueryCount(env.root, env.home)).toBe(before);
  });
});
