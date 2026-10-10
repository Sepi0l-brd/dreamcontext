import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { frozenDir, FROZEN_DIR } from '../../eval/harness.js';
import { T1_CLOUD_TYPES, t1FrozenDir } from '../../scripts/gold-v2-lib.js';
import { evalFrozenDir } from '../../src/lib/recall-cloud-config.js';
import { CLOUD_ELIGIBLE_TYPES } from '../../src/lib/embeddings/egress-rules.js';

describe('the eval-frozen directory is defined once and mirrored by output', () => {
  it.each(['/tmp/some-home', '/var/folders/x/home with space', homedir()])('agrees for home %s', (home) => {
    expect(frozenDir(home)).toBe(evalFrozenDir(home));
    expect(t1FrozenDir(home)).toBe(evalFrozenDir(home));
    expect(evalFrozenDir(home)).toBe(join(home, '.dreamcontext', 'eval-frozen'));
  });

  it('agrees on the default home', () => {
    expect(FROZEN_DIR).toBe(evalFrozenDir());
    expect(t1FrozenDir()).toBe(evalFrozenDir());
  });

  it("keeps T1's cloud-type list equal to the egress allow-list", () => {
    expect([...T1_CLOUD_TYPES].sort()).toEqual([...CLOUD_ELIGIBLE_TYPES].sort());
  });
});
