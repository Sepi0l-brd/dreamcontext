# Memory-uplift RESULTS — recall before/after

Branch `memory-uplift`. Deterministic benchmark: 60-query gold set (`eval/gold.jsonl`), authored blind to the improvements by a separate sub-agent from corpus reality. Reproduce: `npx vitest run tests/unit/recall-eval.test.ts`.

## Headline

| metric | BEFORE (baseline) | AFTER | Δ |
|---|---|---|---|
| **overall recall@1** | **68.3%** | **85.0%** | **+16.7 pts** |
| **overall recall@3** | **81.7%** | **95.0%** | **+13.3 pts** |
| overall MRR | 0.768 | 0.903 | +0.135 |

No category regressed. The two weakest categories improved the most.

## Per-category (recall@1 / recall@3)

| category | before r@1 | after r@1 | before r@3 | after r@3 |
|---|---|---|---|---|
| turkish | 37.5% | **75.0%** (+37.5) | 37.5% | **87.5%** (+50.0) |
| paraphrase | 41.7% | **66.7%** (+25.0) | 75.0% | 91.7% (+16.7) |
| exact-term | 83.3% | 100.0% (+16.7) | 100.0% | 100.0% |
| field-match | 87.5% | 100.0% (+12.5) | 87.5% | 100.0% |
| recency | 75.0% | 87.5% (+12.5) | 87.5% | 87.5% |
| mixed (TR/EN) | 83.3% | 83.3% | 83.3% | 100.0% (+16.7) |
| topical-adjacency | 83.3% | 83.3% | 100.0% | 100.0% |

## What shipped (all on `memory-uplift`, all tests green)

**Batch 0 — measurement** (`f560fd8`): deterministic vitest harness + 60-query gold set + frozen `eval/BASELINE.md`. `docKey()` added.

