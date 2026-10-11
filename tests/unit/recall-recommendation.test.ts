import { describe, expect, it } from 'vitest';
import {
  combineMix,
  languageMixOf,
  looksTurkish,
  machineClassOf,
  recommendRecall,
  turkishShareOf,
  turkishShareOfPrompts,
  type RecallSignals,
} from '../../src/lib/recall-recommendation.js';

const GIB = 1024 ** 3;
const BIG: RecallSignals = { turkishShare: null, promptTurkishShare: null, totalMemBytes: 32 * GIB, cpuCount: 10, modelName: null, keyPresent: false };

const TURKISH = 'Kullanıcı ayarlarını değiştirdiğinde panel yeniden yüklenir ve işlem sırasında hiçbir veri dışarı gönderilmez. Öğrenciler için güvenli bir çözüm.';
const ENGLISH = 'When the user changes a setting the dashboard reloads and nothing is sent anywhere while it happens. A safe default for everyone involved here.';

describe('looksTurkish', () => {
  it('reads Turkish text as Turkish and English as not', () => {
    expect(looksTurkish(TURKISH)).toBe(true);
    expect(looksTurkish(ENGLISH)).toBe(false);
  });
  it('declines to judge too little text', () => {
    expect(looksTurkish('çok kısa')).toBeNull();
    expect(looksTurkish('')).toBeNull();
  });
  it('a few Turkish names in English prose do not make it Turkish', () => {
    expect(looksTurkish(`${ENGLISH} Thanks to Çağrı and Şule for reviewing it. ${ENGLISH} ${ENGLISH}`)).toBe(false);
  });
});

describe('turkishShareOf', () => {
  const doc = (body: string) => ({ title: '', description: '', body });
  it('is the share of judged documents, skipping the ones with too little text', () => {
    expect(turkishShareOf([doc(TURKISH), doc(ENGLISH), doc(ENGLISH), doc(ENGLISH), doc('x')])).toBe(0.25);
  });
  it('is null when nothing can be judged', () => {
    expect(turkishShareOf([])).toBeNull();
    expect(turkishShareOf([doc('x')])).toBeNull();
  });
});

describe('turkishShareOfPrompts', () => {
  it('judges short prompts that a document threshold would skip', () => {
    expect(turkishShareOfPrompts(['neden fast keyword önerildi, bunu düzelt', 'why is fast keyword recommended here'])).toBe(0.5);
  });
  it('skips prompts too short to carry a language, and is null when none are left', () => {
    expect(turkishShareOfPrompts(['ok', 'devam'])).toBeNull();
    expect(turkishShareOfPrompts([])).toBeNull();
  });
});

describe('combineMix', () => {
  it('takes the more Turkish reading, unknown only when both are', () => {
    expect(combineMix('english', 'turkish')).toBe('turkish');
    expect(combineMix('mixed', 'english')).toBe('mixed');
    expect(combineMix('unknown', 'english')).toBe('english');
    expect(combineMix('unknown', 'unknown')).toBe('unknown');
  });
});

describe('languageMixOf and machineClassOf', () => {
  it('buckets the share', () => {
    expect(languageMixOf(null)).toBe('unknown');
    expect(languageMixOf(0)).toBe('english');
    expect(languageMixOf(0.09)).toBe('english');
    expect(languageMixOf(0.1)).toBe('mixed');
    expect(languageMixOf(0.59)).toBe('mixed');
    expect(languageMixOf(0.6)).toBe('turkish');
  });
  it('light means low memory, few cores, or an Air', () => {
    expect(machineClassOf(BIG)).toBe('standard');
    expect(machineClassOf({ ...BIG, totalMemBytes: 8 * GIB })).toBe('light');
    expect(machineClassOf({ ...BIG, cpuCount: 4 })).toBe('light');
    expect(machineClassOf({ ...BIG, modelName: 'MacBook Air' })).toBe('light');
    expect(machineClassOf({ ...BIG, modelName: 'MacBook Pro' })).toBe('standard');
  });
});

describe('recommendRecall', () => {
  it('a Turkish brain gets the best-accuracy cloud tier, and a pointer to private queries on a capable machine', () => {
    const r = recommendRecall({ ...BIG, turkishShare: 0.9 });
    expect(r).toMatchObject({ option: 'cloud', reason: 'multi-language', note: 'private-query-available', languageMix: 'turkish', machineClass: 'standard' });
  });
  it('a mixed brain gets the same recommendation', () => {
    expect(recommendRecall({ ...BIG, turkishShare: 0.3 })).toMatchObject({ option: 'cloud', reason: 'multi-language', languageMix: 'mixed' });
  });
  it('on a light machine it does not point at the local-embedding tier', () => {
    const r = recommendRecall({ ...BIG, turkishShare: 0.9, totalMemBytes: 8 * GIB });
    expect(r).toMatchObject({ option: 'cloud', note: 'light-machine', machineClass: 'light' });
  });
  it('reports whether the key the cloud tier needs is already here', () => {
    expect(recommendRecall({ ...BIG, turkishShare: 0.9, keyPresent: true }).keyPresent).toBe(true);
    expect(recommendRecall({ ...BIG, turkishShare: 0.9, keyPresent: false }).keyPresent).toBe(false);
  });
  it('an English-only brain gets keyword search, key or no key', () => {
    expect(recommendRecall({ ...BIG, turkishShare: 0.02 })).toMatchObject({ option: 'raw', reason: 'english-only', note: null });
    expect(recommendRecall({ ...BIG, turkishShare: 0, keyPresent: true }).option).toBe('raw');
  });
  it('English documents prompted in Turkish are multi-language, not English only', () => {
    const r = recommendRecall({ ...BIG, turkishShare: 0.02, promptTurkishShare: 0.9 });
    expect(r).toMatchObject({ option: 'cloud', reason: 'multi-language', docsMix: 'english', promptsMix: 'turkish', languageMix: 'turkish' });
  });
  it('English documents and English prompts stay English only', () => {
    expect(recommendRecall({ ...BIG, turkishShare: 0.02, promptTurkishShare: 0.05 })).toMatchObject({ option: 'raw', reason: 'english-only' });
  });
  it('prompts alone are enough to read the language', () => {
    expect(recommendRecall({ ...BIG, promptTurkishShare: 0.5 })).toMatchObject({ option: 'cloud', docsMix: 'unknown', promptsMix: 'mixed' });
  });
  it('no language signal keeps the default', () => {
    expect(recommendRecall(BIG)).toMatchObject({ option: 'haiku', reason: 'no-language-signal', languageMix: 'unknown' });
  });
});
