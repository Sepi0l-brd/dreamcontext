// Gate for authored gold v2 files (plan §2.2). Prints counts and ids ONLY — never query text,
// so the orchestrator (and any forked implementer) can run it against sealed files safely.
//
//   npx tsx scripts/gold-v2-check.ts --snapshot-root <dir> [--train <jsonl>] [--heldout <jsonl>] [--reserve <jsonl>]
//                                    [--samples-dir <dir>] [--legacy <jsonl> ...]
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { docKey, tokenize, type CorpusDoc } from '../src/lib/recall.js';
import {
  ASCII_VARIANT_COUNT, CATEGORIES, LANGS, SNAPSHOT_ID, SPLIT_QUOTAS, SPLITS, readJsonl,
  snapshotDir, stableCorpusForGold, validateGoldLine, type GoldLang, type GoldQueryV2, type GoldSplit,
} from './gold-v2-lib.js';
import { legacyTargets, type SampleFile } from './gold-v2-sample.js';

const TURKISH_CHARS = /[çğıöşüÇĞİÖŞÜ]/;
const MAX_PARAPHRASE_OVERLAP = 1;
const MIN_VERBATIM_TITLE_CHARS = 12;

export interface CheckInput {
  files: Partial<Record<GoldSplit, string>>;
  corpus: readonly CorpusDoc[];
  legacy: ReadonlySet<string>;
  /** Directory with <split>-<lang>.json sample files; when given, targets are matched one-to-one. */
  samplesDir?: string;
}

export interface CheckResult {
  errors: string[];
  warnings: string[];
  /** split -> lang -> count */
  counts: Record<string, Record<string, number>>;
  /** split -> lang -> targets that are not cloud-eligible are reported by gold-v2-eligibility, not here. */
  asciiCounts: Record<string, number>;
}

function readSample(dir: string, split: GoldSplit, lang: GoldLang): SampleFile | null {
  const p = join(dir, `${split}-${lang}.json`);
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf-8')) as SampleFile) : null;
}