**Batch 1 — recall engine** (`a56f9d4`, tests `125e029`): the metric movers.
- **B4 stemming + synonyms** (biggest mover): EN suffix stripping + Turkish suffix folding in `tokenize()` + a query-time synonym map (`recall-synonyms.ts`). This is what doubled Turkish (37.5→75) and lifted paraphrase (41.7→66.7).
- **B2 BM25F** field weighting (title×3/tags×2/desc×2/body×1) — pushed exact-term and field-match to 100%.
- **B3 recency + status** re-rank (down-weight `completed`, light recency decay) — recency 75→87.5.
- **B6** Haiku index relevance-ranking — replaced the 8000-char positional slice that silently hid ~half the corpus (all changelog) from the Haiku recall path.
- **B5** link-aware boost — built + unit-tested, shipped **OFF by default** (the live corpus has ~0 real wikilinks, so enabling it would be a no-op; honors the existing deferral discipline).
- **Decoupling invariant:** `hit.score` stays raw flat-BM25 (so the hook gates `>= 2.0` / `>= 1.0` and the explore agent's `>= 5 / < 2` are unaffected); all new signals feed a derived `rankScore` used only for ordering. Regression-locked by `recall-weighting.test.ts`.

**Batch 2 — continuous capture** (`a5edce7`): the corpus now enriches itself automatically.
- **C1** auto transcript digest (`session-digest.ts`) on the SessionStart catch-up path (never the latency-sensitive Stop hook), per-session try/catch, bounded ≤8KB.
- **C2** auto-salience (`salience.ts`): user-correction / error→fix / decision-keyword detectors (EN+TR) → auto-bookmarks. This finally implements the "awake-ripple tagging" the brain model is built on (previously 30/32 consolidations had zero bookmarks).
- **C3** digests + bookmarks indexed into `buildCorpus` so a decision in session N is recallable in N+1, before any sleep.
- **C4** recall hits bump `knowledge_access` (shared `bumpKnowledgeAccess`) so recalled docs stop rotting to "stale".

**Batch 3 — correctness** (`1451ab5`): explore agent's Bash allowlist now includes `dreamcontext memory recall` + `transcript distill` (the headline context-first-explore optimization was non-functional before); the dead `marketing/.env` PreToolUse write-block was revived (it never fired under matcher `Agent` only).

**Phase-5 review fixes** (`e31b2e3`): BM25-fallback gate uses `.some()` so re-ranking can't suppress a strong raw match; `session_id` sanitized in digest frontmatter.

## Test + build status
- `npm test`: **1038/1038 passing** (76 files; +47 new tests for this work).
- `npm run build`: clean (CLI + dashboard).
- Note: integration tests require a build first (project convention); the 1038 figure is post-build.

## Honest caveats
- **60-query gold set is suggestive, not proof.** It was authored blind to the improvements, but it is one author's view of "realistic queries" on one corpus. A +16.7 pt overall r@1 is a strong signal, not a guarantee of identical gains on every project.
- **Continuous capture (Batch 2) is not reflected in the % above** — it grows the corpus *over time*; the benchmark measures a fixed committed snapshot (digests/bookmarks contribute 0 docs there by design, so the number is comparable before/after). Its payoff is qualitative: the brain now captures the high-signal slice of every session automatically instead of only what someone remembered to bookmark before running sleep.
- **B5 (link-aware) is off** — mechanism shipped + tested, but a no-op until the corpus actually grows wikilinks.
- Embeddings/vector overlay and WAVE 3/4 items remain out of scope (separate future work).

## Not auto-merged
Left on `memory-uplift` for review. The recall engine touches a hot path; suggest a skim of `src/lib/recall.ts` (rankScore vs score) and `src/cli/commands/hook.ts` (capture wiring) before merging to main.

---

## v3 (2026-06-10) — TR morphology + directed bridges + canonical-first

Tuned on `gold.jsonl` (60q), validated on `gold-heldout.jsonl` (30q, authored blind — see knowledge/recall-engine-v2.md v3 update). Frozen 242-doc corpus via `scripts/recall-ab.ts`.

| Metric | Train old | Train v3 | Held-out old | Held-out v3 |
|---|---|---|---|---|
| overall recall@1 | 86.7 | **91.7** | 83.3 | **93.3** |
| overall recall@3 | 93.3 | **96.7** | 90.0 | **96.7** |
| overall MRR | 0.906 | **0.943** | 0.875 | **0.957** |
| turkish recall@1 | 75.0 | 75.0 | 70.0 | **90.0** |
| turkish recall@3 | 87.5 | **100.0** | 80.0 | **100.0** |
| paraphrase recall@1 | 66.7 | **91.7** | 87.5 | 87.5 |

No category regressed on either set. linkAware was benchmarked and rejected (train r@1 68.3 with it ON). Regression locks: `tests/unit/recall-engine-v3.test.ts`.

---

## Embedding A/B (2026-07-07) — BM25 vs hybrid vs dense on the frozen gold sets

The prove-it-or-kill-it gate for the experimental local embedding layer
(knowledge/decisions/decision-embedding-layer.md). Reproduce:
`npx tsx scripts/embed-ab.ts` (train) / `--heldout`. Corpus discipline as v3:
git-tracked stable corpus (675 docs, captures + in-flight noise excluded),
frozen gold sets untouched. Model: `Xenova/multilingual-e5-small` q8 (384-dim,
113 MB), chunked at heading boundaries (2503 chunks), content-hash cache at
`_dream_context/.embeddings/` (gitignored, incremental: warm refresh ~15 ms).

**IMPORTANT context:** the corpus nearly tripled since v3 froze its 242-doc
snapshot (675 docs now, mostly changelog + new knowledge), so absolute numbers
are NOT comparable to the v3 table above — the same queries face far more
distractors. All three modes below face the identical corpus, so the A/B is
internally fair.

### Fusion journey (what was tried, in order)

1. **Plain RRF (k=60, per the decision doc's "start here")** — KILLED. Overall
   train r@1 68.3 vs bm25 75.0; exact-term r@1 100 → 83.3 (the forbidden
   regression). Equal-vote rank fusion lets dense flip decisive lexical wins.
2. **Convex-weighted RRF (w_bm25 swept 0.5–0.9)** — KILLED. Best (w=0.8) r@1
   76.7 but exact-term stuck at 91.7 at EVERY weight: rank fusion erases BM25's
   score margins, so near-ties flip regardless of weight.
3. **Relative-score fusion (min-max convex, λ swept)** — safe but toothless.
   λ ≤ 0.2 holds exact-term at 100 but is a near-no-op; λ ≥ 0.25 regresses.
4. **Adaptive fusion-type switch (SHIPPED)** — topRaw ≥ 18 → relative fusion
   λ=0.1 (margins preserved, exact wins can't flip); topRaw < 18 → weighted RRF
   w_bm25=0.6 (weak-BM25 score gaps are noise; rank fusion lets dense rescue
   buried docs). Tuned on train ONLY; held-out validated untouched.

### Headline (adaptive hybrid vs bm25)

| metric | train bm25 | train hybrid | held-out bm25 | held-out hybrid |
|---|---|---|---|---|
| recall@1 | 75.0 | **78.3** (+3.3) | 60.0 | **63.3** (+3.3) |
| recall@3 | 90.0 | **93.3** (+3.3) | 86.7 | **90.0** (+3.3) |
| recall@5 | 95.0 | 95.0 (=) | 90.0 | **93.3** (+3.3) |
| MRR | 0.832 | **0.853** | 0.740 | **0.751** |
| nDCG@10 | 0.869 | **0.881** | 0.796 | **0.805** |
| exact-term r@1 | 100.0 | **100.0 (no regression)** | 75.0 | 75.0 (=) |

### Where hybrid wins (the "multiple scenarios" answer)

- **turkish**: train r@3 62.5 → **87.5** (+25); held-out r@1 20 → **40** (×2),
  r@3 80 → 90, r@5 90 → **100**. The multilingual dense channel bridges TR→EN
  natively — this is the strongest scenario win.
- **recency**: train r@1 50 → **75** (+25), nDCG 0.720 → 0.868.
- **field-match**: train r@3 87.5 → **100**.
- **exact-term / mixed**: byte-identical to bm25 (the adaptive guard working).

### Where it costs

- train paraphrase r@3 91.7 → 83.3 (one query, q014-adjacent zone; r@5 equal).
- held-out topical-adjacency r@1 75 → 50 (ONE query, h027, topRaw 17.7 — right
  at the cutoff boundary; drops rank 1 → 2). n=4 category, so ±25pt swings are
  single queries.
- Latency: +40 ms/query over bm25 (219 vs 181 ms mean; embed+dot is ~20 ms of
  that). Cold start: ~1 s model load (cached at ~/.dreamcontext/models); first
  full-corpus index ~4 min one-time (2503 chunks), then incremental (~15 ms
  warm, content-hash keyed, survives git checkout).

### Dense-only (why the overlay architecture is right)

Dense alone is catastrophically worse: train r@1 38.3, exact-term 58.3, mixed
0.0. BEIR's "dense fails on exact tokens" fully reproduced on this corpus. BM25
stays the backbone; dense is an overlay. (Dense query latency itself is ~20 ms
— cheaper than BM25's ~180 ms df-scan — an optimization lead, not a mode.)

### Verdict vs the graduation gates (decision-embedding-layer)

1. hybrid r@5 + MRR strictly beat bm25 — **MRR yes both sets; r@5 yes on
   held-out, TIE (95.0) on train**. Partially met.
2. exact-term & field-match r@1 no regression — **MET** (train 100/87.5
   preserved; held-out equal).
3. laptop latency acceptable — **MET** (+40 ms warm; interactive).
4. no category regresses — **NOT met to the letter**: two single-query dips
   (train paraphrase r@3, held-out topical r@1) against much larger wins.

**Call: hybrid is a real but CATEGORY-SHAPED win — big for Turkish/cross-lingual
and recency-style weak-BM25 queries, neutral-to-marginal for English
exact/paraphrase queries. It stays opt-in beta (`DREAMCONTEXT_RECALL_MODE=hybrid`
/ `dreamcontext recall hybrid`), NOT default: gates 1 and 4 are not cleanly met.
Recommended for TR-heavy / multilingual vaults; unnecessary for EN-only vaults.**
Regression locks: `tests/unit/embeddings.test.ts` (17 tests: chunker
determinism, incremental cache, fusion math, raw-score decoupling invariant,
BM25 fallback).

### v2 (same day) — pin guard + changelog-free dense channel: ALL FOUR GATES MET

Per-query forensics on the v1 regressions found two independent root causes,
each with a targeted fix:

1. **Pin guard (`ADAPTIVE_PIN_MARGIN = 1.35`).** The worst English regression
   (train q021: gold at rank 1 → out of top-10) had a signature: BM25's OWN
   rankScore margin over its runner-up was decisive (1.55×) while every
   measured dense displacement WIN had a flat margin (1.05–1.32). So in the
   unconfident RRF zone, a BM25 top-1 with margin ≥ 1.35 is pinned at rank 1 —
   dense keeps its vote on ranks 2+.
2. **Changelog docs excluded from the dense channel (`DENSE_EXCLUDED_TYPES`).**
   One-line pointer docs make unusually focused vectors that match broadly and
   crowd out canonical docs — the same canonical-first finding the
   CHANGELOG_RANK_FACTOR encoded for BM25, reproduced in the dense space.
   (Dense-only overall r@1 jumped 38.3 → 43.3 train / 36.7 → 56.7 held-out from
   this alone.) BM25 still surfaces changelogs; only the dense candidate list
   is filtered.

Same protocol: designed on train forensics, validated untouched on held-out.
(bm25 baseline shifted slightly vs the v1 table — the live corpus absorbed the
embedding tasks' own updates between runs; every comparison below is within-run.)

| metric | train bm25 | train hybrid v2 | held-out bm25 | held-out hybrid v2 |
|---|---|---|---|---|
| recall@1 | 76.7 | **81.7** (+5.0) | 60.0 | **66.7** (+6.7) |
| recall@3 | 90.0 | **95.0** (+5.0) | 86.7 | 86.7 (=) |
| recall@5 | 95.0 | **96.7** (+1.7) | 90.0 | **96.7** (+6.7) |
| MRR | 0.840 | **0.878** | 0.740 | **0.772** |
| nDCG@10 | 0.875 | **0.904** | 0.796 | **0.820** |

Category highlights (within-run deltas):
- **paraphrase (EN)**: train r@1 66.7 → **83.3** (+16.7), r@5 91.7 → **100**,
  MRR 0.800 → 0.892 — the pin guard turned v1's English *regression* into the
  second-largest English *win*.
- **turkish**: train r@3 62.5 → **87.5**; held-out r@1 20 → **40**, r@5 90 →
  **100** (all v1 wins kept).
- **recency**: train r@1 62.5 → **75.0**, nDCG 0.766 → 0.868.
- **topical-adjacency (held-out)**: v1's h027 regression GONE (r@1 75 = 75);
  r@5 75 → **100** (+25).
- **exact-term / field-match / mixed**: identical to bm25 everywhere (guards
  working).

**Not one recall@k or MRR cell regresses on either gold set.** Sole blemish:
train turkish nDCG@10 0.763 → 0.750 (one query, q031, rank 7 → 11; its
r@1/r@3/r@5 cells are unchanged).

**Gate check (decision-embedding-layer "Conditions to Make It Default"):**
1. r@5 + MRR strictly beat bm25 — **MET** (both sets).
2. exact-term & field-match r@1 no regression — **MET** (identical).
3. laptop latency — **MET** (~232 ms vs ~183 ms warm; +50 ms).
4. no category regresses — **MET** on recall@1/3/5 + MRR (nDCG footnote above).

**Call v2: the quality gates for default-on are now met. Remaining blockers are
purely operational (113 MB first model download, ~4 min first full-corpus
index) — recommended rollout is staged: opt-in beta → auto-enable when the
model + cache are already warm on the machine (never a surprise download on
first prompt). That wiring belongs to the beta-rollout task.** Regression
locks extended to 19 tests (pin guard, dense-channel exclusion).

## 2026-10-07 — `whiteboard` channel added (no regression)

`scripts/recall-ab.ts` on the stable corpus, before vs after adding the tenth corpus type (3 boards, 1382 → 1385 docs):

| set | r@1 | r@3 | MRR before → after |
|---|---|---|---|
| train (`gold.jsonl`) | 66.7 = | 86.7 = | 0.766 → 0.766 (paraphrase 0.759 → 0.758) |
| held-out (`gold-heldout.jsonl`) | 50.0 = | 63.3 = | 0.581 → 0.580 (exact-term 0.800 → 0.792) |

No recall@k cell moves; the MRR deltas are IDF wobble from the three new docs.

## 2026-10-07 — `core` channel added (no regression)

Same-corpus A/B (with and without `core` evaluated on ONE `buildCorpus` in one process; the live brain grew between separate runs while another session worked). 4 core docs: 0.soul, 3.style_guide_and_branding, 4.tech_stack, 6.system_flow.

| set | r@1 | r@3 | MRR without → with |
|---|---|---|---|
| train | 66.7 = | 86.7 = | 0.766 → 0.765 |
| held-out | 50.0 = | 63.3 = | 0.580 → 0.580 |

Rank moves, all outside the top 3: q028 7→8 and q059 5→6 (`core/6.system_flow` above the gold doc), h012 8→9 (`core/0.soul` above). All three are on-topic answers, not noise.

## 2026-10-11 — Recall tiers (local, cloud-index, cloud): held-out results

Task "Recall dil fark etmeksizin isabetli olur". Source of every number: `eval/runs/2026-10-11-final.json` (held-out aggregates, verdicts, latency, cost), with the train-only tuning in `eval/runs/2026-10-11-tune-train.json` and `eval/runs/2026-10-11-tune-train-local.json`. Aggregates only; no query text.

### Method

- **Frozen snapshot** `dc-20261010` (1204 files, 1585 stable docs). Every tier and every baseline ran on it.
- **Gold v2**, authored before any tuning. Train (30 per language) lives in the repo; the held-out and a reserve are sealed. **Held-out n = 72** (tr 23 / en 25 / mixed 24), not the planned 75, so per-language verdicts at n of about 25 are directional and the pooled figure is primary.
- **B0** (the floor to beat) ran on the archived engine `0ba4c25a`: `raw` (BM25), `hybrid-e5` (the previous local hybrid) and `haiku` (BM25 behind a Haiku query translation). Injection is K=5.
- **Tuning was train-only.** Fusion constants were chosen on train (and the legacy 90-query set as a no-regression check); the sealed held-out was never read while tuning.
- **One look per tier**, each recorded in the eval ledger. Engines: local `8ed3a6d8`, cloud `c274d18f` (with the fallback guard), cloud-index `ba736f4f` (run before the fallback guard existed, so its per-query fallback state was not recorded).
- **Pre-registered rules:** AC-Q1, AC-Q2 (a tier must strictly beat the best B0 mode per language and pooled; paired sign test reported), AC-Q3 (no loss on exact terms or English).

### Held-out recall (n = 72)

| Mode | Lang | n | r@1 | r@3 | r@5 | MRR |
|---|---|---|---|---|---|---|
| B0 raw | tr | 23 | 8.7 | 30.4 | 30.4 | 0.191 |
| B0 raw | en | 25 | 76.0 | 88.0 | 88.0 | 0.813 |
| B0 raw | mixed | 24 | 45.8 | 54.2 | 75.0 | 0.548 |
| B0 raw | all | 72 | 44.4 | 58.3 | 65.3 | 0.526 |
| B0 hybrid-e5 | tr | 23 | 8.7 | 21.7 | 26.1 | 0.171 |
| B0 hybrid-e5 | en | 25 | 72.0 | 88.0 | 88.0 | 0.793 |
| B0 hybrid-e5 | mixed | 24 | 45.8 | 54.2 | 66.7 | 0.535 |
| B0 hybrid-e5 | all | 72 | 43.1 | 55.6 | 61.1 | 0.509 |
| B0 haiku | tr | 23 | 43.5 | 52.2 | 52.2 | 0.478 |
| B0 haiku | en | 25 | 56.0 | 64.0 | 64.0 | 0.600 |
| B0 haiku | mixed | 24 | 50.0 | 62.5 | 62.5 | 0.563 |
| B0 haiku | all | 72 | 50.0 | 59.7 | 59.7 | 0.549 |
| **local** | tr | 23 | 8.7 | 21.7 | 26.1 | 0.189 |
| **local** | en | 25 | 72.0 | 88.0 | 88.0 | 0.793 |
| **local** | mixed | 24 | 45.8 | 62.5 | 66.7 | 0.542 |
| **local** | all | 72 | 43.1 | 58.3 | 61.1 | 0.517 |
| **cloud-index** | tr | 23 | 39.1 | 91.3 | 100 | 0.643 |
| **cloud-index** | en | 25 | 68.0 | 88.0 | 100 | 0.795 |
| **cloud-index** | mixed | 24 | 58.3 | 79.2 | 83.3 | 0.702 |
| **cloud-index** | all | 72 | 55.6 | 86.1 | 94.4 | 0.715 |
| **cloud** | tr | 23 | 65.2 | 87.0 | 95.7 | 0.790 |
| **cloud** | en | 25 | 80.0 | 100 | 100 | 0.893 |
| **cloud** | mixed | 24 | 75.0 | 95.8 | 95.8 | 0.858 |
| **cloud** | all | 72 | 73.6 | 94.4 | 97.2 | 0.849 |

Pooled r@5 95% intervals: raw 53.8-75.2, local 49.6-71.5, cloud-index 86.6-97.8, cloud 90.4-99.2. Turkish is where the gap lives: raw and local sit near 26-30% r@5, cloud-index reaches 100%, cloud 95.7%.

### Verdicts

**AC-Q1 (cloud r@5 >= 90% in each language): PASS.** tr 22/23 (need 21), en 25/25 (need 23), mixed 23/24 (need 22).

**AC-Q2 (floor: strictly better than the best B0 mode, per language and pooled):**

| Tier | tr | en | mixed | pooled | Pooled paired sign test vs best B0 (raw) |
|---|---|---|---|---|---|
| cloud | PASS (22 vs 12) | PASS (25 vs 22) | PASS (23 vs 18) | PASS (70 vs 47) | 24 wins, 1 loss, p = 1.6e-06 |
| cloud-index | PASS (23 vs 12) | PASS (25 vs 22) | PASS (20 vs 18) | PASS (68 vs 47) | 23 wins, 2 losses, p = 1.9e-05 |
| local | FAIL (6 vs 7) | FAIL (22 vs 22) | FAIL (16 vs 18) | FAIL (44 vs 47) | 0 wins, 3 losses, p = 0.25 |

Per-language paired tests, cloud vs the strongest baseline for that language: tr vs haiku 11-1 (p = 0.0063); en vs raw 3-0 (p = 0.25); mixed vs raw 5-0 (p = 0.0625). Cloud-index: tr vs haiku 11-0 (p = 0.00098); en vs raw 3-0 (p = 0.25); mixed vs raw 4-2 (p = 0.69). At n of about 25 only the Turkish gap is individually significant; the pooled test is the primary evidence.

**The local tier fails the floor.** It does not beat raw BM25 in any language, and it loses three paired queries to it (0-3, p = 0.25, not significant either way). Per plan §2.5 the local tier therefore keeps the pre-goal constants: nothing about it was changed for this goal, it is not claimed as an improvement, and its Turkish recall stays low. The cloud tiers are the answer to Turkish; local is the offline default, unchanged.

**AC-Q3 (exact-term r@1 >= raw, English r@5 >= best B0 EN): PASS for all three tiers.** Exact-term r@1 (12 queries): local 9, cloud-index 8, cloud 10 vs raw 8. English r@5: local 22, cloud-index 25, cloud 25 vs best B0 22.

**AC-Q5 (injection rate and effective r@5, reported not gating).** raw, hybrid-e5, local, cloud-index and cloud inject on 100% of queries, so effective r@5 equals r@5 (pooled 65.3, 61.1, 61.1, 94.4, 97.2). Haiku injects on 79.2% of queries, effective r@5 59.7% pooled. The call on which tier to recommend by default (Q4 gate) is the owner's, with these numbers.

### Chosen constants (train-only)

| Tier | Constants |
|---|---|
| **cloud** | `voyageai/rerank-2.5-lite`; pool `bm25-dense-union`; candidates N = 40; blend alpha = 0.7. Alpha 1.0 broke legacy exact-term r@1, so 0.7 won. Train r@5 100 / 93.3 / 100 (tr / en / mixed). |
| **cloud-index** | relative lambda 0.7 plus the dense gate {rawSure 60, rawLead 14, leadRatio 2}; no rerank. Train r@5 86.7 / 90 / 90. |
| **local** | unchanged: the e5 stage-1 tuning on train kept the production constants. |

### Latency (hook, `scripts/hook-latency.ts`, 50 runs per tier, first run discarded)

**Caveat: measured on a machine that was not quiet.** 8 cores, load averages 14-34 across the runs. Absolute numbers are inflated: the floor (bare node plus the hook with recall off) alone was 1184 ms p50 and 1988 ms p90. Overhead = tier wall minus floor wall (same statistic).

| Tier | wall p50 (ms) | wall p90 (ms) | overhead p50 (ms) | overhead p90 (ms) |
|---|---|---|---|---|
| floor (recall off) | 1184 | 1988 | - | - |
| raw | 1793 | 2787 | 609 | 799 |
| local | 6072 | 10708 | 4888 | 8720 |
| cloud-index | 5772 | 13070 | 4588 | 11082 |
| cloud | 2434 | 3412 | 1250 | 1424 |

- **AC-L1 (wall p90 <= 5000 ms):** raw PASS (2787), cloud PASS (3412); local (10708) and cloud-index (13070) FAIL as measured. Both failures are load-confounded (their local models compete with the busy machine for CPU) and **must be re-measured on a quiet machine** before they count either way.
- **AC-L2 (overhead p90 <= 1.5 s preferred):** cloud meets it on overhead (1424 ms) but not on wall (3412 ms); raw meets it (799 ms); local (8720) and cloud-index (11082) miss as measured.
- **AC-L3 (raw p50 <= 400 ms):** open. Raw overhead p50 was 609 ms and wall 1793 ms; the floor alone being 1184 ms says the machine, not recall, dominates. No profiling fix was attempted.
- **AC-L4 (offline / circuit-breaker case): not measured**, counted as unmet.

The held-out run latencies recorded in the sealed files were also taken under load and are not AC-L evidence.

### Cost

- **Full cloud index (AC-C1): PASS.** 1585 docs, 6597 chunks embedded, 0 reused, 241 s, **$0.159** (cap $0.50), unseeded.
- **Cloud queries (AC-C2, informational): about $0.25 per 1,000 queries** (46 billed queries cost $0.0116, embed plus rerank). Under the $1.00 cap; a rough estimate from a small sample.
- **Total goal spend (AC-C3): $0.549** (cap $5.00): legacy rerank check E0 $0.0114, spike TS $0.0422, eval ledger $0.4837 (includes the index build), real-consent latency run $0.0116.

### Caveats

- n = 72 (23 / 25 / 24); per-language verdicts are directional, pooled is primary.
- cloud-index ran on engine `ba736f4f`, before the fallback guard existed, so no per-query record shows it did not silently fall back; local ran on `8ed3a6d8`, cloud on `c274d18f`, B0 on `0ba4c25a`.
- Latency was load-confounded as described above.

### Open items

1. Re-measure latency on a quiet machine (AC-L1 for local and cloud-index, AC-L2, AC-L3).
2. Run the AC-L4 offline-cloud / circuit-breaker test.
3. Improve the local tier (parked task): it fails the floor, so a stronger local model is the route; the e5-small constants are exhausted.
4. Q4 gate: the owner decides which tier to recommend by default, using AC-Q5 and the cost figures above.
