import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { freezeCorpus, isExcluded, FreezeError } from '../../scripts/eval-freeze-corpus.js';
import { candidatePool, legacyTargets, sampleAll, sampleTargets, writeSamples } from '../../scripts/gold-v2-sample.js';
import { checkGold } from '../../scripts/gold-v2-check.js';
import {
  SNAPSHOT_ID, SPLIT_QUOTAS, assertUnderFrozen, corpusFingerprint, goldId, sealedDir, sha256, snapshotDir,
  splitSize, stableCorpusForGold, t1FrozenDir, validateGoldLine, verifyFrozenHashes, T1_CLOUD_TYPES,
  type GoldQueryV2,
} from '../../scripts/gold-v2-lib.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');

let home: string;
let src: string;

function doc(path: string, name: string, n: number, updated: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const body = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} of ${name} covers topic${n} detail${i} alpha${n * 7 + i}.`).join('\n');
  writeFileSync(path, `---\nname: ${name}\ndescription: about ${name}\nupdated: '${updated}'\n---\n${body}\n`);
}

/** Tiny fixture vault: enough unique docs to fill the quotas of one split x language. */
function buildFixtureVault(root: string): void {
  for (let i = 0; i < 70; i++) doc(join(root, 'knowledge', `know-${i}.md`), `Knowledge number ${i}`, i, `2026-0${1 + (i % 9)}-15`);
  for (let i = 0; i < 40; i++) doc(join(root, 'knowledge', 'features', `feat-${i}.md`), `Feature number ${i}`, 100 + i, `2026-0${1 + (i % 9)}-10`);
  for (let i = 0; i < 70; i++) doc(join(root, 'state', `task-${i}.md`), `Task number ${i}`, 200 + i, `2026-0${1 + (i % 9)}-05`);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gold-v2-home-'));
  mkdirSync(t1FrozenDir(home), { recursive: true });
  src = join(mkdtempSync(join(tmpdir(), 'gold-v2-src-')), '_dream_context');
  buildFixtureVault(src);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(dirname(src), { recursive: true, force: true });
});

describe('gold-v2-lib', () => {
  it('quotas add up to 30 / 25 / 20 per language', () => {
    expect(splitSize('train')).toBe(30);
    expect(splitSize('heldout')).toBe(25);
    expect(splitSize('reserve')).toBe(20);
  });

  it('frozen dir is injectable and assertUnderFrozen fails closed', () => {
    expect(t1FrozenDir('/h')).toBe('/h/.dreamcontext/eval-frozen');
    expect(() => assertUnderFrozen(join(tmpdir(), 'elsewhere'), home)).toThrow();
    expect(() => assertUnderFrozen(t1FrozenDir(home), home)).toThrow(); // the dir itself does not count
    expect(() => assertUnderFrozen(join(t1FrozenDir(home), 'x', 'y'), home)).not.toThrow();
    const evil = join(home, '.dreamcontext', 'eval-frozen-evil');
    mkdirSync(evil, { recursive: true });
    expect(() => assertUnderFrozen(evil, home)).toThrow();
  });

  it('T1_CLOUD_TYPES is the pinned allow-list', () => {
    expect([...T1_CLOUD_TYPES]).toEqual(['knowledge', 'feature', 'task', 'objective', 'thesis', 'whiteboard', 'core', 'memory']);
  });

  it('validateGoldLine accepts a good line and names each defect by id', () => {
    const good = { id: 'g2h-tr-001', query: 'bir sorgu metni burada', expected: ['knowledge/a'], category: 'paraphrase', lang: 'tr' };
    expect(validateGoldLine(good, 'heldout')).toEqual([]);
    expect(validateGoldLine({ ...good, id: 'g2t-tr-001' }, 'heldout')).toContain('g2t-tr-001: id_split_mismatch');
    expect(validateGoldLine({ ...good, lang: 'en' }, 'heldout')).toContain('g2h-tr-001: id_lang_mismatch');
    expect(validateGoldLine({ ...good, expected: ['a', 'b'] }, 'heldout')).toContain('g2h-tr-001: expected_must_be_one_key');
    expect(validateGoldLine({ ...good, variant: 'ascii', lang: 'tr' }, 'heldout')).toEqual([]);
    expect(validateGoldLine({ ...good, category: 'nope' }, 'heldout')).toContain('g2h-tr-001: bad_category');
  });
});

describe('freezeCorpus', () => {
  it('copies, excludes private paths, preserves mtimes and writes the marker files', () => {
    mkdirSync(join(src, 'marketing'), { recursive: true });
    writeFileSync(join(src, 'marketing', 'big.md'), 'x');
    mkdirSync(join(src, 'lab'), { recursive: true });
    writeFileSync(join(src, 'lab', 'credentials.json'), '{}');
    writeFileSync(join(src, 'state', '.config.json'), '{}');
    writeFileSync(join(src, 'state', '.brain-local.json'), '{}');
    writeFileSync(join(src, 'knowledge', '.env.local'), 'A=1');
    mkdirSync(join(src, '.embeddings'), { recursive: true });
    writeFileSync(join(src, '.embeddings', 'cache.json'), '{}');
    const stamp = new Date('2026-03-04T05:06:07Z');
    utimesSync(join(src, 'knowledge', 'know-1.md'), stamp, stamp);

    const r = freezeCorpus({ src, home, now: '2026-10-10T12:00:00.000Z' });
    expect(r.dir).toBe(snapshotDir(home));
    expect(existsSync(join(r.contextRoot, 'knowledge', 'know-1.md'))).toBe(true);
    for (const gone of ['marketing', '.embeddings', join('lab', 'credentials.json'), join('state', '.config.json'),
      join('state', '.brain-local.json'), join('knowledge', '.env.local')]) {
      expect(existsSync(join(r.contextRoot, gone))).toBe(false);
    }
    expect(Math.round(statSync(join(r.contextRoot, 'knowledge', 'know-1.md')).mtimeMs / 1000)).toBe(Math.round(stamp.getTime() / 1000));
    expect(readFileSync(join(r.dir, 'now.txt'), 'utf-8').trim()).toBe('2026-10-10T12:00:00.000Z');
    const fp = JSON.parse(readFileSync(join(r.dir, 'FINGERPRINT.json'), 'utf-8'));
    expect(fp.fingerprint).toBe(r.fingerprint);
    expect(fp.docs).toBe(180);
    expect(r.fingerprint).toBe(corpusFingerprint(stableCorpusForGold(src)));
  });

  it('leaves an existing vectors/ sibling alone and refuses an existing snapshot', () => {
    const vectors = join(snapshotDir(home), 'vectors');
    mkdirSync(vectors, { recursive: true });
    writeFileSync(join(vectors, 'keep.json'), '{}');
    freezeCorpus({ src, home });
    expect(readFileSync(join(vectors, 'keep.json'), 'utf-8')).toBe('{}');
    expect(() => freezeCorpus({ src, home })).toThrow(FreezeError);
  });

  it('fails on a symlink and writes no snapshot', () => {
    symlinkSync(join(src, 'knowledge', 'know-1.md'), join(src, 'knowledge', 'link.md'));
    expect(() => freezeCorpus({ src, home })).toThrow(/symlink/);
    expect(existsSync(join(snapshotDir(home), '_dream_context'))).toBe(false);
  });

  it('fails on a symlinked directory pointing outside the source', () => {
    const outside = mkdtempSync(join(tmpdir(), 'gold-v2-outside-'));
    try {
      symlinkSync(outside, join(src, 'knowledge', 'escape'));
      expect(() => freezeCorpus({ src, home })).toThrow(/symlink/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('ignores a symlink that sits inside an excluded directory', () => {
    mkdirSync(join(src, 'marketing'), { recursive: true });
    symlinkSync(join(src, 'knowledge'), join(src, 'marketing', 'loop'));
    expect(() => freezeCorpus({ src, home })).not.toThrow();
  });

  it('isExcluded covers the plan list', () => {
    expect(isExcluded('marketing', true)).toBe(true);
    expect(isExcluded('tmp/a.md', false)).toBe(true);
    expect(isExcluded('knowledge/.recall-cache', true)).toBe(true);
    expect(isExcluded('lab/credentials.json', false)).toBe(true);
    expect(isExcluded('lab/insights/credentials.md', false)).toBe(false);
    expect(isExcluded('state/task.md', false)).toBe(false);
    expect(isExcluded('a/.env', false)).toBe(true);
  });
});

describe('sampler', () => {
  const tiny = { 'exact-term': 2, 'field-match': 1, paraphrase: 2, recency: 2, 'topical-adjacency': 1 } as const;

  it('is deterministic, honours quotas and stratifies across doc types', () => {
    const corpus = stableCorpusForGold(src);
    const a = sampleTargets({ root: src, seed: 1, split: 'train', lang: 'tr', perCategory: tiny, exclude: new Set(), asciiCount: 2, corpus });
    const b = sampleTargets({ root: src, seed: 1, split: 'train', lang: 'tr', perCategory: tiny, exclude: new Set(), asciiCount: 2, corpus });
    const c = sampleTargets({ root: src, seed: 2, split: 'train', lang: 'tr', perCategory: tiny, exclude: new Set(), asciiCount: 2, corpus });
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(a).toHaveLength(8);
    expect(a.filter((t) => t.ascii)).toHaveLength(2);
    expect(new Set(a.map((t) => t.docKey)).size).toBe(8);
    expect(new Set(a.map((t) => t.docKey.split('/')[0])).size).toBeGreaterThan(1);
    expect(sampleTargets({ root: src, seed: 1, split: 'train', lang: 'en', perCategory: tiny, exclude: new Set(), asciiCount: 2, corpus }).some((t) => t.ascii)).toBe(false);
  });

  it('excludes given keys and throws when the pool is exhausted', () => {
    const corpus = stableCorpusForGold(src);
    const pool = candidatePool(corpus).map((d) => `${d.type}/${d.slug}`);
    const exclude = new Set(pool.slice(0, pool.length - 3));
    expect(() => sampleTargets({ root: src, seed: 1, split: 'train', lang: 'en', perCategory: tiny, exclude, corpus })).toThrow(/pool exhausted/);
    const picked = sampleTargets({ root: src, seed: 1, split: 'train', lang: 'en', perCategory: { 'exact-term': 3, 'field-match': 0, paraphrase: 0, recency: 0, 'topical-adjacency': 0 }, exclude, corpus });
    expect(picked.map((t) => t.docKey).sort()).toEqual(pool.slice(pool.length - 3).sort());
  });

  it('sampleAll: every split x language, disjoint, legacy excluded, never overwrites', () => {
    const legacyPath = join(home, 'legacy.jsonl');
    const legacyKeys = ['knowledge/know-0', 'knowledge/know-1', 'task/task-0'];
    writeFileSync(legacyPath, `${JSON.stringify({ id: 'q1', expected: [legacyKeys[0]], alt: [legacyKeys[1]] })}\n${JSON.stringify({ id: 'q2', expected: [legacyKeys[2]] })}\n`);
    const legacy = legacyTargets([legacyPath]);
    expect(legacy.size).toBe(3);

    // 180 fixture docs cannot fill 9 samples of 25/20/30 (225); shrink the quotas through a larger fixture instead.
    for (let i = 70; i < 120; i++) doc(join(src, 'knowledge', `know-${i}.md`), `Knowledge number ${i}`, i, '2026-05-01');
    for (let i = 40; i < 60; i++) doc(join(src, 'knowledge', 'features', `feat-${i}.md`), `Feature number ${i}`, 100 + i, '2026-05-02');
    for (let i = 70; i < 120; i++) doc(join(src, 'state', `task-${i}.md`), `Task number ${i}`, 200 + i, '2026-05-03');
    const files = sampleAll({ root: src, seed: 7, legacy });
    expect(files).toHaveLength(9);
    const all = files.flatMap((f) => f.targets.map((t) => t.docKey));
    expect(all).toHaveLength(3 * (30 + 25 + 20));
    expect(new Set(all).size).toBe(all.length);
    for (const k of legacyKeys) expect(all).not.toContain(k);
    for (const f of files) {
      expect(f.targets).toHaveLength(splitSize(f.split));
      for (const cat of Object.keys(SPLIT_QUOTAS[f.split]) as Array<keyof typeof SPLIT_QUOTAS.train>) {
        expect(f.targets.filter((t) => t.category === cat)).toHaveLength(SPLIT_QUOTAS[f.split][cat]);
      }
    }
    const out = join(home, 'samples');
    expect(writeSamples(files, out)).toHaveLength(9);
    expect(() => writeSamples(files, out)).toThrow(/refusing to overwrite/);
  });
});

describe('checkGold', () => {
  /** Author a perfect gold file for one split from fresh samples (all three languages). */
  function authorSplit(split: 'train', root: string) {
    for (let i = 70; i < 120; i++) doc(join(root, 'knowledge', `know-${i}.md`), `Knowledge number ${i}`, i, '2026-05-01');
    for (let i = 40; i < 60; i++) doc(join(root, 'knowledge', 'features', `feat-${i}.md`), `Feature number ${i}`, 100 + i, '2026-05-02');
    for (let i = 70; i < 120; i++) doc(join(root, 'state', `task-${i}.md`), `Task number ${i}`, 200 + i, '2026-05-03');
    const files = sampleAll({ root, seed: 3, legacy: new Set() });
    const dir = join(home, 'samples');
    writeSamples(files, dir);
    const rows: GoldQueryV2[] = [];
    for (const f of files.filter((x) => x.split === split)) {
      for (const t of f.targets) {
        const accent = f.lang === 'en' || t.ascii ? '' : ' için çözüm';
        rows.push({
          id: goldId(split, f.lang, t.n), query: `how do we handle zzq${t.n}${f.lang} situation${accent}`,
          expected: [t.docKey], category: t.category, lang: f.lang, ...(t.ascii ? { variant: 'ascii' as const } : {}),
        });
      }
    }
    const path = join(home, `${split}.jsonl`);
    writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return { path, dir, rows, corpus: stableCorpusForGold(root) };
  }

  it('passes a perfect file and prints no query text', () => {
    const { path, dir, corpus } = authorSplit('train', src);
    const res = checkGold({ files: { train: path }, corpus, legacy: new Set(), samplesDir: dir });
    expect(res.errors).toEqual([]);
    expect(res.counts.train).toEqual({ tr: 30, en: 30, mixed: 30 });
    expect(res.asciiCounts.train).toBe(4);
    expect(JSON.stringify(res)).not.toContain('situation');
  });

  it('flags missing keys, reuse, legacy targets, overlap, verbatim titles and wrong languages', () => {
    const { path, dir, rows, corpus } = authorSplit('train', src);
    const bad = rows.map((r) => ({ ...r }));
    bad[0].expected = ['knowledge/does-not-exist'];
    bad[1].expected = [bad[2].expected[0]]; // reuse
    const para = bad.find((r) => r.category === 'paraphrase' && r.lang === 'en' && r.expected[0].startsWith('knowledge/'));
    const paraDoc = corpus.find((d) => `${d.type}/${d.slug}` === para?.expected[0]);
    if (para && paraDoc) para.query = `${paraDoc.title} ${paraDoc.slug.replace(/-/g, ' ')} again`;
    const en = bad.find((r) => r.lang === 'en' && r.id !== bad[0].id && r.id !== bad[1].id);
    if (en) en.query = 'bu sorgu çok Türkçe';
    writeFileSync(path, bad.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const legacy = new Set([bad[5].expected[0]]);
    const res = checkGold({ files: { train: path }, corpus, legacy, samplesDir: dir });
    const text = res.errors.join('\n');
    expect(text).toContain(`${bad[0].id}: expected_key_missing_in_snapshot`);
    expect(text).toContain(`${bad[2].id}: target_reused_by_train/${bad[1].id}`); // the later line is the reuser
    expect(text).toContain(`${bad[5].id}: target_is_legacy`);
    expect(text).toMatch(/paraphrase_overlap_|quotes_title_verbatim/);
    if (en) expect(text).toContain(`${en.id}: en_query_has_turkish_chars`);
    expect(text).toContain('expected_differs_from_sample');
  });

  it('flags wrong counts and a missing split file content', () => {
    const { path, corpus } = authorSplit('train', src);
    const lines = readFileSync(path, 'utf-8').trim().split('\n');
    writeFileSync(path, lines.slice(0, 80).join('\n') + '\n');
    const res = checkGold({ files: { train: path }, corpus, legacy: new Set() });
    expect(res.errors.some((e) => /^train\/\w+: count_/.test(e))).toBe(true);
  });
});

describe('verifyFrozenHashes', () => {
  it('skips PENDING and absent files, verifies filled present files, flags mismatches', () => {
    const md = join(home, 'FROZEN.md');
    const train = join(home, 'train.jsonl');
    writeFileSync(train, '{"a":1}\n{"a":2}\n');
    mkdirSync(sealedDir(home), { recursive: true });
    writeFileSync(join(sealedDir(home), 'heldout.jsonl'), '{"h":1}\n');

    writeFileSync(md, '- train.jsonl: sha256=PENDING count=PENDING\n- heldout.jsonl: sha256=PENDING count=PENDING\n- reserve.jsonl: sha256=PENDING count=PENDING\n');
    expect(verifyFrozenHashes({ frozenMdPath: md, trainPath: train, home })).toEqual({ checked: [], skipped: ['train', 'heldout', 'reserve'], mismatches: [] });

    const good = sha256(readFileSync(train));
    writeFileSync(md, `- train.jsonl: sha256=${good} count=2\n- heldout.jsonl: sha256=${'0'.repeat(64)} count=1\n- reserve.jsonl: sha256=${'1'.repeat(64)} count=5\n`);
    const r = verifyFrozenHashes({ frozenMdPath: md, trainPath: train, home });
    expect(r.checked).toEqual(['train', 'heldout']);
    expect(r.skipped).toEqual(['reserve']); // filled but the sealed file is absent
    expect(r.mismatches).toEqual(['heldout: sha256']);
  });

  it('the repo FROZEN.md matches the files that exist (hash checked only when filled and present)', () => {
    const r = verifyFrozenHashes({
      frozenMdPath: join(REPO, 'eval', 'gold-v2', 'FROZEN.md'),
      trainPath: join(REPO, 'eval', 'gold-v2', 'train.jsonl'),
    });
    expect(r.mismatches).toEqual([]);
  });
});