export function checkGold(input: CheckInput): CheckResult {
  const res: CheckResult = { errors: [], warnings: [], counts: {}, asciiCounts: {} };
  const byKey = new Map(input.corpus.map((d) => [docKey(d), d]));
  const seenIds = new Set<string>();
  const targetOwner = new Map<string, string>(); // docKey -> "split/id"

  for (const split of SPLITS) {
    const path = input.files[split];
    if (!path) continue;
    const rows = readJsonl(path) as GoldQueryV2[];
    const counts: Record<string, number> = {};
    const catCounts: Record<string, Record<string, number>> = {};
    let ascii = 0;

    for (const row of rows) {
      const schemaErrs = validateGoldLine(row, split);
      res.errors.push(...schemaErrs);
      if (schemaErrs.length > 0) continue;
      const id = row.id;
      if (seenIds.has(id)) res.errors.push(`${id}: duplicate_id`);
      seenIds.add(id);
      counts[row.lang] = (counts[row.lang] ?? 0) + 1;
      catCounts[row.lang] = catCounts[row.lang] ?? {};
      catCounts[row.lang][row.category] = (catCounts[row.lang][row.category] ?? 0) + 1;
      if (row.variant === 'ascii') ascii++;

      const target = row.expected[0];
      const doc = byKey.get(target);
      if (!doc) res.errors.push(`${id}: expected_key_missing_in_snapshot`);
      for (const a of row.alt ?? []) if (!byKey.has(a)) res.errors.push(`${id}: alt_key_missing_in_snapshot`);
      if (input.legacy.has(target)) res.errors.push(`${id}: target_is_legacy`);
      const owner = targetOwner.get(target);
      if (owner) res.errors.push(`${id}: target_reused_by_${owner}`);
      else targetOwner.set(target, `${split}/${id}`);

      if (doc) {
        const queryTokens = new Set(tokenize(row.query));
        const identity = new Set(tokenize(`${doc.title} ${doc.slug}`));
        const overlap = [...queryTokens].filter((t) => identity.has(t)).length;
        if (row.category === 'paraphrase' && overlap > MAX_PARAPHRASE_OVERLAP) res.errors.push(`${id}: paraphrase_overlap_${overlap}`);
        const title = doc.title.trim().toLowerCase();
        if (title.length >= MIN_VERBATIM_TITLE_CHARS && row.query.toLowerCase().includes(title)) res.errors.push(`${id}: quotes_title_verbatim`);
      }

      const hasTr = TURKISH_CHARS.test(row.query);
      if (row.lang === 'en' && hasTr) res.errors.push(`${id}: en_query_has_turkish_chars`);
      if (row.variant === 'ascii' && hasTr) res.errors.push(`${id}: ascii_variant_has_turkish_chars`);
      if (row.lang === 'tr' && row.variant !== 'ascii' && !hasTr) res.warnings.push(`${id}: tr_without_turkish_chars`);
      if (row.lang === 'mixed' && !hasTr) res.warnings.push(`${id}: mixed_without_turkish_chars`);
    }

    res.counts[split] = counts;
    res.asciiCounts[split] = ascii;
    for (const lang of LANGS) {
      const want = Object.values(SPLIT_QUOTAS[split]).reduce((a, b) => a + b, 0);
      if ((counts[lang] ?? 0) !== want) res.errors.push(`${split}/${lang}: count_${counts[lang] ?? 0}_expected_${want}`);
      for (const cat of CATEGORIES) {
        const have = catCounts[lang]?.[cat] ?? 0;
        if (have !== SPLIT_QUOTAS[split][cat]) res.errors.push(`${split}/${lang}/${cat}: count_${have}_expected_${SPLIT_QUOTAS[split][cat]}`);
      }
    }
    if (ascii !== ASCII_VARIANT_COUNT[split]) res.errors.push(`${split}: ascii_variants_${ascii}_expected_${ASCII_VARIANT_COUNT[split]}`);

    if (input.samplesDir) {
      for (const lang of LANGS) {
        const sample = readSample(input.samplesDir, split, lang);
        if (!sample) { res.errors.push(`${split}/${lang}: sample_file_missing`); continue; }
        const rowsOfLang = new Map(rows.filter((r) => r.lang === lang).map((r) => [r.id, r]));
        for (const t of sample.targets) {
          const id = `g2${split === 'train' ? 't' : split === 'heldout' ? 'h' : 'r'}-${lang}-${String(t.n).padStart(3, '0')}`;
          const row = rowsOfLang.get(id);
          if (!row) { res.errors.push(`${id}: missing_for_sampled_target`); continue; }
          if (row.expected[0] !== t.docKey) res.errors.push(`${id}: expected_differs_from_sample`);
          if (row.category !== t.category) res.errors.push(`${id}: category_differs_from_sample`);
          if ((row.variant === 'ascii') !== t.ascii) res.errors.push(`${id}: variant_differs_from_sample`);
        }
        if (rowsOfLang.size !== sample.targets.length) res.errors.push(`${split}/${lang}: rows_${rowsOfLang.size}_sampled_${sample.targets.length}`);
      }
    }
  }
  return res;
}

function argValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

const HELP = `Usage: npx tsx scripts/gold-v2-check.ts [--snapshot-root <dir>] [--train <jsonl>] [--heldout <jsonl>] [--reserve <jsonl>]
                                         [--samples-dir <dir>] [--legacy <jsonl> ...]
Validates schema, ids, quotas, snapshot membership, disjointness, legacy exclusion, paraphrase overlap, verbatim titles
and (with --samples-dir) one-to-one coverage of the sampled targets. Prints counts and ids only, never query text.
Exit code 1 on any error.`;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP);
  } else {
    try {
      const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
      const snap = resolve(argValue(argv, '--snapshot-root') ?? snapshotDir());
      const legacyArgs = argv.flatMap((a, i) => (a === '--legacy' ? [argv[i + 1]] : []));
      const files: CheckInput['files'] = {};
      for (const s of SPLITS) { const v = argValue(argv, `--${s}`); if (v) files[s] = resolve(v); }
      const result = checkGold({
        files,
        corpus: stableCorpusForGold(join(snap, '_dream_context')),
        legacy: legacyTargets(legacyArgs.length > 0 ? legacyArgs : [join(repo, 'eval', 'gold.jsonl'), join(repo, 'eval', 'gold-heldout.jsonl')]),
        samplesDir: argValue(argv, '--samples-dir') ? resolve(argValue(argv, '--samples-dir') as string) : undefined,
      });
      console.log(`snapshot ${SNAPSHOT_ID}: counts ${JSON.stringify(result.counts)} ascii ${JSON.stringify(result.asciiCounts)}`);
      for (const w of result.warnings) console.log(`warn  ${w}`);
      for (const e of result.errors) console.log(`error ${e}`);
      console.log(`${result.errors.length} errors, ${result.warnings.length} warnings`);
      if (result.errors.length > 0) process.exitCode = 1;
    } catch (err) {
      console.error(`check failed: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  }
}
