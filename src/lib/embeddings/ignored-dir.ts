import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Create `dir` (and parents) and make it ignore everything inside it: a `.gitignore` holding `*`.
 * Works for the project repo AND a brain-sync repo rooted at `_dream_context/` without touching
 * either repo's own `.gitignore`. Vectors and vault ids are credential-class (vectors are
 * partially invertible), so every directory that holds them goes through here.
 */
export function ensureSelfIgnoredDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const ignorePath = join(dir, '.gitignore');
  if (!existsSync(ignorePath)) writeFileSync(ignorePath, '*\n');
}
