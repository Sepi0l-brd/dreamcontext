# Held-out / reserve ledger

Every evaluation that reads `heldout` or `reserve` appends exactly one line, in this format:

`YYYY-MM-DD | split | mode-or-tier | engine sha | who ran it | reason`

Expected final content: B0 x {heldout, reserve} x 3 modes, then the final run x 3 tiers. A reserve
final run happens only after a documented AC-Q2 failure.

| 2026-10-11 | heldout | raw | - | 0ba4c25a | B0 baseline (TB) |
| 2026-10-11 | reserve | raw | - | 0ba4c25a | B0 baseline (TB) |
