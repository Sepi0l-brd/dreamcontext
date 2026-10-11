# Held-out / reserve ledger

Every evaluation that reads `heldout` or `reserve` appends exactly one line, in this format:

`YYYY-MM-DD | split | mode-or-tier | engine sha | who ran it | reason`

Expected final content: B0 x {heldout, reserve} x 3 modes, then the final run x 3 tiers. A reserve
final run happens only after a documented AC-Q2 failure.

| 2026-10-11 | heldout | raw | - | 0ba4c25a | B0 baseline (TB) |
| 2026-10-11 | reserve | raw | - | 0ba4c25a | B0 baseline (TB) |
| 2026-10-11 | heldout | tier-cloud-index | - | ba736f4f | final (T10) |
| 2026-10-11 | heldout | haiku | - | 0ba4c25a | B0 baseline (TB) |
| 2026-10-11 | reserve | haiku | - | 0ba4c25a | B0 baseline (TB) |
| 2026-10-11 | heldout | tier-cloud | voyageai/rerank-2.5-lite | c274d18f | final (T10) |
| 2026-10-11 | heldout | hybrid-e5 | - | 0ba4c25a | B0 baseline (TB) |
| 2026-10-11 | reserve | hybrid-e5 | - | 0ba4c25a | B0 baseline (TB) |
| 2026-10-11 | heldout | tier-local | - | 8ed3a6d8 | final (T10) |
