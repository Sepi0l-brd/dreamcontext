import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * dreamcontext's own dogfooded brain lives in a separate PRIVATE repo, not in this one.
 * A few tests guard documents that live there (the soul, positioning.md, the live
 * diagrams, the recall gold set's targets). They resolve it from DREAMCONTEXT_OWN_BRAIN
 * (a `_dream_context/` path) or the sibling checkout `../dreamcontext-brain`, and SKIP
 * when neither exists — a contributor's clone and CI have no copy of it.
 */
function resolveOwnBrain(): string | null {
  const fromEnv = process.env.DREAMCONTEXT_OWN_BRAIN;
  if (fromEnv) return existsSync(fromEnv) ? resolve(fromEnv) : null;
  const sibling = join(__dirname, '..', '..', '..', 'dreamcontext-brain', '_dream_context');
  return existsSync(sibling) ? sibling : null;
}

export const OWN_BRAIN = resolveOwnBrain();
