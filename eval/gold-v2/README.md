# Gold v2 (2026-10)

Written **before any tuning**, against a frozen snapshot of the brain
(`~/.dreamcontext/eval-frozen/dc-20261010/_dream_context`). Protocol: plan §2 of the
`recall-dil-fark-etmeksizin-…` task.

| split | per language (tr / en / mixed) | where it lives |
|---|---|---|
| train | 30 | `eval/gold-v2/train.jsonl` (this repo) |
| heldout | 25 | `~/.dreamcontext/eval-frozen/dc-20261010/sealed/heldout.jsonl` — never in the repo |
| reserve | 20 | `~/.dreamcontext/eval-frozen/dc-20261010/sealed/reserve.jsonl` — never in the repo |

Per-language category quotas (exact-term / field-match / paraphrase / recency / topical-adjacency):
train 6/5/8/6/5, heldout 4/4/7/5/5, reserve 3/3/5/4/5. Turkish queries typed without diacritics
carry `"variant":"ascii"` (train 4, heldout 4, reserve 3).

## Line schema (`GoldQueryV2`)

```json
{"id":"g2h-tr-007","query":"…","expected":["knowledge/some-slug"],"alt":[],"category":"paraphrase","lang":"tr"}
```

`id` = `g2{t|h|r}-{tr|en|mixed}-NNN` where NNN is the sampled target's number. `expected` holds
exactly one docKey (`type/slug`); no query quotes its target's title.

## Integrity rules

- Targets are drawn by `scripts/gold-v2-sample.ts` (seed 20261010): disjoint across all splits and
  languages, and disjoint from every target of `eval/gold.jsonl` and `eval/gold-heldout.jsonl`.
- Authors are fresh headless runs that see only the snapshot and their own sample file.
- `scripts/gold-v2-check.ts` prints counts and ids only; it never prints query text.
- `FROZEN.md` holds sha256 and counts. `tests/unit/gold-v2-frozen.test.ts` re-hashes a file only
  when it is filled in and the file is present.
- Held-out and reserve are looked at through `HELDOUT-LEDGER.md` only: every look is a ledger line.
- Never tune on held-out or reserve; never edit a sealed file after `FROZEN.md` is filled.
