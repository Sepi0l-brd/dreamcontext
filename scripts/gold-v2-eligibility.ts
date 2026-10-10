// Offline (no network): per split × language, how many gold targets are NOT cloud-eligible on the
// frozen snapshot (plan-r5 §3 TS / G1). Counts only — never prints a query, id or docKey, so it may
// read the sealed held-out/reserve files without opening them to the reader.
//
// Usage: npx tsx scripts/gold-v2-eligibility.ts [--home <dir>]
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { docKey } from '../src/lib/recall.js';
import { isCloudEligibleDoc, type WithheldRule } from '../src/lib/embeddings/egress-rules.js';
import {
  LANGS, SPLITS, sealedDir, snapshotDir, stableCorpusForGold,
  type GoldLang, type GoldSplit,
} from './gold-v2-lib.js';

interface TargetLine { lang: GoldLang; expected: string[] }

const homeArg = process.argv.indexOf('--home');
const home = homeArg >= 0 ? process.argv[homeArg + 1] : undefined;
const repoRoot = join(import.meta.dirname, '..');

function splitPath(split: GoldSplit): string {
  return split === 'train'
    ? join(repoRoot, 'eval', 'gold-v2', 'train.jsonl')
    : join(sealedDir(home), `${split}.jsonl`);
}

function readTargets(path: string): TargetLine[] {
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).map((l) => {
    const raw = JSON.parse(l) as { lang?: unknown; expected?: unknown };
    if (!LANGS.includes(raw.lang as GoldLang) || !Array.isArray(raw.expected)) throw new Error('gold line without a valid lang/expected');
    return { lang: raw.lang as GoldLang, expected: raw.expected.map(String) };
  });
}

const root = join(snapshotDir(home), '_dream_context');
const byKey = new Map(stableCorpusForGold(root).map((d) => [docKey(d), d]));

console.log('split     lang    targets  not-eligible  (by rule)');
for (const split of SPLITS) {
  const path = splitPath(split);
  if (!existsSync(path)) { console.log(`${split.padEnd(9)} (file absent)`); continue; }
  const lines = readTargets(path);
  for (const lang of LANGS) {
    const mine = lines.filter((l) => l.lang === lang);
    const rules: Partial<Record<WithheldRule | 'missing', number>> = {};
    let bad = 0;
    for (const l of mine) {
      const doc = byKey.get(l.expected[0]);
      const rule = doc ? isCloudEligibleDoc(doc, root) : 'missing';
      if (rule) { bad++; rules[rule] = (rules[rule] ?? 0) + 1; }
    }
    console.log(`${split.padEnd(9)} ${lang.padEnd(6)} ${String(mine.length).padStart(7)}  ${String(bad).padStart(12)}  ${JSON.stringify(rules)}`);
  }
}
