# Gold v2 — frozen hashes

Filled by the orchestrator after sealing (RUNBOOK step 9). `PENDING` entries are skipped by
`tests/unit/gold-v2-frozen.test.ts`; once filled, a present file whose hash or line count differs
fails the test.

- snapshot: dc-20261010
- fingerprint: 03d9ce95b568031c0c2e2b31baa2eb7f1e66c8b7106c751c2d43b9f2c9b1bc96
- now: 2026-10-10T20:09:05.000Z

- train.jsonl: sha256=b7eb3fc605ea704fcc905c6e39c9f4a88a4096dd45faf649a20aed291d65008e count=90
- heldout.jsonl: sha256=701741f1e7dd32f1c50ce25ec2fae875fcf51202ca0295b6b31c7c5f3e7d86be count=72
- reserve.jsonl: sha256=b1e3add9d3c77039ebeef299c7524c5ab2b955c7cfb212730030b62d8b1776b6 count=57

## Authoring record (orchestrator, before any measurement)

- 9 fresh headless opus author runs (`--setting-sources '' --tools Read,Glob,Grep`), one per split x language,
  then one fresh opus validator per file (checks A-F, strict).
- Lines the validator failed were re-authored by fresh runs that saw only the target and the validator's
  short note (never the rejected query), and re-validated; up to 3 revision rounds (72 -> 25 -> 14 -> 6).
- 6 targets no attempt passed were DROPPED, never hand-written: heldout tr 2, heldout mixed 1, reserve tr 1,
  reserve mixed 2. Final counts: train 30/30/30, heldout tr 23 / en 25 / mixed 24, reserve tr 19 / en 20 /
  mixed 18 (tr/en/mixed).
- Pre-registered consequence (decided here, before B0 or any tier touched held-out): AC-Q1's "at least 23/25"
  becomes r@5 >= 90% of each language's n (tr >= 21/23, en >= 23/25, mixed >= 22/24; reserve >= 18/20 becomes
  tr >= 18/19, en >= 18/20, mixed >= 17/18). §2.4's "strictly greater when B_L < 23/25" becomes "when
  B_L < 92% of n" (tr 22/23, mixed 23/24).
- Known skew: train has no feature-type targets (features were exhausted by heldout/reserve, drawn first);
  heldout is about 30% features.
